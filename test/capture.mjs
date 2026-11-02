/**
 * Capture test: drives the session/event listener with the real event shapes
 * and checks what lands in the vault.   node test/capture.mjs
 */
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { resolveConfig } from '../src/config.js'
import { createRedactor } from '../src/privacy.js'
import { createVault } from '../src/vault.js'
import { registerCapture } from '../src/capture.js'

const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-cap-'))
const cfg = resolveConfig({ vaultDir: dir })
const redactor = createRedactor(cfg.privacy)
const vault = createVault(cfg, redactor)

/** Minimal stand-in for the Cordis context. */
const handlers = new Map()
const ctx = {
  on(name, fn) {
    if (!handlers.has(name)) handlers.set(name, [])
    handlers.get(name).push(fn)
    return () => {
      const list = handlers.get(name) ?? []
      const at = list.indexOf(fn)
      if (at !== -1) list.splice(at, 1)
    }
  },
  logger: { info() {}, warn() {} },
}

function emit(name, ...args) {
  for (const fn of handlers.get(name) ?? []) fn(...args)
}

const results = []
function check(name, fn) {
  try {
    fn()
    results.push(`  ok   ${name}`)
  } catch (error) {
    results.push(`  FAIL ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

const dispose = registerCapture(ctx, { cfg, vault, redactor })
const session = { id: 's-abc', header: { cwd: 'G:\\TempProject\\测试\\memory-graph-plugin' } }

/* A turn exactly as the harness records it. */
emit('session/event', session, {
  type: 'user/message',
  seq: 1,
  time: Date.now(),
  data: {
    role: 'user',
    content: [{ type: 'text', text: '把 vault 改成纯文本，顺便 key 是 sk-abcdefghijklmnopqrstuvwxyz012345' }],
    source: { kind: 'user', rpcId: 'r-1', clientTimeZone: 'Asia/Shanghai' },
  },
})
emit('session/event', session, {
  type: 'assistant/message',
  seq: 2,
  time: Date.now(),
  data: {
    turn: 7,
    step: 1,
    message: { role: 'assistant', content: [{ type: 'text', text: '改成纯文本了，因为没有二进制合并问题。' }] },
    stream: null,
  },
})
emit('session/event', session, { type: 'tool/result', seq: 3, time: Date.now(), data: { turn: 7, step: 1, message: {} } })
emit('session/event', session, { type: 'turn/end', seq: 4, time: Date.now(), data: { turn: 7, reason: { kind: 'completed' } } })

await new Promise((resolve) => setTimeout(resolve, 60))

const files = await vault.episodeFiles()
check('a closed turn becomes one episode file', () => {
  assert.equal(files.length, 1, files.join(','))
})

const raw = await fsp.readFile(path.join(dir, 'episodes', files[0]), 'utf8')
const lines = raw.split('\n').filter((line) => line.trim() !== '')
check('one line per turn', () => {
  assert.equal(lines.length, 1, raw)
})

const record = JSON.parse(lines[0])
check('the episode carries project, turn and both sides', () => {
  assert.equal(record.project, 'memory-graph-plugin')
  assert.equal(record.turn, 7)
  assert.ok(record.user.includes('纯文本'), record.user)
  assert.ok(record.assistant.includes('二进制合并'), record.assistant)
})
check('a secret in the user text never reaches the file', () => {
  assert.equal(raw.includes('sk-abcdefghij'), false, raw)
  assert.ok(record.user.includes('[REDACTED]'), record.user)
})

/* A second turn, flushed by the next user message rather than turn/end. */
emit('session/event', session, {
  type: 'user/message',
  seq: 5,
  time: Date.now(),
  data: { role: 'user', content: [{ type: 'text', text: '第二个问题：实体页要不要自动合并别名？' }] },
})
emit('session/event', session, {
  type: 'assistant/message',
  seq: 6,
  time: Date.now(),
  data: { turn: 8, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '先按 slug 归一化，别名靠人工。' }] }, stream: null },
})
emit('session/event', session, { type: 'turn/end', seq: 7, time: Date.now(), data: { turn: 8, reason: { kind: 'completed' } } })
await new Promise((resolve) => setTimeout(resolve, 60))

const after = (await fsp.readFile(path.join(dir, 'episodes', files[0]), 'utf8')).split('\n').filter((l) => l.trim() !== '')
check('the second turn appends instead of rewriting', () => {
  assert.equal(after.length, 2, String(after.length))
  assert.ok(after[1].includes('实体页'), after[1])
})

/* Trivial turns are dropped, so the vault does not fill with noise. */
emit('session/event', session, {
  type: 'user/message',
  seq: 8,
  time: Date.now(),
  data: { role: 'user', content: [{ type: 'text', text: 'ok' }] },
})
emit('session/event', session, { type: 'turn/end', seq: 9, time: Date.now(), data: { turn: 9, reason: { kind: 'completed' } } })
await new Promise((resolve) => setTimeout(resolve, 60))

const finalLines = (await fsp.readFile(path.join(dir, 'episodes', files[0]), 'utf8')).split('\n').filter((l) => l.trim() !== '')
check('a one-word turn is not stored', () => {
  assert.equal(finalLines.length, 2, String(finalLines.length))
})

/* An unknown session with no cwd still gets a sensible project tag. */
emit('session/event', { id: 's-nocwd' }, {
  type: 'user/message',
  seq: 1,
  time: Date.now(),
  data: { role: 'user', content: [{ type: 'text', text: '这个会话没有工作目录，也应该能记下来。' }] },
})
emit('session/event', { id: 's-nocwd' }, { type: 'turn/end', seq: 2, time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } })
await new Promise((resolve) => setTimeout(resolve, 60))

const allLines = (await fsp.readFile(path.join(dir, 'episodes', files[0]), 'utf8')).split('\n').filter((l) => l.trim() !== '')
check('a session without cwd falls back to the default project', () => {
  assert.equal(allLines.length, 3, String(allLines.length))
  assert.equal(JSON.parse(allLines[2]).project, cfg.defaultProject)
})

/* Injected context — a compaction checkpoint, a runtime snapshot, a time
   prelude, a skill catalog, an approval notice — arrives as a user message but
   is not a conversation. `source.kind` marks it; the last entry has no
   provenance at all, to exercise the text-pattern fallback. */
const injections = [
  { source: { kind: 'compact-checkpoint', form: 'checkpoint' }, text: 'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background.' },
  { source: { kind: 'runtime-context', form: 'snapshot' }, text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.' },
  { source: { kind: 'time-context', form: 'sampled' }, text: 'Time sampled while preparing turn 3, step 1: 2026-11-02T15:37:18+08:00[Asia/Shanghai]' },
  { source: { kind: 'skill-catalog', form: 'catalog' }, text: '<system-reminder>\nThe available skill catalog changed. This complete catalog replaces every earlier available-skills list in this session.\n</system-reminder>' },
  { source: { kind: 'user-approval' }, text: 'The approval policy changed from "ask" to "never" (changed by the user).' },
  { text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.' },
]
for (const [i, { source, text }] of injections.entries()) {
  emit('session/event', session, {
    type: 'user/message',
    seq: 20 + i,
    time: Date.now(),
    data: { role: 'user', content: [{ type: 'text', text }], ...(source ? { source } : {}) },
  })
  emit('session/event', session, {
    type: 'assistant/message',
    seq: 40 + i,
    time: Date.now(),
    data: { turn: 20 + i, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '收到，继续原来的工作。' }] }, stream: null },
  })
  emit('session/event', session, { type: 'turn/end', seq: 60 + i, time: Date.now(), data: { turn: 20 + i, reason: { kind: 'completed' } } })
}
await new Promise((resolve) => setTimeout(resolve, 60))

const readLines = async () =>
  (await fsp.readFile(path.join(dir, 'episodes', files[0]), 'utf8')).split('\n').filter((l) => l.trim() !== '')

const afterInjections = await readLines()
check('injected context is never stored as a memory', () => {
  assert.equal(afterInjections.length, 3, String(afterInjections.length))
  assert.equal(afterInjections.some((l) => l.includes('automatically generated checkpoint')), false)
  assert.equal(afterInjections.some((l) => l.includes('system-reminder')), false)
  assert.equal(afterInjections.some((l) => l.includes('Time sampled')), false)
  assert.equal(afterInjections.some((l) => l.includes('approval policy')), false)
})

/* The filter must not swallow the real turn that follows an injection. */
emit('session/event', session, {
  type: 'user/message',
  seq: 80,
  time: Date.now(),
  data: { role: 'user', content: [{ type: 'text', text: '压缩之后继续：请检查一下 capture 的 flush 时机。' }], source: { kind: 'user', rpcId: 'r-2' } },
})
emit('session/event', session, {
  type: 'assistant/message',
  seq: 81,
  time: Date.now(),
  data: { turn: 30, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'flush 现在挂在 turn/end 上。' }] }, stream: null },
})
emit('session/event', session, { type: 'turn/end', seq: 82, time: Date.now(), data: { turn: 30, reason: { kind: 'completed' } } })
await new Promise((resolve) => setTimeout(resolve, 60))

const afterReal = await readLines()
check('a real turn after an injection is still stored', () => {
  assert.equal(afterReal.length, 4, String(afterReal.length))
  assert.ok(afterReal[3].includes('flush'), afterReal[3])
})

check('an injected turn is dropped even when the model replied to it', () => {
  assert.equal(afterReal.some((l) => l.includes('收到，继续原来的工作')), false, afterReal.join('\n'))
})

check('disposing removes the listeners', () => {
  for (const item of dispose) item()
  assert.equal((handlers.get('session/event') ?? []).length, 0)
})

console.log(results.join('\n'))
if (process.exitCode) {
  console.log('\nSOME CHECKS FAILED')
} else {
  console.log(`\nall ${results.length} checks passed`)
  await fsp.rm(dir, { recursive: true, force: true })
}
