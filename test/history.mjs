/**
 * History test: replay a session file the way the store actually laid it out,
 * and check what reaches the vault.   node test/history.mjs
 *
 * The fixture `test/fixtures/session.v4.jsonl.zstd` is a real zstd frame holding
 * real event shapes, so the decompression path is exercised rather than mocked.
 * It was produced once with:
 *
 *   node -e "… zlib.zstdCompressSync(JSON.stringify(events).split…)"   (node >= 22.15)
 *
 * and holds three turns: one real, one that is only a runtime snapshot, and one
 * with a `<system-reminder>` wrapped around the person's own words.
 */
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveConfig } from '../src/config.js'
import { createRedactor } from '../src/privacy.js'
import { createVault } from '../src/vault.js'
import { isoAt } from '../src/turns.js'
import { createReplay, importSession, listSessions, runBackfill } from '../src/history.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = path.join(here, 'fixtures', 'session.v4.jsonl.zstd')

const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-hist-'))
const cfg = resolveConfig({ vaultDir: dir })
const redactor = createRedactor(cfg.privacy)
const vault = createVault(cfg, redactor)

/** An empty store laid out exactly like ~/.dsh/sessions. */
async function makeStore(name = 'store') {
  const root = path.join(dir, name)
  return root
}

async function plant(root, { group = '--G-TempProject-Test--', id = 'session-history-fixture', file = fixture, mtime } = {}) {
  const target = path.join(root, group, id)
  await fsp.mkdir(target, { recursive: true })
  const copy = path.join(target, 'session.v4.jsonl.zstd')
  await fsp.copyFile(file, copy)
  if (mtime) await fsp.utimes(copy, mtime, mtime)
  return copy
}

const results = []
async function check(name, fn) {
  try {
    await fn()
    results.push(`  ok   ${name}`)
  } catch (error) {
    results.push(`  FAIL ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

/* ------------------------------------------------------------------ store */

const store = await makeStore()
await plant(store)
await plant(store, { group: '--G-Article2--', id: 'session-older', mtime: new Date(Date.now() - 86_400_000) })

await check('the store is walked two levels deep, newest directory first', async () => {
  const found = await listSessions(store)
  assert.equal(found.length, 2, `expected 2 sessions, got ${found.length}`)
  assert.equal(found[0].dirName, 'session-history-fixture')
  assert.equal(found[1].dirName, 'session-older')
  assert.ok(found[0].size > 0)
})

await check('a missing directory reports nothing instead of throwing', async () => {
  const found = await listSessions(path.join(dir, 'nope'))
  assert.deepEqual(found, [])
})

/* ----------------------------------------------------------------- replay */

await check('a real turn is replayed, a runtime snapshot is not', () => {
  const seen = new Set()
  const replay = createReplay({ cfg, redactor, seen })
  replay.feed(JSON.stringify({ type: 'session', id: 'session-x', cwd: 'C:\\TempProject\\历史项目' }))
  replay.feed(
    JSON.stringify({
      type: 'user/message',
      time: 1793170060000,
      data: { content: [{ type: 'text', text: '我们决定把记忆存成纯文本 vault，每一轮对话追加一条情节。' }], source: { kind: 'user' } },
    }),
  )
  replay.feed(JSON.stringify({ type: 'turn/end', time: 1793170090000, data: { turn: 1 } }))
  replay.feed(
    JSON.stringify({
      type: 'user/message',
      time: 1793170100000,
      data: {
        content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier snapshots.' }],
        source: { kind: 'user' },
      },
    }),
  )
  replay.feed(JSON.stringify({ type: 'assistant/message', time: 1793170110000, data: { content: [{ type: 'text', text: '收到。' }] } }))
  replay.feed(JSON.stringify({ type: 'turn/end', time: 1793170120000, data: { turn: 2 } }))
  const report = replay.finish()

  assert.equal(report.episodes.length, 1, 'only the turn a person typed should survive')
  assert.equal(report.episodes[0].turn, 1)
  assert.ok(report.episodes[0].user.includes('纯文本 vault'))
  assert.equal(report.closedTurns, 2)
})

await check('a reminder inside a real message is stripped, not the message', () => {
  const replay = createReplay({ cfg, redactor, seen: new Set() })
  replay.feed(
    JSON.stringify({
      type: 'user/message',
      time: 1793170060000,
      data: {
        content: [{ type: 'text', text: '<system-reminder>sampled time</system-reminder>把记忆图谱的面板改成中文。' }],
        source: { kind: 'user' },
      },
    }),
  )
  replay.feed(JSON.stringify({ type: 'turn/end', time: 1793170090000, data: { turn: 3 } }))
  const [episode] = replay.finish().episodes
  assert.ok(episode, 'the message should survive')
  assert.ok(!episode.user.includes('system-reminder'), 'the reminder must be gone')
  assert.equal(episode.user, '把记忆图谱的面板改成中文。')
})

await check('the timestamp is the turn’s own, not the day of the import', () => {
  const replay = createReplay({ cfg, redactor, seen: new Set() })
  replay.feed(
    JSON.stringify({
      type: 'user/message',
      time: 1793170060000,
      data: { content: [{ type: 'text', text: '这段历史发生在上个月，应该落在上个月的时间轴上。' }], source: { kind: 'user' } },
    }),
  )
  replay.feed(JSON.stringify({ type: 'turn/end', time: 1793170090000, data: { turn: 1 } }))
  const [episode] = replay.finish().episodes
  assert.equal(episode.t, isoAt(1793170090000))
  assert.ok(episode.t.startsWith('2026-'), `expected a 2026 date, got ${episode.t}`)
})

await check('a secret in replayed text is redacted before it is stored', () => {
  const replay = createReplay({ cfg, redactor, seen: new Set() })
  replay.feed(
    JSON.stringify({
      type: 'user/message',
      time: 1793170060000,
      data: {
        content: [{ type: 'text', text: '出问题就写信给 someone@example.com，别贴密钥 sk-live-abcdefghijklmnopqrstuvwx。' }],
        source: { kind: 'user' },
      },
    }),
  )
  replay.feed(JSON.stringify({ type: 'turn/end', time: 1793170090000, data: { turn: 1 } }))
  const [episode] = replay.finish().episodes
  assert.ok(!episode.user.includes('someone@example.com'), `email leaked: ${episode.user}`)
  assert.ok(!episode.user.includes('sk-live-abcdefghijklmnopqrstuvwx'), `secret leaked: ${episode.user}`)
})

await check('a corrupt line is counted, not thrown', () => {
  const replay = createReplay({ cfg, redactor, seen: new Set() })
  replay.feed('{not json')
  replay.feed(JSON.stringify({ type: 'turn/end', time: 1793170090000, data: { turn: 1 } }))
  const report = replay.finish()
  assert.equal(report.malformed, 1)
  assert.equal(report.episodes.length, 0)
})

await check('a turn already in the vault is skipped', () => {
  const seen = new Set(['session-y#1'])
  const replay = createReplay({ cfg, redactor, seen })
  replay.feed(JSON.stringify({ type: 'session', id: 'session-y' }))
  replay.feed(
    JSON.stringify({
      type: 'user/message',
      time: 1793170060000,
      data: { content: [{ type: 'text', text: '这一轮已经在记忆库里了，不该再写一遍。' }], source: { kind: 'user' } },
    }),
  )
  replay.feed(JSON.stringify({ type: 'turn/end', time: 1793170090000, data: { turn: 1 } }))
  const report = replay.finish()
  assert.equal(report.episodes.length, 0)
  assert.equal(report.duplicates, 1)
})

/* ------------------------------------------------------------------- file */

await check('the real zstd frame is decompressed into the vault', async () => {
  const [entry] = await listSessions(store)
  const report = await importSession({ entry, cfg, vault, redactor, seen: new Set() })
  assert.equal(report.id, 'session-history-fixture')
  assert.equal(report.project, '历史项目', 'the project comes from the session header')
  assert.equal(report.truncated, false)
  assert.equal(report.episodes, 2, `expected 2 usable turns, got ${report.episodes}`)

  const stats = await vault.stats()
  assert.equal(stats.episodes.records, 2, 'both turns should be on disk')
  assert.deepEqual(stats.projects, ['历史项目'], 'the project file is touched too')
})

await check('a second run imports nothing twice', async () => {
  const report = await runBackfill({ cfg, vault, redactor, dir: store })
  assert.equal(report.found, 2)
  assert.equal(report.imported, 0, `re-imported ${report.imported} episodes`)
  assert.ok(report.duplicates >= 2, `expected the two known turns, got ${report.duplicates}`)
  const stats = await vault.stats()
  assert.equal(stats.episodes.records, 2, 'the vault must not have grown')
})

/* -------------------------------------------------------------- dry run */

await check('a dry run reports without writing', async () => {
  // Its own vault: the dedupe key is the session id inside the file, so a
  // second vault is what proves the dry run *would* have written these turns.
  const freshDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-dry-'))
  const freshCfg = resolveConfig({ vaultDir: freshDir })
  const freshVault = createVault(freshCfg, createRedactor(freshCfg.privacy))
  const fresh = await makeStore('dry')
  await plant(fresh)

  const report = await runBackfill({ cfg: freshCfg, vault: freshVault, redactor, dir: fresh, dryRun: true })
  assert.equal(report.dryRun, true)
  assert.equal(report.imported, 2, 'it should still say what it would import')
  assert.equal((await freshVault.stats()).episodes.records, 0, 'a dry run must not write')

  // And the same run without the flag does write those two.
  const real = await runBackfill({ cfg: freshCfg, vault: freshVault, redactor, dir: fresh })
  assert.equal(real.imported, 2)
  assert.equal((await freshVault.stats()).episodes.records, 2)
})

await check('the limit takes the newest sessions first', async () => {
  const report = await runBackfill({ cfg, vault, redactor, dir: store, limit: 1, dryRun: true })
  assert.equal(report.scanned, 1)
  assert.equal(report.sessions[0].id, 'session-history-fixture')
})

let failed = 0
for (const line of results) {
  if (line.includes('FAIL')) failed += 1
}
console.log(results.join('\n'))
console.log(failed === 0 ? `\nall ${results.length} checks passed` : `\n${failed} of ${results.length} checks failed`)
if (failed === 0) process.exitCode = 0
