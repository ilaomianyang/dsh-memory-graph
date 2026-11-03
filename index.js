/**
 * dsh-memory-graph — associative long-term memory for DeepSeek Harness.
 *
 * Design in one paragraph: the session log already remembers everything and
 * gets compacted away. This plugin keeps a second, durable layer outside the
 * context window: raw episodes (never distilled, never lost), typed memory
 * cards with temporal validity and a supersede chain, and one page per entity
 * so separate projects connect through the things they share. Retrieval is
 * explicit — the agent asks — so nothing is injected into a turn that does not
 * need it. Storage is plain files under one directory: readable, portable,
 * greppable, and owned by the user.
 *
 * Configuration has two doors. The profile's `cordis.patch.yml` is the durable
 * record (hand-written, or written by 设置 → 记忆图谱); the fields marked
 * `.volatile()` in `src/schema.js` can also be edited there while the plugin
 * runs. A volatile-only write does not remount the plugin: the Loader updates the
 * live references in place and emits `loader/volatile-update`, and `cfg` below is
 * refreshed in place so every reader of `cfg.a.b` — capture, tools, extraction,
 * search — sees the new value on its next call. Structural knobs (`enabled`,
 * `vaultDir`) stay ordinary on purpose: they are consumed once, so changing one
 * re-activates the plugin, which is the semantics it needs.
 */
import { resolveConfig } from './src/config.js'
import { createRedactor } from './src/privacy.js'
import { createVault } from './src/vault.js'
import { registerTools } from './src/tools.js'
import { registerCapture } from './src/capture.js'
import { createGraphHandler, GRAPH_PATH } from './src/graphdata.js'
import { createDistillHandler, DISTILL_PATH } from './src/distillapi.js'
import { createPageHandler, PAGE_PATH } from './src/pageapi.js'
import { createDistillRunner } from './src/distillrun.js'
import { createAutoDistiller, registerAutoDistill } from './src/auto.js'
import { createUpdateChecker, createUpdateHandler, UPDATE_PATH } from './src/update.js'
import { extractorServices } from './src/extract.js'

export const name = 'memory-graph'
export const inject = ['tools']

/**
 * Settings-form schema.
 *
 * The harness draws a plugin's page in 设置 from the schema it exports, and it
 * builds that schema with its own schemastery. So this one import is the only
 * dependency the plugin has; it is loaded opportunistically so a checkout that
 * never ran `npm install` still works — it just has no Settings page and runs on
 * the defaults in `src/config.js`.
 */
let Config
try {
  ;({ Config } = await import('./src/schema.js'))
} catch {
  Config = undefined
}
export { Config }

/**
 * A redactor whose rules can be replaced while it is in use.
 *
 * Handing the plain `createRedactor` result to the vault, the tools and the
 * extractor would freeze the privacy rules at activation time, because they hold
 * that object. This wrapper forwards every call to the rules that are current
 * now, so editing `privacy.*` in 设置 applies to the next string written instead
 * of the next restart.
 */
function createLiveRedactor(cfg) {
  let current = createRedactor(cfg.privacy)
  return {
    redact: (text, where) => current.redact(text, where),
    get ruleCount() {
      return current.ruleCount
    },
    rebuild() {
      current = createRedactor(cfg.privacy)
    },
  }
}

export function apply(ctx, config) {
  const cfg = resolveConfig(config)
  const redactor = createLiveRedactor(cfg)

  // Re-resolving in place, rather than re-running apply, is what makes a Settings
  // write land: every consumer holds this one `cfg` object and reads `cfg.a.b` at
  // call time, so the new values are live with no other file touched. A change to
  // an ordinary field still remounts the plugin, which is when this listener is
  // rebuilt against the new activation.
  ctx.on('loader/volatile-update', () => {
    try {
      Object.assign(cfg, resolveConfig(config))
      redactor.rebuild()
    } catch {
      // A half-written config must not break the running plugin: a stale
      // snapshot is better than a throw on every edit.
    }
  })

  if (!cfg.enabled) return

  const vault = createVault(cfg, redactor)

  const log = (level, message) => {
    try {
      ctx.logger?.[level]?.(`[memory-graph] ${message}`)
    } catch {
      // Logging must never break activation.
    }
  }

  ctx.effect(() => {
    vault
      .ensure()
      .then(() => vault.regenerateReadme())
      .then(() => log('info', `vault ready at ${cfg.vaultDir}`))
      .catch((error) => log('warn', `vault unavailable at ${cfg.vaultDir}: ${error?.message ?? error}`))
    return () => {}
  })

  // One distillation at a time, for the whole plugin. Three callers can ask for
  // one — the model's tool, the panel's button, and the automatic distiller — and
  // a distillation spends real model budget while advancing one cursor in the
  // vault, so they all go through this runner and the second caller is refused
  // rather than queued.
  const runner = createDistillRunner({
    getVault: () => vault,
    getConfig: () => cfg,
    getRedactor: () => redactor,
    getServices: () => extractorServices(ctx),
    refreshViews: async () => {
      for (const render of [vault.regenerateReadme, vault.regenerateGraph]) {
        if (typeof render === 'function') await render.call(vault)
      }
    },
    log,
  })

  ctx.effect(() => {
    const disposers = registerTools(ctx, { cfg, vault, redactor, runner, getUpdate: () => updates.peek() })
    log('info', `${disposers.length} memory tools registered`)
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // Disposal of an already-gone registration is not an error.
        }
      }
    }
  })

  // Version and updates. `pluginManager` is read opportunistically: a profile
  // without it (a headless composition, a test harness) still reports the version
  // it is running, it just cannot install anything.
  const pluginManager = () => {
    try {
      return ctx.get?.('pluginManager')
    } catch {
      return undefined
    }
  }
  const updates = createUpdateChecker({ cfg, log, getPluginManager: pluginManager })

  ctx.effect(() => {
    // One check at startup — it is cached for `update.checkEveryHours` after this,
    // so the cost is one request per day, not one per page load. With
    // `autoInstall` on, a newer version is installed here, before any turn runs:
    // the one moment where swapping the plugin cannot interrupt a conversation.
    updates
      .onStart()
      .then((result) => {
        if (result && typeof result.behind === 'boolean' && result.behind) log('info', `有新版本 ${result.latest}（当前 ${result.current}）`)
      })
      .catch(() => {})
    return () => {}
  })

  // The automatic distiller: a tick that decides, never a timer that fires a run.
  // Both triggers (a threshold of waiting episodes, and "every N minutes") default
  // to off and are live Settings fields, so the ticker runs whether or not they
  // are on and simply reads the config each time.
  ctx.effect(() => {
    const distiller = createAutoDistiller({ cfg, vault, run: (options) => runner.run(options), log })
    const stop = registerAutoDistill({ ctx, distiller })
    log('info', `auto distill ${cfg.auto.enabled ? 'on' : 'off'} (threshold ${cfg.auto.minEpisodes || '—'}, every ${cfg.auto.everyMinutes || '—'} min)`)
    return () => {
      try {
        stop()
      } catch {
        // ignore
      }
    }
  })

  ctx.effect(() => {
    const disposers = registerCapture(ctx, { cfg, vault, redactor })
    log('info', `episode capture registered (${cfg.capture.enabled ? 'on' : 'off'})`)
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // ignore
        }
      }
    }
  })

  // The Session memory view's data door: one exact Fetch route on the
  // authenticated `/api` channel, so the browser sends the cookie it already
  // holds and Connection rejects anything that is not the owner Peer. Two
  // deliberate choices here.
  //
  // `connection` is optional, not in `inject`: a headless or CLI profile has no
  // web server and no browser, and the plugin must keep working there — only the
  // panel is missing. `ctx.inject` keeps the subscription until the service
  // appears, so a profile that adds the web GUI later still gets the route.
  //
  // The disposer is held by this plugin's effect, not by the Connection
  // service's: uninstalling or disabling the plugin must remove the door.
  ctx.effect(() => {
    const disposeInject = ctx.inject(['connection'], (inner) => {
      const registry = inner.get('connection')?.fetch
      if (typeof registry?.register !== 'function') {
        // A build without exact Fetch routes: the plugin keeps working, the tab
        // explains itself instead of hanging on a request that can never land.
        log('warn', 'connection.fetch is unavailable; the session memory view has no data route')
        return () => {}
      }
      const disposeRoute = registry.register({
        path: GRAPH_PATH,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: createGraphHandler({ getVault: () => vault, getConfig: () => cfg }),
      })
      // The button's door. Same distillation the `memory_distill` tool runs,
      // reached from the panel; POST only, so a page load or a prefetch can never
      // spend model budget by accident.
      const disposeDistill = registry.register({
        path: DISTILL_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: createDistillHandler({ getRunner: () => runner }),
      })
      // The whole-vault graph, as the page the sidebar panel embeds. GET only and
      // read-only: it renders from cards already on disk and writes nothing.
      const disposePage = registry.register({
        path: PAGE_PATH,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: createPageHandler({ getVault: () => vault }),
      })
      // Version and updates. GET is a read (and the only method the page needs on
      // load); POST is the one verb that can install a package, so a prefetch or a
      // link preview can never trigger it.
      const disposeUpdate = registry.register({
        path: UPDATE_PATH,
        methods: ['GET', 'POST'],
        requestBody: 'buffered',
        fetch: createUpdateHandler({ getChecker: () => updates }),
      })
      log(
        'info',
        `session memory view served at ${GRAPH_PATH}, distill at ${DISTILL_PATH}, vault graph page at ${PAGE_PATH}, update at ${UPDATE_PATH}`,
      )
      return () => {
        for (const dispose of [disposeRoute, disposeDistill, disposePage, disposeUpdate]) {
          try {
            dispose?.()
          } catch {
            // A route already gone is not an error.
          }
        }
      }
    })
    return () => {
      try {
        disposeInject?.()
      } catch {
        // ignore
      }
    }
  })
}
