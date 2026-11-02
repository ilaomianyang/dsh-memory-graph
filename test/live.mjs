/**
 * End-to-end check against a real model. Not part of `npm test`: it needs
 * network access and spends tokens.
 *
 *   node test/live.mjs                      # seeded episodes, Chinese + English
 *   node test/live.mjs --log <session.jsonl> # replay a real session log instead
 *   node test/live.mjs --dry                # show what the model proposes, write nothing
 *   node test/live.mjs --keep               # leave the temp vault on disk to look at
 *
 * The key is resolved exactly the way the plugin resolves it: env var named by
 * `extractor.apiKeyEnv`, then the harness credential store. Override the endpoint
 * with LIVE_BASE_URL / LIVE_MODEL / LIVE_KEY_ENV.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { resolveConfig } from '../src/config.js'
import { createRedactor } from '../src/privacy.js'
import { createVault } from '../src/vault.js'
import { distill } from '../src/extract.js'
import { searchCards } from '../src/search.js'
import { registerCapture } from '../src/capture.js'

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const value = (name) => {
  const at = argv.indexOf(`--${name}`)
  return at >= 0 ? argv[at + 1] : undefined
}

const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mem-live-'))
const cfg = resolveConfig({
  vaultDir: dir,
  extractor: {
    enabled: true,
    // This script talks to an endpoint directly; the plugin's default transport
    // borrows Settings instead, which a bare `node` process cannot do.
    transport: 'http',
    apiKeyEnv: process.env.LIVE_KEY_ENV || 'DEEPSEEK_API_KEY',
    baseUrl: process.env.LIVE_BASE_URL || 'https://api.deepseek.com/v1',
    model: process.env.LIVE_MODEL || 'deepseek-chat',
  },
})
const redactor = createRedactor(cfg.privacy)
const vault = createVault(cfg, redactor)

const SEED = [
  {
    project: 'memory-graph',
    t: '2026-10-28T10:12:00+08:00',
    user: '我打算把长期记忆做成纯文本的库：episodes 存原始对话，cards 存蒸馏出来的记忆，entities 存实体索引。你觉得这样分层有问题吗？',
    assistant:
      '分层本身没问题，但要防止 cards 变成 episodes 的摘要备份。关键是 cards 必须有类型和有效期，否则过时的决策会一直毒害检索。建议每条卡片带 kind、valid_from/valid_to、supersedes，并且蒸馏只在离线显式触发，不挂在对话主路径上。',
    tools: 0,
  },
  {
    project: 'memory-graph',
    t: '2026-10-28T10:41:00+08:00',
    user: '那就定下来：蒸馏用一个单独的模型接口，key 从环境变量读，不写进配置文件。另外记忆只在模型主动查的时候给，不做自动注入。',
    assistant:
      '同意。自动注入会把记忆塞进每一个轮次，token 成本和污染风险都不划算；工具化按需查询可控得多。apiKeyEnv 默认 MEMORY_LLM_API_KEY，配置文件里永远只出现变量名。',
    tools: 3,
  },
  {
    project: 'blog-engine',
    t: '2026-10-30T09:05:00+08:00',
    user: 'The blog generator keeps rewriting my markdown footnotes. I want the pipeline to treat the markdown body as opaque: only rewrite frontmatter, never touch the rendered content.',
    assistant:
      'Then the transformer has to parse frontmatter and stop at the closing delimiter, passing the rest through byte-for-byte. Any markdown-aware step breaks that promise, so drop the remark/rehype pass from the publish path and run validation as a separate read-only check.',
    tools: 1,
  },
]

if (value('log')) {
  const lines = fs.readFileSync(value('log'), 'utf8').split('\n').filter(Boolean)
  const handlers = new Map()
  const ctx = {
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, [])
      handlers.get(name).push(fn)
      return () => {}
    },
    logger: { info() {}, warn() {} },
  }
  registerCapture(ctx, { cfg, vault, redactor })
  const session = { id: 'live-replay', header: { cwd: process.cwd() } }
  let seen = 0
  for (const line of lines) {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (!['user/message', 'assistant/message', 'tool/result', 'turn/end'].includes(event.type)) continue
    seen += 1
    for (const fn of handlers.get('session/event') ?? []) fn(session, event)
  }
  await new Promise((resolve) => setTimeout(resolve, 400))
  console.log(`replayed ${seen} events from ${value('log')}`)
} else {
  for (const episode of SEED) await vault.appendEpisode(episode)
  console.log(`seeded ${SEED.length} episodes`)
}

const stats = await vault.stats()
console.log(`vault ${dir}\nepisodes: ${stats.episodes.records} · cards: ${stats.cards.total} · projects: ${stats.projects.join(', ') || '-'}`)
if (stats.episodes.records === 0) {
  console.error('no episodes to distill — nothing to check')
  process.exit(1)
}

const started = Date.now()
const report = await distill({ cfg, vault, redactor, dryRun: flag('dry') })
console.log(`\ndistill ${report.ok ? 'ok' : 'FAILED'} in ${Date.now() - started}ms · key=${report.keySource ?? '?'} · ${report.episodes} episode(s)`)

if (!report.ok) {
  console.error(report.reason)
  process.exit(1)
}
if (report.dryRun) {
  for (const card of report.proposed) console.log(`  [${card.kind}] ${card.title} · ${card.entities.join(', ')}`)
  console.log(`\nskipped: ${report.skipped ?? '-'}`)
} else {
  for (const card of report.cards) console.log(`  ${card.id} [${card.kind}] ${card.title}${card.deduped ? ' (dup)' : ''}`)
  console.log(`written: ${report.written}/${report.cards.length + (report.written - report.cards.length)} · usage: ${JSON.stringify(report.usage)}`)
  console.log(`skipped: ${report.skipped ?? '-'}`)

  // The loop only closes if what was written can be found again.
  const probe = report.cards[0]?.title ?? 'memory'
  const hits = searchCards(await vault.listCards(), probe, { limit: 3 })
  console.log(`\nsearch "${probe.slice(0, 40)}" -> ${hits.length} hit(s)`)
  for (const hit of hits) console.log(`  ${hit.score.toFixed(2)} ${hit.card.id} ${hit.card.title}`)
}

if (flag('keep')) console.log(`\nkept: ${dir}`)
else await fsp.rm(dir, { recursive: true, force: true })
