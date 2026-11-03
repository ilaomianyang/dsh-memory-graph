/**
 * The "distill now" route.
 *
 * The panel's button is the one control in this plugin that spends model budget,
 * so the things worth asserting are its edges: it runs the same distillation as
 * the tool (nothing re-implemented), one press is one run, a second press while
 * the first is working is refused instead of queued, and every outcome comes back
 * as a report the panel can print — including the ones that are not failures.
 *
 *   node test/distillapi.mjs
 */
import assert from 'node:assert/strict'

import { DISTILL_PATH, createDistillHandler } from '../src/distillapi.js'
import { createDistillRunner } from '../src/distillrun.js'

const results = []
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(
      () => results.push(`  ok   ${name}`),
      (error) => {
        results.push(`  FAIL ${name}: ${error.message}`)
        process.exitCode = 1
      },
    )
}

const body = async (response) => JSON.parse(await response.text())

const makeHandler = (overrides = {}) => {
  const seen = []
  const runner = createDistillRunner({
    getVault: () => ({ name: 'vault' }),
    getConfig: () => ({ extractor: { enabled: true } }),
    getRedactor: () => ({ redact: (text) => text }),
    getServices: () => ({ llm: 'LLM', selection: { provider: 'p', model: 'm' } }),
    distill: async (input) => {
      seen.push(input)
      return { ok: true, episodes: 12, written: 3, cards: [{ id: 'card-1', kind: 'decision', title: '用 BM25' }] }
    },
    ...overrides,
  })
  const handler = createDistillHandler({ getRunner: () => runner })
  return { handler, seen, runner }
}

await check('the route sits on the authenticated /api channel like the graph one', () => {
  assert.ok(DISTILL_PATH.startsWith('/api/'))
  assert.ok(DISTILL_PATH.includes('distill'), 'it is the distill door, not the graph door')
  assert.ok(!DISTILL_PATH.includes('?'), 'a query string would make the exact route never match')
})

await check('it runs the same distillation the tool runs, with the live vault and model', async () => {
  const { handler, seen } = makeHandler()
  const response = await handler()
  assert.equal(response.status, 200)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].vault.name, 'vault')
  assert.equal(seen[0].cfg.extractor.enabled, true)
  assert.equal(seen[0].llm, 'LLM', 'the harness transport service is passed through')
  assert.equal(seen[0].selection.provider, 'p', 'so the run uses the model selected in Settings')
  assert.equal(typeof seen[0].redactor.redact, 'function', 'and the live privacy rules')
  assert.equal(seen[0].dryRun, false, 'a button press is a real run, not a rehearsal')
})

await check('the answer is a report the panel can print', async () => {
  const { handler } = makeHandler()
  const report = await body(await handler())
  assert.equal(report.ok, true)
  assert.equal(report.busy, false)
  assert.equal(report.episodes, 12)
  assert.equal(report.written, 3)
  assert.deepEqual(report.cards, [{ id: 'card-1', kind: 'decision', title: '用 BM25', deduped: false }])
})

await check('one press is one run: a second press while it works is refused', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let runs = 0
  const { handler } = makeHandler({
    distill: async () => {
      runs += 1
      await gate
      return { ok: true, episodes: 1, written: 1 }
    },
  })

  const first = handler()
  // Let the first call reach its await, then press again.
  await new Promise((resolve) => setTimeout(resolve, 0))
  const second = await body(await handler())
  assert.equal(second.busy, true, 'the second caller is told, not queued')
  assert.equal(second.ok, false)

  release()
  const after = await body(await first)
  assert.equal(after.ok, true)
  assert.equal(runs, 1, 'exactly one distillation spent budget')

  const third = await body(await handler())
  assert.equal(third.busy, false, 'and the lock is released for the next press')
  assert.equal(runs, 2)
})

await check('a refusal from the extractor is an answer, not a 500', async () => {
  const { handler } = makeHandler({
    distill: async () => ({ ok: false, reason: 'Extractor is disabled. Set config extractor.enabled = true.' }),
  })
  const response = await handler()
  assert.equal(response.status, 200, 'the panel prints the line instead of an error banner')
  const report = await body(response)
  assert.equal(report.ok, false)
  assert.ok(String(report.reason).includes('extractor.enabled'))
})

await check('an unexpected throw is a 500 with the message, and the lock still frees', async () => {
  let calls = 0
  const { handler } = makeHandler({
    distill: async () => {
      calls += 1
      if (calls === 1) throw new Error('model route is gone')
      return { ok: true, episodes: 0, written: 0, reason: 'nothing new' }
    },
  })
  const failed = await handler()
  assert.equal(failed.status, 500)
  const report = await body(failed)
  assert.equal(report.ok, false)
  assert.ok(String(report.message).includes('model route is gone'))

  const retried = await handler()
  assert.equal(retried.status, 200, 'a crashed run does not wedge the button')
  assert.equal((await body(retried)).ok, true)
})

await check('a run that wrote cards refreshes the vault views, a dry one does not', async () => {
  let refreshed = 0
  const { handler } = makeHandler({
    refreshViews: async () => {
      refreshed += 1
    },
  })
  await handler()
  assert.equal(refreshed, 1, 'graph.html and README catch up without a restart')

  const empty = makeHandler({
    distill: async () => ({ ok: true, episodes: 0, written: 0, reason: 'Every episode has already been distilled.' }),
    refreshViews: async () => {
      refreshed += 1
    },
  })
  await empty.handler()
  assert.equal(refreshed, 1, 'nothing written, nothing to re-render')
})

await check('a view that fails to render does not fail the run that wrote the cards', async () => {
  const warnings = []
  const { handler } = makeHandler({
    refreshViews: async () => {
      throw new Error('disk full')
    },
    log: (level, message) => warnings.push(`${level}: ${message}`),
  })
  const response = await handler()
  assert.equal(response.status, 200)
  assert.equal((await body(response)).written, 3)
  assert.equal(warnings.length, 1)
  assert.ok(warnings[0].includes('disk full'))
})

await check('the card list is capped so a huge run cannot bloat the panel', async () => {
  const cards = Array.from({ length: 120 }, (_, i) => ({ id: `c-${i}`, kind: 'fact', title: `t${i}` }))
  const { handler } = makeHandler({ distill: async () => ({ ok: true, episodes: 120, written: 120, cards }) })
  const report = await body(await handler())
  assert.equal(report.cards.length, 40)
  assert.equal(report.written, 120, 'the count is still the truth')
})
await check('the runner tells its callers when it is busy, so the ticker can stand down', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const { runner } = makeHandler({
    distill: async () => {
      await gate
      return { ok: true, episodes: 1, written: 1 }
    },
  })
  assert.equal(runner.busy(), false)
  const running = runner.run({})
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(runner.busy(), true, 'a run in flight is visible without asking it to start another')
  release()
  await running
  assert.equal(runner.busy(), false, 'and it clears when the run settles')
})

await check('a route with no runner wired answers 500 instead of throwing at the browser', async () => {
  const handler = createDistillHandler({ getRunner: () => null })
  const response = await handler()
  assert.equal(response.status, 500)
  const report = await body(response)
  assert.equal(report.ok, false)
  assert.equal(report.reason, 'unavailable')
})

console.log(results.join('\n'))
console.log(process.exitCode === 1 ? '\nSOME CHECKS FAILED' : `\nall ${results.length} checks passed`)