/**
 * Extractor test: prompt building, key resolution, response handling and the
 * per-card project attribution, with `fetch` stubbed so it never leaves the box.
 *   node test/extract.mjs
 */
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { resolveConfig } from '../src/config.js'
import { createRedactor } from '../src/privacy.js'
import { createVault } from '../src/vault.js'
import { buildPrompt, callModel, distill, parseCards, plannedBatchSize, readCredentialRef, resolveKeyInfo, resolveRoute, selectionEffort } from '../src/extract.js'

const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-extract-'))
const results = []
function check(name, fn) {
  try {
    fn()
    results.push(`  ok   ${name}`)
  } catch (error) {
    results.push(`  FAIL ${name}: ${error.message}`)
    process.exitCode = 1
  }
}
async function checkAsync(name, fn) {
  try {
    await fn()
    results.push(`  ok   ${name}`)
  } catch (error) {
    results.push(`  FAIL ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

/* ------------------------------------------------------------- fetch stub */

const realFetch = globalThis.fetch
const calls = []
let reply = { status: 200, body: { choices: [{ message: { content: '{"cards":[]}' } }] } }

function stubFetch(handler) {
  calls.length = 0
  globalThis.fetch = async (url, init) => {
    const entry = { url, body: JSON.parse(init.body), headers: init.headers }
    calls.push(entry)
    const next = handler ? await handler(entry, calls.length) : reply
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      text: async () => (typeof next.body === 'string' ? next.body : JSON.stringify(next.body)),
    }
  }
}
stubFetch()

const modelReply = (cards, extra = {}) =>
  ({ status: 200, body: { choices: [{ message: { content: JSON.stringify({ cards, ...extra }) } }], usage: { total_tokens: 42 }, model: 'stub-1' } })

const draft = {
  kind: 'decision',
  title: 'A durable thing was decided',
  body: 'Because of the reason, which will still matter later.',
  entities: ['memory-graph'],
  confidence: 'user_stated',
  valid_from: '2026-11-01',
}

/* ------------------------------------------------------------------ parse */

check('parseCards reads a bare JSON object', () => {
  const { cards } = parseCards(JSON.stringify({ cards: [draft] }))
  assert.equal(cards.length, 1)
  assert.equal(cards[0].kind, 'decision')
  assert.equal(cards[0].validFrom, '2026-11-01')
})

check('parseCards reads a fenced code block', () => {
  const { cards } = parseCards('```json\n{"cards":[{"kind":"fact","title":"Fenced","body":"b"}]}\n```')
  assert.equal(cards.length, 1)
  assert.equal(cards[0].title, 'Fenced')
})

check('parseCards reads a bare array', () => {
  const { cards } = parseCards(JSON.stringify([{ title: 'Bare array', body: 'b' }]))
  assert.equal(cards.length, 1)
})

check('parseCards drops unusable cards instead of throwing', () => {
  const { cards } = parseCards(JSON.stringify({ cards: [null, 7, { body: 'no title' }, { title: '  ' }, { title: 'Kept' }] }))
  assert.equal(cards.length, 1)
  assert.equal(cards[0].title, 'Kept')
})

check('parseCards normalises unknown kinds and confidence', () => {
  const { cards } = parseCards(JSON.stringify({ cards: [{ title: 'T', kind: 'gossip', confidence: 'certain' }] }))
  assert.equal(cards[0].kind, 'note')
  assert.equal(cards[0].confidence, 'inferred')
})

check('parseCards keeps only id-shaped supersedes and valid dates', () => {
  const { cards } = parseCards(
    JSON.stringify({ cards: [{ title: 'T', supersedes: ['c-20260101-aaaa', 'not-an-id', 4], valid_from: '01/11/2026' }] }),
  )
  assert.deepEqual(cards[0].supersedes, ['c-20260101-aaaa'])
  assert.equal(cards[0].validFrom, null)
})

check('parseCards keeps a per-card project', () => {
  const { cards } = parseCards(JSON.stringify({ cards: [{ title: 'T', project: ' blog-engine ' }] }))
  assert.equal(cards[0].project, 'blog-engine')
})

check('parseCards reports non-JSON without throwing', () => {
  const parsed = parseCards('the model rambled instead of answering')
  assert.equal(parsed.cards.length, 0)
  assert.match(parsed.skipped, /not JSON/)
  assert.ok(parsed.raw.length > 0)
})

check('parseCards passes a skip reason through', () => {
  const parsed = parseCards(JSON.stringify({ cards: [], skipped: 'nothing durable happened' }))
  assert.equal(parsed.skipped, 'nothing durable happened')
})

/* ------------------------------------------------------------------- keys */

check('resolveKeyInfo prefers the configured key', () => {
  const cfg = resolveConfig({ extractor: { apiKey: 'sk-configured', apiKeyEnv: 'MEMORY_TEST_KEY_A' } })
  assert.deepEqual(resolveKeyInfo(cfg).source, 'config extractor.apiKey')
})

check('resolveKeyInfo falls back to the named env var', () => {
  process.env.MEMORY_TEST_KEY_B = 'sk-from-env'
  const cfg = resolveConfig({ extractor: { apiKeyEnv: 'MEMORY_TEST_KEY_B' } })
  const found = resolveKeyInfo(cfg)
  assert.equal(found.key, 'sk-from-env')
  assert.equal(found.source, 'env MEMORY_TEST_KEY_B')
})

check('resolveKeyInfo reports where it looked when there is no key', () => {
  const cfg = resolveConfig({ extractor: { apiKeyEnv: 'MEMORY_TEST_KEY_MISSING' } })
  const found = resolveKeyInfo(cfg)
  assert.equal(found.key, '')
  assert.ok(found.looked.some((where) => where.includes('MEMORY_TEST_KEY_MISSING')), JSON.stringify(found.looked))
})

const store = path.join(dir, 'credentials.yaml')
await fsp.writeFile(
  store,
  ['version: 1', 'refs:', '  FIRST_KEY: "sk-first"', "  TARGET_KEY: 'sk-target'", 'other:', '  TARGET_KEY: sk-decoy'].join('\n'),
)
check('readCredentialRef reads only the refs block, quotes stripped', () => {
  assert.equal(readCredentialRef('TARGET_KEY', store), 'sk-target')
  assert.equal(readCredentialRef('FIRST_KEY', store), 'sk-first')
})
check('readCredentialRef ignores names outside refs and missing files', () => {
  assert.equal(readCredentialRef('NOPE', store), '')
  assert.equal(readCredentialRef('TARGET_KEY', path.join(dir, 'no-such-file.yaml')), '')
  assert.equal(readCredentialRef('', store), '')
})

/* ----------------------------------------------------------------- prompt */

const episode = (project, t, user, assistant) => ({ file: 'e.jsonl', line: 0, record: { project, t, user, assistant } })
const episodes = [
  episode('memory-graph', '2026-11-01T09:00:00+08:00', '我们要一个记忆插件。', '好的。'),
  episode('blog-engine', '2026-11-01T10:00:00+08:00', 'The generator rewrites footnotes.', 'Drop the rehype pass.'),
]

check('buildPrompt scopes a single-project batch by that project', () => {
  const messages = buildPrompt([episodes[0]], [], 'memory-graph')
  assert.match(messages[1].content, /episode\(s\) from project "memory-graph"/)
  assert.equal(messages[0].role, 'system')
})

check('buildPrompt names every project when a batch spans projects', () => {
  const messages = buildPrompt(episodes, [], 'memory-graph')
  assert.match(messages[1].content, /2 projects \(memory-graph, blog-engine\)/)
  assert.match(messages[1].content, /every card must name its own project/)
})

check('buildPrompt lists existing memories of the batch projects', () => {
  const cards = [
    { id: 'c-20260101-aaaa', project: 'memory-graph', kind: 'decision', status: 'active', title: 'Old decision' },
    { id: 'c-20260101-bbbb', project: 'unrelated', kind: 'decision', status: 'active', title: 'Other project' },
  ]
  const messages = buildPrompt(episodes, cards, undefined)
  assert.ok(messages[1].content.includes('c-20260101-aaaa'), messages[1].content)
  assert.ok(!messages[1].content.includes('c-20260101-bbbb'), 'leaked another project into the prompt')
})

check('buildPrompt omits the existing block when there is nothing to show', () => {
  const messages = buildPrompt([episodes[0]], [], 'memory-graph')
  assert.ok(!messages[1].content.includes('Existing memories'))
})

/* -------------------------------------------------------------- callModel */

const cfgFor = (overrides = {}) =>
  resolveConfig({
    vaultDir: dir,
    // These cases stub `fetch`, so they exercise the HTTP transport; the harness
    // transport is covered further down with a stub llm service.
    extractor: { enabled: true, transport: 'http', apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1', model: 'stub-1', ...overrides },
  })

/** Config for the harness transport: no key and no endpoint, only a route. */
const harnessCfg = (overrides = {}) =>
  resolveConfig({ vaultDir: dir, extractor: { enabled: true, model: 'deepseek-chat', ...overrides } })

await checkAsync('callModel returns content, usage and where the key came from', async () => {
  stubFetch(() => modelReply([draft]))
  const result = await callModel(cfgFor(), [{ role: 'user', content: 'hi' }])
  assert.match(result.content, /durable thing/)
  assert.equal(result.keySource, 'config extractor.apiKey')
  assert.equal(result.model, 'stub-1')
})

await checkAsync('callModel asks for JSON mode on the first attempt', async () => {
  stubFetch(() => modelReply([]))
  await callModel(cfgFor(), [])
  assert.deepEqual(calls[0].body.response_format, { type: 'json_object' })
})

await checkAsync('callModel retries without response_format when the endpoint rejects it', async () => {
  stubFetch((entry, nth) =>
    nth === 1
      ? { status: 400, body: { error: { message: 'response_format is not supported' } } }
      : modelReply([draft]),
  )
  const result = await callModel(cfgFor(), [])
  assert.equal(calls.length, 2)
  assert.equal('response_format' in calls[1].body, false)
  assert.match(result.content, /durable thing/)
})

await checkAsync('callModel does not retry an unrelated 400', async () => {
  stubFetch(() => ({ status: 400, body: { error: { message: 'bad model name' } } }))
  await assert.rejects(() => callModel(cfgFor(), []), /HTTP 400/)
  assert.equal(calls.length, 1)
})

await checkAsync('callModel reports a non-JSON response body', async () => {
  stubFetch(() => ({ status: 200, body: '<html>gateway</html>' }))
  await assert.rejects(() => callModel(cfgFor(), []), /non-JSON response/)
})

await checkAsync('callModel rejects an empty completion', async () => {
  stubFetch(() => ({ status: 200, body: { choices: [{ message: { content: '   ' } }] } }))
  await assert.rejects(() => callModel(cfgFor(), []), /empty completion/)
})

await checkAsync('callModel names the places it looked for a key', async () => {
  stubFetch(() => modelReply([]))
  await assert.rejects(() => callModel(cfgFor({ apiKey: '' }), []), /Looked in env MEMORY_LLM_API_KEY/)
  assert.equal(calls.length, 0, 'should not have called the endpoint without a key')
})

/* ---------------------------------------------------------------- distill */

const cfg = cfgFor()
const redactor = createRedactor(cfg.privacy)
const vault = createVault(cfg, redactor)

await vault.appendEpisode({ project: 'memory-graph', t: '2026-11-01T09:00:00+08:00', user: '记忆要纯文本。', assistant: '好。' })
await vault.appendEpisode({ project: 'blog-engine', t: '2026-11-01T10:00:00+08:00', user: 'Stop rewriting footnotes.', assistant: 'Dropping the rehype pass.' })

stubFetch(() =>
  modelReply([
    { kind: 'decision', project: 'memory-graph', title: '记忆库用纯文本存储', body: '可 diff。', entities: ['memory-graph'] },
    { kind: 'preference', project: 'blog-engine', title: 'Never rewrite the markdown body', body: 'Opaque body.', entities: ['blog-engine'] },
    { kind: 'note', title: 'Card with no project at all', body: 'Falls back.', entities: [] },
  ]),
)

let report
await checkAsync('distill writes one card per proposal', async () => {
  report = await distill({ cfg, vault, redactor })
  assert.equal(report.ok, true)
  assert.equal(report.episodes, 2)
  assert.equal(report.written, 3)
})

check('distill files each card under its own project', () => {
  const projects = report.cards.map((card) => `${card.project}:${card.title}`).sort()
  assert.deepEqual(projects, [
    'blog-engine:Card with no project at all',
    'blog-engine:Never rewrite the markdown body',
    'memory-graph:记忆库用纯文本存储',
  ])
})

await checkAsync('distill falls back to the dominant project when a card forgets one', async () => {
  const cards = await vault.listCards({ includeRetracted: true })
  const orphan = cards.find((card) => card.title === 'Card with no project at all')
  assert.equal(orphan.project, 'blog-engine', 'a 1-1 tie goes to the most recent episode')
})

await checkAsync('distill records the episode span as provenance', async () => {
  const cards = await vault.listCards({ includeRetracted: true })
  const card = cards.find((item) => item.title === '记忆库用纯文本存储')
  assert.equal(card.source.kind, 'distill')
  assert.equal(card.source.model, 'stub-1')
  assert.ok(card.source.episodes.length >= 1)
})

await checkAsync('distill marks the episodes as read so the next run is a no-op', async () => {
  const again = await distill({ cfg, vault, redactor })
  assert.equal(again.episodes, 0)
  assert.match(again.reason, /already been distilled/)
  assert.equal(calls.length, 1, 'a no-op run must not call the model again')
})

await checkAsync('distill writes an audit line naming the projects and the key source', async () => {
  const audit = await fsp.readFile(path.join(dir, 'audit', `${new Date().toISOString().slice(0, 7)}.log`), 'utf8')
  assert.ok(audit.includes('distill'), audit)
  assert.ok(audit.includes('projects=memory-graph,blog-engine'), audit)
  assert.ok(audit.includes('cards=3'), audit)
})

await checkAsync('distill dry run proposes without writing', async () => {
  const dryDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-dry-'))
  const dryCfg = resolveConfig({ vaultDir: dryDir, extractor: { enabled: true, transport: 'http', apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' } })
  const dryVault = createVault(dryCfg, createRedactor(dryCfg.privacy))
  await dryVault.appendEpisode({ project: 'p', t: '2026-11-01T09:00:00+08:00', user: 'A thing.', assistant: 'Yes.' })
  stubFetch(() => modelReply([{ kind: 'fact', title: 'Proposed only', body: 'b' }]))
  const dry = await distill({ cfg: dryCfg, vault: dryVault, redactor: createRedactor(dryCfg.privacy), dryRun: true })
  assert.equal(dry.proposed.length, 1)
  assert.equal((await dryVault.listCards({ includeRetracted: true })).length, 0)
  assert.equal((await dryVault.stats()).distill.lastRun, null, 'a dry run must not advance the cursor')
  await fsp.rm(dryDir, { recursive: true, force: true })
})

await checkAsync('distill refuses to run while the extractor is disabled', async () => {
  const offCfg = resolveConfig({ vaultDir: dir, extractor: { enabled: false } })
  const off = await distill({ cfg: offCfg, vault, redactor })
  assert.equal(off.ok, false)
  assert.match(off.reason, /disabled/)
})

await checkAsync('distill does not write a card whose body carries a secret through untouched', async () => {
  const secretDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-secret-'))
  const secretCfg = resolveConfig({ vaultDir: secretDir, extractor: { enabled: true, transport: 'http', apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' } })
  const secretRedactor = createRedactor(secretCfg.privacy)
  const secretVault = createVault(secretCfg, secretRedactor)
  const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'
  await secretVault.appendEpisode({ project: 'p', t: '2026-11-01T09:00:00+08:00', user: `My key is ${secret}.`, assistant: 'Noted.' })
  stubFetch(() => modelReply([{ kind: 'fact', title: 'Key rotated', body: `The key ${secret} was rotated.`, entities: [] }]))
  await distill({ cfg: secretCfg, vault: secretVault, redactor: secretRedactor })
  const [card] = await secretVault.listCards({ includeRetracted: true })
  assert.ok(!card.body.includes(secret), card.body)
  assert.ok(card.body.includes('[REDACTED]'), card.body)
  await fsp.rm(secretDir, { recursive: true, force: true })
})

/* ------------------------------------------------ harness transport (llm) */

/**
 * A stand-in for the harness `llm` service: it records what the extractor
 * proposed, applies the `configure` callback the way the real service does, and
 * streams whatever chunks the case needs.
 */
function stubLlm({ chunks, script, delayMs = 0 } = {}) {
  const seen = []
  let calls = 0
  const reply = () => {
    // `script` gives one answer per model call; `chunks` repeats for all of them.
    if (Array.isArray(script)) return script[Math.min(calls, script.length - 1)]
    return chunks
  }
  return {
    seen,
    get calls() {
      return calls
    },
    llm: {
      async prepareCall(config, signal, configure) {
        const resolved = configure ? { ...config, ...configure(config, { reasoning: { efforts: [] } }) } : { ...config }
        seen.push({ config: resolved, signal })
        const answer = reply()
        calls += 1
        return {
          config: resolved,
          stream(options) {
            seen.push({ options })
            return (async function* () {
              if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
              for (const chunk of answer ?? [
                { type: 'text-delta', index: 0, text: '{"cards":[]}' },
                { type: 'usage', usage: { totalTokens: 7 } },
                { type: 'finish', reason: { kind: 'stop' } },
              ]) {
                yield chunk
              }
            })()
          },
        }
      },
    },
  }
}

/** One model answer that contains these card titles. */
const cardsChunks = (...titles) => [
  {
    type: 'text-delta',
    index: 0,
    text: JSON.stringify({ cards: titles.map((title) => ({ kind: 'note', title, body: 'body' })) }),
  },
  { type: 'usage', usage: { totalTokens: 100 } },
  { type: 'finish', reason: { kind: 'stop' } },
]

/** One model answer that ran out of output budget. */
const truncatedChunks = [
  { type: 'text-delta', index: 0, text: '{"cards":[{"kind":"note","title":"cut' },
  { type: 'finish', reason: { kind: 'max-tokens' } },
]

check('resolveRoute borrows the model selected in Settings', () => {
  const route = resolveRoute(harnessCfg(), { provider: 'wb', model: 'deepseek-v4.1-flash' })
  assert.equal(route.provider, 'wb')
  assert.equal(route.model, 'deepseek-v4.1-flash')
  assert.equal(route.effort, '')
  assert.match(route.source, /Settings/)
})

check('resolveRoute keeps the thinking level of the selection', () => {
  assert.equal(selectionEffort({ reasoningEffort: 'high' }), 'high')
  assert.equal(selectionEffort({ reasoning: 'medium' }), 'medium')
  assert.equal(selectionEffort({ reasoning: { id: 'low', name: 'Low' } }), 'low')
  assert.equal(selectionEffort({}), '')
  assert.equal(resolveRoute(harnessCfg(), { provider: 'p', model: 'm', reasoningEffort: 'low' }).effort, 'low')
})

check('an explicit reasoningEffort overrides the selection', () => {
  const route = resolveRoute(harnessCfg({ reasoningEffort: 'high' }), { provider: 'p', model: 'm', reasoningEffort: 'low' })
  assert.equal(route.effort, 'high')
})

check('resolveRoute prefers configured provider/model when useCurrentModel is off', () => {
  const cfg = harnessCfg({ useCurrentModel: false, provider: 'deepseek', model: 'deepseek-chat' })
  const route = resolveRoute(cfg, { provider: 'ignored', model: 'ignored' })
  assert.deepEqual([route.provider, route.model], ['deepseek', 'deepseek-chat'])
  assert.match(route.source, /config extractor\.provider/)
})

check('resolveRoute explains what is missing instead of guessing a route', () => {
  assert.throws(
    () => resolveRoute(harnessCfg({ useCurrentModel: false, provider: 'deepseek', model: '' }), { provider: 'p', model: 'm' }),
    /both required/,
  )
  assert.throws(() => resolveRoute(harnessCfg(), undefined), /No model is selected in Settings/)
})

await checkAsync('the harness transport needs no key and names the route it used', async () => {
  const { llm, seen } = stubLlm()
  const result = await callModel(harnessCfg(), [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }], {
    llm,
    selection: { provider: 'wb', model: 'deepseek-v4.1-flash' },
  })
  assert.equal(result.content, '{"cards":[]}')
  assert.equal(result.model, 'wb/deepseek-v4.1-flash')
  assert.match(result.keySource, /Settings/)
  assert.equal(seen[0].config.provider, 'wb')
  assert.equal(seen[1].options.system, 'S')
  assert.deepEqual(seen[1].options.messages, [{ role: 'user', content: [{ type: 'text', text: 'U' }] }])
})

await checkAsync('the harness transport passes a configured thinking level to the route', async () => {
  const { llm, seen } = stubLlm()
  await callModel(harnessCfg({ reasoningEffort: 'high' }), [{ role: 'user', content: 'U' }], {
    llm,
    selection: { provider: 'p', model: 'm' },
  })
  assert.equal(seen[0].config.reasoningEffort, 'high')
})

await checkAsync('the harness transport sends the output cap and leaves sampling to the route', async () => {
  const { llm, seen } = stubLlm()
  await callModel(harnessCfg({ maxOutputTokens: 4096 }), [{ role: 'user', content: 'U' }], {
    llm,
    selection: { provider: 'p', model: 'm' },
  })
  assert.equal(seen[0].config.maxTokens, 4096)
  assert.equal('temperature' in seen[0].config, false, 'the borrowed route owns sampling')
})

await checkAsync('the harness transport reports a failed finish with its code', async () => {
  const { llm } = stubLlm({
    chunks: [{ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'slow down' } } }],
  })
  await assert.rejects(
    () => callModel(harnessCfg(), [{ role: 'user', content: 'U' }], { llm, selection: { provider: 'p', model: 'm' } }),
    /RATE_LIMIT.*slow down/s,
  )
})

await checkAsync('the harness transport asks for a bigger cap when output is truncated', async () => {
  const { llm } = stubLlm({ chunks: [{ type: 'text-delta', index: 0, text: '{"cards":[' }, { type: 'finish', reason: { kind: 'max-tokens' } }] })
  await assert.rejects(
    () => callModel(harnessCfg(), [{ role: 'user', content: 'U' }], { llm, selection: { provider: 'p', model: 'm' } }),
    /maxOutputTokens/,
  )
})

await checkAsync('the harness transport rejects an empty completion', async () => {
  const { llm } = stubLlm({ chunks: [{ type: 'text-delta', index: 0, text: '   ' }, { type: 'finish', reason: { kind: 'stop' } }] })
  await assert.rejects(
    () => callModel(harnessCfg(), [{ role: 'user', content: 'U' }], { llm, selection: { provider: 'p', model: 'm' } }),
    /empty completion/,
  )
})

await checkAsync('a missing llm service points at the http transport instead of failing obscurely', async () => {
  await assert.rejects(() => callModel(harnessCfg(), [{ role: 'user', content: 'U' }]), /no llm service.*"http"/s)
})

await checkAsync('the harness transport says who cancelled an aborted call', async () => {
  const { llm } = stubLlm({ delayMs: 40, chunks: [{ type: 'finish', reason: { kind: 'aborted' } }] })
  const abort = new AbortController()
  setTimeout(() => abort.abort(), 5)
  await assert.rejects(
    () =>
      callModel(harnessCfg(), [{ role: 'user', content: 'U' }], {
        llm,
        signal: abort.signal,
        selection: { provider: 'p', model: 'm' },
      }),
    /p\/m was cancelled before the route answered/s,
  )
})

await checkAsync('distill over the harness transport records the borrowed route as provenance', async () => {
  const llmDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-harness-'))
  const llmCfg = resolveConfig({ vaultDir: llmDir, extractor: { enabled: true, model: 'deepseek-chat' } })
  const llmRedactor = createRedactor(llmCfg.privacy)
  const llmVault = createVault(llmCfg, llmRedactor)
  await llmVault.appendEpisode({ project: 'p', t: '2026-11-01T09:00:00+08:00', user: 'Use the model from Settings.', assistant: 'OK.' })
  const { llm } = stubLlm({
    chunks: [
      { type: 'text-delta', index: 0, text: JSON.stringify({ cards: [{ kind: 'preference', title: 'Borrow the Settings model', body: 'No key of its own.', entities: ['dsh'] }] }) },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
  })
  calls.length = 0
  const report = await distill({ cfg: llmCfg, vault: llmVault, redactor: llmRedactor, llm, selection: { provider: 'wb', model: 'deepseek-v4.1-flash' } })
  assert.equal(report.ok, true)
  assert.equal(report.written, 1)
  assert.equal(report.model, 'wb/deepseek-v4.1-flash')
  const [card] = await llmVault.listCards({ includeRetracted: true })
  assert.equal(card.source.model, 'wb/deepseek-v4.1-flash')
  assert.equal(calls.length, 0, 'the harness transport must not touch fetch')
  await fsp.rm(llmDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Batching: one call per batch, so the answer fits the output budget
// ---------------------------------------------------------------------------

/** A vault with `count` undistilled episodes and a harness-only extractor. */
async function backlog(count, overrides = {}) {
  const vaultDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-batch-'))
  const cfg = resolveConfig({ vaultDir, extractor: { enabled: true, ...overrides } })
  const redactor = createRedactor(cfg.privacy)
  const vault = createVault(cfg, redactor)
  for (let i = 0; i < count; i += 1) {
    await vault.appendEpisode({ project: 'p', t: `2026-10-${String((i % 28) + 1).padStart(2, '0')}T09:00:00+08:00`, user: `turn ${i}`, assistant: 'ok' })
  }
  return { cfg, redactor, vault, vaultDir }
}

check('plannedBatchSize fits the output budget and never exceeds the backlog', () => {
  assert.equal(plannedBatchSize(harnessCfg({ maxOutputTokens: 3000 }), 23), 9)
  assert.equal(plannedBatchSize(harnessCfg({ maxOutputTokens: 3000 }), 3), 3)
  assert.equal(plannedBatchSize(harnessCfg({ maxOutputTokens: 400 }), 23), 1)
  assert.equal(plannedBatchSize(harnessCfg({ maxOutputTokens: 100 }), 23), 1, 'one episode per call is the floor')
})

await checkAsync('a long backlog is distilled in batches of the planned size', async () => {
  const { cfg, redactor, vault, vaultDir } = await backlog(20, { maxOutputTokens: 3000 })
  const stub = stubLlm({ script: [cardsChunks('first'), cardsChunks('second'), cardsChunks('third')] })
  const report = await distill({ cfg, vault, redactor, llm: stub.llm, selection: { provider: 'p', model: 'm' } })
  assert.equal(report.ok, true)
  assert.equal(report.episodes, 20, 'every episode is covered, in steps of nine')
  assert.deepEqual(report.batches, { planned: 3, done: 3, size: 9 })
  assert.equal(stub.calls, 3, 'nine, nine, two — three calls, not one forty-episode request')
  assert.equal(report.written, 3)
  assert.equal(report.usage.totalTokens, 300, 'usage is summed across batches')
  assert.equal((await vault.readUndistilled(100)).length, 0, 'the whole backlog is marked distilled')
  await fsp.rm(vaultDir, { recursive: true, force: true })
})

await checkAsync('a truncated batch is halved and retried instead of failing the run', async () => {
  const { cfg, redactor, vault, vaultDir } = await backlog(4, { maxOutputTokens: 3000 })
  // Four episodes fit one call; the model still runs out, so the run must ask
  // for half of them rather than give up on the backlog.
  const stub = stubLlm({ script: [truncatedChunks, cardsChunks('left half'), cardsChunks('right half')] })
  const report = await distill({ cfg, vault, redactor, llm: stub.llm, selection: { provider: 'p', model: 'm' } })
  assert.equal(report.ok, true)
  assert.equal(report.episodes, 4)
  assert.equal(stub.calls, 3, 'one overflow, then two halves')
  assert.equal(report.written, 2)
  assert.equal((await vault.readUndistilled(100)).length, 0)
  await fsp.rm(vaultDir, { recursive: true, force: true })
})

await checkAsync('a single episode that overflows is reported, not retried forever', async () => {
  const { cfg, redactor, vault, vaultDir } = await backlog(1, { maxOutputTokens: 3000 })
  const stub = stubLlm({ chunks: truncatedChunks })
  const report = await distill({ cfg, vault, redactor, llm: stub.llm, selection: { provider: 'p', model: 'm' } })
  assert.equal(report.ok, false)
  assert.match(report.reason, /maxOutputTokens/)
  assert.equal(stub.calls, 1)
  await fsp.rm(vaultDir, { recursive: true, force: true })
})

await checkAsync('a later batch failing keeps the cards the earlier ones wrote', async () => {
  const { cfg, redactor, vault, vaultDir } = await backlog(10, { maxOutputTokens: 1600 })
  const failing = [{ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'slow down' } } }]
  const { llm } = stubLlm({ script: [cardsChunks('kept'), failing] })
  const report = await distill({ cfg, vault, redactor, llm, selection: { provider: 'p', model: 'm' } })
  assert.equal(report.ok, false, 'the run did not finish')
  assert.match(report.reason, /RATE_LIMIT/)
  assert.equal(report.written, 1, 'the first batch stays written')
  assert.equal(report.cards.length, 1)
  assert.equal(report.batches.done, 1)
  const cards = await vault.listCards({ includeRetracted: true })
  assert.equal(cards.length, 1)
  assert.equal(cards[0].title, 'kept')
  assert.equal((await vault.readUndistilled(100)).length, 5, 'only the finished batch is marked')
  await fsp.rm(vaultDir, { recursive: true, force: true })
})

await checkAsync('a dry run previews one batch and says how much is left', async () => {
  const { cfg, redactor, vault, vaultDir } = await backlog(20, { maxOutputTokens: 3000 })
  const stub = stubLlm({ script: [cardsChunks('preview one', 'preview two')] })
  const report = await distill({ cfg, vault, redactor, llm: stub.llm, selection: { provider: 'p', model: 'm' }, dryRun: true })
  assert.equal(report.ok, true)
  assert.equal(report.dryRun, true)
  assert.equal(stub.calls, 1, 'a preview spends one call, not three')
  assert.equal(report.episodes, 9)
  assert.equal(report.remaining, 11)
  assert.deepEqual(report.proposed.map((card) => card.title), ['preview one', 'preview two'])
  assert.equal((await vault.listCards({ includeRetracted: true })).length, 0, 'nothing is written')
  assert.equal((await vault.readUndistilled(100)).length, 20, 'nothing is marked distilled')
  await fsp.rm(vaultDir, { recursive: true, force: true })
})

globalThis.fetch = realFetch

console.log(results.join('\n'))
if (process.exitCode) {
  console.log('\nSOME CHECKS FAILED')
} else {
  console.log(`\nall ${results.length} checks passed`)
  await fsp.rm(dir, { recursive: true, force: true })
}
