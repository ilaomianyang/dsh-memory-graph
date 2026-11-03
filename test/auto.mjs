/**
 * The automatic distiller.
 *
 * Two triggers, one tick, and one rule that matters more than the features: a tick
 * *decides*, it does not run. That is what makes this testable at all — the whole
 * decision is a pure function of (config, clock, last attempt, pending episodes),
 * so these checks never wait a minute and never spend a token.
 *
 * The state that survives a restart lives in the vault, so it is faked here the
 * same way the real one behaves: read what was written.
 *
 *   node test/auto.mjs
 */
import assert from 'node:assert/strict'

import { autoDecision, createAutoDistiller, inQuietHours, registerAutoDistill } from '../src/auto.js'
import { parseQuietHours, resolveConfig } from '../src/config.js'

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

const MINUTE = 60 * 1000
const AUTO = { enabled: true, minEpisodes: 10, everyMinutes: 0, minGapMinutes: 30, quietHours: '', project: '' }

/** A vault that only remembers what `writeAutoState` was told. */
const makeVault = ({ pending = 0, state = {}, failWrite = false } = {}) => {
  const vault = {
    written: state,
    reads: 0,
    async readUndistilled(limit) {
      vault.reads += 1
      vault.lastLimit = limit
      return Array.from({ length: Math.min(pending, limit) }, (_, i) => ({ file: 'f.jsonl', line: i, record: {} }))
    },
    async readAutoState() {
      return vault.written
    },
    async writeAutoState(patch) {
      if (failWrite) throw new Error('disk full')
      vault.written = { ...vault.written, ...patch }
      return vault.written
    },
  }
  return vault
}

const makeDistiller = ({ auto = AUTO, pending = 0, state = {}, clock = { at: 1_000_000 }, run, failWrite } = {}) => {
  const calls = []
  const logs = []
  const vault = makeVault({ pending, state, failWrite })
  const distiller = createAutoDistiller({
    cfg: { auto, extractor: { maxEpisodesPerRun: 40 } },
    vault,
    now: () => clock.at,
    run: async (options) => {
      calls.push(options)
      return run ? run(options) : { ok: true, episodes: pending, written: 2, model: 'deepseek-chat' }
    },
    log: (level, message) => logs.push(`${level}: ${message}`),
  })
  return { distiller, vault, calls, logs, clock }
}

/* --------------------------------------------------------------- the rules */

await check('off by default: a tick does nothing at all', async () => {
  const { distiller, calls, vault } = makeDistiller({ auto: { ...AUTO, enabled: false }, pending: 100 })
  const decision = await distiller.tick()
  assert.equal(decision.due, false)
  assert.equal(decision.reason, 'auto is off')
  assert.equal(vault.reads, 0, 'an off switch does not even read the vault')
  assert.equal(calls.length, 0)
})

await check('the threshold rule fires only once enough episodes have piled up', () => {
  const base = { auto: AUTO, now: 5_000_000, lastAttemptAt: null }
  assert.equal(autoDecision({ ...base, pending: 9 }).due, false)
  const hit = autoDecision({ ...base, pending: 10 })
  assert.equal(hit.due, true)
  assert.equal(hit.rule, 'threshold')
  assert.equal(autoDecision({ ...base, pending: 0 }).reason, 'nothing to distill')
})

await check('the schedule rule fires on elapsed time, and 0 disables it', () => {
  const auto = { ...AUTO, minEpisodes: 0, everyMinutes: 60 }
  const now = 10 * 60 * MINUTE
  // No clock yet is never "overdue": the ticker starts it, so switching a daily
  // schedule on cannot spend before the first interval has passed.
  assert.equal(autoDecision({ auto, now, lastAttemptAt: null, pending: 1 }).due, false)
  assert.equal(autoDecision({ auto, now, lastAttemptAt: now - 61 * MINUTE, pending: 1 }).due, true)
  assert.equal(autoDecision({ auto, now, lastAttemptAt: now - 59 * MINUTE, pending: 1 }).due, false)
  assert.equal(autoDecision({ auto: { ...auto, everyMinutes: 0 }, now, lastAttemptAt: now - 999 * MINUTE, pending: 1 }).due, false)
})

await check('a schedule with no clock starts one instead of spending on the spot', async () => {
  const { distiller, calls, vault, clock } = makeDistiller({ auto: { ...AUTO, minEpisodes: 0, everyMinutes: 1440 }, pending: 5 })
  const first = await distiller.tick()
  assert.equal(first.due, false, 'switching a daily schedule on does not run immediately')
  assert.equal(first.reason, 'nothing is due yet')
  assert.equal(calls.length, 0)
  assert.equal(vault.written.startedAt, clock.at, 'the clock starts now')
  assert.equal(vault.written.lastAttemptAt, undefined, 'and it is not an attempt: the gap must not be armed by it')
  clock.at += 24 * 60 * MINUTE
  const next = await distiller.tick()
  assert.equal(next.due, true)
  assert.equal(next.rule, 'schedule')
  assert.equal(calls.length, 1, 'and a day later it runs')
})

await check('a threshold with no clock still fires at once: that rule is the pile, not the clock', async () => {
  const { distiller, calls } = makeDistiller({ auto: { ...AUTO, minEpisodes: 3, everyMinutes: 1440 }, pending: 5 })
  const decision = await distiller.tick()
  assert.equal(decision.ran, true)
  assert.equal(decision.rule, 'threshold')
  assert.equal(calls.length, 1)
})

/* -------------------------------------------------------------- catch-up */

const CATCH_UP = { ...AUTO, enabled: true, minEpisodes: 0, everyMinutes: 0, minGapMinutes: 30, catchUp: true, catchUpEveryMinutes: 10, maxBatchesPerDay: 3 }

await check('catch-up is off unless asked for: a full batch is not a queue', () => {
  const base = { auto: { ...AUTO, minEpisodes: 0, everyMinutes: 0 }, now: 5_000_000, lastAttemptAt: null, pending: 500, batchSize: 40 }
  assert.equal(autoDecision(base).due, false)
})

await check('catch-up runs on its own cadence even though minGapMinutes is longer', async () => {
  const { distiller, calls, clock } = makeDistiller({ auto: CATCH_UP, pending: 500 })
  const first = await distiller.tick()
  assert.equal(first.rule, 'catch-up', 'a backlog is due on the first tick')
  assert.equal(first.batchesToday, 1)
  assert.equal(calls.length, 1)
  clock.at += 5 * MINUTE
  const tooSoon = await distiller.tick()
  assert.equal(tooSoon.due, false, 'ten minutes is the catch-up cadence, five is not enough')
  assert.match(tooSoon.reason, /catch-up gap/u)
  clock.at += 6 * MINUTE
  const again = await distiller.tick()
  assert.equal(again.rule, 'catch-up')
  assert.equal(again.batchesToday, 2)
  assert.equal(calls.length, 2)
})

await check('catch-up stops at the daily cap and starts again the next day', async () => {
  const { distiller, calls, clock, vault } = makeDistiller({ auto: CATCH_UP, pending: 500 })
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await distiller.tick()).rule, 'catch-up')
    clock.at += 11 * MINUTE
  }
  const capped = await distiller.tick()
  assert.equal(capped.due, false)
  assert.match(capped.reason, /上限 3/u)
  assert.equal(calls.length, 3, 'three batches are the whole day')
  assert.equal(vault.written.batchesToday, 3)

  clock.at += 24 * 60 * MINUTE
  const tomorrow = await distiller.tick()
  assert.equal(tomorrow.rule, 'catch-up')
  assert.equal(tomorrow.batchesToday, 1, 'a new day resets the counter')
})

await check('a pile smaller than one batch is not catch-up work', async () => {
  const { distiller, calls } = makeDistiller({ auto: CATCH_UP, pending: 12 })
  const decision = await distiller.tick()
  assert.equal(decision.due, false, 'twelve episodes wait for a schedule or a threshold')
  assert.equal(calls.length, 0)
})

await check('the daily counter is read back from the vault, not assumed to be zero', async () => {
  const clock = { at: new Date(2026, 10, 3, 9, 0, 0).getTime() }
  const state = { batchDay: '2026-11-03', batchesToday: 3, lastAttemptAt: clock.at - 20 * MINUTE }
  const { distiller, calls } = makeDistiller({ auto: CATCH_UP, pending: 500, state, clock })
  const decision = await distiller.tick()
  assert.equal(decision.due, false, 'a restart must not hand out a fresh daily allowance')
  assert.match(decision.reason, /上限 3/u)
  assert.equal(calls.length, 0)
})

await check('quiet hours outrank catch-up', async () => {
  const at = new Date(2026, 10, 3, 2, 0, 0).getTime()
  const decision = autoDecision({ auto: { ...CATCH_UP, quietHours: '23:00-08:00' }, now: at, lastAttemptAt: null, pending: 500, batchSize: 40 })
  assert.equal(decision.due, false)
  assert.equal(decision.reason, 'quiet hours')
})

await check('both rules can be on: whichever is satisfied first runs', () => {
  const auto = { ...AUTO, minEpisodes: 10, everyMinutes: 60 }
  const now = 100 * MINUTE
  // Past the gap, inside the schedule window: only the pile of episodes can fire it.
  assert.equal(autoDecision({ auto, now, lastAttemptAt: now - 31 * MINUTE, pending: 40 }).rule, 'threshold')
  assert.equal(autoDecision({ auto, now, lastAttemptAt: now - 61 * MINUTE, pending: 1 }).rule, 'schedule')
  assert.equal(autoDecision({ auto, now, lastAttemptAt: now - 31 * MINUTE, pending: 1 }).due, false)
})

await check('the minimum gap holds whichever rule fired', () => {
  const auto = { ...AUTO, minEpisodes: 1, everyMinutes: 1, minGapMinutes: 30 }
  const now = 100 * MINUTE
  assert.equal(autoDecision({ auto, now, lastAttemptAt: now - 10 * MINUTE, pending: 99 }).due, false)
  assert.equal(autoDecision({ auto, now, lastAttemptAt: now - 31 * MINUTE, pending: 99 }).due, true)
})

await check('quiet hours save the run for later, including a window past midnight', () => {
  const at = (hour, minute = 0) => new Date(2026, 10, 3, hour, minute).getTime()
  const auto = { ...AUTO, quietHours: '23:00-08:00' }
  assert.equal(inQuietHours('23:00-08:00', at(23, 30)), true)
  assert.equal(inQuietHours('23:00-08:00', at(2)), true)
  assert.equal(inQuietHours('23:00-08:00', at(8)), false)
  assert.equal(inQuietHours('02:00-03:00', at(2, 30)), true)
  assert.equal(inQuietHours('02:00-03:00', at(4)), false)
  assert.equal(inQuietHours('', at(3)), false, 'empty means always')
  assert.equal(inQuietHours('nonsense', at(3)), false, 'unreadable text must not silence it forever')
  assert.equal(autoDecision({ auto, now: at(23, 30), lastAttemptAt: null, pending: 50 }).reason, 'quiet hours')
})

/* ------------------------------------------------------------- the ticker */

await check('a tick that decides yes runs exactly one distillation and records the attempt', async () => {
  const { distiller, calls, vault, logs } = makeDistiller({ pending: 12 })
  const decision = await distiller.tick()
  assert.equal(decision.due, true)
  assert.equal(decision.ran, true)
  assert.equal(calls.length, 1, 'one tick, one run')
  assert.equal(typeof vault.written.lastAttemptAt, 'number', 'the gap clock is persisted, so a restart cannot lose it')
  assert.ok(logs.some((line) => line.includes('read 12 episode(s) → wrote 2 card(s)')), logs.join('\n'))
})

await check('the same tick right after does not run again: the gap is armed before the call', async () => {
  const { distiller, calls, clock } = makeDistiller({ pending: 12 })
  await distiller.tick()
  clock.at += 5 * MINUTE
  const again = await distiller.tick()
  assert.equal(again.due, false)
  assert.equal(again.reason, 'the gap between runs has not elapsed')
  assert.equal(calls.length, 1)
  clock.at += 30 * MINUTE
  assert.equal((await distiller.tick()).due, true, 'and it comes back after the gap')
  assert.equal(calls.length, 2)
})

await check('nor after a restart, which is what the vault state file is for', async () => {
  const first = makeDistiller({ pending: 12 })
  await first.distiller.tick()
  const written = first.vault.written
  const second = makeDistiller({ pending: 12, state: written, clock: { at: 1_000_000 + 6 * MINUTE } })
  const decision = await second.distiller.tick()
  assert.equal(decision.due, false, 'a fresh process reads the attempt clock instead of starting over')
  assert.equal(second.calls.length, 0)
})

await check('a run that produced nothing still arms the gap, so a quiet vault is not re-asked', async () => {
  const { distiller, calls, clock } = makeDistiller({
    pending: 12,
    run: async () => ({ ok: true, episodes: 12, written: 0, reason: 'nothing worth keeping' }),
  })
  await distiller.tick()
  clock.at += 2 * MINUTE
  assert.equal((await distiller.tick()).due, false)
  assert.equal(calls.length, 1)
})

await check('an automatic run never overlaps one already in flight', async () => {
  const { distiller, calls, logs } = makeDistiller({
    pending: 12,
    run: async () => ({ ok: false, busy: true, reason: 'A distillation is already running.' }),
  })
  const decision = await distiller.tick()
  assert.equal(decision.ran, true)
  assert.equal(calls.length, 1)
  assert.ok(logs.some((line) => line.includes('already running')), logs.join('\n'))
})

await check('a failed run is logged with the reason, and the gap still holds', async () => {
  const { distiller, calls, clock, logs } = makeDistiller({
    pending: 12,
    run: async () => ({ ok: false, reason: 'Extractor is disabled. Set config extractor.enabled = true.' }),
  })
  await distiller.tick()
  assert.ok(logs.some((line) => line.includes('Extractor is disabled')), logs.join('\n'))
  clock.at += 5 * MINUTE
  await distiller.tick()
  assert.equal(calls.length, 1, 'a refusal is not retried on the next tick')
})

await check('the configured project reaches the run', async () => {
  const { distiller, calls } = makeDistiller({ auto: { ...AUTO, project: 'Article2' }, pending: 12 })
  await distiller.tick()
  assert.equal(calls[0].project, 'Article2', 'automatic cards land in the project the user named')
})

await check('an unreadable vault is a logged skip, not a crashed ticker', async () => {
  const { distiller, logs } = makeDistiller({ pending: 12 })
  distiller.state()
  const broken = createAutoDistiller({
    cfg: { auto: AUTO, extractor: { maxEpisodesPerRun: 40 } },
    vault: {
      async readUndistilled() {
        throw new Error('EACCES')
      },
      async readAutoState() {
        return {}
      },
      async writeAutoState() {},
    },
    run: async () => {
      throw new Error('should not run')
    },
    log: (level, message) => logs.push(`${level}: ${message}`),
  })
  const decision = await broken.tick()
  assert.equal(decision.ran, false)
  assert.ok(logs.some((line) => line.includes('EACCES')), logs.join('\n'))
})

/* ------------------------------------------------------------- the wiring */

await check('the ticker asks for enough episodes to see the threshold', async () => {
  const { distiller, vault } = makeDistiller({ auto: { ...AUTO, minEpisodes: 200 }, pending: 250 })
  await distiller.tick()
  assert.ok(vault.lastLimit >= 200, `asked for ${vault.lastLimit}, which would hide the threshold`)
})

await check('registering the ticker returns a stop that clears both timers', () => {
  let ticks = 0
  const stop = registerAutoDistill({
    ctx: {},
    distiller: {
      async tick() {
        ticks += 1
        return { due: false }
      },
    },
    intervalMs: 5,
  })
  assert.equal(typeof stop, 'function')
  stop()
  assert.equal(typeof stop, 'function', 'stopping twice must not throw')
  stop()
})

await check('a malformed quiet window is dropped instead of silencing the feature', () => {
  assert.equal(parseQuietHours(''), null)
  assert.equal(parseQuietHours('25:00-08:00'), null)
  assert.equal(parseQuietHours('later'), null)
  const cfg = resolveConfig({})
  assert.equal(cfg.auto.enabled, false, 'automatic distillation is off unless someone asks for it')
  assert.equal(cfg.auto.quietHours, '')
  const weird = resolveConfig({ auto: { quietHours: 'nonsense', minEpisodes: '12' } })
  assert.equal(weird.auto.quietHours, '', 'the broken window is dropped')
  assert.equal(weird.auto.minEpisodes, 12, 'a numeric string is still a number')
})

console.log(results.join('\n'))
console.log(process.exitCode === 1 ? '\nSOME CHECKS FAILED' : `\nall ${results.length} checks passed`)
