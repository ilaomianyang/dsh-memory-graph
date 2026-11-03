/**
 * Self-update: notice that a newer version exists, then let one decision install it.
 *
 * Two halves, deliberately separated.
 *
 * *Checking* is a single `GET <registry>/<name>/latest` — no query string, no
 * body, nothing about the vault or the user in it — compared against the version
 * this module is running. The answer is cached in the vault (`.update-state.json`)
 * for `update.checkEveryHours`, so a page load does not turn into a request storm
 * and an offline machine just keeps the last answer.
 *
 * *Installing* goes through the host's own `pluginManager.installBundle`, the same
 * pnpm path `dsh plugin` uses, so the plugin does not invent a second way to move
 * packages around and the profile's registry configuration is respected.
 *
 * The one thing that must not happen is a development checkout updating itself:
 * under a `link:` install "install the newest version" would replace the user's
 * working tree with a registry tarball. That is refused, and the refusal is
 * reported as a fact about the installation rather than as an error.
 */
import fsp from 'node:fs/promises'

import { paths } from './config.js'

export const UPDATE_PATH = '/api/memory-graph.update'
export const PACKAGE_NAME = '@ilaomianyang/dsh-memory-graph'
const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
const REQUEST_TIMEOUT_MS = 8000
/** A GET younger than this is answered from the cache even when the caller asks. */
const FRESH_MS = 60 * 1000

/**
 * The version this code is, read from its own manifest.
 *
 * Not a constant: a release bump must not need a second place to be edited, and
 * the file is right there next to `src/`. A missing or unreadable manifest is not
 * fatal — the plugin keeps working and simply cannot compare versions.
 */
export async function readOwnVersion(url = new URL('../package.json', import.meta.url)) {
  try {
    const manifest = JSON.parse(await fsp.readFile(url, 'utf8'))
    return typeof manifest?.version === 'string' ? manifest.version : null
  } catch {
    return null
  }
}

/**
 * Compare two dotted versions: -1, 0, 1.
 *
 * Deliberately small rather than a semver dependency: the only consumers are a
 * published version and a registry dist-tag, both plain `x.y.z`. A prerelease
 * (`1.0.0-beta.1`) sorts below its release, which is the one rule worth keeping.
 */
export function compareVersions(left, right) {
  const parse = (text) => {
    const [core, pre = ''] = String(text ?? '').trim().replace(/^v/u, '').split('-', 2)
    const nums = core.split('.').map((part) => {
      const value = Number.parseInt(part, 10)
      return Number.isFinite(value) ? value : 0
    })
    while (nums.length < 3) nums.push(0)
    return { nums: nums.slice(0, 3), pre }
  }
  const a = parse(left)
  const b = parse(right)
  for (let i = 0; i < 3; i += 1) {
    if (a.nums[i] !== b.nums[i]) return a.nums[i] < b.nums[i] ? -1 : 1
  }
  if (a.pre === b.pre) return 0
  // A prerelease is older than the release it precedes; two prereleases compare
  // as text, which is wrong in theory and unreachable for this package.
  if (a.pre === '') return 1
  if (b.pre === '') return -1
  return a.pre < b.pre ? -1 : 1
}

/**
 * What the registry says the newest version is.
 *
 * `latest` as a dist-tag, not "the highest version ever published": a dist-tag is
 * what `npm install` would give you, and it is what a person means by "the newest
 * version".
 */
export async function fetchLatestVersion({ registry, name = PACKAGE_NAME, timeoutMs = REQUEST_TIMEOUT_MS, fetchFn } = {}) {
  const base = String(registry || DEFAULT_REGISTRY).replace(/\/+$/u, '')
  const url = `${base}/${name.replace('/', '%2f')}/latest`
  const doFetch = fetchFn ?? globalThis.fetch
  if (typeof doFetch !== 'function') throw new Error('这个运行时没有 fetch，查不了新版本 · fetch is unavailable in this runtime')
  const init = { headers: { accept: 'application/json' } }
  if (typeof AbortSignal?.timeout === 'function') init.signal = AbortSignal.timeout(timeoutMs)
  const response = await doFetch(url, init)
  if (!response?.ok) throw new Error(`registry ${base} answered ${response?.status ?? 'nothing'} · 注册表 ${base} 返回 ${response?.status ?? '无响应'}`)
  const body = await response.json()
  const version = typeof body?.version === 'string' ? body.version : ''
  if (version === '') throw new Error(`registry ${base} returned no version · 注册表 ${base} 没有返回版本号`)
  return { version, registry: base, name: body?.name ?? name }
}

function isoAt(ms) {
  const date = new Date(ms)
  const pad = (value) => String(Math.abs(value)).padStart(2, '0')
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`
}

/**
 * How this plugin is installed, as far as the update decision is concerned.
 *
 * `link:` and `file:` are a working copy (this repository, in development): a
 * registry install would overwrite it, so an update is refused rather than
 * attempted. Anything else — including "cannot tell" — is treated the same way:
 * not updatable until the host itself says the package came from a registry.
 */
export function installKindOf(bundles, name = PACKAGE_NAME) {
  if (!Array.isArray(bundles)) return 'unknown'
  const mine = bundles.find((bundle) => bundle?.name === name)
  if (!mine) return 'unknown'
  const spec = String(mine?.installTarget?.spec ?? '')
  const source = String(mine?.source ?? '')
  if (/^(link|file|workspace):/u.test(spec) || /^(link|file|workspace):/u.test(source)) return 'link'
  if (mine.availability === 'profile' && spec !== '') return 'registry'
  return 'unknown'
}

/**
 * The checker. One instance per activation, shared by the route, the startup
 * check and `memory_stats`.
 */
export function createUpdateChecker({ cfg, log = () => {}, getPluginManager, getName = () => PACKAGE_NAME, now = () => Date.now(), readVersion = readOwnVersion, fetchFn } = {}) {
  let current = null
  let cached = null
  let busy = false
  let lastError = null
  let loading = null

  const settings = () => cfg?.update ?? {}
  const stateFile = () => (cfg?.vaultDir ? paths(String(cfg.vaultDir)).updateState : null)

  async function version() {
    if (current === null) current = await readVersion()
    return current
  }

  async function loadCache() {
    if (cached !== null) return cached
    cached = { checkedAt: null, latest: null, registry: null, error: null }
    const file = stateFile()
    if (file === null) return cached
    try {
      const parsed = JSON.parse(await fsp.readFile(file, 'utf8'))
      const at = Number(parsed?.checkedAtMs)
      cached = {
        checkedAt: Number.isFinite(at) && at > 0 ? at : null,
        latest: typeof parsed?.latest === 'string' ? parsed.latest : null,
        registry: typeof parsed?.registry === 'string' ? parsed.registry : null,
        error: typeof parsed?.error === 'string' ? parsed.error : null,
      }
    } catch {
      // A missing or broken cache is the normal first run, not a failure.
    }
    return cached
  }

  async function saveCache(next) {
    cached = next
    const file = stateFile()
    if (file === null) return
    try {
      await fsp.mkdir(String(cfg.vaultDir), { recursive: true })
      await fsp.writeFile(
        file,
        `${JSON.stringify({ checkedAtMs: next.checkedAt, latest: next.latest, registry: next.registry, error: next.error }, null, 2)}\n`,
        'utf8',
      )
    } catch (error) {
      log('warn', `自动更新：没能记下检查结果 · update: could not write the check cache: ${error?.message ?? error}`)
    }
  }

  async function registryOf() {
    const configured = String(settings().registry || '')
    if (configured !== '') return configured
    try {
      const manager = getPluginManager?.()
      const resolved = typeof manager?.registries === 'function' ? await manager.registries() : null
      if (typeof resolved?.registry === 'string' && resolved.registry !== '') return resolved.registry
    } catch {
      // No plugin manager, or a profile that will not say: npm's own registry.
    }
    return DEFAULT_REGISTRY
  }

  async function refresh() {
    const at = now()
    const own = await version()
    try {
      const found = await fetchLatestVersion({ registry: await registryOf(), fetchFn })
      const next = { checkedAt: at, latest: found.version, registry: found.registry, error: null }
      await saveCache(next)
      lastError = null
      log('info', `自动更新：最新版本 ${found.version}，当前 ${own ?? '未知'}`)
      return next
    } catch (error) {
      // Keep the previous answer and its timestamp: an offline machine should not
      // forget what it knew, and a failed check must not look like "up to date".
      const previous = await loadCache()
      lastError = String(error?.message ?? error)
      await saveCache({ ...previous, error: lastError })
      log('warn', `自动更新：查不到新版本 · update: could not reach the registry: ${lastError}`)
      return { ...previous, error: lastError }
    }
  }

  async function ensureFresh(force = false) {
    const cache = await loadCache()
    const ttl = Math.max(1, Number(settings().checkEveryHours ?? 12)) * 3600 * 1000
    const age = cache.checkedAt === null ? Number.POSITIVE_INFINITY : now() - cache.checkedAt
    if (force && age >= FRESH_MS) return refresh()
    if (age < ttl) return cache
    if (loading !== null) return loading
    loading = refresh().finally(() => {
      loading = null
    })
    return loading
  }

  async function installKind() {
    try {
      const manager = getPluginManager?.()
      if (typeof manager?.listBundles !== 'function') return 'unknown'
      return installKindOf(await manager.listBundles(), getName())
    } catch {
      return 'unknown'
    }
  }

  /** The shape the Settings page and the tests read. */
  async function status({ force = false } = {}) {
    const own = await version()
    if (settings().enabled === false) {
      return {
        ok: true,
        current: own,
        latest: null,
        behind: false,
        canCheck: false,
        canInstall: false,
        installKind: 'unknown',
        checkedAt: null,
        registry: await registryOf(),
        busy,
        message: '自动检查更新已在设置里关掉 · update checks are off',
        error: null,
      }
    }
    const cache = await ensureFresh(force)
    const kind = await installKind()
    const behind = own !== null && cache.latest !== null ? compareVersions(cache.latest, own) > 0 : false
    const canInstall = behind && kind === 'registry' && !busy
    let message = null
    if (cache.error !== null && cache.latest === null) message = `查不到新版本 · could not check: ${cache.error}`
    else if (cache.latest === null) message = null
    else if (behind) message = `有新版本 ${cache.latest} · ${own ?? '?'} → ${cache.latest}`
    else message = `已是最新版本 ${own ?? cache.latest}`
    if (behind && kind === 'link') message = `${message}；当前是本地 link: 安装，不能自动更新`
    return {
      ok: true,
      current: own,
      latest: cache.latest,
      behind,
      canCheck: true,
      canInstall,
      installKind: kind,
      checkedAt: cache.checkedAt === null ? null : isoAt(cache.checkedAt),
      registry: cache.registry ?? (await registryOf()),
      busy,
      message,
      error: cache.error,
    }
  }

  /**
   * Install the newest version through the host.
   *
   * Refusals are returned, not thrown: every one of them is something a person
   * needs to read (development install, nothing to update, no plugin manager),
   * and the difference between "refused" and "failed" is worth keeping.
   */
  async function install() {
    if (busy) return { ok: false, applied: false, application: 'failed', version: null, message: '已经有一次更新在跑 · an update is already running', error: null }
    const state = await status({ force: true })
    if (state.error !== null && state.latest === null) {
      return { ok: false, applied: false, application: 'failed', version: null, message: `查不到新版本，装不了 · could not check: ${state.error}`, error: state.error }
    }
    if (!state.behind) {
      return { ok: false, applied: false, application: 'failed', version: state.current, message: `已经是最新版本 ${state.current ?? ''} · already up to date`, error: null }
    }
    if (state.installKind === 'link') {
      return {
        ok: false,
        applied: false,
        application: 'failed',
        version: state.latest,
        message: '当前不是从 npm 安装的（link: 本地安装），自动更新会覆盖你的开发目录，已拒绝 · this is a link: install, so updating would overwrite the working copy',
        error: null,
      }
    }
    const manager = getPluginManager?.()
    if (typeof manager?.installBundle !== 'function') {
      return { ok: false, applied: false, application: 'failed', version: state.latest, message: '宿主没有提供 pluginManager，装不了 · the host exposes no pluginManager', error: null }
    }
    busy = true
    try {
      const spec = `${getName()}@${state.latest}`
      log('info', `自动更新：正在安装 ${spec}`)
      const result = await manager.installBundle(spec, { enabled: true })
      const application = String(result?.application ?? 'failed')
      const applied = application === 'applied' || application === 'restart-required'
      if (applied) {
        // The running code is now a version older than the one on disk; forget the
        // cache so the next status is honest about what is installed.
        cached = null
      }
      const message = applied
        ? application === 'restart-required'
          ? `已安装 ${state.latest}，需要重启 Harness 生效 · installed, restart the harness to apply`
          : `已更新到 ${state.latest} · updated to ${state.latest}`
        : `更新没有成功：${result?.error?.diagnostic ?? result?.error?.code ?? application} · update did not apply`
      log(applied ? 'info' : 'warn', `自动更新：${message}`)
      return {
        ok: applied,
        applied,
        application,
        version: applied ? (result?.version ?? state.latest) : state.latest,
        message,
        error: applied ? null : String(result?.error?.diagnostic ?? result?.error?.code ?? ''),
      }
    } catch (error) {
      const message = String(error?.message ?? error)
      log('warn', `自动更新：安装失败 · update install failed: ${message}`)
      return { ok: false, applied: false, application: 'failed', version: state.latest, message: `安装失败：${message}`, error: message }
    } finally {
      busy = false
    }
  }

  /** Startup hook: check once, and install only when that was asked for. */
  async function onStart() {
    if (settings().enabled === false) return null
    try {
      const state = await status()
      if (state.behind && settings().autoInstall === true && state.installKind === 'registry') {
        return await install()
      }
      return state
    } catch (error) {
      log('warn', `自动更新：启动检查失败 · update: startup check failed: ${error?.message ?? error}`)
      return null
    }
  }

  return { status, install, onStart, version, peek: () => ({ current, latest: cached?.latest ?? null, checkedAt: cached?.checkedAt ?? null, busy }), lastError: () => lastError }
}

/**
 * The route. One path, two methods: GET answers "am I behind?", POST answers
 * "then update" — and POST is the only verb that can touch the installation, so a
 * page load or a prefetch can never do it by accident.
 */
export function createUpdateHandler({ getChecker }) {
  return async function handle(request) {
    const checker = getChecker()
    if (!checker) {
      return new Response(JSON.stringify({ ok: false, error: '更新检查还没有就绪 · the update checker is not ready' }), {
        status: 503,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      })
    }
    try {
      if ((request?.method ?? 'GET').toUpperCase() === 'POST') {
        const result = await checker.install()
        // 200 when it landed, 409 when it was refused (a link: install, nothing to
        // update, no plugin manager). "Refused" and "failed" are both non-2xx on
        // purpose: neither should look like a version change to a caller.
        return new Response(JSON.stringify(result), {
          status: result.ok ? 200 : 409,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        })
      }
      const url = new URL(request?.url ?? 'http://localhost/')
      const force = url.searchParams.get('force') === '1'
      const state = await checker.status({ force })
      return new Response(JSON.stringify(state), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      })
    } catch (error) {
      return new Response(JSON.stringify({ ok: false, error: `更新检查失败：${error?.message ?? error}` }), {
        status: 500,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      })
    }
  }
}
