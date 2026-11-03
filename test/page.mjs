/**
 * The whole-vault graph page.
 *
 * This route is what makes the graph viewable inside the app: the sidebar panel
 * embeds it, so the page has to be real HTML, has to be the *same* renderer the
 * vault writes to disk, and has to say something printable when the vault is
 * unreadable instead of handing the panel a blank frame.
 *
 *   node test/page.mjs
 */
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { PAGE_PATH, createPageHandler } from '../src/pageapi.js'
import { resolveConfig } from '../src/config.js'
import { createRedactor } from '../src/privacy.js'
import { createVault } from '../src/vault.js'

const results = []
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(
      () => results.push(`  ok   ${name}`),
      (error) => {
        results.push(`  FAIL ${name}: ${error.message}`)
        process.exitCode = 1
      },
    )
}

const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-page-'))
const cfg = resolveConfig({ vaultDir: dir })
const redactor = createRedactor(cfg.privacy)
const vault = createVault(cfg, redactor)

await check('the route sits on the authenticated /api channel like the other two', () => {
  assert.ok(PAGE_PATH.startsWith('/api/'))
  assert.ok(PAGE_PATH.includes('page'), 'it is the page door, not the graph door')
  assert.ok(!PAGE_PATH.includes('?'), 'a query string would make the exact route never match')
})

await check('an empty vault still answers with a page, not an error', async () => {
  const handler = createPageHandler({ getVault: () => vault })
  const response = await handler()
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /text\/html/)
  const body = await response.text()
  assert.ok(body.toLowerCase().includes('<!doctype html'), body.slice(0, 80))
})

await check('it is the same renderer the vault writes to disk', async () => {
  await vault.writeCard({
    kind: 'decision',
    project: '测试',
    title: '整库图与应用里的面板是同一份渲染',
    body: '因为第二份实现迟早会和库里的东西对不上。',
    sources: [],
  })
  await vault.regenerateGraph()
  const onDisk = await fsp.readFile(path.join(dir, 'graph.html'), 'utf8')
  const handler = createPageHandler({ getVault: () => vault })
  const served = await (await handler()).text()
  // The timestamp differs between the two renders; everything structural must not.
  const skeleton = (html) => html.replace(/<!--[^]*?-->/g, '').replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, 'T')
  assert.equal(skeleton(served), skeleton(onDisk))
})

await check('the page is frameable by its own origin and nothing else', async () => {
  const handler = createPageHandler({ getVault: () => vault })
  const response = await handler()
  assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN')
  assert.equal(response.headers.get('cache-control'), 'no-store', 'a stale graph would be a lie')
})

await check('a broken vault prints the reason instead of a blank frame', async () => {
  const broken = {
    graphPage: async () => {
      throw new Error('EACCES: 读不了 <vault>/cards')
    },
  }
  const handler = createPageHandler({ getVault: () => broken })
  const response = await handler()
  assert.equal(response.status, 500)
  const body = await response.text()
  assert.ok(body.includes('EACCES'), 'the reason is on the page')
  assert.ok(body.includes('&lt;vault&gt;'), 'and it is escaped, not injected as markup')
})

await check('no vault at all is a 500 with a reason, not a crash', async () => {
  const handler = createPageHandler({ getVault: () => null })
  const response = await handler()
  assert.equal(response.status, 500)
  assert.ok((await response.text()).includes('vault unavailable'))
})

await check('the vault never reaches the browser as a path', async () => {
  const handler = createPageHandler({ getVault: () => vault })
  const body = await (await handler()).text()
  assert.equal(body.includes(dir), false, 'the served page carries no vault path')
  assert.equal(body.includes('episodes/'), false, 'and no vault-relative file names')
})

console.log(results.join('\n'))
if (process.exitCode) {
  console.log('\nSOME CHECKS FAILED')
} else {
  console.log(`\nall ${results.length} checks passed`)
  await fsp.rm(dir, { recursive: true, force: true })
}
