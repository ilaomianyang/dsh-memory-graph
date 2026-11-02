/**
 * Smoke test: no network, no harness, no dependencies.
 *   node test/smoke.mjs
 * Exercises the vault, the redactor, retrieval and the supersede chain.
 */
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { resolveConfig } from '../src/config.js'
import { createRedactor } from '../src/privacy.js'
import { createVault } from '../src/vault.js'
import { searchCards, timelineCards, tokenize } from '../src/search.js'
import { buildPrompt, parseCards } from '../src/extract.js'

const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-'))
const cfg = resolveConfig({ vaultDir: dir, extractor: { enabled: true } })
const redactor = createRedactor(cfg.privacy)
const vault = createVault(cfg, redactor)

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

/* ------------------------------------------------------------------ redactor */
check('redacts api keys', () => {
  const { text, hits } = redactor.redact('key is sk-abcdefghijklmnopqrstuvwxyz012345 and that is it')
  assert.equal(text.includes('sk-abcdefghij'), false, text)
  assert.ok(text.includes('[REDACTED]'), text)
  assert.ok(hits.length > 0)
})
check('redacts emails', () => {
  assert.equal(redactor.redact('mail me at a.b@example.com').text, 'mail me at [email]')
})
check('redacts home path', () => {
  const { text } = redactor.redact(`config in ${os.homedir()}/x/y`)
  assert.equal(text, 'config in ~/x/y')
})
check('leaves normal prose intact', () => {
  const prose = '我们把存储从 SQLite 换成了纯文本，因为要能 diff。'
  assert.equal(redactor.redact(prose).text, prose)
})

/* ------------------------------------------------------------------ tokenize */
check('tokenize latin + cjk', () => {
  const tokens = tokenize('记忆图谱 memory graph 用纯文本存储')
  assert.ok(tokens.includes('memory'), tokens.join(','))
  assert.ok(tokens.includes('纯文'), tokens.join(','))
  assert.ok(!tokens.includes('的'), 'stopword should be dropped')
})

/* ------------------------------------------------------------------ write */
const { card: storage, deduped: firstDeduped } = await vault.saveCard({
  kind: 'decision',
  title: '记忆存储用纯文本而不是 SQLite',
  body: 'SQLite 要处理锁和二进制合并。纯文本可以直接 grep、直接读、直接备份。',
  entities: ['memory-graph', 'vault格式', 'sqlite'],
  confidence: 'user_stated',
  project: 'memory-graph',
  source: { kind: 'agent' },
})
check('writes a card', () => {
  assert.equal(firstDeduped, false)
  assert.match(storage.id, /^c-\d{8}-[0-9a-f]{4}$/)
})

const { card: again, deduped: secondDeduped } = await vault.saveCard({
  kind: 'decision',
  title: '记忆存储用纯文本而不是 SQLite。',
  body: '短一点的重复内容',
  entities: ['vault格式'],
  project: 'memory-graph',
})
check('re-confirms an identical card instead of duplicating', () => {
  assert.equal(secondDeduped, true)
  assert.equal(again.id, storage.id)
})

const { card: otherProject } = await vault.saveCard({
  kind: 'preference',
  title: '用户希望所有插件零依赖且不依赖构建步骤',
  body: '不需要 bundler，装到哪个 profile 都能直接跑。',
  entities: ['dsh插件', '零依赖'],
  confidence: 'user_stated',
  project: 'other-project',
})

const { card: privacy } = await vault.saveCard({
  kind: 'fact',
  title: '记忆写入前必须过滤凭据',
  body: '内置规则覆盖 sk- / ghp_ / 私钥块；命中即替换为 [REDACTED]。',
  entities: ['vault格式', '隐私边界', 'dsh插件'],
  confidence: 'user_stated',
  project: 'memory-graph',
})


/* ------------------------------------------------------------------ supersede */
const { card: replaced } = await vault.saveCard({
  kind: 'decision',
  title: '抽取模型默认关闭',
  body: '第一版打算默认开启蒸馏。',
  entities: ['抽取器'],
  project: 'memory-graph',
})
const { card: replacement } = await vault.saveCard({
  kind: 'decision',
  title: '抽取模型默认关闭，改用显式调用',
  body: '默认开启会在用户不知情时产生 API 费用。改成只有 memory_distill 才调用。',
  entities: ['抽取器', '隐私边界'],
  project: 'memory-graph',
  supersedes: [replaced.id],
})

/* ------------------------------------------------------------------ search */
const cards = await vault.listCards({ includeRetracted: true })
const hits = searchCards(cards, '为什么不用 sqlite 存记忆', { limit: 5, hops: 1 })
check('finds the storage decision', () => {
  assert.ok(hits.length > 0, 'no hits')
  assert.equal(hits[0].card.id, storage.id, `got ${hits[0].card.title}`)
})
check('keyword search is project-agnostic', () => {
  const crossHits = searchCards(cards, '零依赖 插件', { limit: 5, hops: 1 })
  assert.ok(crossHits.some((hit) => hit.card.id === otherProject.id), 'cross-project miss')
})
check('entity expansion pulls in a linked neighbour', () => {
  const linked = searchCards(cards, 'vault格式', { limit: 10, hops: 1 })
  const ids = linked.map((hit) => hit.card.id)
  assert.ok(ids.includes(storage.id) && ids.includes(privacy.id), ids.join(','))
})
check('superseded card is demoted but still findable', () => {
  const chain = searchCards(cards, '抽取模型默认关闭', { limit: 5, hops: 0 })
  const ids = chain.map((hit) => hit.card.id)
  assert.ok(ids.includes(replacement.id), ids.join(','))
  const old = cards.find((card) => card.id === replaced.id)
  assert.equal(old.status, 'superseded')
  assert.equal(old.supersededBy, replacement.id)
  assert.ok(old.validTo, 'superseded card needs a valid_to')
})
check('no-match query degrades to recency, not an error', () => {
  const none = searchCards(cards, '完全无关的词组zzz', { limit: 3, hops: 0 })
  assert.ok(Array.isArray(none))
})

/* ------------------------------------------------------------------ timeline */
const timeline = timelineCards(cards, { limit: 10, entity: 'vault格式' })
check('timeline filters by entity', () => {
  assert.ok(timeline.length >= 2, String(timeline.length))
  assert.ok(timeline.every((card) => card.entities.includes('vault格式')))
})

/* ------------------------------------------------------------------ entities */
const entities = await vault.listEntities()
check('one page per entity, with mentions', () => {
  const vaultFormat = entities.find((entity) => entity.slug === 'vault格式')
  assert.ok(vaultFormat, entities.map((e) => e.slug).join(','))
  assert.ok(vaultFormat.mentions.length >= 2, String(vaultFormat.mentions.length))
})
check('one entity carries memories from several projects', () => {
  const hub = entities.find((entity) => entity.slug === 'dsh插件')
  assert.ok(hub, 'shared entity missing')
  const touched = new Set(hub.mentions.map((mention) => mention.cardId))
  const projects = new Set(cards.filter((card) => touched.has(card.id)).map((card) => card.project))
  assert.ok(projects.size >= 2, [...projects].join(','))
})

/* ------------------------------------------------------------------ episodes */
await vault.appendEpisode({ t: '2026-11-02T10:00:00+08:00', project: 'p', session: 's1', turn: 1, user: 'hello there friend', assistant: 'hi' })
await vault.appendEpisode({ t: '2026-11-02T10:05:00+08:00', project: 'p', session: 's1', turn: 2, user: 'second message', assistant: 'ok' })
const pending = await vault.readUndistilled(10)
check('undistilled episodes are read from the cursor', () => {
  assert.equal(pending.length, 2, String(pending.length))
})
await vault.markDistilled(pending)
const after = await vault.readUndistilled(10)
check('cursor leaves nothing pending', () => {
  assert.equal(after.length, 0, String(after.length))
})

/* ------------------------------------------------------------------ extract parsing */
check('parses a fenced json reply', () => {
  const reply = '```json\n{"cards":[{"kind":"fact","title":"存储是纯文本","body":"因为要能 diff。","entities":["vault格式"],"confidence":"user_stated"}]}\n```'
  const { cards: parsed } = parseCards(reply)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].kind, 'fact')
  assert.equal(parsed[0].title, '存储是纯文本')
})
check('parses json with prose around it', () => {
  const { cards: parsed } = parseCards('Sure. {"cards":[]} done.')
  assert.equal(parsed.length, 0)
})
check('survives a non-json reply', () => {
  const { cards: parsed, skipped } = parseCards('I could not find anything durable.')
  assert.equal(parsed.length, 0)
  assert.ok(skipped)
})
check('drops invalid kinds and keeps valid ones', () => {
  const { cards: parsed } = parseCards('{"cards":[{"kind":"garbage","title":"a","body":"b"},{"kind":"open_question","title":"c","body":"d"}]}')
  assert.equal(parsed.length, 2)
  assert.equal(parsed[0].kind, 'note')
  assert.equal(parsed[1].kind, 'open_question')
})
check('rejects supersedes ids that are not card ids', () => {
  const { cards: parsed } = parseCards('{"cards":[{"kind":"fact","title":"a","body":"b","supersedes":["not-an-id","c-20261102-abcd"]}]}')
  assert.deepEqual(parsed[0].supersedes, ['c-20261102-abcd'])
})
const prompt = buildPrompt(pending, cards, 'memory-graph')
check('prompt carries the transcript and existing ids', () => {
  assert.equal(prompt.length, 2)
  assert.ok(prompt[1].content.includes('hello there friend'))
  assert.ok(prompt[1].content.includes(storage.id), 'existing ids should be offered for supersedes')
})

/* ------------------------------------------------------------------ config */
check('a broken skip pattern is dropped instead of disabling capture', () => {
  const bad = resolveConfig({ capture: { skipPatterns: ['^Real prompt', '[unclosed'] } })
  assert.deepEqual(bad.capture.skipPatterns, ['^Real prompt'])
})
check('injection defaults are present out of the box', () => {
  const plain = resolveConfig({})
  assert.equal(plain.capture.skipPatterns.some((p) => p.includes('checkpoint')), true)
  assert.equal(plain.capture.skipPatterns.some((p) => p.includes('system-reminder')), true)
})

/* ------------------------------------------------------------------ readme + stats */
await vault.regenerateReadme()
const readme = await fsp.readFile(path.join(dir, 'README.md'), 'utf8')
check('README is generated and links cards', () => {
  assert.ok(readme.includes('# Memory vault'), readme.slice(0, 120))
  assert.ok(readme.includes(storage.id), 'readme should link cards')
  assert.ok(readme.includes('## memory-graph'))
})
const stats = await vault.stats()
check('stats count accurately', () => {
  assert.ok(stats.cards.total >= 5, String(stats.cards.total))
  assert.ok(stats.cards.superseded >= 1)
  assert.ok(stats.entities >= 4)
  assert.ok(stats.projects.includes('memory-graph'))
  assert.equal(stats.episodes.records, 2)
})

const gitignore = await fsp.readFile(path.join(dir, '.gitignore'), 'utf8')
check('the vault carries a .gitignore for its own repo', () => {
  assert.ok(gitignore.includes('.distill-state.json'), gitignore)
})

/* ------------------------------------------------------------------ forget */
await vault.retractCard(privacy.id, 'test retraction')
const retracted = await vault.getCard(privacy.id)
const visibleCards = await vault.listCards()
const retractedHits = searchCards(visibleCards, '凭据 过滤', { limit: 5 })
check('retract keeps the file and sets status', () => {
  assert.equal(retracted.status, 'retracted')
  assert.ok(!retractedHits.some((hit) => hit.card.id === privacy.id), 'retracted card should not surface')
})
await vault.purgeCard(privacy.id)

const stillThere = await vault.getCard(privacy.id)
check('purged card is gone', () => {
  assert.equal(stillThere, null)
})

console.log(results.join('\n'))
console.log(`\nvault: ${dir}`)
if (process.exitCode) {
  console.log('\nSOME CHECKS FAILED')
} else {
  console.log(`\nall ${results.length} checks passed`)
  await fsp.rm(dir, { recursive: true, force: true })
}
