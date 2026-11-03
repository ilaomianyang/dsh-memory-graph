/**
 * The automatic distiller: two independently configurable triggers over one tick.
 *
 * The rule that matters most is that neither trigger is a timer that fires a run.
 * A tick only ever *decides*, and the decision is a pure function of the config,
 * the clock, the last attempt and how many episodes are waiting — so the whole
 * behaviour can be asserted in tests without waiting a minute or spending a token.
 *
 * Why the attempt clock is separate from the vault's `lastRun`: a run that
 * distilled nothing (an empty vault, a model that returned no cards) must still
 * arm the gap, or a quiet vault would be re-asked on every tick. `lastAttemptAt`
 * is therefore written before the call, not after it.
 */
import { parseQuietHours } from './config.js'

const MINUTE = 60 * 1000

/** Is `now` inside the quiet window? A window may cross midnight. */
export function inQuietHours(window, now) {
  const bounds = parseQuietHours(window)
  if (bounds === null) return false
  const date = new Date(now)
  const minutes = date.getHours() * 60 + date.getMinutes()
  if (bounds.from === bounds.to) return false
  // 23:00-08:00 wraps: quiet when at-or-after the start, or before the end.
  return bounds.from < bounds.to
    ? minutes >= bounds.from && minutes < bounds.to
    : minutes >= bounds.from || minutes < bounds.to
}

/**
 * Should this tick run a distillation? Pure, so the rules are readable in one
 * place and testable without a clock.
 *
 * @param {object} input
 * @param {object} input.auto        the `auto` config group
 * @param {number} input.now         epoch ms
 * @param {number|null} input.lastAttemptAt  epoch ms of the previous attempt
 * @param {number} input.pending     undistilled episodes waiting
 * @returns {{due: boolean, rule: string|null, reason: string}}
 */
export function autoDecision({ auto, now, lastAttemptAt = null, pending = 0 }) {
  if (auto?.enabled !== true) return { due: false, rule: null, reason: 'auto is off' }
  if (pending <= 0) return { due: false, rule: null, reason: 'nothing to distill' }
  if (inQuietHours(auto.quietHours, now)) return { due: false, rule: null, reason: 'quiet hours' }

  const sinceAttempt = lastAttemptAt === null ? Infinity : now - lastAttemptAt
  const gap = (auto.minGapMinutes ?? 0) * MINUTE
  if (gap > 0 && sinceAttempt < gap) return { due: false, rule: null, reason: 'the gap between runs has not elapsed' }

  // Schedule rule: "every N minutes" means a run is due once N minutes have
  // passed since the last attempt — including the very first, so switching it on
  // does not require waiting for a whole interval before anything happens.
  if ((auto.everyMinutes ?? 0) > 0 && sinceAttempt >= auto.everyMinutes * MINUTE) {
    return { due: true, rule: 'schedule', reason: `every ${auto.everyMinutes} minute(s)` }
  }

  // Threshold rule: enough quiet episodes have piled up.
  if ((auto.minEpisodes ?? 0) > 0 && pending >= auto.minEpisodes) {
    return { due: true, rule: 'threshold', reason: `${pending} episode(s) waiting, threshold ${auto.minEpisodes}` }
  }

  return { due: false, rule: null, reason: 'nothing is due yet' }
}

/**
 * The ticker.
 *
 * `run` is the shared runner from `src/distillrun.js`, so an automatic run and a
 * pressed button can never overlap. The state file lives in the vault so an app
 * restart does not reset the gap and fire a run on every launch.
 */
export function createAutoDistiller({ cfg, vault, run, log = () => {}, now = () => Date.now() }) {
  let loaded = false
  let lastAttemptAt = null
  let lastReport = null

  async function loadState() {
    if (loaded) return
    loaded = true
    try {
      const state = await vault.readAutoState?.()
      const at = Number(state?.lastAttemptAt)
      lastAttemptAt = Number.isFinite(at) && at > 0 ? at : null
    } catch (error) {
      log('warn', `auto: could not read .auto-state.json: ${error?.message ?? error}`)
    }
  }

  /** One decision, and at most one run. Returns what it decided, for the tests. */
  async function tick() {
    const auto = cfg.auto ?? {}
    await loadState()
    if (auto.enabled !== true) return { due: false, rule: null, reason: 'auto is off', ran: false }

    let pending = 0
    try {
      const batch = await vault.readUndistilled(Math.max(1, auto.minEpisodes ?? 0, cfg.extractor?.maxEpisodesPerRun ?? 40))
      pending = Array.isArray(batch) ? batch.length : 0
    } catch (error) {
      log('warn', `auto: could not count undistilled episodes: ${error?.message ?? error}`)
      return { due: false, rule: null, reason: 'the vault could not be read', ran: false }
    }

    const at = now()
    const decision = autoDecision({ auto, now: at, lastAttemptAt, pending })
    if (!decision.due) return { ...decision, pending, ran: false }

    // Arm the gap before the call: a slow or failing run must not be retried on
    // the next tick.
    lastAttemptAt = at
    try {
      await vault.writeAutoState?.({ lastAttemptAt: at })
    } catch (error) {
      log('warn', `auto: could not record the attempt: ${error?.message ?? error}`)
    }

    const report = await run({ project: auto.project ? String(auto.project) : undefined })
    lastReport = report
    if (report?.busy === true) {
      log('info', 'auto: skipped, a distillation is already running')
    } else if (report?.ok === true) {
      log(
        'info',
        `auto (${decision.rule}): read ${report.episodes} episode(s) → wrote ${report.written} card(s)` +
          (report.model ? ` · ${report.model}` : ''),
      )
    } else {
      log('warn', `auto (${decision.rule}): ${report?.message ?? report?.reason ?? 'did not run'}`)
    }
    return { ...decision, pending, ran: true, report }
  }

  /** What the ticker knows, for a diagnostics line or a test. */
  function state() {
    return { lastAttemptAt, lastReport }
  }

  return { tick, state }
}

/**
 * Wire the ticker to the plugin's lifetime.
 *
 * The interval runs even when auto is off — it reads one boolean and returns —
 * because `auto.enabled` is a live Settings field, and a ticker that only started
 * when the plugin mounted would never see it switched on.
 */
export function registerAutoDistill({ ctx, distiller, intervalMs = 60000 }) {
  const timer = setInterval(() => {
    distiller.tick().catch(() => {
      // tick() already logs its own failures; a rejected promise must not become
      // an unhandled rejection that takes the host down.
    })
  }, intervalMs)
  // Do not wait a whole interval after activation to notice a rule that is
  // already due (a restart with a threshold already met).
  const first = setTimeout(() => {
    distiller.tick().catch(() => {})
  }, 5000)
  if (typeof timer.unref === 'function') timer.unref()
  if (typeof first.unref === 'function') first.unref()
  return () => {
    clearInterval(timer)
    clearTimeout(first)
  }
}
