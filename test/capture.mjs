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
  data: { role: 'user', content: [{ type: 'text', text: '把 vault 改成纯文本，顺便 key 是 sk-abcdefghijklmnopqrstuvwxyz012345' }] },
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
