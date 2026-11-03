/**
 * The vault: a plain-text, self-describing memory store.
 *
 * Layout
 *   vault.json              schema marker
 *   projects.json           project registry (cross-project linking)
 *   episodes/YYYY-MM-DD.jsonl   append-only raw record of what happened
 *   cards/YYYY-MM/<id>.md       distilled, typed, time-bounded memories
 *   entities/<slug>.md          one page per thing, with a mention timeline
 *   audit/YYYY-MM.log           human-readable trace of every write
 *   .distill-state.json     how far extraction has read each episode file
 *
 * Nothing here is a database: every artefact is a file a human can read, diff
 * and delete. `cards/` is the semantic layer, `episodes/` the raw layer, and
 * the entity pages are the index that makes cross-project recall possible.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { paths } from './config.js'
import { renderGraphHtml } from './graph.js'
import { tokenize } from './search.js'

const CARD_KEYS = [
  'id',
  'kind',
  'title',
  'project',
  'entities',
  'created',
  'valid_from',
  'valid_to',
  'status',
  'confidence',
  'source',
  'supersedes',
  'superseded_by',
  'tags',
  'updated',
]

const ENTITY_KEYS = ['id', 'name', 'type', 'aliases', 'first_seen', 'last_seen', 'mentions']

export const CARD_KINDS = ['decision', 'fact', 'open_question', 'preference', 'note']
export const CARD_STATUS = ['active', 'superseded', 'retracted']
export const CONFIDENCE = ['user_stated', 'verified', 'inferred']

const locks = new Map()

function withLock(key, fn) {
  const previous = locks.get(key) ?? Promise.resolve()
  const next = previous.then(fn, fn)
  locks.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  )
  return next
}

async function exists(file) {
  try {
    await fsp.access(file)
    return true
  } catch {
    return false
  }
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true })
}

async function writeAtomic(file, content) {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`
  await ensureDir(path.dirname(file))
  await fsp.writeFile(tmp, content, 'utf8')
  await fsp.rename(tmp, file)
}

async function readText(file, fallback = '') {
  try {
    return await fsp.readFile(file, 'utf8')
  } catch {
    return fallback
  }
}

async function readJson(file, fallback) {
  const text = await readText(file, '')
  if (text.trim() === '') return fallback
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

export function nowIso() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const offset = -d.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

export function today() {
  return nowIso().slice(0, 10)
}

/* ---------------------------------------------------------------- frontmatter */

function encodeValue(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return String(value)
  if (Array.isArray(value)) return `[${value.map(encodeValue).join(', ')}]`
  if (typeof value === 'object') return JSON.stringify(value)
  return JSON.stringify(String(value))
}

function serializeFrontmatter(data, keyOrder) {
  const seen = new Set()
  const lines = []
  for (const key of keyOrder) {
    if (!(key in data)) continue
    seen.add(key)
    lines.push(`${key}: ${encodeValue(data[key])}`)
  }
  for (const key of Object.keys(data)) {
    if (seen.has(key)) continue
    lines.push(`${key}: ${encodeValue(data[key])}`)
  }
  return `---\n${lines.join('\n')}\n---\n`
}

function decodeValue(raw) {
  const value = raw.trim()
  if (value === '' || value === 'null' || value === '~') return null
  if (value === 'true') return true
  if (value === 'false') return false
  if (value.startsWith('[') || value.startsWith('{') || value.startsWith('"')) {
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value)
  return value
}

export function parseFrontmatter(text) {
  if (!text.startsWith('---')) return { data: {}, body: text }
  const end = text.indexOf('\n---', 3)
  if (end === -1) return { data: {}, body: text }
  const head = text.slice(3, end).replace(/^\r?\n/, '')
  const body = text.slice(text.indexOf('\n', end + 1) + 1).replace(/^\r?\n/, '')
  const data = {}
  for (const line of head.split(/\r?\n/)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const colon = line.indexOf(':')
    if (colon === -1) continue
    const key = line.slice(0, colon).trim()
    if (key === '') continue
    data[key] = decodeValue(line.slice(colon + 1))
  }
  return { data, body }
}

/* ---------------------------------------------------------------- identifiers */

function rand(n) {
  return crypto.randomBytes(8).toString('hex').slice(0, n)
}

export function newCardId() {
  return `c-${today().replace(/-/g, '')}-${rand(4)}`
}

export function slugify(name, fallback = 'item') {
  const slug = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\\/:*?"<>|#%{}^~[\]`']/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60)
  if (slug === '') return `${fallback}-${rand(4)}`
  return slug
}

export function normalizeTitle(title) {
  return String(title ?? '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[.,;:!?'"`~!@#$%^&*()_\-+=[\]{}\\|/<>，。；：！？、“”‘’（）【】《》…—]/g, '')
}

/**
 * How much two titles have in common, 0..1: Jaccard over the same tokens the
 * search uses (CJK bigrams, Latin words). Wording varies between extraction
 * runs — "蒸馏走独立模型接口" and "蒸馏用独立模型接口" are one memory, not two —
 * and a graph with both has two nodes pulling retrieval apart.
 */
export function titleSimilarity(left, right) {
  const a = new Set(tokenize(left))
  const b = new Set(tokenize(right))
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const token of a) if (b.has(token)) shared += 1
  return shared / (a.size + b.size - shared)
}

/**
 * Two titles are the same memory at this much overlap. Measured on the
 * evaluation set: unrelated cards in one project peak at 0.20 (the retired
 * Zabbix card and the Uptime Kuma one that replaced it, which must stay
 * separate), while the re-wordings one model produced for the same episode
 * scored 0.60 to 0.78. The threshold sits in that gap, low enough to catch a
 * short re-wording.
 */
export const NEAR_DUPLICATE = 0.55

/* ---------------------------------------------------------------- vault */

export function createVault(cfg, redactor) {
  const P = paths(cfg.vaultDir)
  let ready = null
  let cardCache = { at: 0, cards: null }

  async function ensure() {
    if (ready) return ready
    ready = (async () => {
      await ensureDir(P.episodes)
      await ensureDir(P.cards)
      await ensureDir(P.entities)
      await ensureDir(P.audit)

      if (!(await exists(P.vaultJson))) {
        await writeAtomic(
          P.vaultJson,
          `${JSON.stringify({ schema: 'dsh-memory-graph/1', created: nowIso(), app: 'dsh-memory-graph' }, null, 2)}\n`,
        )
      }
      if (!(await exists(P.projects))) {
        await writeAtomic(P.projects, '{}\n')
      }
      if (!(await exists(P.distillState))) {
        await writeAtomic(P.distillState, '{}\n')
      }
      // The vault is plain text so the owner can version it themselves; keep the
      // OS junk and the per-machine distillation cursors out of that repo.
      if (!(await exists(P.gitignore))) {
        await writeAtomic(P.gitignore, '*.tmp\n.DS_Store\nThumbs.db\n.distill-state.json\n')
      }
    })()
    return ready
  }

  function invalidate() {
    cardCache = { at: 0, cards: null }
  }

  async function audit(scope, message) {
    await ensure()
    const stamp = nowIso()
    const file = path.join(P.audit, `${stamp.slice(0, 7)}.log`)
    await withLock(`audit:${file}`, () => fsp.appendFile(file, `[${stamp}] ${scope}: ${message}\n`, 'utf8'))
  }

  /* ------------------------------------------------------------ projects */

  async function touchProject(slug, title) {
    await ensure()
    return withLock(`projects:${P.projects}`, async () => {
      const registry = await readJson(P.projects, {})
      const now = nowIso()
      const entry = registry[slug] ?? { title: title ?? slug, firstSeen: now, cards: 0 }
      entry.title = entry.title || title || slug
      entry.lastSeen = now
      registry[slug] = entry
      await writeAtomic(P.projects, `${JSON.stringify(registry, null, 2)}\n`)
      return entry
    })
  }

  async function listProjects() {
    await ensure()
    const registry = await readJson(P.projects, {})
    return Object.entries(registry).map(([slug, meta]) => ({ slug, ...meta }))
  }

  /* ------------------------------------------------------------ episodes */

  /**
   * Append one episode to the day it happened.
   *
   * The date in the filename is the record's own `t`, not "now": a backfilled
   * session from last month belongs in last month's file, or the vault listing
   * would claim that three months of history happened today. A record without a
   * parseable timestamp falls back to today.
   */
  async function appendEpisode(record) {
    await ensure()
    const stamp = typeof record?.t === 'string' ? record.t.slice(0, 10) : ''
    const day = /^\d{4}-\d{2}-\d{2}$/.test(stamp) ? stamp : today()
    const file = path.join(P.episodes, `${day}.jsonl`)
    const line = `${JSON.stringify(record)}\n`
    await withLock(`episode:${file}`, () => fsp.appendFile(file, line, 'utf8'))
    // Keep projects.json honest even before the first card is distilled.
    if (typeof record?.project === 'string' && record.project !== '') {
      await touchProject(record.project).catch(() => {})
    }
    return { file: path.basename(file), bytes: Buffer.byteLength(line) }
  }

  async function episodeFiles() {
    await ensure()
    let names = []
    try {
      names = await fsp.readdir(P.episodes)
    } catch {
      return []
    }
    return names.filter((n) => n.endsWith('.jsonl')).sort()
  }

  async function readUndistilled(maxEpisodes) {
    await ensure()
    const state = await readJson(P.distillState, {})
    const files = state.files ?? {}
    const out = []
    for (const name of await episodeFiles()) {
      if (out.length >= maxEpisodes) break
      const text = await readText(path.join(P.episodes, name), '')
      if (text === '') continue
      const lines = text.split('\n').filter((l) => l.trim() !== '')
      const start = files[name] ?? 0
      for (let i = start; i < lines.length && out.length < maxEpisodes; i++) {
        try {
          out.push({ file: name, line: i, record: JSON.parse(lines[i]) })
        } catch {
          // A truncated last line (process killed mid-append) is skipped, not fatal.
        }
      }
    }
    return out
  }

  async function markDistilled(entries) {
    await ensure()
    return withLock(`distill:${P.distillState}`, async () => {
      const state = await readJson(P.distillState, {})
      state.files = state.files ?? {}
      for (const entry of entries) {
        state.files[entry.file] = Math.max(state.files[entry.file] ?? 0, entry.line + 1)
      }
      state.lastRun = nowIso()
      await writeAtomic(P.distillState, `${JSON.stringify(state, null, 2)}\n`)
    })
  }

  /* ------------------------------------------------------------ cards */

  function cardPath(card) {
    return path.join(P.cards, String(card.created ?? nowIso()).slice(0, 7), `${card.id}.md`)
  }

  function renderCard(card) {
    const data = {
      id: card.id,
      kind: card.kind,
      title: card.title,
      project: card.project,
      entities: card.entities ?? [],
      created: card.created,
      valid_from: card.validFrom ?? null,
      valid_to: card.validTo ?? null,
      status: card.status ?? 'active',
      confidence: card.confidence ?? 'inferred',
      source: card.source ?? null,
      supersedes: card.supersedes ?? [],
      superseded_by: card.supersededBy ?? null,
      tags: card.tags ?? [],
      updated: card.updated ?? null,
    }
    const body = String(card.body ?? '').trim()
    const footer = [
      '',
      '---',
      `<!-- dsh-memory-graph · ${card.kind} · ${card.project} -->`,
    ].join('\n')
    return `${serializeFrontmatter(data, CARD_KEYS)}\n${body}\n${footer}\n`
  }

  function cardFromFile(file, text) {
    const { data, body } = parseFrontmatter(text)
    if (!data.id) return null
    const cleanBody = body
      .replace(/\n---\n<!-- dsh-memory-graph[^>]*-->\s*$/, '')
      .replace(/\n?<!-- dsh-memory-graph[^>]*-->\s*$/, '')
      .trim()
    return {
      id: data.id,
      kind: data.kind ?? 'note',
      title: data.title ?? '（无标题 untitled）',
      project: data.project ?? cfg.defaultProject,
      entities: Array.isArray(data.entities) ? data.entities : [],
      created: data.created ?? nowIso(),
      validFrom: data.valid_from ?? data.created ?? null,
      validTo: data.valid_to ?? null,
      status: data.status ?? 'active',
      confidence: data.confidence ?? 'inferred',
      source: data.source ?? null,
      supersedes: Array.isArray(data.supersedes) ? data.supersedes : [],
      supersededBy: data.superseded_by ?? null,
      tags: Array.isArray(data.tags) ? data.tags : [],
      updated: data.updated ?? null,
      body: cleanBody,
      file,
    }
  }

  async function listCards({ includeRetracted = false } = {}) {
    await ensure()
    const fresh = Date.now() - cardCache.at < 2000 && cardCache.cards !== null
    if (fresh) {
      return includeRetracted ? cardCache.cards : cardCache.cards.filter((c) => c.status !== 'retracted')
    }
    let names = []
    try {
      names = await fsp.readdir(P.cards, { recursive: true })
    } catch {
      names = []
    }
    const files = names.filter((n) => n.endsWith('.md'))
    const cards = []
    for (const rel of files) {
      const file = path.join(P.cards, rel)
      const text = await readText(file, '')
      const card = cardFromFile(file, text)
      if (card) cards.push(card)
    }
    cards.sort((a, b) => String(a.created).localeCompare(String(b.created)))
    cardCache = { at: Date.now(), cards }
    return includeRetracted ? cards : cards.filter((c) => c.status !== 'retracted')
  }

  async function getCard(id) {
    const cards = await listCards({ includeRetracted: true })
    return cards.find((c) => c.id === id) ?? null
  }

  /**
   * The card this write would duplicate: an exact title first, then the closest
   * re-wording of an existing active title in the same project. A card that
   * names its predecessor is a reversal, not a duplicate: "监控换成 X" after
   * "监控换到 Y" reads alike but is a new decision, so `supersedes` turns the
   * near-duplicate pass off and only an exact title can match.
   * @returns {Promise<{card: object, exact: boolean, score: number}|null>}
   */
  async function findDuplicate(title, project, { allowNear = true } = {}) {
    const target = normalizeTitle(title)
    if (target === '') return null
    const cards = (await listCards()).filter((card) => card.project === project)
    const exact = cards.find((card) => normalizeTitle(card.title) === target)
    if (exact) return { card: exact, exact: true, score: 1 }
    if (!allowNear) return null
    let best = null
    let bestScore = 0
    for (const card of cards) {
      if (card.status !== 'active') continue
      const score = titleSimilarity(title, card.title)
      if (score >= NEAR_DUPLICATE && score > bestScore) {
        best = card
        bestScore = score
      }
    }
    return best ? { card: best, exact: false, score: bestScore } : null
  }

  /**
   * Create a card, or re-confirm the identical one already present.
   * @returns {{ card: object, deduped: boolean }}
   */
  async function writeCard(input) {
    await ensure()
    return withLock('cards', async () => {
      const project = input.project || cfg.defaultProject
      const duplicate = await findDuplicate(input.title, project, {
        allowNear: (input.supersedes ?? []).length === 0,
      })
      const existing = duplicate?.card ?? null
      const stamp = nowIso()

      if (existing) {
        existing.updated = stamp
        existing.status = 'active'
        if (input.body && input.body.length > (existing.body ?? '').length) existing.body = input.body
        const merged = new Set([...(existing.entities ?? []), ...(input.entities ?? [])])
        existing.entities = [...merged]
        await writeAtomic(cardPath(existing), renderCard(existing))
        invalidate()
        await touchProject(project)
        const why = duplicate.exact
          ? ''
          : ` （近似重复 near-duplicate ${duplicate.score.toFixed(2)}，对着 "${String(input.title ?? '').trim()}"）`
        await audit('card', `再次确认 ${existing.id} "${existing.title}"${why}`)
        return { card: existing, deduped: true }
      }

      const card = {
        id: input.id ?? newCardId(),
        kind: CARD_KINDS.includes(input.kind) ? input.kind : 'note',
        title: String(input.title ?? '').trim().slice(0, 160) || '（无标题 untitled）',
        project,
        entities: [...new Set((input.entities ?? []).map((e) => slugify(e)))].filter(Boolean),
        created: input.created ?? stamp,
        validFrom: input.validFrom ?? today(),
        validTo: input.validTo ?? null,
        status: 'active',
        confidence: CONFIDENCE.includes(input.confidence) ? input.confidence : 'inferred',
        source: input.source ?? null,
        supersedes: input.supersedes ?? [],
        supersededBy: null,
        tags: input.tags ?? [],
        updated: null,
        body: String(input.body ?? '').trim(),
      }

      await writeAtomic(cardPath(card), renderCard(card))
      invalidate()
      await touchProject(project)

      for (const oldId of card.supersedes) {
        const old = await getCard(oldId)
        if (!old) continue
        old.status = 'superseded'
        old.validTo = card.validFrom
        old.supersededBy = card.id
        await writeAtomic(cardPath(old), renderCard(old))
        await audit('card', `${old.id} 已被 ${card.id} 替换（superseded）`)
      }

      await audit('card', `写入 ${card.id} [${card.kind}] "${card.title}" (${card.project})`)
      return { card, deduped: false }
    })
  }

  async function retractCard(id, reason) {
    return withLock('cards', async () => {
      const card = await getCard(id)
      if (!card) return null
      card.status = 'retracted'
      card.validTo = card.validTo ?? today()
      card.body = `${card.body}\n\n<!-- 已撤回 retracted: ${String(reason ?? '没有给出原因 · no reason given').slice(0, 200)} -->`
      await writeAtomic(cardPath(card), renderCard(card))
      invalidate()
      await audit('card', `已撤回 ${id}${reason ? ` (${reason})` : ''}`)
      return card
    })
  }

  async function purgeCard(id) {
    return withLock('cards', async () => {
      const card = await getCard(id)
      if (!card) return false
      await fsp.rm(card.file, { force: true })
      invalidate()
      await audit('card', `已彻底删除 ${id}（purged）`)
      return true
    })
  }

  /* ------------------------------------------------------------ entities */

  function entityPath(slug) {
    return path.join(P.entities, `${slug}.md`)
  }

  function renderEntity(entity) {
    const data = {
      id: entity.id,
      name: entity.name,
      type: entity.type,
      aliases: entity.aliases ?? [],
      first_seen: entity.firstSeen,
      last_seen: entity.lastSeen,
      mentions: `${entity.mentions.length}`,
    }
    const lines = (entity.mentions ?? [])
      .slice(-200)
      .map((m) => `- ${String(m.date).slice(0, 10)} · ${m.note} (${m.cardId})`)
    return `${serializeFrontmatter(data, ENTITY_KEYS)}\n${entity.name}\n\n${lines.join('\n')}\n`
  }

  async function readEntity(slug) {
    const file = entityPath(slug)
    const text = await readText(file, '')
    if (text === '') return null
    const { data, body } = parseFrontmatter(text)
    const mentions = []
    for (const line of body.split(/\r?\n/)) {
      const m = /^- (\d{4}-\d{2}-\d{2}) · (.*) \((c-[^)]+)\)$/.exec(line.trim())
      if (m) mentions.push({ date: m[1], note: m[2], cardId: m[3] })
    }
    return {
      id: data.id ?? `e-${slug}`,
      slug,
      name: data.name ?? slug,
      type: data.type ?? 'concept',
      aliases: Array.isArray(data.aliases) ? data.aliases : [],
      firstSeen: data.first_seen ?? null,
      lastSeen: data.last_seen ?? null,
      mentions,
    }
  }

  async function listEntities() {
    await ensure()
    let names = []
    try {
      names = await fsp.readdir(P.entities)
    } catch {
      return []
    }
    const out = []
    for (const name of names.filter((n) => n.endsWith('.md'))) {
      const entity = await readEntity(name.replace(/\.md$/, ''))
      if (entity) out.push(entity)
    }
    return out.sort((a, b) => (a.name > b.name ? 1 : -1))
  }

  async function linkEntities(names, card, { type = 'concept' } = {}) {
    await ensure()
    const linked = []
    for (const rawName of names ?? []) {
      const name = String(rawName ?? '').trim()
      if (name === '' || name.length > 80) continue
      const slug = slugify(name)
      const entity = (await readEntity(slug)) ?? {
        id: `e-${slug}`,
        slug,
        name,
        type,
        aliases: [],
        firstSeen: today(),
        lastSeen: today(),
        mentions: [],
      }
      if (entity.aliases.length === 0 && normalizeTitle(entity.name) !== normalizeTitle(name)) {
        entity.aliases = [entity.name]
      }
      entity.lastSeen = today()
      if (!entity.mentions.some((m) => m.cardId === card.id)) {
        entity.mentions.push({
          date: today(),
          cardId: card.id,
          note: String(card.title).slice(0, 120).replace(/\n/g, ' '),
        })
      }
      await writeAtomic(entityPath(slug), renderEntity(entity))
      linked.push(slug)
    }
    return linked
  }

  /** Write a card and wire its entity pages in one step. */
  async function saveCard(input) {
    const { card, deduped } = await writeCard(input)
    const slugs = await linkEntities(card.entities, card)
    return { card, deduped, entities: slugs }
  }

  /* ------------------------------------------------------------ readme */

  async function regenerateReadme() {
    await ensure()
    const cards = await listCards()
    const entities = await listEntities()
    const projects = await listProjects()

    const byProject = new Map()
    for (const card of cards) {
      if (!byProject.has(card.project)) byProject.set(card.project, [])
      byProject.get(card.project).push(card)
    }

    const lines = []
    lines.push('# Memory vault · 记忆库')
    lines.push('')
    lines.push('`dsh-memory-graph` 写入的纯文本长期记忆。读它、grep 它、改它、删它——它是你的。')
    lines.push('Plain-text long-term memory written by the **dsh-memory-graph** plugin — read it, grep it, edit it, delete it.')
    lines.push('')
    lines.push(`- 卡片 cards: **${cards.length}** · 实体 entities: **${entities.length}** · 项目 projects: **${projects.length}**`)
    lines.push(`- 最后更新 last updated: ${nowIso()}`)
    lines.push('- 想看图就打开同目录的 `graph.html` · open `graph.html` next to this file to see the graph')
    lines.push('')
    lines.push('## 分层 · Layers')
    lines.push('')
    lines.push('| 层 layer | 路径 path | 是什么 · what it is |')
    lines.push('| --- | --- | --- |')
    lines.push('| raw | `episodes/` | 每轮一条，只追加不修改 · one line per turn, append-only |')
    lines.push('| semantic | `cards/` | 从情节蒸馏出的带类型和日期的记忆 · typed, dated memories distilled from episodes |')
    lines.push('| index | `entities/` | 每样东西一页，附提及时间线 · one page per thing, with a mention timeline |')
    lines.push('| trace | `audit/` | 每次写入、撤回、蒸馏的记录 · every write, retraction and extraction run |')
    lines.push('')

    for (const [project, list] of [...byProject.entries()].sort()) {
      lines.push(`## ${project}`)
      lines.push('')
      const recent = list.slice(-25).reverse()
      for (const card of recent) {
        const mark = card.status === 'superseded' ? '~~' : ''
        const label = `${mark}${card.title}${mark}`
        const flag = card.status === 'active' ? '' : ` \`${card.status}\``
        lines.push(`- \`${String(card.created).slice(0, 10)}\` **${card.kind}** — ${label}${flag} · [${card.id}](cards/${card.created.slice(0, 7)}/${card.id}.md)`)
      }
      lines.push('')
    }

    if (entities.length > 0) {
      lines.push('## 实体 · Entities')
      lines.push('')
      lines.push(
        entities
          .slice(0, 120)
          .map((e) => `[${e.name}](entities/${e.slug}.md)`)
          .join(' · '),
      )
      lines.push('')
    }

    await writeAtomic(P.readme, `${lines.join('\n')}\n`)
  }

  /**
   * The single-file graph page, as a string.
   *
   * `regenerateGraph` writes it to disk for people who open the file directly;
   * this returns the same bytes to the route that embeds it in the app panel. One
   * renderer, so the panel and the file can never disagree.
   */
  async function buildGraph() {
    await ensure()
    const cards = await listCards({ includeRetracted: true })
    const entities = await listEntities()
    const projects = await listProjects()
    const html = renderGraphHtml({ cards, entities, projects, generatedAt: nowIso() })
    return { html, cards, entities, projects }
  }

  async function graphPage() {
    return (await buildGraph()).html
  }

  /**
   * Write the single-file graph view next to the README. Same inputs as the
   * readme, plus the retracted cards — the graph shows them faded rather than
   * dropping them, because "this was retracted" is itself a memory.
   */
  async function regenerateGraph() {
    const { html, cards, entities } = await buildGraph()
    await writeAtomic(P.graph, html)
    return {
      file: P.graph,
      bytes: Buffer.byteLength(html),
      cards: cards.length,
      entities: entities.length,
    }
  }

  /* ------------------------------------------------------------ stats */

  async function stats() {
    await ensure()
    const cards = await listCards({ includeRetracted: true })
    const entities = await listEntities()
    const projects = await listProjects()
    const files = await episodeFiles()
    let episodes = 0
    for (const name of files) {
      const text = await readText(path.join(P.episodes, name), '')
      episodes += text.split('\n').filter((l) => l.trim() !== '').length
    }
    const state = await readJson(P.distillState, {})
    return {
      vaultDir: cfg.vaultDir,
      cards: {
        total: cards.length,
        active: cards.filter((c) => c.status === 'active').length,
        superseded: cards.filter((c) => c.status === 'superseded').length,
        retracted: cards.filter((c) => c.status === 'retracted').length,
        byKind: cards.reduce((acc, c) => ({ ...acc, [c.kind]: (acc[c.kind] ?? 0) + 1 }), {}),
      },
      entities: entities.length,
      projects: projects.map((p) => p.slug),
      episodes: { files: files.length, records: episodes },
      distill: { lastRun: state.lastRun ?? null, cursor: state.files ?? {} },
      privacy: { rules: redactor.ruleCount },
    }
  }

  /**
   * Every episode, newest last, optionally narrowed to one Session.
   *
   * `readUndistilled` walks from a cursor and stops at a budget, which is the
   * wrong shape for a viewer that wants "what was said in THIS Session": the
   * cursor may sit past those lines already, and a Session's episodes are
   * usually the most recent records, so the whole set is read and filtered.
   * `limit` keeps the newest N after filtering.
   * @returns {Promise<Array<{file: string, line: number, record: object}>>}
   */
  async function readEpisodes({ session = null, limit = 0 } = {}) {
    await ensure()
    const out = []
    for (const name of await episodeFiles()) {
      const text = await readText(path.join(P.episodes, name), '')
      if (text === '') continue
      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === '') continue
        let record
        try {
          record = JSON.parse(lines[i])
        } catch {
          continue // a torn last line, not a reason to lose the file
        }
        if (session !== null && record?.session !== session) continue
        out.push({ file: name, line: i, record })
      }
    }
    if (limit > 0 && out.length > limit) return out.slice(out.length - limit)
    return out
  }

  /**
   * The automatic distiller's own bookkeeping.
   *
   * Kept out of `.distill-state.json` on purpose: that file is the *cursor*
   * (which lines have been read) and is written by `markDistilled`. This one
   * records attempts — including the ones that produced nothing — because the
   * gap between two automatic runs must hold even when a run wrote no cards,
   * or a quiet vault would be re-asked every minute.
   */
  async function readAutoState() {
    return readJson(P.autoState, {})
  }

  async function writeAutoState(patch) {
    return withLock(`auto:${P.autoState}`, async () => {
      const state = await readJson(P.autoState, {})
      Object.assign(state, patch)
      await writeAtomic(P.autoState, `${JSON.stringify(state, null, 2)}\n`)
      return state
    })
  }

  return {
    dir: cfg.vaultDir,
    paths: P,
    ensure,
    audit,
    appendEpisode,
    episodeFiles,
    readUndistilled,
    readEpisodes,
    readAutoState,
    writeAutoState,
    markDistilled,
    listCards,
    getCard,
    writeCard,
    saveCard,
    retractCard,
    purgeCard,
    findDuplicate,
    readEntity,
    listEntities,
    linkEntities,
    listProjects,
    touchProject,
    regenerateReadme,
    regenerateGraph,
    graphPage,
    stats,
  }
}
