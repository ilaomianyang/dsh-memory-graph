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
 */
import { resolveConfig } from './src/config.js'
import { createRedactor } from './src/privacy.js'
import { createVault } from './src/vault.js'
import { registerTools } from './src/tools.js'
import { registerCapture } from './src/capture.js'

export const name = 'memory-graph'
export const inject = ['tools']

export function apply(ctx, config) {
  const cfg = resolveConfig(config)
  if (!cfg.enabled) return

  const redactor = createRedactor(cfg.privacy)
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

  ctx.effect(() => {
    const disposers = registerTools(ctx, { cfg, vault, redactor })
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

  ctx.effect(() => {
    const disposers = registerCapture(ctx, { cfg, vault, redactor })
    if (cfg.capture.enabled) log('info', 'episode capture is on')
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
}
