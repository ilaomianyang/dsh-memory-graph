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
  'still', 'now', 'currently', 'actually', 'really', 'what', 'why', 'how', 'when', 'where',
  'which', 'who', 'whose', 'ever', 'any', 'some', 'there', 'here',
  // Single characters.
  '的', '了', '是', '在', '和', '与', '就', '都', '也', '很', '要', '会', '把', '被', '让',
  '我', '你', '他', '她', '它', '这', '那', '个', '们', '有', '没', '不', '吗', '呢', '啊',
  // Multi-character function words. Chinese is bigram-tokenised, so a question word
  // becomes tokens that look rare to BM25 (`什么` may appear in two cards out of forty)
  // and would otherwise outrank the actual subject of the question. These carry no
  // topic: they are how the question is asked, not what it is about.
  '什么', '为什', '怎么', '怎样', '如何', '是否', '能否', '多少', '哪些', '哪个', '哪里',
  '这个', '那个', '这些', '那些', '这样', '那样', '一个', '一下', '一样', '一点', '一些',
  '是不', '不是', '要不', '不要', '不用', '没有', '可以', '可能', '应该', '需要', '现在', '已经',
  '还是', '就是', '也是', '都是', '只是', '但是', '因为', '所以', '如果', '然后', '而且',
  '出来', '起来', '下来', '过来', '进去', '上来', '还在', '在用', '有没', '有什', '么样',
  '我们', '你们', '他们', '她们', '它们', '自己', '这套', '那套', '东西', '时候', '地方',
  '啥样', '咋样', '一眼', '确定', '知道', '觉得', '看看', '说说',
])

/**
 * Characters that carry grammar rather than subject matter.
 *
 * Enumerating whole function *words* does not generalise: every new way of asking
 * a question produces new fragments — "到底是不是" splits into `底是`, `是不`,
 * `不是`; "做了没有" into `做了`, `了没`, `没有`. Each fragment is rare in the
 * corpus, so BM25 gives it a high idf and it behaves like a rare topic word. The
 * filter therefore has to be a rule about the characters: a bigram touching a
 * function character at either end is a piece of a phrase, not a term.
 *
 * Only characters that are *almost always* grammatical belong here. `有`, `不`,
 * `要` and `得` are deliberately absent: they are equally common inside content
 * words (`所有`, `不同`, `需要`, `得到`), and a first version that included them
 * did real damage — the question "所有项目都要零依赖吗" lost `所有` and `要零`,
 * which is exactly what it was asking about.
 */
const CJK_FUNCTION_CHARS = new Set(
  [...'的了吗呢吧啊呀嘛么什怎哪谁几是在和与就都也很把被让我你他她它们这那没为个么要'],
)

/**
 * Words that ask about the *history* of something rather than its current state.
 *
 * `原来` is not in the list on purpose: as often as not it means "so that's why",
 * which is a discovery about the present, and treating it as history lifted a
 * retired card by 6.7× in probing.
 */
const HISTORY_INTENT =
  /(最早|最初|起初|一开始|先用|起初那|以前|之前|先前|原先|原本|原来那|当初|当年|从前|那会儿|那阵子|当时|上一版|上一套|上一代|老版本|老做法|旧版|旧方案|旧的做法|旧的|那版|历史|曾经|改过|变过|换过|放弃了|不用了|what did we (?:originally|first)|originally|initially|used to|previously|earlier|before that|first version)/i

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
      if (!STOPWORDS.has(cjk) && !CJK_FUNCTION_CHARS.has(cjk)) out.push(cjk)
    } else if (cjk.length > 1) {
      for (let i = 0; i < cjk.length - 1; i++) {
        const bigram = cjk.slice(i, i + 2)
        if (STOPWORDS.has(bigram)) continue
        // "开着吗" must not yield `着吗`, and "到底是不是" must not yield `底是`.
        if (CJK_FUNCTION_CHARS.has(bigram[0]) || CJK_FUNCTION_CHARS.has(bigram[1])) continue
        out.push(bigram)
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

function statusWeight(status, history = false) {
  if (status === 'retracted') return 0
  // A retired memory keeps only a trace of its weight: it is still worth finding
  // when nothing else matches, but it must never outrank the card that replaced it
  // — and a question asked in the old wording is exactly when that would happen.
  // Unless the question is asking about the past: "最早那版是什么" is a normal thing
  // to ask a memory, and demoting the old card there makes the answer unreachable.
  if (status === 'superseded') return history ? 1 : 0.15
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
  // Asking about the past is a different question from asking about the present:
  // the same words should surface the superseded card, not only its successor.
  const history = HISTORY_INTENT.test(String(query ?? ''))
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
      raw: score,
      score: score * recencyWeight(doc.card.created) * statusWeight(doc.card.status, history),
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
    const value = (entry?.score ?? 0) + boost * recencyWeight(card.created) * statusWeight(card.status, history)
    scored.set(card.id, { card, raw: (entry?.raw ?? 0) + boost, score: value, via: entry ? 'keyword+entity' : 'entity' })
  }

  // ---- follow the superseded edge forward.
  // Matching a retired memory is a signal, not a hit: the question was phrased in
  // the old words and the answer is now its successor. Without this the freshest
  // state of a topic loses to the stale card that happens to share its wording.
  //
  // Not when the question is about the past, though. "告警最早是发邮件的吗" wants
  // the old card, and pushing its own score onto the successor lifts the successor
  // above the very card that was asked for.
  const byId = new Map(pool.map((card) => [card.id, card]))
  const staleHits = history ? [] : [...scored.values()].filter((e) => e.card.status === 'superseded')
  for (const entry of staleHits) {
    if (!entry.card.supersededBy) continue
    const successor = byId.get(entry.card.supersededBy)
    if (!successor || successor.status !== 'active') continue
    const pull = (entry.raw ?? 0) * 0.9 * recencyWeight(successor.created) * statusWeight(successor.status, history)
    const existing = scored.get(successor.id)
    if (!existing) {
      scored.set(successor.id, { card: successor, raw: (entry.raw ?? 0) * 0.9, score: pull, via: `supersedes:${entry.card.id}` })
    } else if (existing.score < pull) {
      existing.score = pull
      existing.raw = Math.max(existing.raw ?? 0, (entry.raw ?? 0) * 0.9)
      existing.via = `${existing.via}+supersedes`
    }
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
      if (statusWeight(card.status, history) === 0) continue
      const shared = (card.entities ?? []).filter((slug) => seedEntities.has(slug))
      if (shared.length === 0) continue
      const seedScore = seeds[0]?.score ?? 1
      scored.set(card.id, {
        card,
        score: seedScore * 0.25 * Math.min(1, shared.length / 2) * recencyWeight(card.created) * statusWeight(card.status, history),
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
