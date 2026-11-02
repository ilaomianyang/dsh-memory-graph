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
  const buffers = new Map()
  const disposers = []
  const timers = new Map()

  // Both the switch and the skip list are editable while the plugin runs (they
  // are `.volatile()` in the schema), so neither is baked in here: the switch is
  // read per event, and the compiled rules are rebuilt only when the list's text
  // actually changes — a `new RegExp` on every token would be pure waste.
  let skipKey
  let skipRules = []

  function compiledSkipRules() {
    const list = cfg.capture.skipPatterns ?? []
    const key = list.join('\u0000')
    if (key !== skipKey) {
      skipKey = key
      skipRules = list.flatMap((pattern) => {
        try {
          return [new RegExp(pattern, 'i')]
        } catch {
          return []
        }
      })
    }
    return skipRules
  }

  /** True when the "user" side is really a harness injection, not a person typing. */
  const injected = (text) => text !== '' && compiledSkipRules().some((re) => re.test(text))

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

  function drop(id) {
    buffers.delete(id)
    const timer = timers.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.delete(id)
    }
  }

  async function flush(id) {
    const buffer = buffers.get(id)
    if (!buffer) return
    const toolCount = buffer.tools
    const user = truncate(buffer.user, cfg.capture.userChars)
    const assistant = truncate(buffer.assistant.join('\n'), cfg.capture.assistantChars)

    // Every episode is anchored to something the user actually said. A turn with
    // no user side is context noise, and one too short to mean anything — such as
    // "ok" — would only fill the vault with lines the extractor cannot use.
    if (user === '' || user.length + assistant.length < cfg.capture.minChars) {
      drop(id)
      return
    }

    drop(id)

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
      // The switch is read here, not at registration: turning capture off in
      // 设置 must stop writes immediately without unregistering the listener.
      if (!cfg.capture.enabled) return

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

      if (type === 'user/message') {
        const text = eventText(event)
        // The harness delivers runtime snapshots, skill catalogs, sampled time,
        // approval notices and compaction checkpoints through the same channel as
        // the person typing. `source.kind` tells them apart; older logs carry no
        // provenance, so fall back to the text patterns. Only what the user
        // actually said opens a memory episode.
        const kind = event?.data?.source?.kind
        const synthetic = typeof kind === 'string' ? kind !== 'user' : injected(text)
        if (synthetic || text === '') return

        const id = idOf(session)
        const open = buffers.get(id)
        if (open && (open.user !== '' || open.assistant.length > 0)) {
          // A turn that never closed (interrupted, or an older harness): keep it.
          flush(id).catch(() => {})
        }

        const { buffer } = bufferOf(session)
        buffer.user = text
        if (typeof event?.data?.turn === 'number') buffer.turn = event.data.turn
        schedule(id)
        return
      }

      const { id, buffer } = bufferOf(session)

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
      for (const id of [...buffers.keys()]) flush(id).catch(() => {})
    },
  ]
}
