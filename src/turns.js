/**
 * Turn assembly: live events and a replayed session file go through one reducer.
 *
 * Two things must never be implemented twice. First, what counts as a message a
 * person actually typed — the harness pushes runtime snapshots, skill catalogs,
 * sampled time and compaction checkpoints down the same channel, sometimes
 * tagged `user`. Second, the truncation and redaction applied before anything
 * touches disk. If the live listener and the history importer had separate
 * copies of either, they would drift and the drift would be silent: a leaked
 * snapshot on one side, a lost message on the other.
 *
 * So the filter lives here. The callers only decide *when* a turn is closed and
 * *what timestamp* its episode carries.
 */
import { nowIso } from './vault.js'

/** Assistant text is context, not the record; a handful of parts is plenty. */
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

export function eventText(event) {
  const parts = collectText(event?.data)
  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

export function truncate(text, max) {
  const value = String(text ?? '').trim()
  if (value.length <= max) return value
  return `${value.slice(0, max)}…`
}

/**
 * Delimited harness blocks come off before any pattern is consulted.
 *
 * They are the one kind of injection whose extent is knowable, so removing them
 * keeps the person's own words when a real message happens to carry one — the
 * alternative (dropping the whole message) loses the part that was worth
 * keeping. Undelimited blocks (a runtime snapshot) are handled by the patterns.
 */
export function stripInjectedBlocks(text) {
  return String(text ?? '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** The project a session belongs to: the last segment of the cwd it started in. */
export function projectOf(session, fallback) {
  const cwd = session?.header?.cwd ?? session?.meta?.cwd ?? session?.cwd
  if (typeof cwd === 'string' && cwd.trim() !== '') {
    // Both separators, whatever platform this is running on: the path comes from
    // the session header, which may well have been written on the other OS.
    const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/)
    const base = parts[parts.length - 1] ?? ''
    if (base !== '') return base
  }
  return fallback
}

/** The same shape as vault's nowIso(), for an arbitrary instant. */
export function isoAt(ms) {
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  const offset = -d.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

/**
 * Feed it events in order; it hands back finished episodes.
 *
 * `push()` returns an array because one event can close two turns: a user
 * message that arrives while the previous turn never closed flushes that one
 * first, then opens the next.
 */
export function createTurnAssembler({ cfg, redactor }) {
  const buffers = new Map()

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

  function openBuffer(sessionId, project) {
    let buffer = buffers.get(sessionId)
    if (!buffer) {
      buffer = {
        project: project ?? cfg.defaultProject,
        user: '',
        assistant: [],
        tools: 0,
        turn: null,
        at: null,
      }
      buffers.set(sessionId, buffer)
    }
    return buffer
  }

  function finish(sessionId, at) {
    const buffer = buffers.get(sessionId)
    if (!buffer) return null
    buffers.delete(sessionId)

    const toolCount = buffer.tools
    const user = truncate(buffer.user, cfg.capture.userChars)
    const assistant = truncate(buffer.assistant.join('\n'), cfg.capture.assistantChars)

    // Every episode is anchored to something the user actually said. A turn with
    // no user side is context noise, and one too short to mean anything — such as
    // "ok" — would only fill the vault with lines the extractor cannot use.
    if (user === '' || user.length + assistant.length < cfg.capture.minChars) return null

    // The turn's own clock when the log carries one (a replayed session, or a
    // turn flushed a minute late), otherwise now: the timeline should say when
    // it happened, not when it was written down.
    const stamp = at ?? buffer.at
    const when = typeof stamp === 'string' ? stamp : stamp === null || stamp === undefined ? nowIso() : isoAt(stamp)

    return {
      t: when,
      project: buffer.project,
      session: sessionId,
      turn: buffer.turn,
      user: redactor.redact(user).text,
      assistant: redactor.redact(assistant).text,
      ...(cfg.capture.includeToolOutput && toolCount > 0 ? { tools: toolCount } : {}),
    }
  }

  return {
    /**
     * @param {{sessionId: string, project?: string, event: object}} input
     * @returns {object[]} episodes that are finished and ready to append
     */
    push({ sessionId, project, event }) {
      if (!cfg.capture.enabled) return []
      const type = event?.type
      const at = Number.isFinite(event?.time) ? event.time : null
      const done = []

      if (type === 'turn/end') {
        const buffer = buffers.get(sessionId)
        if (!buffer) return done
        if (typeof event?.data?.turn === 'number') buffer.turn = event.data.turn
        const episode = finish(sessionId, at)
        if (episode) done.push(episode)
        return done
      }

      if (type !== 'user/message' && type !== 'assistant/message' && type !== 'tool/result') return done

      if (type === 'user/message') {
        // The harness delivers runtime snapshots, skill catalogs, sampled time,
        // approval notices and compaction checkpoints through the same channel as
        // the person typing — and not always with a telling `source.kind`: a real
        // runtime snapshot has arrived here tagged `user` (it was captured as if
        // the person had typed it). So provenance can only *add* a skip, never
        // veto the patterns; both are consulted, and delimited blocks come off
        // first so a message that merely carried a reminder keeps its own words.
        const kind = event?.data?.source?.kind
        const text = stripInjectedBlocks(eventText(event))
        const synthetic = (typeof kind === 'string' && kind !== 'user') || text === '' || injected(text)
        if (synthetic) return done

        const open = buffers.get(sessionId)
        if (open && (open.user !== '' || open.assistant.length > 0)) {
          // A turn that never closed (interrupted, or an older harness): keep it.
          const episode = finish(sessionId, at)
          if (episode) done.push(episode)
        }

        const buffer = openBuffer(sessionId, project)
        buffer.user = text
        buffer.turn = typeof event?.data?.turn === 'number' ? event.data.turn : buffer.turn
        if (at !== null) buffer.at = at
        return done
      }

      const buffer = openBuffer(sessionId, project)
      if (at !== null) buffer.at = at

      if (type === 'assistant/message') {
        const text = eventText(event)
        if (text !== '' && buffer.assistant.length < MAX_ASSISTANT_PARTS) buffer.assistant.push(text)
        if (typeof event?.data?.turn === 'number') buffer.turn = event.data.turn
        return done
      }

      buffer.tools += 1
      return done
    },

    /** Close one session's open turn. Returns the episode, or null if it was noise. */
    flush(sessionId, at) {
      return finish(sessionId, at ?? undefined)
    },

    /** Close every open turn (shutdown, or the end of a replayed file). */
    flushAll(at) {
      const out = []
      for (const sessionId of [...buffers.keys()]) {
        const episode = finish(sessionId, at ?? undefined)
        if (episode) out.push(episode)
      }
      return out
    },

    /** True when this session has an open turn — a hint for the timer bookkeeping. */
    isOpen(sessionId) {
      return buffers.has(sessionId)
    },

    forget(sessionId) {
      buffers.delete(sessionId)
    },
  }
}
