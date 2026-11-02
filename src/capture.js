/**
 * Capture: turn the session log into raw episodes.
 *
 * Deliberately model-free. Every turn is appended as it closes, so the "never
 * loses anything" guarantee holds even while the extractor is unconfigured,
 * offline, or out of quota. Distillation happens later and separately.
 */
import path from 'node:path'
import { nowIso } from './vault.js'

const FLUSH_AFTER_MS = 90_000
const MAX_ASSISTANT_PARTS = 6

function collectText(node, depth = 0, seen = new Set(), out = []) {
  if (node === null || node === undefined || depth > 4) return out
  if (typeof node === 'string') return out
  if (Array.isArray(node)) {
    for (const item of node) collectText(item, depth + 1, seen, out)
    return out
  }
  if (typeof node !== 'object') return out
  if (seen.has(node)) return out
  seen.add(node)

  if (node.type === 'text' && typeof node.text === 'string') {
    out.push(node.text)
    return out
  }
  for (const key of ['content', 'message', 'text', 'parts', 'blocks']) {
    if (key in node) collectText(node[key], depth + 1, seen, out)
  }
  return out
}

function eventText(event) {
  const parts = collectText(event?.data)
  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

function projectOf(session, fallback) {
  const cwd = session?.header?.cwd ?? session?.meta?.cwd ?? session?.cwd
  if (typeof cwd === 'string' && cwd.trim() !== '') {
    const base = path.basename(cwd.replace(/[\\/]+$/, ''))
    if (base !== '') return base
  }
  return fallback
}

function truncate(text, max) {
  const value = String(text ?? '').trim()
  if (value.length <= max) return value
  return `${value.slice(0, max)}…`
}

export function registerCapture(ctx, { cfg, vault, redactor }) {
  if (!cfg.capture.enabled) return []

  const buffers = new Map()
  const disposers = []
  const timers = new Map()

  const idOf = (session) => String(session?.id ?? session?.header?.id ?? 'unknown')

  function bufferOf(session) {
    const id = idOf(session)
    let buffer = buffers.get(id)
    if (!buffer) {
      buffer = { project: projectOf(session, cfg.defaultProject), user: '', assistant: [], tools: 0, turn: null }
      buffers.set(id, buffer)
    }
    return { id, buffer }
  }

  async function flush(id, { force = false } = {}) {
    const buffer = buffers.get(id)
    if (!buffer) return
    const toolCount = buffer.tools
    const user = truncate(buffer.user, cfg.capture.userChars)
    const assistant = truncate(buffer.assistant.join('\n'), cfg.capture.assistantChars)
    if (!force && user === '' && assistant === '') {
      buffers.delete(id)
      return
    }
    if (user.length + assistant.length < cfg.capture.minChars) {
      buffers.delete(id)
      return
    }

    buffers.delete(id)
    const timer = timers.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.delete(id)
    }

    const redactedUser = redactor.redact(user).text
    const redactedAssistant = redactor.redact(assistant).text
    await vault.appendEpisode({
      t: nowIso(),
      project: buffer.project,
      session: id,
      turn: buffer.turn,
      user: redactedUser,
      assistant: redactedAssistant,
      ...(cfg.capture.includeToolOutput && toolCount > 0 ? { tools: toolCount } : {}),
    })
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
      const type = event?.type

      // A turn is the natural write unit: flush it as soon as it closes, so an
      // episode exists even if the next turn never comes.
      if (type === 'turn/end') {
        const id = idOf(session)
        const buffer = buffers.get(id)
        if (buffer) {
          if (typeof event?.data?.turn === 'number') buffer.turn = event.data.turn
          flush(id).catch(() => {})
        }
        return
      }

      if (type !== 'user/message' && type !== 'assistant/message' && type !== 'tool/result') return

      const { id, buffer } = bufferOf(session)

      if (type === 'user/message') {
        const text = eventText(event)
        if (buffer.user !== '' || buffer.assistant.length > 0) {
          flush(id).catch(() => {})
          buffers.delete(id)
          bufferOf(session)
        }
        const fresh = buffers.get(id)
        if (fresh) {
          fresh.user = text
          fresh.turn = typeof event?.data?.turn === 'number' ? event.data.turn : fresh.turn
        }
        schedule(id)
        return
      }

      if (type === 'assistant/message') {
        const text = eventText(event)
        if (text !== '' && buffer.assistant.length < MAX_ASSISTANT_PARTS) buffer.assistant.push(text)
        if (typeof event?.data?.turn === 'number') buffer.turn = event.data.turn
        schedule(id)
        return
      }

      buffer.tools += 1
      schedule(id)
    }),
  )

  return [
    ...disposers,
    () => {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      for (const id of [...buffers.keys()]) flush(id, { force: true }).catch(() => {})
    },
  ]
}
