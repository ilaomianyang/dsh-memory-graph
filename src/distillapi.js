/**
 * The "distill now" door: one exact Fetch route that runs the same distillation
 * `memory_distill` runs, so the panel's button and the model's tool cannot drift
 * apart. The run itself — and the one-run-at-a-time lock — live in
 * `src/distillrun.js`, because the automatic distiller fires through the same
 * door.
 *
 * This module only translates: a report becomes a 200 (including the reports that
 * say `ok: false`, because "the extractor is off" is an answer the panel prints,
 * not a failure it has to explain), and an unexpected throw becomes a 500.
 */
import { json } from './http.js'

export const DISTILL_PATH = '/api/memory-graph.distill'

/** 200 for an answer (including a refusal), 500 only for a crash. */
function respond(report) {
  const { failed, ...rest } = report
  return json(rest, failed === true ? 500 : 200)
}

export function createDistillHandler({ getRunner }) {
  return async function handleDistill() {
    const runner = getRunner()
    if (typeof runner?.run !== 'function') {
      return json(
        { ok: false, reason: 'unavailable', message: '蒸馏器不可用 · the distiller is not available' },
        500,
      )
    }
    return respond(await runner.run())
  }
}
