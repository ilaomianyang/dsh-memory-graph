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
 * Three rules, in the order they are asked:
 *
 * 1. **catch-up** — a pile bigger than one batch is a queue, not a schedule. It
 *    runs every `catchUpEveryMinutes` until the pile is smaller than a batch, and
 *    stops for the day at `maxBatchesPerDay`. This is the rule that lets an
 *    imported history drain itself overnight without a person pressing anything,
 *    and the daily cap is what keeps it from spending without a ceiling.
 * 2. **schedule** — `everyMinutes` since the last run (or since the clock
 *    started).
 * 3. **threshold** — `minEpisodes` waiting.
 *
 * The gap (`minGapMinutes`) sits between 1 and 2/3: catch-up measures its own
 * cadence, while the other two answers still respect the gap a person configured.
 *
 * @param {object} input
 * @param {object} input.auto        the `auto` config group
 * @param {number} input.now         epoch ms
 * @param {number|null} input.lastAttemptAt  epoch ms of the previous attempt
 * @param {number} input.pending     undistilled episodes waiting
 * @param {number} [input.batchSize] episodes one run distils
 * @param {number} [input.batchesToday] automatic batches already run today
 * @returns {{due: boolean, rule: string|null, reason: string}}
 */
export function autoDecision({ auto, now, lastAttemptAt = null, startedAt = null, pending = 0, batchSize = 40, batchesToday = 0 }) {
  if (auto?.enabled !== true) return { due: false, rule: null, reason: 'auto is off' }
  if (pending <= 0) return { due: false, rule: null, reason: 'nothing to distill' }
  if (inQuietHours(auto.quietHours, now)) return { due: false, rule: null, reason: 'quiet hours' }

  // Two different clocks, on purpose:
  //   * the gap measures time since the last *run* (nothing else);
  //   * the schedule measures time since the last run, or since the clock was
  //     started when there has not been one yet.
  // `null` for either means "not started", and a schedule with no clock is never
  // overdue — turning a daily schedule on must not spend on the spot. The
  // threshold rule ignores both clocks: its trigger is the pile, not the time.
  const sinceRun = lastAttemptAt === null ? null : now - lastAttemptAt
  const clock = lastAttemptAt ?? startedAt
  const sinceClock = clock === null ? null : now - clock

  // Catch-up first: its cadence is its own, and it is the only rule that can be
  // due while the gap configured for the others has not elapsed.
  if (auto.catchUp === true && pending >= Math.max(1, batchSize)) {
    const cap = auto.maxBatchesPerDay ?? 0
    if (cap > 0 && batchesToday >= cap) {
      return { due: false, rule: null, reason: `今日已跑 ${batchesToday} 批，达到上限 ${cap} · daily batch cap reached` }
    }
    const every = Math.max(1, auto.catchUpEveryMinutes ?? 10) * MINUTE
    if (sinceRun === null || sinceRun >= every) {
      return {
        due: true,
        rule: 'catch-up',
        reason: `还有 ${pending} 条待蒸馏，今天第 ${batchesToday + 1} 批${cap > 0 ? ` / 上限 ${cap}` : ''}`,
      }
    }
    return { due: false, rule: null, reason: `距上一批不到 ${auto.catchUpEveryMinutes ?? 10} 分钟 · catch-up gap` }
  }

  const gap = (auto.minGapMinutes ?? 0) * MINUTE
  if (gap > 0 && sinceRun !== null && sinceRun < gap) {
    return { due: false, rule: null, reason: 'the gap between runs has not elapsed' }
  }

  // Schedule rule: due once `everyMinutes` have passed on its own clock.
  if ((auto.everyMinutes ?? 0) > 0 && sinceClock !== null && sinceClock >= auto.everyMinutes * MINUTE) {
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
  let startedAt = null
  let lastReport = null
  let day = null
  let batchesToday = 0

  async function loadState() {
    if (loaded) return
    loaded = true
    try {
      const state = await vault.readAutoState?.()
      const attempt = Number(state?.lastAttemptAt)
      const start = Number(state?.startedAt)
      lastAttemptAt = Number.isFinite(attempt) && attempt > 0 ? attempt : null
      startedAt = Number.isFinite(start) && start > 0 ? start : null
      day = typeof state?.batchDay === 'string' ? state.batchDay : null
      const count = Number(state?.batchesToday)
      batchesToday = Number.isFinite(count) && count > 0 ? count : 0
    } catch (error) {
      log('warn', `自动蒸馏：读不了 .auto-state.json · auto: could not read .auto-state.json: ${error?.message ?? error}`)
    }
  }

  /** Today's local date, the key the daily batch cap resets on. */
  function todayKey(at) {
    const date = new Date(at)
    const pad = (value) => String(Math.abs(value)).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  }

  /** One decision, and at most one run. Returns what it decided, for the tests. */
  async function tick() {
    const auto = cfg.auto ?? {}
    await loadState()
    if (auto.enabled !== true) return { due: false, rule: null, reason: 'auto is off', ran: false }

    const batchSize = Math.max(1, cfg.extractor?.maxEpisodesPerRun ?? 40)
    let pending = 0
    try {
      // Ask for one batch more than a batch: the decision needs to know whether a
      // *full* batch is waiting (catch-up) and whether the threshold is met, and
      // one extra row answers both without a second read.
      const batch = await vault.readUndistilled(Math.max(1, auto.minEpisodes ?? 0, batchSize))
      pending = Array.isArray(batch) ? batch.length : 0
    } catch (error) {
      log('warn', `自动蒸馏：数不了还没蒸馏的情节 · auto: could not count undistilled episodes: ${error?.message ?? error}`)
      return { due: false, rule: null, reason: 'the vault could not be read', ran: false }
    }

    const at = now()
    // Start the schedule's clock when it has none yet (just switched on, or a
    // fresh install) instead of treating it as overdue: switching a daily
    // schedule on must not spend before the first interval has even passed. This
    // is a separate field from `lastAttemptAt` so it does not arm the gap and
    // delay the threshold rule, which has nothing to do with the clock.
    if ((auto.everyMinutes ?? 0) > 0 && lastAttemptAt === null && startedAt === null) {
      startedAt = at
      try {
        await vault.writeAutoState?.({ startedAt: at })
      } catch (error) {
        log('warn', `自动蒸馏：没能启动计划时钟 · auto: could not start the schedule clock: ${error?.message ?? error}`)
      }
    }

    // The daily cap is per calendar day, and a new day resets it — in memory now
    // and on disk with the next write, so a restart cannot lose the count either.
    const today = todayKey(at)
    if (day !== today) {
      day = today
      batchesToday = 0
    }

    const decision = autoDecision({ auto, now: at, lastAttemptAt, startedAt, pending, batchSize, batchesToday })
    if (!decision.due) return { ...decision, pending, batchesToday, ran: false }

    // Arm the gap before the call: a slow or failing run must not be retried on
    // the next tick.
    lastAttemptAt = at
    // Counted before the call, like the gap: a run that fails or finds another one
    // in flight still spent this batch's slot, so the daily cap stays a real cap.
    if (decision.rule === 'catch-up') batchesToday += 1
    try {
      await vault.writeAutoState?.(decision.rule === 'catch-up' ? { lastAttemptAt: at, batchDay: today, batchesToday } : { lastAttemptAt: at })
    } catch (error) {
      log('warn', `自动蒸馏：没能记下这次尝试 · auto: could not record the attempt: ${error?.message ?? error}`)
    }

    const report = await run({ project: auto.project ? String(auto.project) : undefined })
    lastReport = report
    if (report?.busy === true) {
      log('info', '自动蒸馏：跳过，已经有一次蒸馏在跑 · auto: skipped, a distillation is already running')
    } else if (report?.ok === true) {
      log(
        'info',
        `自动蒸馏 auto (${decision.rule}): read ${report.episodes} episode(s) → wrote ${report.written} card(s)` +
          (report.model ? ` · ${report.model}` : ''),
      )
    } else {
      log(
        'warn',
        `自动蒸馏 auto (${decision.rule}): ${report?.message ?? report?.reason ?? '没有运行 · did not run'}`,
      )
    }
    return { ...decision, pending, batchesToday, ran: true, report }
  }

  /** What the ticker knows, for a diagnostics line or a test. */
  function state() {
    return { lastAttemptAt, lastReport, batchesToday, day }
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
