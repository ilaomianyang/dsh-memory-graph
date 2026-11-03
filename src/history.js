/**
 * History: read the sessions that ran before this plugin existed.
 *
 * Capture only sees turns that arrive while the host is running, so a vault
 * installed today starts empty and the person's past is not in it. The harness
 * keeps every closed session on disk as `session.v4.jsonl.zstd`; this module
 * replays those files through the same turn assembler the live listener uses, so
 * a backfilled episode and a captured one are the same kind of record.
 *
 * Two things make it safe to run twice:
 *   - a turn is identified by `(session, turn)`, and turns already in the vault
 *     are skipped, so re-running after a session grew imports only the new part;
 *   - the timestamps come from the session file, not from now, so history lands
 *     in the right place on the timeline instead of piling up under today.
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { Decompress } from 'fzstd'

import { createTurnAssembler, projectOf } from './turns.js'

const SESSION_FILE = 'session.v4.jsonl.zstd'
/** zstd in, JSON out: a cap so one enormous session cannot pin the process. */
export const DEFAULT_MAX_BYTES = 512 * 1024 * 1024
/** No single event is this large; a longer line means the stream is corrupt. */
const MAX_LINE = 4 * 1024 * 1024

/**
 * A session file is not one zstd frame: the writer appends one frame per batch,
 * so the file is a *concatenated container*. Both decoders that matter — Node's
 * and fzstd's — stop at a frame boundary, which is why the raw walk of these
 * files used to yield a single header line and nothing else.
 *
 * Node grew a zstd codec in 22.15 / 23.8 and decodes frames with full fidelity;
 * the pure-JS fallback below refuses some high-accuracy FSE tables that real
 * session files here do contain ("FSE accuracy too high"). A plugin cannot choose
 * the runtime it lands in, so both paths exist and the report names the one that
 * ran.
 */
const ZSTD_MAGIC = 0xfd2fb528
const hasNativeZstd = typeof zlib.zstdDecompressSync === 'function'
export const decoderKind = hasNativeZstd ? 'node-zstd' : 'fzstd'

export function defaultSessionsDir() {
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home.trim() !== '') return path.join(home.trim(), 'sessions')
  return path.join(os.homedir(), '.dsh', 'sessions')
}

/** The profile's session store: every closed session, newest modified first. */
export async function listSessions(dir) {
  const out = []
  let groups = []
  try {
    groups = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const group of groups) {
    if (!group.isDirectory()) continue
    const groupDir = path.join(dir, group.name)
    let entries = []
    try {
      entries = await fsp.readdir(groupDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const file = path.join(groupDir, entry.name, SESSION_FILE)
      try {
        const stat = await fsp.stat(file)
        if (!stat.isFile()) continue
        out.push({ file, size: stat.size, mtimeMs: stat.mtimeMs, group: group.name, dirName: entry.name })
      } catch {
        // A session directory without a log: the turn never produced anything.
      }
    }
  }
  // Newest first: with a limit, the recent past is what a person wants back.
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out
}

/**
 * Cut the inflated byte stream into lines, with a ceiling on how much of one
 * session is read at all.
 *
 * A session log is tens of megabytes compressed and hundreds as text, and a
 * backfill walks a hundred of them: nothing here holds the whole plaintext.
 */
function lineCutter(onLine, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  let inflated = 0
  let pending = ''
  let stopped = false
  let partial = false
  return {
    push(chunk) {
      if (stopped || chunk.length === 0) return
      inflated += chunk.length
      pending += chunk.toString('utf8')
      let cut = pending.indexOf('\n')
      while (cut !== -1) {
        const line = pending.slice(0, cut)
        pending = pending.slice(cut + 1)
        if (line.trim() !== '') onLine(line)
        cut = pending.indexOf('\n')
      }
      if (pending.length > MAX_LINE || inflated > maxBytes) {
        stopped = true
        pending = ''
      }
    },
    end() {
      if (!stopped && pending.trim() !== '') onLine(pending)
      pending = ''
    },
    /** The caller stopped early — a byte ceiling, not a corrupt file. */
    markPartial() {
      partial = true
    },
    get stopped() {
      return stopped
    },
    get truncated() {
      return stopped || partial
    },
    get inflated() {
      return inflated
    },
  }
}

/**
 * Frame boundaries, without decompressing: a correctness port of the scanner the
 * harness itself uses for these files (zstd frame header, then 3-byte block
 * headers, then an optional 4-byte checksum). A partial trailing frame is the
 * normal state of a session that is still being written; its start is returned
 * so the caller can ignore it rather than call it corruption.
 */
export function scanFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    const torn = () => ({ frames, tornStart: start })
    if (buffer.length - offset < 4) return torn()
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) return torn()
    offset += 4
    if (offset === buffer.length) return torn()

    const descriptor = buffer.readUInt8(offset)
    offset += 1
    // Reserved bits, or a window with no content size where one is required:
    // reason enough to stop trusting the rest of the file.
    if ((descriptor & 0b00011000) !== 0) return torn()
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0b00100000) !== 0
    const checksumFlag = (descriptor & 0b00000100) !== 0
    const dictionaryFlag = descriptor & 0b11
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return torn()
    offset += remainingHeaderBytes

    for (;;) {
      if (buffer.length - offset < 3) return torn()
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0b11
      const blockSize = blockHeader >>> 3
      if (blockType === 3) return torn() // reserved block type
      const payloadBytes = blockType === 1 ? 1 : blockSize // RLE blocks carry one byte
      if (buffer.length - offset < payloadBytes) return torn()
      offset += payloadBytes
      if (lastBlock) break
    }

    if (checksumFlag) {
      if (buffer.length - offset < 4) return torn()
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

async function readBytes(file, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const handle = await fsp.open(file, 'r')
  try {
    const { size } = await handle.stat()
    const want = Math.max(0, Math.min(size, maxBytes))
    const buffer = Buffer.allocUnsafe(want)
    let read = 0
    while (read < want) {
      const { bytesRead } = await handle.read(buffer, read, want - read, read)
      if (bytesRead === 0) break
      read += bytesRead
    }
    return { buffer: buffer.subarray(0, read), size, partial: want < size }
  } finally {
    await handle.close()
  }
}

/** The reference decoder: every frame zstd can produce, one frame at a time. */
async function readLinesNative(file, onLine, options) {
  const cutter = lineCutter(onLine, options)
  const { buffer, partial } = await readBytes(file, options)
  if (partial) cutter.markPartial()

  let torn = false
  let failed = 0
  for (const { start, end } of scanFrames(buffer).frames) {
    let plain
    try {
      plain = zlib.zstdDecompressSync(buffer.subarray(start, end))
    } catch {
      // One frame the codec refuses (a truncated append after a crash) should
      // cost that batch, not the session.
      failed += 1
      continue
    }
    cutter.push(plain)
    if (cutter.stopped) break
  }
  torn = failed > 0
  cutter.end()
  if (torn && cutter.inflated === 0) throw new Error('这个会话文件里没有可解码的 zstd 帧')
  return cutter
}

/** The fallback for a Node without a zstd codec: pure JS, most frames. */
async function readLinesFallback(file, onLine, options) {
  const cutter = lineCutter(onLine, options)
  const decoder = new Decompress((chunk) => cutter.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)))
  const { buffer, partial } = await readBytes(file, options)
  if (partial) cutter.markPartial()
  decoder.push(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength), true)
  cutter.end()
  return cutter
}

async function readLines(file, onLine, options) {
  return hasNativeZstd ? readLinesNative(file, onLine, options) : readLinesFallback(file, onLine, options)
}

/** Every `(session, turn)` the vault already has, so a re-run imports nothing twice. */
export async function existingTurns(vault) {
  const seen = new Set()
  let files = []
  try {
    files = typeof vault.episodeFiles === 'function' ? await vault.episodeFiles() : []
  } catch {
    return seen
  }
  const dir = vault.paths?.episodes
  if (typeof dir !== 'string') return seen
  for (const name of files) {
    let text = ''
    try {
      text = await fsp.readFile(path.join(dir, name), 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        const record = JSON.parse(line)
        if (typeof record?.session === 'string') seen.add(`${record.session}#${record.turn ?? ''}`)
      } catch {
        // A half-written last line from a crash; the next run sees it whole.
      }
    }
  }
  return seen
}

/**
 * One replayed session, fed a line at a time.
 *
 * Kept separate from the file reading so the filter, the dedupe and the
 * timestamps can be tested on hand-written events — the part that matters is the
 * policy, not the decompressor.
 */
export function createReplay({ sessionId = '', project = '', cfg, redactor, seen }) {
  const assembler = createTurnAssembler({ cfg, redactor })
  const episodes = []
  let id = sessionId
  let cwd = ''
  let closedTurns = 0
  let duplicates = 0
  let malformed = 0

  const keep = (episode) => {
    const key = `${episode.session}#${episode.turn ?? ''}`
    if (seen.has(key)) {
      duplicates += 1
      return
    }
    seen.add(key)
    episodes.push(episode)
  }

  return {
    feed(line) {
      let event
      try {
        event = JSON.parse(line)
      } catch {
        malformed += 1
        return
      }
      if (event?.type === 'session') {
        if (typeof event.id === 'string' && event.id !== '') id = event.id
        if (typeof event.cwd === 'string') cwd = event.cwd
        return
      }
      if (event?.type === 'turn/end') closedTurns += 1
      for (const episode of assembler.push({
        sessionId: id,
        project: projectOf({ cwd }, cfg.defaultProject),
        event,
      })) {
        keep(episode)
      }
    },

    /** A session whose last turn never closed still holds a real message. */
    finish() {
      for (const episode of assembler.flushAll()) keep(episode)
      return {
        id,
        project: projectOf({ cwd }, cfg.defaultProject),
        cwd,
        closedTurns,
        episodes,
        duplicates,
        malformed,
      }
    },
  }
}

/** Replay one session file, then write what the vault does not have. */
export async function importSession({ entry, cfg, vault, redactor, seen, dryRun = false, maxBytes, collect = null }) {
  const replay = createReplay({ sessionId: entry.dirName, cfg, redactor, seen })
  let failure = null
  let inflated = 0
  let truncated = false
  try {
    const cutter = await readLines(entry.file, (line) => replay.feed(line), { maxBytes })
    inflated = cutter.inflated
    truncated = cutter.truncated
  } catch (error) {
    // One unreadable file must not end a backfill that has hundreds of others:
    // the report says which one failed and the run carries on.
    failure = error?.message ?? String(error)
  }

  const report = replay.finish()

  if (Array.isArray(collect)) collect.push(...report.episodes)
  if (!dryRun) {
    for (const episode of report.episodes) await vault.appendEpisode(episode)
  }

  return {
    ...report,
    episodes: report.episodes.length,
    truncated,
    failure,
    inflated,
    file: entry.file,
    size: entry.size,
  }
}

/**
 * Walk the store, newest session first, and import what the vault does not have.
 *
 * Returns a report rather than logging: the tool formats it, the tests assert on
 * it, and a person reads the same numbers.
 */
export async function runBackfill({
  cfg,
  vault,
  redactor,
  dir = defaultSessionsDir(),
  limit = 0,
  dryRun = false,
  maxBytes = DEFAULT_MAX_BYTES,
  onProgress = null,
  collect = null,
}) {
  const started = Date.now()
  const seen = await existingTurns(vault)
  const all = await listSessions(dir)
  const selected = limit > 0 ? all.slice(0, limit) : all

  const sessions = []
  let imported = 0
  let duplicates = 0
  let budget = maxBytes
  let exhausted = false

  for (const entry of selected) {
    if (budget <= 0) {
      exhausted = true
      break
    }
    const report = await importSession({ entry, cfg, vault, redactor, seen, dryRun, maxBytes: budget, collect })
    budget -= entry.size
    imported += report.episodes
    duplicates += report.duplicates
    sessions.push(report)
    onProgress?.(report)
  }

  // Views last, and only when something changed: `README.md` and `graph.html` are
  // rendered from the cards, so an import that adds episodes but no cards changes
  // nothing on either. The *reason* to do it here is that a backfill is the one
  // operation that can add hundreds of episodes after the last render, and a stale
  // view is indistinguishable from an empty vault when a person opens the file.
  let refreshed = false
  const previous = { readme: true, graph: true }
  if (!dryRun && imported > 0) {
    for (const [key, render] of [
      ['readme', vault.regenerateReadme],
      ['graph', vault.regenerateGraph],
    ]) {
      if (typeof render !== 'function') {
        previous[key] = false
        continue
      }
      try {
        await render.call(vault)
      } catch {
        // A view that will not render must not lose the episodes that just landed.
        previous[key] = false
      }
    }
    refreshed = Object.values(previous).some(Boolean)
  }

  return {
    dir,
    dryRun,
    decoder: decoderKind,
    found: all.length,
    scanned: sessions.length,
    imported,
    duplicates,
    exhausted,
    refreshed,
    malformed: sessions.reduce((n, s) => n + s.malformed, 0),
    failed: sessions.filter((s) => s.failure !== null).length,
    ms: Date.now() - started,
    sessions: sessions
      .filter((s) => s.episodes > 0 || s.duplicates > 0 || s.closedTurns > 0 || s.failure !== null)
      .sort((a, b) => b.episodes - a.episodes),
  }
}
