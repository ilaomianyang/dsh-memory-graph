/**
 * Config defaults and normalisation.
 *
 * The Settings form is drawn from the schema in `src/schema.js`, but that form
 * is a convenience, not the contract: every field is normalised here again, so a
 * config written by hand in `cordis.patch.yml`, or one carrying a stale key from
 * an older version, still resolves to a usable configuration.
 *
 * This is also the seam between the two config worlds. A field declared
 * `.volatile()` arrives here as a live reference rather than a value; this module
 * unwraps it, so everything downstream sees plain values, and re-resolving on
 * `loader/volatile-update` turns a Settings write into a new snapshot.
 */
import os from 'node:os'
import path from 'node:path'

/** Credential shapes that must never reach a vault file. User rules are added to these. */
export const DEFAULT_DENY_PATTERNS = [
  'sk-ant-[A-Za-z0-9_-]{20,}',
  'sk-[A-Za-z0-9_-]{24,}',
  'ghp_[A-Za-z0-9]{20,}',
  'github_pat_[A-Za-z0-9_]{20,}',
  'glpat-[A-Za-z0-9_-]{16,}',
  'xox[baprs]-[A-Za-z0-9-]{10,}',
  'AKIA[0-9A-Z]{16}',
  'AIza[0-9A-Za-z_-]{30,}',
  '-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----',
  '(?i)bearer\\s+[A-Za-z0-9._~+/-]{20,}={0,2}',
  '(?i)(password|passwd|secret|api[_-]?key|access[_-]?token)\\s*[:=]\\s*["\']?\\S{6,}',
]

/**
 * Text the harness injects into the conversation as a user message: compaction
 * checkpoints, runtime-context snapshots, skill-catalog reminders. They are not
 * user intent, and distilling them would manufacture memories out of nothing.
 */
export const DEFAULT_SKIP_PATTERNS = [
  '^This is an automatically generated checkpoint',
  '^Current runtime context\\.',
  '<system-reminder>',
]

const DEFAULTS = {
  enabled: true,
  vaultDir: '',
  /** Project tag used when a session has no usable cwd. */
  defaultProject: 'shared',
  /** Link new cards into project-level entity hubs so cross-project recall works. */
  crossProject: true,
  capture: {
    enabled: true,
    userChars: 1500,
    assistantChars: 1500,
    includeToolOutput: false,
    minChars: 12,
    skipPatterns: [...DEFAULT_SKIP_PATTERNS],
  },
  privacy: {
    useDefaultPatterns: true,
    denyPatterns: [],
    redactEmails: true,
    redactPaths: true,
  },
  extractor: {
    enabled: false,
    /**
     * `harness` borrows a route the Settings → Models page already configured
     * (provider, key, base URL, thinking level), so the extractor needs no
     * credentials of its own. `http` posts to an OpenAI-compatible endpoint with
     * the key below, for machines where no model is configured in Settings.
     */
    transport: 'harness',
    /** harness: follow the model currently selected in Settings instead of provider/model. */
    useCurrentModel: true,
    /** harness: provider route id, e.g. `deepseek`, `wb`, `agy-local`. */
    provider: '',
    /** harness: thinking level for this call, when the route offers one. '' keeps the route default. */
    reasoningEffort: '',
    baseUrl: 'https://api.deepseek.com/v1',
    path: '/chat/completions',
    /**
     * Empty by default: in harness mode the model comes from Settings, and an
     * id left here would only be used with `useCurrentModel` off. http mode
     * fills in `deepseek-chat` at normalisation time.
     */
    model: '',
    apiKeyEnv: 'MEMORY_LLM_API_KEY',
    apiKey: '',
    maxOutputTokens: 3000,
    temperature: 0.1,
    timeoutMs: 90000,
    maxEpisodesPerRun: 40,
  },
  retrieval: {
    limit: 8,
    hops: 1,
    snippetChars: 220,
    timelineLimit: 30,
  },
  /**
   * The automatic distiller: two independent triggers that share one tick and
   * one lock. Both default to off — a background model call is the user's
   * decision, never the plugin's.
   */
  auto: {
    enabled: false,
    /** Undistilled-episode threshold; 0 turns the threshold rule off. */
    minEpisodes: 0,
    /** Minutes between runs; 0 turns the schedule rule off. */
    everyMinutes: 0,
    /** Never two automatic runs closer than this, whichever rule fired. */
    minGapMinutes: 30,
    /** `23:00-08:00` style window in which nothing runs. Empty means always. */
    quietHours: '',
    /** Project tag for automatic cards; empty uses the newest episode's project. */
    project: '',
    /**
     * Catch-up mode: instead of waiting for the schedule, keep running a batch
     * every `catchUpEveryMinutes` while a full batch is still waiting — and stop
     * at `maxBatchesPerDay`. This is what turns a backlog (an imported history,
     * a week of sessions) into something that drains itself without a person
     * pressing a button, while still capping what it can spend in one day.
     */
    catchUp: false,
    /** Minutes between catch-up batches. */
    catchUpEveryMinutes: 10,
    /** Most automatic batches in one calendar day; 0 turns the daily cap off. */
    maxBatchesPerDay: 6,
  },

  /**
   * Update checking. The plugin asks the registry what the newest version is and
   * compares it with the version it is running; it never installs unless asked
   * (`autoInstall`) or a person presses the button. One HTTPS GET, no query
   * string, nothing about the vault or the user in it.
   */
  update: {
    enabled: true,
    /** Hours a check result stays good for. */
    checkEveryHours: 12,
    /** Install a newer version at startup without being asked. */
    autoInstall: false,
    /** Registry to ask; empty uses the plugin manager's, then npm's own. */
    registry: '',
  },
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** True for the frozen reference a `.volatile()` leaf validates to, not for a value. */
function isVolatileRef(value) {
  return value !== null && typeof value === 'object' && VOLATILE_WRITE in value
}

/**
 * Replace every volatile reference with the value it holds right now.
 *
 * A field marked `.volatile()` in `src/schema.js` does not validate to its value:
 * it validates to a frozen `{ get() }` handle, and the settings page writes
 * through that handle. Everything below this function — the defaults merge, the
 * normalisation, and the caller's `cfg` — deals in plain values, so the refs are
 * unwrapped at the one place config enters the plugin. `resolveConfig` runs again
 * on every `loader/volatile-update`, which is how a Settings write becomes a
 * fresh snapshot.
 *
 * This is also what makes `{ ...DEFAULTS, ...config }` safe: a ref is a plain
 * object whose only own key is `get`, so merging without unwrapping would keep
 * the defaults and drop the user's value without any error.
 */
export function unwrapConfig(value) {
  if (isVolatileRef(value)) return unwrapConfig(value.get())
  if (Array.isArray(value)) return value.map(unwrapConfig)
  if (isPlainObject(value)) {
    const out = {}
    for (const [key, child] of Object.entries(value)) out[key] = unwrapConfig(child)
    return out
  }
  return value
}

function merge(base, override) {
  if (!isPlainObject(override)) return { ...base }
  const out = { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? merge(base[key], value) : value
  }
  return out
}

function expandHome(input) {
  if (typeof input !== 'string' || input.trim() === '') return ''
  const trimmed = input.trim()
  if (trimmed === '~') return os.homedir()
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(os.homedir(), trimmed.slice(2))
  }
  return trimmed
}

function int(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

export function resolveConfig(raw) {
  const cfg = merge(DEFAULTS, unwrapConfig(raw ?? {}))

  const dir = expandHome(cfg.vaultDir)
  cfg.vaultDir = dir === '' ? path.join(os.homedir(), 'dsh-memory') : path.resolve(dir)

  cfg.capture.userChars = int(cfg.capture.userChars, 1500, 200, 20000)
  cfg.capture.assistantChars = int(cfg.capture.assistantChars, 1500, 200, 20000)
  cfg.capture.minChars = int(cfg.capture.minChars, 12, 0, 500)

  cfg.retrieval.limit = int(cfg.retrieval.limit, 8, 1, 40)
  cfg.retrieval.hops = int(cfg.retrieval.hops, 1, 0, 2)
  cfg.retrieval.snippetChars = int(cfg.retrieval.snippetChars, 220, 60, 2000)
  cfg.retrieval.timelineLimit = int(cfg.retrieval.timelineLimit, 30, 1, 200)

  cfg.extractor.maxOutputTokens = int(cfg.extractor.maxOutputTokens, 3000, 256, 32000)
  cfg.extractor.timeoutMs = int(cfg.extractor.timeoutMs, 90000, 5000, 600000)
  cfg.extractor.maxEpisodesPerRun = int(cfg.extractor.maxEpisodesPerRun, 40, 1, 400)

  cfg.privacy.denyPatterns = Array.isArray(cfg.privacy.denyPatterns)
    ? cfg.privacy.denyPatterns.filter((p) => typeof p === 'string' && p.trim() !== '')
    : []

  // A user list replaces the defaults; drop anything that is not a usable regex
  // rather than letting one typo disable capture for the whole session.
  cfg.capture.skipPatterns = Array.isArray(cfg.capture.skipPatterns)
    ? cfg.capture.skipPatterns.filter((p) => {
        if (typeof p !== 'string' || p.trim() === '') return false
        try {
          new RegExp(p, 'i')
          return true
        } catch {
          return false
        }
      })
    : []

  // Anything that is not the explicit escape hatch means the borrowed route:
  // a stale or misspelled transport must not silently become an HTTP call that
  // fails later for a missing key.
  cfg.extractor.transport = cfg.extractor.transport === 'http' ? 'http' : 'harness'
  cfg.extractor.useCurrentModel = cfg.extractor.useCurrentModel !== false
  cfg.extractor.provider = String(cfg.extractor.provider || '').trim()
  cfg.extractor.reasoningEffort = String(cfg.extractor.reasoningEffort || '').trim()
  cfg.extractor.baseUrl = String(cfg.extractor.baseUrl || '').replace(/\/+$/, '')
  cfg.extractor.path = String(cfg.extractor.path || '/chat/completions')
  // In http mode `model` is an OpenAI model name with a sensible default; in
  // harness mode it is an id that must be taken literally, so a cleared field
  // stays empty and `resolveRoute` can say what is missing.
  cfg.extractor.model =
    cfg.extractor.transport === 'http' ? String(cfg.extractor.model || 'deepseek-chat') : String(cfg.extractor.model || '')
  cfg.extractor.apiKeyEnv = String(cfg.extractor.apiKeyEnv || 'MEMORY_LLM_API_KEY')

  cfg.auto.enabled = cfg.auto.enabled === true
  cfg.auto.minEpisodes = int(cfg.auto.minEpisodes, 0, 0, 400)
  cfg.auto.everyMinutes = int(cfg.auto.everyMinutes, 0, 0, 10080)
  cfg.auto.minGapMinutes = int(cfg.auto.minGapMinutes, 30, 0, 1440)
  cfg.auto.project = String(cfg.auto.project || '').trim()
  // A malformed window must not disable the rule or, worse, silence it forever:
  // parse what is parseable and fall back to "no quiet hours".
  cfg.auto.quietHours = parseQuietHours(cfg.auto.quietHours) === null ? '' : String(cfg.auto.quietHours).trim()
  cfg.auto.catchUp = cfg.auto.catchUp === true
  cfg.auto.catchUpEveryMinutes = int(cfg.auto.catchUpEveryMinutes, 10, 1, 1440)
  cfg.auto.maxBatchesPerDay = int(cfg.auto.maxBatchesPerDay, 6, 0, 200)

  cfg.update.enabled = cfg.update.enabled !== false
  cfg.update.checkEveryHours = int(cfg.update.checkEveryHours, 12, 1, 24 * 30)
  cfg.update.autoInstall = cfg.update.autoInstall === true
  cfg.update.registry = String(cfg.update.registry || '').trim().replace(/\/+$/, '')

  return cfg
}

/**
 * `23:00-08:00` → minute bounds for comparison; `null` when the text is unusable.
 *
 * Exported because the auto distiller and the Settings hint must agree on what
 * counts as a valid window, and a window crossing midnight (start > end) is the
 * common case, not an edge case.
 */
export function parseQuietHours(text) {
  const raw = String(text ?? '').trim()
  if (raw === '') return null
  const match = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/u.exec(raw)
  if (!match) return null
  const [fromH, fromM, toH, toM] = match.slice(1).map(Number)
  if (fromH > 23 || toH > 23 || fromM > 59 || toM > 59) return null
  return { from: fromH * 60 + fromM, to: toH * 60 + toM }
}

export function paths(vaultDir) {
  return {
    root: vaultDir,
    gitignore: path.join(vaultDir, '.gitignore'),
    vaultJson: path.join(vaultDir, 'vault.json'),
    readme: path.join(vaultDir, 'README.md'),
    graph: path.join(vaultDir, 'graph.html'),
    projects: path.join(vaultDir, 'projects.json'),
    episodes: path.join(vaultDir, 'episodes'),
    cards: path.join(vaultDir, 'cards'),
    entities: path.join(vaultDir, 'entities'),
    audit: path.join(vaultDir, 'audit'),
    distillState: path.join(vaultDir, '.distill-state.json'),
    autoState: path.join(vaultDir, '.auto-state.json'),
    updateState: path.join(vaultDir, '.update-state.json'),
  }
}
