/**
 * Session-view data checks.
 *
 * The panel in the Conversation row is only as honest as this payload: the
 * filter that decides which episodes belong to the Session, the edges that claim
 * a connection, and the caps that keep the drawing readable. None of that is
 * visible from the browser side, so it is asserted here against a real vault in
 * a temp directory.
 *
 *   node test/graphdata.mjs
 */
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { resolveConfig } from '../src/config.js'
import { createRedactor } from '../src/privacy.js'
import { createVault } from '../src/vault.js'
import {
  GRAPH_PATH,
  buildSessionGraph,
  createGraphHandler,
  dominantProject,
  layoutNodes,
  recallQuery,
} from '../src/graphdata.js'

const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-graphdata-'))
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
async function checkAsync(name, fn) {
  try {
    await fn()
    results.push(`  ok   ${name}`)
  } catch (error) {
    results.push(`  FAIL ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

/* ---------------------------------------------------------------- the vault */

const cfg = resolveConfig({ vaultDir: dir, defaultProject: 'proj-a' })
const vault = createVault(cfg, createRedactor(cfg.privacy))
await vault.ensure()

const LEAK = 'ASSISTANT-TEXT-MUST-NOT-LEAK'
await vault.appendEpisode({
  t: '2026-11-02T10:00:00+08:00',
  project: 'proj-a',
  session: 'sess-1',
  turn: 1,
  user: '记忆库要用纯文本存。',
  assistant: LEAK,
})
await vault.appendEpisode({
  t: '2026-11-02T10:05:00+08:00',
  project: 'proj-a',
  session: 'sess-1',
  turn: 2,
  user: '实体页怎么把两个项目连起来？',
  assistant: 'ok',
})
await vault.appendEpisode({
  t: '2026-11-02T11:00:00+08:00',
  project: 'proj-b',
  session: 'sess-2',
  turn: 1,
  user: '别的会话在聊发布流程。',
  assistant: 'ok',
})

const cardA = await vault.saveCard({
  title: '记忆库用纯文本存储',
  body: '每个记忆一个文件，可以 diff。',
  kind: 'decision',
  project: 'proj-a',
  entities: ['memory-vault', 'markdown'],
})
const cardB = await vault.saveCard({
  title: '实体页把项目串起来',
  body: '实体是跨项目的连接点。',
  kind: 'fact',
  project: 'proj-a',
  entities: ['entity-page'],
})
const cardC = await vault.saveCard({
  title: '纯文本也能 grep',
  body: '不需要索引也能查。',
  kind: 'note',
  project: 'proj-b',
  entities: ['memory-vault'],
})

/* ------------------------------------------------------------- pure helpers */

check('the route path is an exact /api path that Connection accepts', () => {
  assert.equal(GRAPH_PATH, '/api/memory-graph.graph')
  assert.equal(GRAPH_PATH.startsWith('/api/'), true)
  assert.ok(GRAPH_PATH.length > '/api/'.length, 'connection rejects a bare channel path')
})

check('the project is the majority of the episodes and null when none name one', () => {
  assert.equal(dominantProject([{ project: 'a' }, { project: 'b' }, { project: 'b' }]), 'b')
  assert.equal(dominantProject([{ project: '' }, {}, { project: 'x' }]), 'x')
  assert.equal(dominantProject([]), null)
})

check('the recall query is the newest turns, capped', () => {
  const episodes = [{ user: 'one' }, { user: 'two' }, { user: 'three' }, { user: 'four' }]
  assert.equal(recallQuery(episodes, { turns: 2 }), 'four\nthree', 'newest last')
  assert.equal(recallQuery([{ user: '' }, { user: 'x' }]), 'x', 'empty turns are skipped')
  const long = recallQuery([{ user: 'y'.repeat(4000) }], { maxChars: 120 })
  assert.equal(long.length, 120)
})

check('the layout is deterministic and stays inside the box', () => {
  const nodes = [
    { key: 'a', k: 'session', r: 12 },
    { key: 'b', k: 'episode', r: 5 },
    { key: 'c', k: 'card', r: 7 },
    { key: 'd', k: 'entity', r: 6 },
  ]
  const links = [
    { s: 'a', t: 'b', k: 'said' },
    { s: 'a', t: 'c', k: 'recall' },
    { s: 'c', t: 'd', k: 'mentions' },
  ]
  layoutNodes(nodes, links)
  const first = nodes.map((node) => [node.x, node.y])
  for (const node of nodes) {
    assert.equal(Number.isFinite(node.x) && Number.isFinite(node.y), true, `${node.key} has a position`)
    assert.ok(node.x >= 0 && node.x <= 1080, `${node.key} x in the box`)
    assert.ok(node.y >= 0 && node.y <= 640, `${node.key} y in the box`)
  }
  const again = nodes.map((node) => ({ ...node }))
  layoutNodes(again, links)
  assert.deepEqual(
    again.map((node) => [node.x, node.y]),
    first,
    'same input, same picture: no Math.random',
  )
})

/* -------------------------------------------------------------- the payload */

let sessOne = null
await checkAsync('a session sees only its own episodes', async () => {
  sessOne = await buildSessionGraph({ vault, session: 'sess-1' })
  assert.equal(sessOne.ok, true)
  assert.equal(sessOne.project, 'proj-a')
  assert.equal(sessOne.counts.episodes, 2)
  assert.equal(sessOne.empty, false)
  const episodes = sessOne.nodes.filter((node) => node.k === 'episode')
  assert.equal(episodes.length, 2)
  assert.deepEqual(
    episodes.map((node) => node.label),
    ['T1', 'T2'],
  )
  assert.equal(
    sessOne.links.filter((link) => link.k === 'said').length,
    2,
    'the session said both episodes',
  )
})

await checkAsync('the payload never carries the assistant side', () => {
  assert.equal(JSON.stringify(sessOne).includes(LEAK), false)
})

await checkAsync('recalled cards are marked, their entities are drawn, links are wired', async () => {
  const cards = sessOne.nodes.filter((node) => node.k === 'card' && !node.foreign)
  assert.ok(cards.length >= 2, 'both project cards are on the graph')
  assert.ok(sessOne.recall.length >= 1, 'the session text retrieves something')
  const hot = sessOne.nodes.filter((node) => node.k === 'card' && node.hot === true)
  assert.ok(hot.length >= 1, 'at least one card is marked as recalled')
  assert.equal(
    sessOne.links.filter((link) => link.k === 'recall').length,
    sessOne.recall.length,
    'one recall edge per recalled card',
  )
  const entities = sessOne.nodes.filter((node) => node.k === 'entity')
  assert.ok(entities.length >= 2, 'the cards mention entities')
  assert.ok(
    sessOne.links.some((link) => link.k === 'mentions'),
    'a card is joined to the entity it mentions',
  )
  const hotNode = hot[0]
  assert.equal(typeof hotNode.body, 'string', 'the panel can show the body on click')
  assert.equal(typeof hotNode.title, 'string')
})

await checkAsync('a card in another project is drawn dim when it shares an entity', async () => {
  const foreign = sessOne.nodes.filter((node) => node.foreign === true)
  assert.equal(foreign.length, 1, 'exactly the cross-project bridge')
  assert.equal(foreign[0].id, cardC.card.id)
  assert.equal(foreign[0].project, 'proj-b')
  assert.ok(
    sessOne.links.some((link) => link.s === `c:${cardC.card.id}` && link.k === 'mentions'),
    'the bridge hangs off the shared entity',
  )
  assert.equal(sessOne.counts.foreign, 1)
})

await checkAsync('every link points at a node that exists', () => {
  const keys = new Set(sessOne.nodes.map((node) => node.key))
  for (const link of sessOne.links) {
    assert.equal(keys.has(link.s), true, `missing source ${link.s}`)
    assert.equal(keys.has(link.t), true, `missing target ${link.t}`)
  }
  assert.equal(new Set(sessOne.nodes.map((node) => node.key)).size, sessOne.nodes.length, 'keys are unique')
})

await checkAsync('a second session resolves to its own project', async () => {
  const other = await buildSessionGraph({ vault, session: 'sess-2' })
  assert.equal(other.project, 'proj-b')
  assert.equal(other.counts.episodes, 1)
  assert.ok(
    other.nodes.some((node) => node.k === 'card' && node.id === cardC.card.id && !node.foreign),
    'its own card is local here',
  )
})

await checkAsync('an unknown session is an empty answer, not a failure', async () => {
  const none = await buildSessionGraph({ vault, session: 'never-seen' })
  assert.equal(none.ok, true)
  assert.equal(none.empty, true)
  assert.equal(none.counts.episodes, 0)
  assert.equal(none.nodes.filter((node) => node.k === 'episode').length, 0)
  assert.ok(
    none.nodes.some((node) => node.k === 'session'),
    'the session node still anchors the (empty) drawing',
  )
})

await checkAsync('the caps hold and say they held', async () => {
  const capped = await buildSessionGraph({ vault, session: 'sess-1', limits: { episodes: 1 } })
  assert.equal(capped.nodes.filter((node) => node.k === 'episode').length, 1)
  assert.equal(capped.truncated.episodes, true)
  assert.equal(capped.counts.episodes, 2, 'the count still reports the real total')
})

/* ---------------------------------------------------------------- the route */

const request = (session) =>
  new Request(`http://127.0.0.1:12180${GRAPH_PATH}?session=${encodeURIComponent(session)}`)

await checkAsync('the route answers JSON for a session', async () => {
  const handler = createGraphHandler({ getVault: () => vault, getConfig: () => cfg })
  const response = await handler(request('sess-1'))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type').startsWith('application/json'), true)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.counts.episodes, 2)
})

await checkAsync('a request without a session is refused, not guessed', async () => {
  const handler = createGraphHandler({ getVault: () => vault, getConfig: () => cfg })
  const response = await handler(new Request(`http://127.0.0.1:12180${GRAPH_PATH}`))
  assert.equal(response.status, 400)
  assert.equal((await response.json()).reason, 'missing-session')
})

await checkAsync('a broken vault answers with something the panel can print', async () => {
  const handler = createGraphHandler({
    getVault: () => ({
      readEpisodes: async () => {
        throw new Error('vault is a directory of permission errors')
      },
    }),
    getConfig: () => cfg,
  })
  const response = await handler(request('sess-1'))
  assert.equal(response.status, 500)
  const body = await response.json()
  assert.equal(body.ok, false)
  assert.equal(body.reason, 'unavailable')
  assert.match(body.message, /permission/)
})

await fsp.rm(dir, { recursive: true, force: true })

console.log(results.join('\n'))
console.log(`\n${results.filter((line) => line.includes(' ok ')).length}/${results.length} checks passed`)
