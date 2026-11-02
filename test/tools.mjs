/**
 * Tool-surface test: every tool's execute + render path, with a stubbed ctx.
 *   node test/tools.mjs
 */
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { resolveConfig } from '../src/config.js'
import { createRedactor } from '../src/privacy.js'
import { createVault } from '../src/vault.js'
import { registerTools } from '../src/tools.js'

const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-tools-'))
const cfg = resolveConfig({ vaultDir: dir })
const redactor = createRedactor(cfg.privacy)
const vault = createVault(cfg, redactor)

const registered = []
const ctx = {
  tools: {
    register(definition) {
      registered.push(definition)
      return () => {}
    },
  },
  get() {
    return undefined
  },
  logger: { info() {}, warn() {} },
}

registerTools(ctx, { cfg, vault, redactor })
const byName = new Map(registered.map((definition) => [definition.name, definition]))

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

async function call(name, args) {
  const definition = byName.get(name)
  assert.ok(definition, `tool ${name} is not registered`)
  const value = await definition.execute(args, { agent: null, signal: undefined })
  const blocks = definition.output.render(args, value)
  assert.ok(Array.isArray(blocks) && blocks.length > 0, `${name} render returned nothing`)
  assert.equal(blocks[0].type, 'text', `${name} render did not produce text`)
  assert.equal(typeof blocks[0].text, 'string')
  return { value, text: blocks[0].text, definition }
}

/* ------------------------------------------------------------------ shape */
check('registers the eight memory tools', () => {
  assert.deepEqual([...byName.keys()].sort(), [
    'memory_distill',
    'memory_forget',
    'memory_get',
    'memory_graph',
    'memory_remember',
    'memory_search',
    'memory_stats',
    'memory_timeline',
  ])
})
check('every tool has a name, description and object schema', () => {
  for (const definition of registered) {
    assert.ok(definition.name.startsWith('memory_'), definition.name)
    assert.ok(definition.description.length > 40, `${definition.name} description too short`)
    assert.equal(definition.parameters.type, 'object', definition.name)
    assert.equal(typeof definition.output.render, 'function', definition.name)
  }
})
check('advertised kinds match what the vault accepts', () => {
  const kinds = byName.get('memory_remember').parameters.properties.kind.enum
  assert.deepEqual(kinds, ['decision', 'fact', 'open_question', 'preference', 'note'])
})

/* ------------------------------------------------------------------ remember */
const remembered = await call('memory_remember', {
  kind: 'decision',
  title: '插件通过 bundle patch 注入而不是改 profile 的 cordis.yml',
  body: 'bundle 自带 cordis.patch.yml，安装后由 profile 的 package.json 引用，升级时不会覆盖用户的覆盖项。',
  entities: ['dsh插件', 'bundle机制'],
  confidence: 'user_stated',
})
check('remember writes a card and reports its id', () => {
  assert.equal(remembered.value.ok, true)
  assert.match(remembered.value.id, /^c-\d{8}-[0-9a-f]{4}$/)
  assert.ok(remembered.text.includes(remembered.value.id), remembered.text)
})
check('default project falls back when there is no session', () => {
  assert.equal(remembered.value.project, cfg.defaultProject)
})

const secret = await call('memory_remember', {
  kind: 'fact',
  title: '不要把这个 token 写进记忆',
  body: '测试用的 key 是 sk-abcdefghijklmnopqrstuvwxyz0123456789，应该被替换掉。',
  entities: ['隐私边界'],
})
const secretCard = await vault.getCard(secret.value.id)
check('a secret in the body is replaced before it hits the file', () => {
  assert.equal(secretCard.body.includes('sk-abcdefghij'), false, secretCard.body)
  assert.ok(secretCard.body.includes('[REDACTED]'), secretCard.body)
  assert.ok(secret.text.includes('redacted'), secret.text)
})

/* ------------------------------------------------------------------ search */
const found = await call('memory_search', { query: '插件是怎么装上的' })
check('search finds what was just remembered', () => {
  assert.ok(found.value.count >= 1, found.text)
  assert.ok(found.text.includes(remembered.value.id), found.text)
})
const miss = await call('memory_search', { query: 'zzz 完全无关的东西' })
check('a miss is a plain answer, not an error', () => {
  assert.equal(miss.value.count >= 0, true)
  assert.ok(typeof miss.text === 'string')
})
const scoped = await call('memory_search', { query: '插件', project: 'no-such-project' })
check('project filter excludes other projects', () => {
  assert.equal(scoped.value.count, 0, scoped.text)
})

/* ------------------------------------------------------------------ get */
const got = await call('memory_get', { id: remembered.value.id })
check('get returns the full card and its entities', () => {
  assert.equal(got.value.found, true)
  assert.ok(got.text.includes('bundle 自带'), got.text)
  assert.ok(got.value.entities.length >= 2, JSON.stringify(got.value.entities))
})
const missing = await call('memory_get', { id: 'c-20260101-0000' })
check('get on a missing id says so', () => {
  assert.equal(missing.value.found, false)
  assert.ok(missing.text.includes('No card'))
})

/* ------------------------------------------------------------------ timeline */
const line = await call('memory_timeline', { entity: 'dsh插件' })
check('timeline returns the matching card', () => {
  assert.ok(line.value.count >= 1, line.text)
  assert.ok(line.text.includes('bundle'), line.text)
})

/* ------------------------------------------------------------------ graph */
const graph = await call('memory_graph', { node: 'dsh插件' })
check('graph walks from an entity to its memories', () => {
  assert.equal(graph.value.found, true)
  assert.ok(graph.value.memories.length >= 1, graph.text)
  assert.ok(graph.text.includes('memories'), graph.text)
})
const graphFromCard = await call('memory_graph', { node: remembered.value.id })
check('graph accepts a card id as the seed', () => {
  assert.equal(graphFromCard.value.found, true)
  assert.ok(graphFromCard.text.includes(remembered.value.id), graphFromCard.text)
})
check('graph names the neighbouring entities', () => {
  assert.ok(graph.value.neighbours.length >= 1, JSON.stringify(graph.value.neighbours))
  assert.ok(graph.text.includes('neighbours'), graph.text)
})
const graphMiss = await call('memory_graph', { node: '完全不存在的实体zzz' })
check('graph on an unknown node says so', () => {
  assert.equal(graphMiss.value.found, false)
  assert.ok(graphMiss.text.includes('Nothing in memory'), graphMiss.text)
})

/* ------------------------------------------------------------------ distill */
const distilled = await call('memory_distill', {})
check('distill without an extractor explains itself instead of failing', () => {
  assert.equal(distilled.value.ok, false)
  assert.ok(distilled.text.includes('extractor.enabled'), distilled.text)
})

/* ------------------------------------------------------------------ forget */
const retracted = await call('memory_forget', { id: secret.value.id, mode: 'retract', reason: 'test' })
check('retract keeps the card and marks it', () => {
  assert.equal(retracted.value.ok, true)
  assert.ok(retracted.text.includes('Retracted'), retracted.text)
})
const purged = await call('memory_forget', { id: secret.value.id, mode: 'purge' })
check('purge removes it for good', () => {
  assert.equal(purged.value.ok, true)
})
const goneAfter = await vault.getCard(secret.value.id)
check('purged card is gone from the vault', () => {
  assert.equal(goneAfter, null)
})

/* ------------------------------------------------------------------ stats */
const stats = await call('memory_stats', {})
check('stats reports the vault and the counts', () => {
  assert.ok(stats.text.includes(dir), stats.text)
  assert.ok(stats.text.includes('privacy rules'), stats.text)
  assert.equal(stats.value.cards.total >= 1, true)
})

console.log(results.join('\n'))
if (process.exitCode) {
  console.log('\nSOME CHECKS FAILED')
} else {
  console.log(`\nall ${results.length} checks passed`)
  await fsp.rm(dir, { recursive: true, force: true })
}
