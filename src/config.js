/**
 * Config defaults and normalisation.
 *
 * The plugin deliberately exports no `Config` schema: it stays dependency-free
 * (no schemastery/zod resolution needed), so the row's `config` object is
 * validated here at activation and every field has a working default.
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
    baseUrl: 'https://api.deepseek.com/v1',
    path: '/chat/completions',
    model: 'deepseek-chat',
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
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
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
  const cfg = merge(DEFAULTS, raw)

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

  cfg.extractor.baseUrl = String(cfg.extractor.baseUrl || '').replace(/\/+$/, '')
  cfg.extractor.path = String(cfg.extractor.path || '/chat/completions')
  cfg.extractor.model = String(cfg.extractor.model || 'deepseek-chat')
  cfg.extractor.apiKeyEnv = String(cfg.extractor.apiKeyEnv || 'MEMORY_LLM_API_KEY')

  return cfg
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
  }
}
