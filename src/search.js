/**
 * Retrieval: keyword scoring (BM25 over cards) + entity matching + one-hop
 * associative expansion + recency weighting.
 *
 * The point of the graph is here, not in the storage layout: a card is a hub
 * for the entities it mentions, so "what else do I know that is connected to
 * this" is an entity lookup, not a similarity search that may drift.
 */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'of', 'to', 'in', 'on', 'for', 'with',
  'is', 'are', 'was', 'were', 'be', 'been', 'it', 'this', 'that', 'these', 'those', 'as', 'at',
  'by', 'from', 'we', 'you', 'i', 'he', 'she', 'they', 'do', 'does', 'did', 'can', 'could',
  'should', 'would', 'will', 'not', 'no', 'yes', 'so', 'than', 'too', 'very', 'just', 'about',
  '的', '了', '是', '在', '和', '与', '就', '都', '也', '很', '要', '会', '把', '被', '让',
  '我', '你', '他', '她', '它', '这', '那', '个', '们', '有', '没', '不', '吗', '呢', '啊',
])

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/

export function tokenize(text) {
  const out = []
  const value = String(text ?? '').toLowerCase()
  let latin = ''
  let cjk = ''

  const flushLatin = () => {
    if (latin.length >= 2 && !STOPWORDS.has(latin)) out.push(latin)
    latin = ''
  }
  const flushCjk = () => {
    if (cjk.length === 1) {
      if (!STOPWORDS.has(cjk)) out.push(cjk)
    } else if (cjk.length > 1) {
      for (let i = 0; i < cjk.length - 1; i++) {
        const bigram = cjk.slice(i, i + 2)
        if (!STOPWORDS.has(bigram)) out.push(bigram)
      }
    }
    cjk = ''
  }

  for (const char of value) {
    if (CJK.test(char)) {
      flushLatin()
      cjk += char
    } else if (/[a-z0-9_]/.test(char)) {
      flushCjk()
      latin += char
    } else {
      flushLatin()
      flushCjk()
    }
  }
  flushLatin()
  flushCjk()

  return out
}

function termFrequency(tokens) {
  const tf = new Map()
  for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1)
  return tf
}

function docTokens(card) {
  const tokens = []
  for (let i = 0; i < 3; i++) tokens.push(...tokenize(card.title))
  for (const entity of card.entities ?? []) tokens.push(...tokenize(entity))
  tokens.push(...tokenize(card.kind))
  tokens.push(...tokenize(card.body))
  return tokens
}

function ageInDays(iso) {
  const time = Date.parse(String(iso ?? ''))
  if (!Number.isFinite(time)) return 365
  return Math.max(0, (Date.now() - time) / 86_400_000)
}

function recencyWeight(iso) {
  return 0.55 + 0.45 * Math.exp(-ageInDays(iso) / 120)
}

function statusWeight(status) {
  if (status === 'retracted') return 0
  if (status === 'superseded') return 0.4
  return 1
}

function makeSnippet(text, queryTokens, maxChars) {
  const body = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (body.length <= maxChars) return body
  const lower = body.toLowerCase()
  let best = -1
  for (const token of queryTokens) {
    if (token.length < 2) continue
    const at = lower.indexOf(token)
    if (at !== -1 && (best === -1 || at < best)) best = at
  }
  if (best === -1) return `${body.slice(0, maxChars)}…`
  const start = Math.max(0, best - Math.floor(maxChars / 3))
  return `${start > 0 ? '…' : ''}${body.slice(start, start + maxChars)}…`
}

/**
 * @returns {{ card: object, score: number, snippet: string, via: string }[]}
 */
export function searchCards(cards, query, options = {}) {
  const limit = options.limit ?? 8
  const hops = options.hops ?? 1
  const snippetChars = options.snippetChars ?? 220
  const project = options.project ?? null
  const kinds = options.kinds ?? null

  const pool = cards.filter((card) => {
    if (project && card.project !== project) return false
    if (kinds && kinds.length > 0 && !kinds.includes(card.kind)) return false
    return true
  })
  if (pool.length === 0) return []

  const queryTokens = tokenize(query)
  const uniqueQuery = [...new Set(queryTokens)]

  // ---- BM25
  const docs = pool.map((card) => {
    const tokens = docTokens(card)
    return { card, tokens, tf: termFrequency(tokens), len: tokens.length }
  })
  const avgLen = docs.reduce((sum, d) => sum + d.len, 0) / docs.length || 1
  const df = new Map()
  for (const token of uniqueQuery) {
    let count = 0
    for (const doc of docs) if (doc.tf.has(token)) count++
    df.set(token, count)
  }
  const N = docs.length
  const k1 = 1.2
  const b = 0.75

  const scored = new Map()
  for (const doc of docs) {
    let score = 0
    for (const token of uniqueQuery) {
      const tf = doc.tf.get(token)
      if (!tf) continue
      const n = df.get(token) ?? 0
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5))
      score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * doc.len) / avgLen)))
    }
    if (score <= 0) continue
    scored.set(doc.card.id, {
      card: doc.card,
      score: score * recencyWeight(doc.card.created) * statusWeight(doc.card.status),
      via: 'keyword',
    })
  }

  // ---- entity exact / substring matching (the cross-project bridge)
  const needle = String(query ?? '').toLowerCase()
  for (const card of pool) {
    let boost = 0
    for (const slug of card.entities ?? []) {
      if (slug === '' || slug.length < 2) continue
      const flat = slug.replace(/-/g, ' ')
      if (needle.includes(flat) || needle.includes(slug)) boost += 0.8
    }
    if (boost === 0) continue
    const entry = scored.get(card.id)
    const value = (entry?.score ?? 0) + boost * recencyWeight(card.created) * statusWeight(card.status)
    scored.set(card.id, { card, score: value, via: entry ? 'keyword+entity' : 'entity' })
  }

  let ranked = [...scored.values()].sort((a, b2) => b2.score - a.score)
  if (ranked.length === 0) {
    // Nothing matched lexically: fall back to the most recent durable memories.
    ranked = pool
      .slice()
      .sort((a, b2) => String(b2.created).localeCompare(String(a.created)))
      .slice(0, limit)
      .map((card) => ({ card, score: 0.05 * recencyWeight(card.created), via: 'recency' }))
    return ranked
      .filter((entry) => entry.card.status !== 'retracted')
      .slice(0, limit)
      .map((entry) => ({ ...entry, snippet: makeSnippet(entry.card.body, uniqueQuery, snippetChars) }))
  }

  // ---- associative expansion: co-mentioned entities pull in neighbours
  if (hops > 0 && ranked.length > 0) {
    const seeds = ranked.slice(0, 3)
    const seedEntities = new Set(seeds.flatMap((entry) => entry.card.entities ?? []))
    for (const card of pool) {
      if (scored.has(card.id)) continue
      if (statusWeight(card.status) === 0) continue
      const shared = (card.entities ?? []).filter((slug) => seedEntities.has(slug))
      if (shared.length === 0) continue
      const seedScore = seeds[0]?.score ?? 1
      scored.set(card.id, {
        card,
        score: seedScore * 0.25 * Math.min(1, shared.length / 2) * recencyWeight(card.created) * statusWeight(card.status),
        via: `linked:${shared.slice(0, 2).join(',')}`,
      })
    }
    ranked = [...scored.values()].sort((a, b2) => b2.score - a.score)
  }

  return ranked.slice(0, limit).map((entry) => ({
    ...entry,
    snippet: makeSnippet(entry.card.body, uniqueQuery, snippetChars),
  }))
}

export function timelineCards(cards, options = {}) {
  const limit = options.limit ?? 30
  const project = options.project ?? null
  const from = options.from ? String(options.from) : null
  const to = options.to ? String(options.to) : null
  const entity = options.entity ? String(options.entity).toLowerCase() : null

  return cards
    .filter((card) => {
      if (card.status === 'retracted') return false
      if (project && card.project !== project) return false
      const day = String(card.created).slice(0, 10)
      if (from && day < from) return false
      if (to && day > to) return false
      if (entity) {
        const haystack = `${(card.entities ?? []).join(' ')} ${card.title} ${card.body}`.toLowerCase()
        if (!haystack.includes(entity.replace(/-/g, ' ')) && !haystack.includes(entity)) return false
      }
      return true
    })
    .sort((a, b) => String(b.created).localeCompare(String(a.created)))
    .slice(0, limit)
}
