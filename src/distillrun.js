/**
 * One distillation, shared by the three ways to ask for it: the tool, the
 * panel's button, and the automatic distiller.
 *
 * The lock lives here and nowhere else. Two of those three can fire without
 * anyone watching — a scheduled tick and a pressed button can land in the same
 * second — and a distillation spends real model budget while advancing one
 * cursor in the vault. So the second caller is told the first is running; it is
 * never queued and never runs concurrently.
 */
import { distill as runDistill } from './extract.js'

/** How many written cards a caller gets to list before it just shows a count. */
const CARD_LIMIT = 40

export function createDistillRunner(options) {
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

  let inflight = null

  /** True while a run is in flight — the auto ticker asks before counting. */
  function busy() {
    return inflight !== null
  }

  /**
   * Run one distillation. Always resolves with a report, never throws: an
   * extractor that is switched off, a vault with nothing new and a model call
   * that blew up are all answers a caller has to print, not exceptions it has to
   * catch three different ways.
   */
  function run({ project, dryRun = false, signal } = {}) {
    if (inflight) {
      return Promise.resolve({ ok: false, busy: true, reason: 'A distillation is already running.' })
    }

    const task = (async () => {
      try {
        const report = await distill({
          cfg: getConfig(),
          vault: getVault(),
          redactor: getRedactor(),
          project,
          dryRun,
          signal,
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
        return {
          ok: Boolean(report.ok),
          busy: false,
          dryRun: Boolean(report.dryRun ?? dryRun),
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
        }
      } catch (error) {
        log('warn', `distillation failed: ${error?.message ?? error}`)
        return {
          ok: false,
          busy: false,
          failed: true,
          reason: 'unavailable',
          message: String(error?.message ?? error),
        }
      }
    })()

    inflight = task
    return task.finally(() => {
      if (inflight === task) inflight = null
    })
  }

  return { run, busy }
}
