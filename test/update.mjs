/**
 * Self-update: noticing a newer version, and the one decision that installs it.
 *
 * The two halves are tested apart on purpose. The *check* is a comparison and a
 * cache — no network is allowed in this suite, so the registry is a function
 * (`fetchFn`) and the clock is a number. The *install* is a call into the host's
 * plugin manager, so the manager is an object that records what it was asked for
 * and can be told to refuse, hang, or come back needing a restart.
 *
 * The rule worth stating out loud: a development `link:` checkout must never
 * update itself into a registry tarball, and that refusal must be a readable
 * sentence rather than an exception.
 *
 *   node test/update.mjs
 */
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { resolveConfig } from '../src/config.js'
import {
  PACKAGE_NAME,
  compareVersions,
  createUpdateChecker,
  createUpdateHandler,
  installKindOf,
  readOwnVersion,
} from '../src/update.js'

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

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE

const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'memory-graph-update-'))
let serial = 0
const freshDir = async () => {
  serial += 1
  const dir = path.join(tmpRoot, `v${serial}`)
  await fsp.mkdir(dir, { recursive: true })
  return dir
}

/** A checker over one temp vault, with the registry and the clock under test control. */
async function makeChecker({
  version = '0.11.0',
  latest = '0.12.0',
  update = {},
  bundles = [{ name: PACKAGE_NAME, availability: 'profile', installTarget: { spec: '0.11.0', version: '0.11.0' } }],
  installResult = { changed: true, application: 'restart-required', stage: 'install', target: PACKAGE_NAME, version: '0.12.0' },
  fetchFails = false,
  registryFails = false,
} = {}) {
  const dir = await freshDir()
  const cfg = resolveConfig({ update: { enabled: true, ...update } })
  cfg.vaultDir = dir
  const clock = { at: Date.UTC(2026, 10, 3, 8, 0, 0) }
  const fetches = []
  const installs = []
  const logs = []
  const manager = {
    async registries() {
      if (registryFails) throw new Error('no registries')
      return { registry: 'https://registry.npmjs.org', fallbackRegistries: [], resolved: null }
    },
    async listBundles() {
      return bundles
    },
    async installBundle(spec, options) {
      installs.push({ spec, options })
      if (typeof installResult === 'function') return installResult(spec, options)
      return installResult
    },
  }
  const checker = createUpdateChecker({
    cfg,
    log: (level, message) => logs.push(`${level}: ${message}`),
    getPluginManager: () => manager,
    readVersion: async () => version,
    now: () => clock.at,
    fetchFn: async (url) => {
      fetches.push(url)
      if (fetchFails) throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org')
      return { ok: true, status: 200, async json() { return { name: PACKAGE_NAME, version: latest } } }
    },
  })
  return { dir, cfg, checker, clock, fetches, installs, logs, manager }
}

const readCache = async (dir) => JSON.parse(await fsp.readFile(path.join(dir, '.update-state.json'), 'utf8'))

/* --------------------------------------------------------------- versions */

await check('a newer version compares higher, an equal one compares equal', () => {
  assert.equal(compareVersions('0.12.0', '0.11.0'), 1)
  assert.equal(compareVersions('0.11.0', '0.11.0'), 0)
  assert.equal(compareVersions('0.11.0', '0.12.0'), -1)
})

await check('a prerelease sits below its release, and a v prefix is ignored', () => {
  assert.equal(compareVersions('1.0.0-beta.1', '1.0.0'), -1)
  assert.equal(compareVersions('v0.11.0', '0.11.0'), 0)
  assert.equal(compareVersions('0.9.9', '0.10.0'), -1)
})

await check('the version comes from this package manifest, not a constant', async () => {
  const version = await readOwnVersion()
  assert.match(String(version), /^\d+\.\d+\.\d+/u)
})

/* ----------------------------------------------------- install kinds */

await check('a link: or file: install is a working copy, not an updatable package', () => {
  assert.equal(installKindOf([{ name: PACKAGE_NAME, availability: 'profile', installTarget: { spec: 'link:G:/repo' } }]), 'link')
  assert.equal(installKindOf([{ name: PACKAGE_NAME, availability: 'profile', installTarget: { spec: 'file:../repo' } }]), 'link')
})

await check('a registry install is updatable, and an unknown shape is not', () => {
  assert.equal(installKindOf([{ name: PACKAGE_NAME, availability: 'profile', installTarget: { spec: '0.11.0' } }]), 'registry')
  assert.equal(installKindOf([]), 'unknown')
  assert.equal(installKindOf(undefined), 'unknown')
  assert.equal(installKindOf([{ name: 'something-else', availability: 'profile', installTarget: { spec: '1.0.0' } }]), 'unknown')
})

/* -------------------------------------------------------------- checking */

await check('a newer registry version reads as behind, in Chinese, with the offset in the stamp', async () => {
  const { checker, dir } = await makeChecker()
  const state = await checker.status()
  assert.equal(state.ok, true)
  assert.equal(state.current, '0.11.0')
  assert.equal(state.latest, '0.12.0')
  assert.equal(state.behind, true)
  assert.match(state.message, /有新版本 0\.12\.0/u)
  assert.match(String(state.checkedAt), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/u)
  const cache = await readCache(dir)
  assert.equal(cache.latest, '0.12.0')
})

await check('the same version reads as up to date', async () => {
  const { checker } = await makeChecker({ latest: '0.11.0' })
  const state = await checker.status()
  assert.equal(state.behind, false)
  assert.match(state.message, /已是最新版本 0\.11\.0/u)
})

await check('a second read inside the window asks the registry once', async () => {
  const { checker, fetches, clock } = await makeChecker()
  await checker.status()
  clock.at += 5 * MINUTE
  await checker.status()
  assert.equal(fetches.length, 1)
})

await check('force does not re-ask within a minute, and does after it', async () => {
  const { checker, fetches, clock } = await makeChecker()
  await checker.status()
  clock.at += 30 * 1000
  await checker.status({ force: true })
  assert.equal(fetches.length, 1, 'a double click must not become two requests')
  clock.at += 40 * 1000
  await checker.status({ force: true })
  assert.equal(fetches.length, 2)
})

await check('the cache expires on its own after checkEveryHours', async () => {
  const { checker, fetches, clock } = await makeChecker({ update: { checkEveryHours: 12 } })
  await checker.status()
  clock.at += 11 * HOUR
  await checker.status()
  assert.equal(fetches.length, 1)
  clock.at += 2 * HOUR
  await checker.status()
  assert.equal(fetches.length, 2)
})

await check('a failed check keeps the last answer and reports the error', async () => {
  const { checker, fetches, clock } = await makeChecker({ fetchFails: true })
  const first = await checker.status()
  assert.equal(first.latest, null)
  assert.match(first.message, /查不到新版本/u)
  assert.match(String(first.error), /ENOTFOUND/u)
  // The cache is not a lie in the other direction either: still no version known.
  clock.at += 20 * HOUR
  const second = await checker.status()
  assert.equal(second.behind, false)
  assert.equal(fetches.length, 2)
})

await check('a registry outage after a good check does not forget the version', async () => {
  const { checker, cfg, clock } = await makeChecker()
  await checker.status()
  cfg.update.checkEveryHours = 1
  clock.at += 2 * HOUR
  const offline = (url) => {
    throw new Error('offline')
  }
  const broken = createUpdateChecker({ cfg, log: () => {}, getPluginManager: () => null, readVersion: async () => '0.11.0', now: () => clock.at, fetchFn: offline })
  const state = await broken.status()
  assert.equal(state.latest, '0.12.0', 'the previous answer survives an outage')
  assert.match(String(state.error), /offline/u)
})

await check('turning checks off reports the version without asking anyone', async () => {
  const { checker, fetches } = await makeChecker({ update: { enabled: false } })
  const state = await checker.status()
  assert.equal(state.current, '0.11.0')
  assert.equal(state.canCheck, false)
  assert.equal(state.behind, false)
  assert.match(state.message, /关掉/u)
  assert.equal(fetches.length, 0)
})

await check('a configured registry wins over the plugin manager one', async () => {
  const { checker } = await makeChecker({ update: { registry: 'https://mirror.example.com/' } })
  const state = await checker.status()
  assert.equal(state.registry, 'https://mirror.example.com')
})

await check('an unusable plugin manager does not stop the check', async () => {
  const { checker } = await makeChecker({ registryFails: true })
  const state = await checker.status()
  assert.equal(state.registry, 'https://registry.npmjs.org')
  assert.equal(state.behind, true)
})

/* ------------------------------------------------------------- installing */

await check('a link: install refuses to update itself and says why', async () => {
  const { checker, installs } = await makeChecker({
    bundles: [{ name: PACKAGE_NAME, availability: 'profile', installTarget: { spec: 'link:G:/TempProject/memory-graph-plugin' } }],
  })
  const state = await checker.status()
  assert.equal(state.behind, true)
  assert.equal(state.canInstall, false)
  assert.match(state.message, /link:/u)
  const result = await checker.install()
  assert.equal(result.ok, false)
  assert.equal(result.applied, false)
  assert.match(result.message, /link:/u)
  assert.equal(installs.length, 0, 'nothing may be installed over a working copy')
})

await check('a registry install asks the host for the exact newer version', async () => {
  const { checker, installs } = await makeChecker()
  const result = await checker.install()
  assert.equal(result.ok, true)
  assert.equal(result.applied, true)
  assert.equal(result.application, 'restart-required')
  assert.equal(result.version, '0.12.0')
  assert.match(result.message, /重启 Harness/u)
  assert.equal(installs.length, 1)
  assert.equal(installs[0].spec, `${PACKAGE_NAME}@0.12.0`)
  assert.equal(installs[0].options.enabled, true)
})

await check('an applied update is reported as applied, not as a restart', async () => {
  const { checker } = await makeChecker({ installResult: { changed: true, application: 'applied', stage: 'install', target: PACKAGE_NAME, version: '0.12.0' } })
  const result = await checker.install()
  assert.equal(result.applied, true)
  assert.match(result.message, /已更新到 0\.12\.0/u)
  assert.doesNotMatch(result.message, /重启/u)
})

await check('nothing to update is a refusal, not an install', async () => {
  const { checker, installs } = await makeChecker({ latest: '0.11.0' })
  const result = await checker.install()
  assert.equal(result.ok, false)
  assert.match(result.message, /已经是最新版本/u)
  assert.equal(installs.length, 0)
})

await check('a failed install is reported with the host diagnostic', async () => {
  const { checker } = await makeChecker({
    installResult: { changed: false, application: 'failed', stage: 'install', target: PACKAGE_NAME, error: { code: 'operation-error', diagnostic: 'ERR_PNPM_FETCH_404' } },
  })
  const result = await checker.install()
  assert.equal(result.ok, false)
  assert.equal(result.applied, false)
  assert.match(result.message, /ERR_PNPM_FETCH_404/u)
})

await check('a second install while one is running is refused, not queued', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const { checker, installs } = await makeChecker({
    installResult: async () => {
      await gate
      return { changed: true, application: 'applied', stage: 'install', target: PACKAGE_NAME, version: '0.12.0' }
    },
  })
  const first = checker.install()
  await new Promise((resolve) => setTimeout(resolve, 20))
  const second = await checker.install()
  assert.equal(second.ok, false)
  assert.match(second.message, /已经有一次更新在跑/u)
  release()
  assert.equal((await first).ok, true)
  assert.equal(installs.length, 1)
})

await check('busy shows up in the status the page reads', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const { checker } = await makeChecker({
    installResult: async () => {
      await gate
      return { changed: true, application: 'applied', stage: 'install', target: PACKAGE_NAME, version: '0.12.0' }
    },
  })
  const running = checker.install()
  await new Promise((resolve) => setTimeout(resolve, 20))
  const during = await checker.status()
  assert.equal(during.busy, true)
  assert.equal(during.canInstall, false)
  release()
  await running
})

await check('autoInstall at startup installs when allowed, and only then', async () => {
  const off = await makeChecker({ update: { autoInstall: false } })
  assert.equal((await off.checker.onStart()).behind, true)
  assert.equal(off.installs.length, 0)

  const on = await makeChecker({ update: { autoInstall: true } })
  const result = await on.checker.onStart()
  assert.equal(result.applied, true)
  assert.equal(on.installs.length, 1)
})

await check('autoInstall never touches a link: install', async () => {
  const { checker, installs } = await makeChecker({
    update: { autoInstall: true },
    bundles: [{ name: PACKAGE_NAME, availability: 'profile', installTarget: { spec: 'link:G:/repo' } }],
  })
  const state = await checker.onStart()
  assert.equal(state.behind, true)
  assert.equal(state.installKind, 'link')
  assert.equal(installs.length, 0)
})

/* ----------------------------------------------------------------- route */

const callHandler = async (checker, { method = 'GET', url = 'http://localhost/api/memory-graph.update' } = {}) => {
  const handler = createUpdateHandler({ getChecker: () => checker })
  const response = await handler(new Request(url, { method }))
  return { status: response.status, headers: response.headers, body: await response.json() }
}

await check('GET answers with the version state and never caches it', async () => {
  const { checker } = await makeChecker()
  const { status, headers, body } = await callHandler(checker)
  assert.equal(status, 200)
  assert.equal(headers.get('cache-control'), 'no-store')
  assert.equal(body.current, '0.11.0')
  assert.equal(body.latest, '0.12.0')
  assert.equal(body.behind, true)
})

await check('POST installs, and a refused POST is a 409 with a sentence in it', async () => {
  const ok = await makeChecker()
  const good = await callHandler(ok.checker, { method: 'POST' })
  assert.equal(good.status, 200)
  assert.equal(good.body.applied, true)

  const link = await makeChecker({
    bundles: [{ name: PACKAGE_NAME, availability: 'profile', installTarget: { spec: 'link:G:/repo' } }],
  })
  const refused = await callHandler(link.checker, { method: 'POST' })
  assert.equal(refused.status, 409)
  assert.equal(refused.body.applied, false)
  assert.match(refused.body.message, /link:/u)
})

await check('a route with no checker explains itself instead of throwing', async () => {
  const { status, body } = await callHandler(null)
  assert.equal(status, 503)
  assert.equal(body.ok, false)
  assert.match(body.error, /更新检查/u)
})

await fsp.rm(tmpRoot, { recursive: true, force: true })

console.log(results.join('\n'))
console.log(process.exitCode === 1 ? `\n${results.filter((line) => line.includes('FAIL')).length} check(s) failed` : `\nall ${results.length} checks passed`)
