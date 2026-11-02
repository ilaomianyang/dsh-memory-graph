/**
 * The "distill now" door: one exact Fetch route that runs the same distillation
 * `memory_distill` runs, so the panel's button and the model's tool cannot drift
 * apart.
 *
 * Two things this deliberately does NOT do.
 *
 * **It does not decide anything.** The route always returns 200 with a report
 * (`ok: false` plus a `reason` for "extractor is off", "nothing new"), because
 * those are answers, not failures: the panel prints the line instead of an error
 * banner. Only an unexpected throw is a 500.
 *
 * **It does not allow two at once.** A distillation spends real model budget and
 * advances one cursor in the vault; two tabs pressing the button at the same time
 * must not spend it twice, so the second caller is told the first is running.
 */
import { distill as runDistill } from './extract.js'
import { json } from './http.js'

export const DISTILL_PATH = '/api/memory-graph.distill'

/** How many written cards the panel gets to list before it just shows a count. */
const CARD_LIMIT = 40

export function createDistillHandler(options) {
  const {
    getVault,
    getConfig,
    getRedactor,
    getServices = () => ({}),
    // Injected so the tests can drive the success/failure paths without a model.
    distill = runDistill,
    // Rendering the vault's own views (graph.html, README) is best effort: the
    // cards are already on disk, and the next write renders them again.
    refreshViews = () => {},
    log = () => {},
  } = options ?? {}

  // One run per process, not one per browser tab.
  let inflight = null

  return async function handleDistill() {
    if (inflight) {
      return json({ ok: false, busy: true, reason: 'A distillation is already running.' })
    }

    const task = (async () => {
      try {
        const report = await distill({
          cfg: getConfig(),
          vault: getVault(),
          redactor: getRedactor(),
          ...getServices(),
        })
        const cards = (report.cards ?? report.proposed ?? []).slice(0, CARD_LIMIT).map((card) => ({
          id: card.id ?? null,
          kind: String(card.kind ?? 'note'),
          title: String(card.title ?? ''),
          deduped: Boolean(card.deduped),
        }))
        if (report.ok && (report.written ?? 0) > 0) {
          try {
            await refreshViews()
          } catch (error) {
            log('warn', `distilled, but a vault view did not render: ${error?.message ?? error}`)
          }
        }
        return json({
          ok: Boolean(report.ok),
          busy: false,
          episodes: report.episodes ?? 0,
          written: report.written ?? 0,
          remaining: report.remaining ?? 0,
          cards,
          batches: report.batches ?? null,
          model: report.model ?? null,
          keySource: report.keySource ?? null,
          usage: report.usage ?? null,
          skipped: report.skipped ?? null,
          reason: report.reason ?? null,
        })
      } catch (error) {
        log('warn', `distillation from the panel failed: ${error?.message ?? error}`)
        return json({ ok: false, busy: false, reason: 'unavailable', message: String(error?.message ?? error) }, 500)
      }
    })()

    inflight = task
    try {
      return await task
    } finally {
      if (inflight === task) inflight = null
    }
  }
}
