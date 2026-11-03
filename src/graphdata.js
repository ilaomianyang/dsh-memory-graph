/**
 * The data behind the Session memory view: what THIS conversation left in the
 * vault, and what it is connected to.
 *
 * Two properties matter more than richness here.
 *
 * **It is honest.** Every edge says something the vault can prove: the session
 * said this episode, the card mentions this entity, this episode's text names
 * that entity, this session's own words would retrieve that card (the same
 * `searchCards` the model calls). Nothing is drawn on a guess, so a sparse graph
 * means the memory really is sparse — which is the useful reading.
 *
 * **It fits a panel.** Nodes are capped per kind and the layout is computed here,
 * on the host, so the browser receives coordinates and draws them: no force
 * simulation in React, no re-layout when the tab is reopened, and one payload
 * small enough to poll. Coordinates are deterministic — same vault, same shape —
 * because the layout is seeded from the node order, not from `Math.random`.
 */
import { searchCards } from './search.js'
import { json } from './http.js'

/** The exact path the host serves and the panel fetches. Authenticated by Connection. */
export const GRAPH_PATH = '/api/memory-graph.graph'

export const GRAPH_LIMITS = {
  episodes: 40,
  cards: 60,
  entities: 40,
  foreignCards: 12,
  recall: 8,
  episodePreview: 180,
  cardBody: 320,
}

const WIDTH = 1080
const HEIGHT = 640
const PADDING = 56
// How far the normalisation may stretch one axis relative to the other.
const STRETCH = 2.6

function clip(text, max) {
  const value = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (value.length <= max) return value
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

function shortId(id) {
  const value = String(id ?? '')
  return value.length <= 8 ? value : value.slice(0, 8)
}

/**
 * The project this conversation belongs to: the one its episodes name most
 * often. A session can span projects (a cwd change mid-conversation, or capture
 * running with cross-project memory), so the majority wins and the rest still
 * show up as connected cards.
 */
export function dominantProject(episodes) {
  const counts = new Map()
  for (const record of episodes) {
    const project = typeof record?.project === 'string' ? record.project : ''
    if (project === '') continue
    counts.set(project, (counts.get(project) ?? 0) + 1)
  }
  let best = null
  let bestCount = 0
  for (const [project, count] of counts) {
    if (count > bestCount) {
      best = project
      bestCount = count
    }
  }
  return best
}

/**
 * What this session would ask the memory if the user said "and what do you
 * remember about that?". The last few user lines are the best available proxy:
 * they are the part of the conversation the model is actually working on.
 */
export function recallQuery(episodes, { turns = 3, maxChars = 1200 } = {}) {
  const lines = []
  for (let i = episodes.length - 1; i >= 0 && lines.length < turns; i--) {
    const user = String(episodes[i]?.user ?? '').trim()
    if (user !== '') lines.push(user)
  }
  const query = lines.join('\n').trim()
  return query.length <= maxChars ? query : query.slice(0, maxChars)
}

/** Entity slugs named in a piece of text, matched on the name and its aliases. */
function entitiesInText(entities, text) {
  const haystack = String(text ?? '').toLowerCase()
  if (haystack === '') return []
  const found = []
  for (const entity of entities) {
    const needles = [entity.name, ...(entity.aliases ?? [])]
      .map((value) => String(value ?? '').trim().toLowerCase())
      .filter((value) => value.length >= 2)
    if (needles.some((needle) => haystack.includes(needle))) found.push(entity.slug)
  }
  return found
}

/**
 * A small deterministic force layout, run once on the host.
 *
 * Repulsion keeps unrelated nodes apart, springs hold the things that are
 * linked together, and the centre pull keeps the whole thing inside the box;
 * the cooling factor makes later iterations settle instead of oscillate. The
 * result is normalised into a fixed box so the browser only has to map it onto
 * the SVG viewBox.
 */
export function layoutNodes(nodes, links, { width = WIDTH, height = HEIGHT, padding = PADDING, iterations = 220 } = {}) {
  const count = nodes.length
  if (count === 0) return
  const index = new Map(nodes.map((node, i) => [node.key, i]))
  const pos = nodes.map((node, i) => {
    // Seeded on a ring by kind so the first frames already separate the layers.
    const angle = (i / Math.max(1, count)) * Math.PI * 2
    const radius = node.k === 'session' ? 0 : node.k === 'episode' ? 0.34 : node.k === 'card' ? 0.26 : 0.46
    return {
      x: Math.cos(angle) * radius * width + (i % 3) - 1,
      y: Math.sin(angle) * radius * height + (i % 5) - 2,
      vx: 0,
      vy: 0,
    }
  })

  const edges = []
  for (const link of links) {
    const a = index.get(link.s)
    const b = index.get(link.t)
    if (a === undefined || b === undefined || a === b) continue
    edges.push([a, b])
  }

  for (let step = 0; step < iterations; step++) {
    const cooling = 1 - step / iterations

    for (let i = 0; i < count; i++) {
      for (let j = i + 1; j < count; j++) {
        let dx = pos[i].x - pos[j].x
        let dy = pos[i].y - pos[j].y
        let squared = dx * dx + dy * dy
        if (squared < 1) {
          dx = ((i % 7) - 3 || 0.5) * 0.5
          dy = ((j % 5) - 2 || 0.5) * 0.5
          squared = dx * dx + dy * dy + 1
        }
        const distance = Math.sqrt(squared)
        const force = Math.min(10, 5200 / squared) * cooling
        const ux = (dx / distance) * force
        const uy = (dy / distance) * force
        pos[i].vx += ux
        pos[i].vy += uy
        pos[j].vx -= ux
        pos[j].vy -= uy
      }
    }

    for (const [a, b] of edges) {
      const dx = pos[b].x - pos[a].x
      const dy = pos[b].y - pos[a].y
      const distance = Math.hypot(dx, dy) || 1
      const force = (distance - 120) * 0.014 * cooling
      const ux = (dx / distance) * force
      const uy = (dy / distance) * force
      pos[a].vx += ux
      pos[a].vy += uy
      pos[b].vx -= ux
      pos[b].vy -= uy
    }

    for (const point of pos) {
      point.vx -= point.x * 0.0026 * cooling
      point.vy -= point.y * 0.0026 * cooling
      point.x += Math.max(-26, Math.min(26, point.vx))
      point.y += Math.max(-26, Math.min(26, point.vy))
      point.vx *= 0.6
      point.vy *= 0.6
    }
  }

  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const point of pos) {
    if (point.x < minX) minX = point.x
    if (point.x > maxX) maxX = point.x
    if (point.y < minY) minY = point.y
    if (point.y > maxY) maxY = point.y
  }
  const spanX = Math.max(1, maxX - minX)
  const spanY = Math.max(1, maxY - minY)
  // Fill the box on both axes instead of fitting the smaller one: the canvas is
  // 1080×640, and a star of eight episodes would otherwise sit in a small circle
  // with two thirds of the canvas empty. The distortion is capped so a nearly
  // one-dimensional layout (a long chain) is not smeared flat.
  const base = Math.min((width - padding * 2) / spanX, (height - padding * 2) / spanY)
  const scaleX = Math.min((width - padding * 2) / spanX, base * STRETCH)
  const scaleY = Math.min((height - padding * 2) / spanY, base * STRETCH)
  const offsetX = (width - spanX * scaleX) / 2
  const offsetY = (height - spanY * scaleY) / 2
  nodes.forEach((node, i) => {
    node.x = Math.round((pos[i].x - minX) * scaleX + offsetX)
    node.y = Math.round((pos[i].y - minY) * scaleY + offsetY)
  })
}

/**
 * Build the payload for one Session.
 *
 * `session` is the Session id capture recorded on each episode, so this is a
 * filter over the vault, never a heuristic. A Session with no episodes is a
 * normal answer (capture off, or a conversation that never reached a turn
 * boundary): the payload says so with `empty` and still shows the project the
 * default points at, so the panel can explain itself instead of going blank.
 */
export async function buildSessionGraph({ vault, session, project: fallbackProject = null, limits = {} }) {
  const caps = { ...GRAPH_LIMITS, ...limits }
  const wanted = String(session ?? '')

  const read = wanted === '' ? [] : await vault.readEpisodes({ session: wanted })
  const records = read.map((entry) => entry.record).filter(Boolean)
  const truncatedEpisodes = records.length > caps.episodes
  const episodes = truncatedEpisodes ? records.slice(records.length - caps.episodes) : records

  const project = dominantProject(records) ?? fallbackProject ?? null
  const allCards = await vault.listCards()
  const allEntities = await vault.listEntities()
  const entityBySlug = new Map(allEntities.map((entity) => [entity.slug, entity]))

  const query = recallQuery(episodes)
  const recalled = query === '' ? [] : searchCards(allCards, query, { limit: caps.recall, hops: 1 })
  const recalledIds = recalled.map((hit) => hit.card.id)

  // Cards to draw, in priority order: what this session's own words retrieve
  // (even from another project — that is the cross-project claim), then the
  // rest of its project newest-first, so the cap never drops what the session
  // is actually about.
  const recalledCards = recalled.map((hit) => hit.card)
  const inProject = allCards.filter((card) => project !== null && card.project === project)
  const ordered = []
  const orderedIds = new Set()
  for (const card of [
    ...recalledCards,
    ...inProject
      .filter((candidate) => !recalledIds.includes(candidate.id))
      .sort((a, b) => String(b.created).localeCompare(String(a.created))),
  ]) {
    if (orderedIds.has(card.id)) continue
    orderedIds.add(card.id)
    ordered.push(card)
  }
  const truncatedCards = ordered.length > caps.cards
  const cards = ordered.slice(0, caps.cards)

  const nodes = []
  const links = []
  const seenLinks = new Set()
  const link = (s, t, k) => {
    if (s === t) return
    const key = `${s}|${t}|${k}`
    if (seenLinks.has(key)) return
    seenLinks.add(key)
    links.push({ s, t, k })
  }

  const sessionKey = 's:session'
  nodes.push({
    key: sessionKey,
    k: 'session',
    label: '',
    sub: `${records.length}`,
    r: 15,
  })

  // --- this conversation's own words
  for (let i = 0; i < episodes.length; i++) {
    const record = episodes[i]
    const entry = truncatedEpisodes ? read[read.length - episodes.length + i] : read[i]
    const key = `e:${entry?.file ?? i}:${entry?.line ?? i}`
    nodes.push({
      key,
      k: 'episode',
      label: `T${record.turn ?? i + 1}`,
      sub: String(record.t ?? '').slice(11, 16),
      text: clip(record.user, caps.episodePreview),
      t: record.t ?? null,
      r: 7,
    })
    link(sessionKey, key, 'said')
  }

  // --- memory cards: the session's own project, plus recalled cards from
  // elsewhere, which keep their own project and are drawn as the bridge they are
  const cardByKey = new Map()
  for (const card of cards) {
    const key = `c:${card.id}`
    const hot = recalledIds.includes(card.id)
    const foreign = project !== null && card.project !== project
    nodes.push({
      key,
      k: 'card',
      label: clip(card.title, 40),
      sub: card.kind,
      id: card.id,
      title: String(card.title ?? ''),
      kind: String(card.kind ?? 'note'),
      project: card.project ?? project ?? '',
      status: card.status ?? 'active',
      confidence: card.confidence ?? 'inferred',
      created: String(card.created ?? '').slice(0, 10),
      validFrom: card.validFrom ?? null,
      body: clip(card.body, caps.cardBody),
      tags: card.tags ?? [],
      entityNames: (card.entities ?? []).map((slug) => entityBySlug.get(slug)?.name ?? slug),
      supersedes: card.supersedes ?? [],
      supersededBy: card.supersededBy ?? null,
      hot,
      foreign,
      r: hot ? 12 : 9,
    })
    cardByKey.set(card.id, key)
    if (hot) link(sessionKey, key, 'recall')
  }

  // --- entities: the ones these cards mention, plus the ones this session named
  const entitySlugs = new Set()
  for (const card of cards) for (const slug of card.entities ?? []) entitySlugs.add(slug)
  for (const record of episodes) {
    for (const slug of entitiesInText(allEntities, `${record.user ?? ''}`)) entitySlugs.add(slug)
  }
  const entityList = [...entitySlugs].filter((slug) => entityBySlug.has(slug)).slice(0, caps.entities)
  const entityKeyBySlug = new Map()
  for (const slug of entityList) {
    const entity = entityBySlug.get(slug)
    const key = `x:${slug}`
    entityKeyBySlug.set(slug, key)
    nodes.push({
      key,
      k: 'entity',
      label: String(entity.name ?? slug),
      sub: entity.type ?? 'concept',
      slug,
      mentions: (entity.mentions ?? []).length,
      r: 7,
    })
  }

  for (const card of cards) {
    const source = cardByKey.get(card.id)
    for (const slug of card.entities ?? []) {
      const target = entityKeyBySlug.get(slug)
      if (target !== undefined) link(source, target, 'mentions')
    }
  }

  for (let i = 0; i < episodes.length; i++) {
    const entry = truncatedEpisodes ? read[read.length - episodes.length + i] : read[i]
    const source = `e:${entry?.file ?? i}:${entry?.line ?? i}`
    for (const slug of entitiesInText(allEntities, `${episodes[i].user ?? ''}`)) {
      const target = entityKeyBySlug.get(slug)
      if (target !== undefined) link(source, target, 'named')
    }
  }

  // --- cross-project: a card in another project that hangs off the same entity
  // is the whole point of the entity layer, so it is drawn, but dimmed and capped.
  const selectedIds = new Set(cards.map((card) => card.id))
  const foreign = []
  for (const card of allCards) {
    if (selectedIds.has(card.id)) continue
    if (project !== null && card.project === project) continue
    if (card.status === 'retracted') continue
    if (!(card.entities ?? []).some((slug) => entityKeyBySlug.has(slug))) continue
    foreign.push(card)
    if (foreign.length >= caps.foreignCards) break
  }
  for (const card of foreign) {
    const key = `c:${card.id}`
    nodes.push({
      key,
      k: 'card',
      label: clip(card.title, 40),
      sub: card.kind,
      id: card.id,
      title: String(card.title ?? ''),
      kind: String(card.kind ?? 'note'),
      project: card.project ?? '',
      status: card.status ?? 'active',
      confidence: card.confidence ?? 'inferred',
      created: String(card.created ?? '').slice(0, 10),
      validFrom: card.validFrom ?? null,
      body: clip(card.body, caps.cardBody),
      tags: card.tags ?? [],
      entityNames: (card.entities ?? []).map((slug) => entityBySlug.get(slug)?.name ?? slug),
      supersedes: card.supersedes ?? [],
      supersededBy: card.supersededBy ?? null,
      hot: false,
      foreign: true,
      r: 9,
    })
    cardByKey.set(card.id, key)
    for (const slug of card.entities ?? []) {
      const target = entityKeyBySlug.get(slug)
      if (target !== undefined) link(key, target, 'mentions')
    }
  }

  // --- a reversal is a shape worth seeing: the replaced card points at its heir
  for (const card of [...cards, ...foreign]) {
    const heir = card.supersededBy ? cardByKey.get(card.supersededBy) : undefined
    if (heir !== undefined) link(cardByKey.get(card.id), heir, 'supersedes')
  }

  while (links.length > caps.links) links.pop()
  layoutNodes(nodes, links)

  return {
    ok: true,
    session: shortId(wanted),
    sessionId: wanted,
    project,
    generatedAt: new Date().toISOString(),
    empty: records.length === 0,
    query,
    counts: {
      episodes: records.length,
      // Local and cross-project cards are counted apart: the header says how
      // much of the picture belongs to this conversation's project and how much
      // arrived through the entity layer.
      cards: project === null ? cards.length : cards.filter((card) => card.project === project).length,
      entities: entityList.length,
      foreign: foreign.length + (project === null ? 0 : cards.filter((card) => card.project !== project).length),
      links: links.length,
    },
    truncated: { episodes: truncatedEpisodes, cards: truncatedCards },
    recall: recalledIds,
    nodes,
    links,
  }
}

/**
 * The HTTP handler for {@link GRAPH_PATH}.
 *
 * Connection admits the request before this runs and only an authenticated
 * owner Peer reaches an exact Fetch route, so there is no second auth check
 * here. What is left is input handling: an unknown Session is not an error
 * worth a 500, and a throw must answer with something the panel can show.
 *
 * `json` builds the response by hand rather than with `Response.json`, which
 * only exists on recent Node: the host may run an older one.
 */

export function createGraphHandler({ getVault, getConfig }) {
  return async function handle(request) {
    const url = new URL(request.url)
    const session = url.searchParams.get('session') ?? ''
    if (session === '') {
      return json(
        {
          ok: false,
          reason: 'missing-session',
          message: '这个会话没有 id，画不出它的记忆图 · this session has no id, so there is no graph to draw',
        },
        400,
      )
    }
    try {
      const cfg = getConfig()
      const vault = getVault()
      const payload = await buildSessionGraph({ vault, session, project: cfg?.defaultProject ?? null })
      return json(payload)
    } catch (error) {
      return json({ ok: false, reason: 'unavailable', message: String(error?.message ?? error) }, 500)
    }
  }
}
