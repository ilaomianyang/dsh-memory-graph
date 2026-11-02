/**
 * Does a later correction actually retire the earlier memory? This is the one
 * behaviour that cannot be checked offline, because it depends on the model
 * filling `supersedes` with a real id.
 *
 *   node test/live-supersede.mjs [--keep]
 *
 * Round one distills a claim. Round two adds the user correcting it and distills
 * again. The check passes when the old card ends up `superseded` and the new card
 * points at it, which is the whole point of temporal validity.
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { resolveConfig } from '../src/config.js'
import { createRedactor } from '../src/privacy.js'
import { createVault } from '../src/vault.js'
import { distill } from '../src/extract.js'

const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mem-supersede-'))
const cfg = resolveConfig({
  vaultDir: dir,
  extractor: {
    enabled: true,
    apiKeyEnv: process.env.LIVE_KEY_ENV || 'DEEPSEEK_API_KEY',
    baseUrl: process.env.LIVE_BASE_URL || 'https://api.deepseek.com/v1',
    model: process.env.LIVE_MODEL || 'deepseek-chat',
  },
})
const redactor = createRedactor(cfg.privacy)
const vault = createVault(cfg, redactor)
const project = 'memory-graph'

await vault.appendEpisode({
  project,
  t: '2026-11-01T09:00:00+08:00',
  user: '记忆库在本地文件夹生成，方便上传到 GitHub 上共享。',
  assistant: '纯文本文件就可以直接进 git，diff 和合并都没问题。',
})
const first = await distill({ cfg, vault, redactor })
if (!first.ok || first.cards.length === 0) {
  console.error('round one produced no cards', first)
  process.exit(1)
}
const oldCards = await vault.listCards({ includeRetracted: true })
console.log(`round 1: ${first.cards.map((card) => `${card.id} ${card.title}`).join(' | ')}`)

await vault.appendEpisode({
  project,
  t: '2026-11-02T10:00:00+08:00',
  user: '更正一下：共享出去的是插件这个项目，不是记忆本身。记忆是私有的，不应该上传。纯文本只是为了可读、可移植、无锁。',
  assistant: '明白，记忆库当私有数据对待，共享的是插件包。',
})
const second = await distill({ cfg, vault, redactor })
if (!second.ok) {
  console.error('round two failed', second)
  process.exit(1)
}
console.log(`round 2: ${second.cards.map((card) => `${card.id} ${card.title} supersedes=${JSON.stringify(card.supersedes ?? [])}`).join(' | ')}`)

const after = await vault.listCards({ includeRetracted: true })
const backwards = (card) => card.supersededBy ?? card.superseded_by ?? null
const retired = after.filter((card) => card.status === 'superseded')
const linking = after.filter((card) => (card.supersedes ?? []).length > 0)

console.log('')
console.log(`superseded cards: ${retired.map((card) => `${card.id} -> ${backwards(card)}`).join(', ') || 'none'}`)
console.log(`cards that point at another: ${linking.map((card) => `${card.id} -> ${card.supersedes.join(',')}`).join(', ') || 'none'}`)

const chained = retired.some((card) => backwards(card) && linking.some((newer) => newer.id === backwards(card) && newer.supersedes.includes(card.id)))
const ok = retired.length > 0 && linking.length > 0 && chained
console.log(ok ? '\nPASS: the correction retired the earlier memory, both directions linked' : '\nFAIL: the correction did not retire the earlier memory')

if (process.argv.includes('--keep')) console.log(`kept: ${dir}`)
else await fsp.rm(dir, { recursive: true, force: true })
process.exit(ok ? 0 : 1)
