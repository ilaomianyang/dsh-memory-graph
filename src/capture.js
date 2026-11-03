/**
 * Capture: turn the session log into raw episodes.
 *
 * Deliberately model-free. Every turn is appended as it closes, so the "never
 * loses anything" guarantee holds even while the extractor is unconfigured,
 * offline, or out of quota. Distillation happens later and separately.
 *
 * What counts as a real message, how it is truncated and how it is redacted
 * lives in `turns.js`, shared with the history importer — see the note there for
 * why there is exactly one copy of that logic.
 */
import { createTurnAssembler, projectOf } from './turns.js'

const FLUSH_AFTER_MS = 90_000

export function registerCapture(ctx, { cfg, vault, redactor }) {
  const assembler = createTurnAssembler({ cfg, redactor })
  const disposers = []
  const timers = new Map()

  const idOf = (session) => String(session?.id ?? session?.header?.id ?? 'unknown')

  function drop(id) {
    assembler.forget(id)
    const timer = timers.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.delete(id)
    }
  }

  async function flush(id) {
    const episode = assembler.flush(id)
    drop(id)
    if (episode) await vault.appendEpisode(episode)
  }

  function schedule(id) {
    const existing = timers.get(id)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      flush(id).catch(() => {})
    }, FLUSH_AFTER_MS)
    timer.unref?.()
    timers.set(id, timer)
  }

  disposers.push(
    ctx.on('session/event', (session, event) => {
      // The switch is read inside the assembler, per event: turning capture off
      // in 设置 must stop writes immediately without unregistering the listener.
      if (!cfg.capture.enabled) return

      const id = idOf(session)
      const episodes = assembler.push({
        sessionId: id,
        project: projectOf(session, cfg.defaultProject),
        event,
      })

      if (episodes.length > 0) {
        for (const episode of episodes) {
          vault.appendEpisode(episode).catch(() => {})
        }
      }

      const type = event?.type
      const relevant =
        type === 'turn/end' || type === 'user/message' || type === 'assistant/message' || type === 'tool/result'
      if (!relevant) return

      // A turn is the natural write unit: flush it as soon as it closes, so an
      // episode exists even if the next turn never comes. The timer is the safety
      // net for a turn that never closes at all.
      if (type === 'turn/end') {
        const timer = timers.get(id)
        if (timer) {
          clearTimeout(timer)
          timers.delete(id)
        }
        assembler.forget(id)
        return
      }

      if (assembler.isOpen(id)) schedule(id)
    }),
  )

  return [
    ...disposers,
    () => {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      for (const episode of assembler.flushAll()) {
        vault.appendEpisode(episode).catch(() => {})
      }
    },
  ]
}
