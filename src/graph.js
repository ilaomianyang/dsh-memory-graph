/**
 * Graph view: the whole vault as one self-contained HTML page.
 *
 * The output is deliberately a single file with inline CSS and inline script —
 * no network, no CDN, no font download, no build step. Double-click it and it
 * works; zip the vault and it still works. Nothing is fetched, so the page says
 * the same thing offline ten years from now.
 *
 * Layout is computed here, in Node, from the vault content: the page opens
 * already settled instead of animating from a random pile, and two runs over
 * the same vault produce the same picture (byte for byte, generation stamp
 * aside). The browser side only draws, filters and hit-tests.
 */
import crypto from 'node:crypto'

/** Five card kinds, one hue each. Entity nodes get their own near-white. */
export const KIND_COLORS = {
  decision: '#6ee7b7',
  fact: '#7dd3fc',
  open_question: '#fbbf24',
  preference: '#c4b5fd',
  note: '#94a3b8',
}

const KIND_LABELS = {
  decision: '决策 decision',
  fact: '事实 fact',
  open_question: '待解 open_question',
  preference: '偏好 preference',
  note: '记录 note',
}

// The legend sits in a status bar below the canvas, so the only thing the
// layout has to keep clear at the bottom is the frame itself.
const VIEW = { width: 1400, height: 860, pad: 70, reserveBottom: 16 }

const LABEL_FONT = { card: 10.5, entity: 11.5 }
const LABEL_MAX = { card: 126, entity: 138 }

/* ---------------------------------------------------------------- helpers */

function round1(n) {
  return Math.round(n * 10) / 10
}

function clampText(text, max) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, max - 1).trimEnd()}…`
}

/**
 * Rough advance width, no font metrics in Node: CJK is full-width, latin about
 * 0.6em (system-ui at 10.5px averages a bit wider than the classic 0.5em).
 * Baked label boxes only need to be close, not exact — they are used to avoid
 * collisions, and the browser strokes every label with the page colour so a
 * couple of pixels of drift stay readable.
 */
function textWidth(text, size) {
  let width = 0
  for (const char of String(text)) {
    const code = char.codePointAt(0)
    if (code >= 0x2e80 && code <= 0x9fff) width += size
    else if (code >= 0xff00 && code <= 0xffef) width += size
    else if (code >= 0x3000 && code <= 0x303f) width += size
    else if (char === ' ') width += size * 0.32
    else width += size * 0.6
  }
  return width
}

function truncateToWidth(text, size, maxWidth) {
  if (textWidth(text, size) <= maxWidth) return text
  let out = ''
  for (const char of String(text)) {
    if (textWidth(`${out}${char}…`, size) > maxWidth) break
    out += char
  }
  return `${out.trimEnd()}…`
}

function hashString(text) {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function makeRng(seed) {
  let state = (seed >>> 0) || 1
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function cardRadius(degree) {
  return round1(5.4 + Math.min(4.2, Math.sqrt(degree) * 1.7))
}

function entityRadius(degree) {
  return round1(8.5 + Math.min(10.5, Math.sqrt(degree) * 2.2))
}

/* ---------------------------------------------------------------- model */

function buildModel({ cards, entities, projects }) {
  const nodes = []
  const bySlug = new Map()
  const byId = new Map()

  for (const entity of entities) {
    const node = {
      key: `e:${entity.slug}`,
      type: 'entity',
      kind: 'entity',
      label: String(entity.name ?? entity.slug),
      slug: entity.slug,
      degree: 0,
      r: 0,
      projects: [],
      mentions: (entity.mentions ?? []).map((mention) => ({
        d: String(mention.date ?? '').slice(0, 10),
        note: clampText(mention.note, 120),
        cardId: mention.cardId,
      })),
      etype: entity.type ?? 'concept',
      aliases: entity.aliases ?? [],
      firstSeen: entity.firstSeen ?? null,
      lastSeen: entity.lastSeen ?? null,
    }
    bySlug.set(entity.slug, node)
    nodes.push(node)
  }

  for (const card of cards) {
    const node = {
      key: `c:${card.id}`,
      type: 'card',
      kind: String(card.kind ?? 'note'),
      label: String(card.title ?? '(untitled)'),
      id: card.id,
      project: card.project ?? 'shared',
      status: card.status ?? 'active',
      confidence: card.confidence ?? 'inferred',
      created: String(card.created ?? '').slice(0, 10),
      snippet: clampText(card.body, 160),
      body: clampText(card.body, 900),
      entities: (card.entities ?? []).map((slug) => ({
        slug,
        name: bySlug.get(slug)?.label ?? slug,
      })),
      supersedes: card.supersedes ?? [],
      supersededBy: card.supersededBy ?? null,
      tags: card.tags ?? [],
      degree: 0,
      r: 0,
      projects: [card.project ?? 'shared'],
    }
    byId.set(card.id, node)
    nodes.push(node)
  }

  const links = []
  const seen = new Set()
  for (const card of cards) {
    const source = byId.get(card.id)
    for (const slug of card.entities ?? []) {
      const target = bySlug.get(slug)
      if (!target) continue
      const key = `${source.key}->${target.key}`
      if (seen.has(key)) continue
      seen.add(key)
      links.push({ s: source.key, t: target.key, k: 'mention' })
      source.degree += 1
      target.degree += 1
      if (!target.projects.includes(source.project)) target.projects.push(source.project)
    }
  }

  for (const card of cards) {
    const source = byId.get(card.id)
    const old = card.supersededBy ? byId.get(card.supersededBy) : null
    if (!source || !old) continue
    const key = `${source.key}->${old.key}`
    if (seen.has(key)) continue
    seen.add(key)
    links.push({ s: source.key, t: old.key, k: 'supersede' })
    source.degree += 1
    old.degree += 1
  }

  for (const node of nodes) {
    node.r = node.type === 'entity' ? entityRadius(node.degree) : cardRadius(node.degree)
    node.haloScale = node.type === 'entity' ? 2.5 : 2.7
    // A hub is an entity that only exists because several projects share it.
    node.hub = node.type === 'entity' && node.projects.length >= 2
    node.projects.sort()
  }

  const projectCounts = new Map()
  for (const card of cards) {
    const slug = card.project ?? 'shared'
    projectCounts.set(slug, (projectCounts.get(slug) ?? 0) + 1)
  }
  const projectList = [...projectCounts.entries()]
    .map(([slug, count]) => ({ slug, count, title: projects.find((p) => p.slug === slug)?.title ?? slug }))
    .sort((a, b) => b.count - a.count || a.slug.localeCompare(b.slug))

  return { nodes, links, projectList }
}

/* ---------------------------------------------------------------- layout */

/**
 * Fruchterman–Reingold relaxation with a gravity term: springs along links,
 * inverse-distance repulsion between every pair, a stronger pull to the middle
 * for entity nodes so the things that many cards share end up in the centre.
 * Deterministic (phyllotaxis start, no wall clock, no Math.random).
 */
function layoutGraph(nodes, links) {
  const { width, height } = VIEW
  const n = nodes.length
  const index = new Map(nodes.map((node, i) => [node.key, i]))
  const xs = new Float64Array(n)
  const ys = new Float64Array(n)
  const dxs = new Float64Array(n)
  const dys = new Float64Array(n)
  const rng = makeRng(hashString(nodes.map((node) => node.key).join('|')))

  // Golden-angle spiral: evenly spaced, no clusters to untangle first.
  const spread = Math.min(width, height) * 0.34
  for (let i = 0; i < n; i++) {
    const angle = i * 2.399963229728653
    const radius = spread * Math.sqrt((i + 0.5) / Math.max(1, n))
    xs[i] = width / 2 + Math.cos(angle) * radius
    ys[i] = height / 2 + Math.sin(angle) * radius * 0.82
  }

  const edges = []
  for (const link of links) {
    const a = index.get(link.s)
    const b = index.get(link.t)
    if (a === undefined || b === undefined) continue
    edges.push([a, b, link.k === 'supersede' ? 1.35 : 1])
  }

  // Fruchterman–Reingold wants an ideal edge length that grows as the frame gets
  // emptier, which is right for big graphs and absurd for small ones: two cells
  // would be flung to opposite corners. Hence the ceiling.
  const ideal = Math.min(132, 1.05 * Math.sqrt((width * height) / Math.max(8, n)))
  let temperature = ideal * 0.9
  const iterations = 460

  for (let iter = 0; iter < iterations; iter++) {
    dxs.fill(0)
    dys.fill(0)

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = xs[i] - xs[j]
        let dy = ys[i] - ys[j]
        let d2 = dx * dx + dy * dy
        if (d2 < 0.02) {
          dx = (rng() - 0.5) * 0.6
          dy = (rng() - 0.5) * 0.6
          d2 = dx * dx + dy * dy + 0.02
        }
        const d = Math.sqrt(d2)
        const force = (ideal * ideal) / d
        const ux = dx / d
        const uy = dy / d
        dxs[i] += ux * force
        dys[i] += uy * force
        dxs[j] -= ux * force
        dys[j] -= uy * force
      }
    }

    for (const [a, b, weight] of edges) {
      const dx = xs[a] - xs[b]
      const dy = ys[a] - ys[b]
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01
      const force = ((d * d) / ideal) * 0.82 * weight
      const ux = dx / d
      const uy = dy / d
      dxs[a] -= ux * force
      dys[a] -= uy * force
      dxs[b] += ux * force
      dys[b] += uy * force
    }

    for (let i = 0; i < n; i++) {
      // Entities are the hubs: hold them near the middle so cards ring them.
      const gravity = nodes[i].type === 'entity' ? 0.19 : 0.062
      dxs[i] += (width / 2 - xs[i]) * gravity
      dys[i] += (height / 2 - ys[i]) * gravity
    }

    for (let i = 0; i < n; i++) {
      const d = Math.sqrt(dxs[i] * dxs[i] + dys[i] * dys[i]) || 1
      const step = Math.min(d, temperature)
      xs[i] += (dxs[i] / d) * step
      ys[i] += (dys[i] / d) * step
    }

    // Hard separation: two nodes never share a spot, whatever the forces say.
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const min = nodes[i].r + nodes[j].r + 15
        let dx = xs[j] - xs[i]
        let dy = ys[j] - ys[i]
        let d = Math.sqrt(dx * dx + dy * dy)
        if (d >= min) continue
        if (d < 0.01) {
          dx = rng() - 0.5
          dy = rng() - 0.5
          d = Math.sqrt(dx * dx + dy * dy) || 0.01
        }
        const push = (min - d) / 2
        xs[i] -= (dx / d) * push
        ys[i] -= (dy / d) * push
        xs[j] += (dx / d) * push
        ys[j] += (dy / d) * push
      }
    }

    temperature = Math.max(0.6, temperature * 0.986)
  }

  // Fit into the padded frame. The two axes are allowed to stretch by different
  // amounts (capped): a round cloud would leave the wide frame half empty, and
  // stretching positions — never the circles — keeps every node perfectly round.
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, xs[i] - nodes[i].r)
    maxX = Math.max(maxX, xs[i] + nodes[i].r)
    minY = Math.min(minY, ys[i] - nodes[i].r)
    maxY = Math.max(maxY, ys[i] + nodes[i].r)
  }
  const boxW = VIEW.width - VIEW.pad * 2
  // The legend and the hint live in a strip along the bottom edge; nodes are
  // kept out of it so a cluster can never end up behind the legend box.
  const boxH = VIEW.height - VIEW.pad - VIEW.reserveBottom
  const spanW = Math.max(1, maxX - minX)
  const spanH = Math.max(1, maxY - minY)
  const scaleX = Math.min(boxW / spanW, 1.45)
  const scaleY = Math.min(boxH / spanH, 1.35)
  const radiusScale = Math.min(1.3, Math.max(0.9, Math.sqrt(scaleX * scaleY)))
  const offsetX = VIEW.pad + (boxW - spanW * scaleX) / 2
  const offsetY = VIEW.pad + (boxH - spanH * scaleY) / 2

  for (let i = 0; i < n; i++) {
    nodes[i].x = round1(offsetX + (xs[i] - minX) * scaleX)
    nodes[i].y = round1(offsetY + (ys[i] - minY) * scaleY)
    nodes[i].r = round1(nodes[i].r * radiusScale)
  }

  // The radii that were just applied are not the ones the span above was
  // measured with, so the outermost cells can poke a few pixels past the
  // padding. Re-measure with the real circles and pull the picture back in —
  // positions shrink, circles never do.
  const frame = {
    x0: VIEW.pad,
    x1: VIEW.width - VIEW.pad,
    y0: VIEW.pad,
    y1: VIEW.height - VIEW.reserveBottom,
  }
  let bx0 = Infinity
  let bx1 = -Infinity
  let by0 = Infinity
  let by1 = -Infinity
  for (let i = 0; i < n; i++) {
    bx0 = Math.min(bx0, nodes[i].x - nodes[i].r)
    bx1 = Math.max(bx1, nodes[i].x + nodes[i].r)
    by0 = Math.min(by0, nodes[i].y - nodes[i].r)
    by1 = Math.max(by1, nodes[i].y + nodes[i].r)
  }
  if (bx0 < frame.x0 || bx1 > frame.x1 || by0 < frame.y0 || by1 > frame.y1) {
    const shrink = Math.min(
      (frame.x1 - frame.x0) / Math.max(1, bx1 - bx0),
      (frame.y1 - frame.y0) / Math.max(1, by1 - by0),
      1,
    )
    const cx = (bx0 + bx1) / 2
    const cy = (by0 + by1) / 2
    const tx = (frame.x0 + frame.x1) / 2
    const ty = (frame.y0 + frame.y1) / 2
    for (let i = 0; i < n; i++) {
      nodes[i].x = round1(tx + (nodes[i].x - cx) * shrink)
      nodes[i].y = round1(ty + (nodes[i].y - cy) * shrink)
    }
  }
}

/* ---------------------------------------------------------------- labels */

function overlaps(a, b) {
  return !(a.x1 <= b.x0 || b.x1 <= a.x0 || a.y1 <= b.y0 || b.y1 <= a.y0)
}

/**
 * Greedy label placement: ten preferred offsets around the node, biggest nodes
 * first. A label that fits nowhere is kept but hidden by default (hover,
 * selection and search reveal it), which is what keeps the picture from turning
 * into a plate of confetti once a vault has fifty entities.
 */
function placeLabels(nodes) {
  const bodies = nodes.map((node) => ({
    node,
    box: {
      x0: node.x - node.r - 2,
      x1: node.x + node.r + 2,
      y0: node.y - node.r - 2,
      y1: node.y + node.r + 2,
    },
  }))
  const taken = []

  const ordered = nodes
    .slice()
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'entity' ? -1 : 1
      return b.degree - a.degree
    })

  const floor = VIEW.height - VIEW.reserveBottom - 6

  for (const node of ordered) {
    const size = node.type === 'entity' ? LABEL_FONT.entity : LABEL_FONT.card
    const text = truncateToWidth(node.label, size, node.type === 'entity' ? LABEL_MAX.entity : LABEL_MAX.card)
    node.short = text
    const width = textWidth(text, size) + 10
    const candidates = [
      { dx: 0, dy: node.r + 10, anchor: 'middle' },
      { dx: 0, dy: -(node.r + 8), anchor: 'middle' },
      { dx: node.r + 7, dy: 1, anchor: 'start' },
      { dx: -(node.r + 7), dy: 1, anchor: 'end' },
      { dx: 0, dy: node.r + 24, anchor: 'middle' },
      { dx: 0, dy: -(node.r + 22), anchor: 'middle' },
      { dx: node.r + 7, dy: -(node.r * 0.6 + 5), anchor: 'start' },
      { dx: node.r + 7, dy: node.r * 0.6 + 6, anchor: 'start' },
      { dx: -(node.r + 7), dy: -(node.r * 0.6 + 5), anchor: 'end' },
      { dx: -(node.r + 7), dy: node.r * 0.6 + 6, anchor: 'end' },
    ]

    let placed = null
    for (const candidate of candidates) {
      const x = node.x + candidate.dx
      const y = node.y + candidate.dy
      const left = candidate.anchor === 'start' ? x : candidate.anchor === 'end' ? x - width : x - width / 2
      // y is the text baseline, so the box is lopsided: cap height above the
      // baseline, descender below it. Inflated a little on top of that, because
      // the width estimate can be off by a pixel or two per glyph run.
      const box = {
        x0: left - 1.5,
        x1: left + width + 1.5,
        y0: y - size * 0.84 - 1.5,
        y1: y + size * 0.24 + 1.5,
      }
      // Never let a label run off the frame: the page clips, and half a word is
      // worse than no word.
      if (box.x0 < 10 || box.x1 > VIEW.width - 10 || box.y0 < 8 || box.y1 > floor) continue
      if (taken.some((other) => overlaps(box, other))) continue
      // Other nodes are hard obstacles; the node this label belongs to is not,
      // otherwise every candidate would collide with its own cell body.
      if (bodies.some((entry) => entry.node !== node && overlaps(box, entry.box))) continue
      taken.push(box)
      placed = { x: round1(x), y: round1(y), anchor: candidate.anchor, on: true }
      break
    }

    node.labelPos = placed ?? { x: round1(node.x), y: round1(node.y + node.r + 11), anchor: 'middle', on: false }
  }
}

/* ---------------------------------------------------------------- payload */

function toPayload({ cards, entities, projects, generatedAt }) {
  const model = buildModel({ cards, entities, projects })
  layoutGraph(model.nodes, model.links)
  placeLabels(model.nodes)

  const nodes = model.nodes.map((node) => {
    const base = {
      key: node.key,
      type: node.type,
      kind: node.kind,
      label: node.short ?? node.label,
      full: node.label,
      x: node.x,
      y: node.y,
      r: node.r,
      degree: node.degree,
      projects: node.projects,
      labelAt: node.labelPos,
    }
    if (node.type === 'entity') {
      return {
        ...base,
        slug: node.slug,
        etype: node.etype,
        aliases: node.aliases,
        firstSeen: node.firstSeen,
        lastSeen: node.lastSeen,
        hub: node.hub,
        mentions: node.mentions.slice(-24).reverse(),
      }
    }
    return {
      ...base,
      id: node.id,
      project: node.project,
      status: node.status,
      confidence: node.confidence,
      created: node.created,
      snippet: node.snippet,
      body: node.body,
      entities: node.entities,
      supersedes: node.supersedes,
      supersededBy: node.supersededBy,
      tags: node.tags,
    }
  })

  const counts = {
    cards: cards.length,
    entities: entities.length,
    projects: model.projectList.length,
    active: cards.filter((card) => (card.status ?? 'active') === 'active').length,
    superseded: cards.filter((card) => card.status === 'superseded').length,
    retracted: cards.filter((card) => card.status === 'retracted').length,
  }

  return {
    generatedAt,
    counts,
    kinds: KIND_LABELS,
    nodes,
    links: model.links,
    projects: model.projectList,
  }
}

/* ---------------------------------------------------------------- assets */

/**
 * Two palettes. `:root` is dark; a light system flips it before the script runs,
 * and the header toggle pins either one with a `data-theme` attribute on <html>
 * (auto means "no attribute", so the media query stays in charge).
 */
const TOKENS = {
  dark: `
  color-scheme: dark;
  --bg-0: #070b0f;
  --bg-1: #0d141b;
  --bg-2: #16222e;
  --fg: #e8eef5;
  --fg-dim: #8fa2b6;
  --line: rgba(148, 163, 184, 0.18);
  --edge: rgba(148, 163, 184, 0.36);
  --mint: #6ee7b7;
  --entity: #e8eef5;
  --panel: rgba(13, 20, 27, 0.9);
  --chip: rgba(148, 163, 184, 0.12);
  --glow-a: rgba(45, 212, 191, 0.11);
  --glow-b: rgba(56, 189, 248, 0.08);
  --shadow: 0 18px 44px rgba(0, 0, 0, 0.55);
  --k-decision: #6ee7b7;
  --k-fact: #7dd3fc;
  --k-open_question: #fbbf24;
  --k-preference: #c4b5fd;
  --k-note: #94a3b8;`,
  light: `
  color-scheme: light;
  --bg-0: #eaeff5;
  --bg-1: #f7fafc;
  --bg-2: #ffffff;
  --fg: #101820;
  --fg-dim: #4d6076;
  --line: rgba(16, 24, 32, 0.16);
  --edge: rgba(16, 24, 32, 0.32);
  --mint: #0b8f6b;
  --entity: #16222e;
  --panel: rgba(255, 255, 255, 0.94);
  --chip: rgba(16, 24, 32, 0.055);
  --glow-a: rgba(13, 148, 136, 0.10);
  --glow-b: rgba(2, 132, 199, 0.07);
  --shadow: 0 18px 44px rgba(16, 24, 32, 0.2);
  --k-decision: #0b8f6b;
  --k-fact: #0b74b8;
  --k-open_question: #a45a06;
  --k-preference: #6d28d9;
  --k-note: #55677a;`,
}

const CSS = `
:root {${TOKENS.dark}
}
@media (prefers-color-scheme: light) {
  :root {${TOKENS.light}
  }
}
:root[data-theme="dark"] {${TOKENS.dark}
}
:root[data-theme="light"] {${TOKENS.light}
}
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body {
  background: var(--bg-0);
  color: var(--fg);
  font: 13px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, "Microsoft YaHei", "PingFang SC", sans-serif;
  -webkit-font-smoothing: antialiased;
  overflow: hidden;
}
#app { display: grid; grid-template-rows: auto 1fr auto; height: 100%; }

header {
  display: flex; align-items: center; gap: 14px; flex-wrap: nowrap;
  padding: 10px 16px 11px;
  border-bottom: 1px solid var(--line);
  background: linear-gradient(180deg, var(--bg-1), rgba(0, 0, 0, 0));
}
.brand { display: flex; align-items: baseline; gap: 9px; min-width: 0; flex: 0 0 auto; }
.brand h1 { font-size: 15px; font-weight: 650; margin: 0; letter-spacing: 0.01em; white-space: nowrap; }
.brand span.en { font-size: 11.5px; color: var(--fg-dim); letter-spacing: 0.06em; text-transform: uppercase; white-space: nowrap; }
.brand::before {
  content: ""; width: 9px; height: 9px; border-radius: 50%;
  background: var(--mint); box-shadow: 0 0 0 4px rgba(110, 231, 183, 0.16);
  align-self: center; flex: none;
}
.counts {
  font-size: 11.5px; color: var(--fg-dim); font-variant-numeric: tabular-nums;
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.counts b { color: var(--fg); font-weight: 600; }
header .spacer { flex: 1 1 0; min-width: 8px; }
.controls { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
input[type="search"], select, button {
  font: inherit; color: var(--fg); background: var(--chip);
  border: 1px solid var(--line); border-radius: 8px; padding: 5px 9px; outline: none;
}
input[type="search"] { width: 210px; min-width: 96px; flex: 0 1 auto; }
input[type="search"]::placeholder { color: var(--fg-dim); }
input[type="search"]:focus, select:focus { border-color: var(--mint); box-shadow: 0 0 0 3px rgba(110, 231, 183, 0.16); }
select { padding-right: 6px; cursor: pointer; max-width: 190px; }
button { cursor: pointer; min-width: 30px; flex: 0 0 auto; }
button:hover { border-color: var(--mint); color: var(--mint); }
.zoom { display: flex; gap: 4px; flex: 0 0 auto; }

main { position: relative; display: grid; grid-template-columns: 1fr; min-height: 0; }
#stage {
  position: relative; min-height: 0; overflow: hidden;
  background:
    radial-gradient(900px 560px at 50% 44%, var(--glow-a) 0%, rgba(0, 0, 0, 0) 62%),
    radial-gradient(700px 520px at 16% 92%, var(--glow-b) 0%, rgba(0, 0, 0, 0) 58%),
    var(--bg-0);
  box-shadow: inset 0 0 200px 40px rgba(0, 0, 0, 0.35);
}
@media (prefers-color-scheme: light) {
  #stage { box-shadow: inset 0 0 170px 30px rgba(148, 163, 184, 0.20); }
}
#canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; touch-action: none; cursor: grab; }
#canvas.panning { cursor: grabbing; }

.edge-glow { fill: none; stroke: var(--edge); stroke-width: 3.6; stroke-opacity: 0.32; stroke-linecap: round; }
.edge { fill: none; stroke: var(--edge); stroke-width: 1.05; stroke-linecap: round; }
.edge-group.supersede .edge { stroke: var(--mint); stroke-opacity: 0.55; stroke-dasharray: 4 4; }
.edge-group.supersede .edge-glow { stroke: var(--mint); stroke-opacity: 0.16; }
.edge-group.lit .edge { stroke: var(--mint); stroke-width: 1.7; stroke-dasharray: 6 6; animation: flow 1.4s linear infinite; }
.edge-group.lit .edge-glow { stroke: var(--mint); stroke-opacity: 0.34; }
.edge-group.dim { opacity: 0.09; }
@keyframes flow { to { stroke-dashoffset: -24; } }

.node { cursor: pointer; }
.node .halo { opacity: 0.9; }
.node.hub .halo { opacity: 1; }
.node .core { fill: currentColor; stroke: var(--bg-0); stroke-width: 0.9; }
.node.entity .core { stroke: var(--bg-1); stroke-width: 1.2; }
.node .nucleus { fill: var(--bg-0); }
.node.hub .ring { fill: none; stroke: currentColor; stroke-opacity: 0.55; stroke-width: 1.1; stroke-dasharray: 3 3.4; animation: spin 9s linear infinite; }
@keyframes spin { to { stroke-dashoffset: -52; } }
.node.superseded .core { stroke: var(--fg); stroke-opacity: 0.6; stroke-width: 1.1; stroke-dasharray: 2.6 2.2; }
.node.retracted { opacity: 0.34; }
.node.retracted .core { stroke-dasharray: 1.6 1.8; }
.node.hit .core { stroke: var(--mint); stroke-width: 2; }
.node.hit .halo { opacity: 0.3; }
.node.sel .core { stroke: var(--mint); stroke-width: 2.4; }
.node.sel .halo { opacity: 0.38; }
.node:hover .core { stroke: var(--fg); stroke-width: 1.8; }
.node.dim { opacity: 0.12; }
.node.dim.retracted { opacity: 0.06; }
.node.dim .halo { opacity: 0.16; }

.k-decision { color: var(--k-decision); }
.k-fact { color: var(--k-fact); }
.k-open_question { color: var(--k-open_question); }
.k-preference { color: var(--k-preference); }
.k-note { color: var(--k-note); }
.k-entity { color: var(--entity); }

text.lbl {
  font-family: inherit; font-size: 10.5px; font-weight: 500;
  fill: var(--fg); fill-opacity: 0.82;
  stroke: var(--bg-0); stroke-width: 3.2px; stroke-linejoin: round;
  paint-order: stroke fill; pointer-events: none; user-select: none;
}
text.lbl.entity { font-size: 11.5px; font-weight: 650; fill-opacity: 0.96; }
text.lbl.off { display: none; }
text.lbl.dim { fill-opacity: 0.12; }

#empty {
  position: absolute; inset: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 10px; padding: 40px;
  text-align: center; color: var(--fg-dim);
}
#empty[hidden] { display: none; }
#empty h2 { margin: 0; font-size: 17px; color: var(--fg); font-weight: 600; }
#empty p { margin: 0; max-width: 540px; line-height: 1.85; }
#empty code { background: var(--chip); border-radius: 5px; padding: 1px 5px; font-size: 12px; }

#tooltip {
  position: absolute; z-index: 6; max-width: 330px; padding: 10px 12px;
  border-radius: 10px; border: 1px solid var(--line); background: var(--panel);
  box-shadow: var(--shadow); backdrop-filter: blur(9px);
  opacity: 0; transform: translateY(3px); transition: opacity 0.12s ease, transform 0.12s ease;
  pointer-events: none;
}
#tooltip.on { opacity: 1; transform: none; }
#tooltip .tt-title { font-weight: 600; font-size: 12.5px; margin-bottom: 3px; }
#tooltip .tt-snip { color: var(--fg-dim); font-size: 11.5px; margin-bottom: 5px; }
#tooltip .tt-meta { color: var(--fg-dim); font-size: 10.5px; font-variant-numeric: tabular-nums; }
#tooltip .tt-kind { display: inline-block; margin-bottom: 5px; }

.badge {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 10.5px; padding: 1px 7px; border-radius: 999px;
  background: var(--chip); color: var(--fg-dim);
}
.badge::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.badge.k-decision { color: var(--k-decision); }
.badge.k-fact { color: var(--k-fact); }
.badge.k-open_question { color: var(--k-open_question); }
.badge.k-preference { color: var(--k-preference); }
.badge.k-note { color: var(--k-note); }
.badge.k-entity { color: var(--entity); }
.badge.plain::before { display: none; }
.badge.warn { color: var(--k-open_question); }
.badge[hidden] { display: none; }

#panel {
  position: absolute; top: 14px; right: 14px; width: 344px;
  max-height: calc(100% - 28px); overflow: auto;
  padding: 16px 18px 18px; border-radius: 14px;
  border: 1px solid var(--line); background: var(--panel);
  box-shadow: var(--shadow); backdrop-filter: blur(12px);
  z-index: 5;
}
#panel[hidden] { display: none; }
#panel .eyebrow { font-size: 10.5px; letter-spacing: 0.09em; text-transform: uppercase; color: var(--fg-dim); }
#panel h2 { font-size: 14.5px; font-weight: 620; margin: 4px 0 10px; line-height: 1.45; }
#panel .row { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
#panel dl { display: grid; grid-template-columns: 74px 1fr; gap: 3px 10px; margin: 0 0 12px; font-size: 11.5px; }
#panel dt { color: var(--fg-dim); }
#panel dd { margin: 0; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
#panel .body { font-size: 12px; line-height: 1.65; white-space: pre-wrap; overflow-wrap: anywhere; margin: 0 0 14px; color: var(--fg); }
#panel h3 { font-size: 10.5px; letter-spacing: 0.09em; text-transform: uppercase; color: var(--fg-dim); margin: 0 0 7px; font-weight: 600; }
#panel .chips { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 14px; }
#panel .chip {
  font-size: 11px; padding: 2px 8px; border-radius: 999px; cursor: pointer;
  border: 1px solid var(--line); background: var(--chip); color: var(--fg);
}
#panel .chip:hover { border-color: var(--mint); color: var(--mint); }
#panel .chip.static { cursor: default; }
#panel .chip.static:hover { border-color: var(--line); color: var(--fg); }
#panel ul.mentions { list-style: none; margin: 0 0 10px; padding: 0; display: grid; gap: 5px; }
#panel ul.mentions li {
  display: grid; grid-template-columns: 74px 1fr; gap: 8px; font-size: 11.5px;
  padding: 4px 6px; border-radius: 7px; cursor: pointer; color: var(--fg);
}
#panel ul.mentions li:hover { background: var(--chip); }
#panel ul.mentions span.d { color: var(--fg-dim); font-variant-numeric: tabular-nums; }
#panel .close {
  position: absolute; top: 10px; right: 10px; width: 24px; min-width: 24px; height: 24px;
  padding: 0; line-height: 1; font-size: 15px; border-radius: 7px;
}

/* The legend and the keyboard hint live in a status bar *below* the canvas, so
   no amount of graph can ever end up behind them. */
footer {
  display: flex; align-items: center; justify-content: space-between; gap: 10px 18px;
  flex-wrap: wrap; padding: 7px 16px 8px;
  border-top: 1px solid var(--line);
  background: var(--bg-1);
  font-size: 10.5px; color: var(--fg-dim);
}
#legend { display: flex; flex-wrap: wrap; gap: 4px 14px; }
#legend .item { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
#legend .dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; flex: none; }
#legend .dot.hollow { background: none; border: 1px dashed currentColor; border-radius: 50%; }
#legend .dot.ringed { background: none; border: 1px solid currentColor; box-shadow: 0 0 0 2px rgba(110, 231, 183, 0.25); }
#legend .i-decision { color: var(--k-decision); }
#legend .i-fact { color: var(--k-fact); }
#legend .i-open_question { color: var(--k-open_question); }
#legend .i-preference { color: var(--k-preference); }
#legend .i-note { color: var(--k-note); }
#legend .i-entity { color: var(--entity); }
#legend .i-mint { color: var(--mint); }

#hint { opacity: 0.85; text-align: right; }
@media (max-width: 860px) {
  #hint { display: none; }
  #panel { width: auto; left: 14px; }
  input[type="search"] { width: 130px; }
}
@media (prefers-reduced-motion: reduce) {
  .edge.lit, .node.hub .ring { animation: none; }
}
`

const BODY = `
<div id="app">
  <header>
    <div class="brand"><h1>记忆图</h1><span class="en">memory graph</span></div>
    <div class="counts" id="counts"></div>
    <div class="spacer"></div>
    <div class="controls">
      <input id="search" type="search" placeholder="搜索标题 / 实体 / id" autocomplete="off" spellcheck="false">
      <select id="project" title="按项目过滤"></select>
      <div class="zoom">
        <button id="theme" title="主题：跟随系统 / 深色 / 浅色">◐</button>
        <button id="zoom-in" title="放大">+</button>
        <button id="zoom-out" title="缩小">−</button>
        <button id="zoom-fit" title="复位 (f)">fit</button>
      </div>
    </div>
  </header>
  <main>
    <div id="stage">
      <svg id="canvas" viewBox="0 0 1400 860" preserveAspectRatio="xMidYMid meet" role="img" aria-label="记忆图">
        <defs id="defs"></defs>
        <g id="viewport">
          <g id="edges"></g>
          <g id="nodes"></g>
          <g id="labels"></g>
        </g>
      </svg>
      <div id="tooltip"></div>
      <aside id="panel" hidden></aside>
      <div id="empty" hidden>
        <h2>记忆库还是空的</h2>
        <p>这张图是从 <code>cards/</code> 和 <code>entities/</code> 读出来的。等 agent 写下第一张记忆卡片——或跑一次蒸馏——再重新生成一次 <code>graph.html</code>，这里就会长出第一颗神经元。</p>
      </div>
      <noscript><p style="padding:24px">这个页面需要 JavaScript 才能画图。</p></noscript>
    </div>
  </main>
  <footer>
    <div id="legend"></div>
    <div id="hint">滚轮缩放 · 拖拽平移 · 点击节点看详情 · Esc 清除 · / 搜索</div>
  </footer>
</div>
`

/* ---------------------------------------------------------------- browser */

/**
 * Everything below runs in the browser. Written with `var` and string
 * concatenation on purpose: it is inlined into a template literal here, so it
 * must not contain backticks or `${` of its own.
 */
function clientScript(dataJson) {
  return `
(function () {
  'use strict'

  var DATA = ${dataJson};
  var canvas = document.getElementById('canvas');
  var NS = canvas.namespaceURI;
  var viewport = document.getElementById('viewport');
  var edgeLayer = document.getElementById('edges');
  var nodeLayer = document.getElementById('nodes');
  var labelLayer = document.getElementById('labels');
  var stage = document.getElementById('stage');
  var tooltip = document.getElementById('tooltip');
  var panel = document.getElementById('panel');
  var emptyBox = document.getElementById('empty');
  var legendBox = document.getElementById('legend');
  var countsBox = document.getElementById('counts');
  var searchBox = document.getElementById('search');
  var projectBox = document.getElementById('project');

  var nodes = DATA.nodes;
  var byKey = {};
  var neighbors = {};
  var selected = null;
  var view = { k: 1, x: 0, y: 0 };
  var GRADIENT_KINDS = ['decision', 'fact', 'open_question', 'preference', 'note', 'entity'];

  /* ------------------------------------------------------------ theme */

  var THEME_KEY = 'dsh-memory-graph-theme';
  var themeButton = document.getElementById('theme');
  var gradients = {};

  function storedTheme() {
    try { return localStorage.getItem(THEME_KEY) || 'auto'; } catch (error) { return 'auto' }
  }

  function gradientStops() {
    var styles = getComputedStyle(document.documentElement);
    GRADIENT_KINDS.forEach(function (kind) {
      var color = styles.getPropertyValue('--k-' + kind).trim() || '#94a3b8';
      var stops = gradients[kind];
      stops[0].setAttribute('stop-color', color);
      stops[1].setAttribute('stop-color', color);
      stops[2].setAttribute('stop-color', color);
    });
  }

  function applyTheme(mode) {
    if (mode === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', mode);
    themeButton.textContent = mode === 'dark' ? '☾' : mode === 'light' ? '☀' : '◐';
    themeButton.title = '主题：' + (mode === 'auto' ? '跟随系统' : mode === 'dark' ? '深色' : '浅色');
    gradientStops();
  }

  themeButton.addEventListener('click', function () {
    var next = storedTheme() === 'auto' ? 'dark' : storedTheme() === 'dark' ? 'light' : 'auto';
    try { localStorage.setItem(THEME_KEY, next); } catch (error) { /* private mode */ }
    applyTheme(next);
  });

  if (window.matchMedia) {
    var media = window.matchMedia('(prefers-color-scheme: light)');
    var onChange = function () { if (storedTheme() === 'auto') gradientStops(); };
    if (media.addEventListener) media.addEventListener('change', onChange);
    else if (media.addListener) media.addListener(onChange);
  }


  nodes.forEach(function (node) {
    byKey[node.key] = node;
    neighbors[node.key] = {};
  });
  DATA.links.forEach(function (link) {
    if (!byKey[link.s] || !byKey[link.t]) return;
    neighbors[link.s][link.t] = true;
    neighbors[link.t][link.s] = true;
  });

  function el(name, attrs) {
    var node = document.createElementNS(NS, name);
    if (attrs) { for (var key in attrs) node.setAttribute(key, attrs[key]); }
    return node;
  }
  function h(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }
  function fmt(n) { return Math.round(n * 10) / 10; }

  // One soft radial glow per kind: the cell body reads as light, not as a dot.
  var defs = document.getElementById('defs');
  GRADIENT_KINDS.forEach(function (kind) {
    var gradient = el('radialGradient', { id: 'glow-' + kind });
    var stops = [];
    [[0, 0.42], [0.4, 0.13], [1, 0]].forEach(function (spec) {
      var stop = el('stop', { offset: String(spec[0]), 'stop-opacity': String(spec[1]) });
      gradient.appendChild(stop);
      stops.push(stop);
    });
    defs.appendChild(gradient);
    gradients[kind] = stops;
  });
  // The address bar can pin a theme and open one node: #dark, #light, and
  // #dark&<card id or entity slug>. Screenshots use it, and so does anything
  // that wants to link straight to one cell.
  var initialTheme = storedTheme();
  var pendingNode = '';
  var fragment = String(location.hash || '').replace(/^#/, '');
  try {
    fragment = decodeURIComponent(fragment);
  } catch (error) {
    // A stray percent sign is not worth a blank page.
  }
  fragment.split('&').forEach(function (part) {
    if (part === 'dark' || part === 'light') initialTheme = part;
    else if (part) pendingNode = part;
  });
  applyTheme(initialTheme);

  /* ------------------------------------------------------------ header */

  var c = DATA.counts;
  countsBox.textContent = '';
  [['卡片', c.cards], ['实体', c.entities], ['项目', c.projects]].forEach(function (pair, i) {
    if (i > 0) countsBox.appendChild(document.createTextNode(' · '));
    var b = h('b', null, String(pair[1]));
    countsBox.appendChild(document.createTextNode(pair[0] + ' '));
    countsBox.appendChild(b);
  });
  if (c.superseded) countsBox.appendChild(document.createTextNode(' · 已替换 ' + c.superseded));
  if (c.retracted) countsBox.appendChild(document.createTextNode(' · 已撤回 ' + c.retracted));
  if (DATA.generatedAt) {
    countsBox.appendChild(document.createTextNode(' · 生成于 ' + String(DATA.generatedAt).replace('T', ' ').slice(0, 16)));
  }

  /* ------------------------------------------------------------ legend */

  var LEGEND = [
    ['decision', '决策'], ['fact', '事实'], ['open_question', '待解'],
    ['preference', '偏好'], ['note', '记录']
  ];
  LEGEND.forEach(function (pair) {
    var item = h('div', 'item');
    item.appendChild(h('span', 'dot i-' + pair[0]));
    item.appendChild(h('span', null, pair[1]));
    legendBox.appendChild(item);
  });
  var ent = h('div', 'item');
  ent.appendChild(h('span', 'dot i-entity'));
  ent.appendChild(h('span', null, '实体（越大连得越多）'));
  legendBox.appendChild(ent);
  var hub = h('div', 'item');
  hub.appendChild(h('span', 'dot hollow i-mint'));
  hub.appendChild(h('span', null, '跨项目枢纽'));
  legendBox.appendChild(hub);
  var sup = h('div', 'item');
  sup.appendChild(h('span', 'ringed i-mint'));
  sup.appendChild(h('span', null, '虚线 = 已被替换'));
  legendBox.appendChild(sup);

  if (nodes.length === 0) {
    emptyBox.hidden = false;
    return;
  }

  /* ------------------------------------------------------------ edges */

  function hashNumber(text) {
    var sum = 0;
    for (var i = 0; i < text.length; i++) sum = (sum * 31 + text.charCodeAt(i)) % 100003;
    return sum;
  }

  var edgeEls = [];
  DATA.links.forEach(function (link) {
    var a = byKey[link.s];
    var b = byKey[link.t];
    if (!a || !b) return;
    var dx = b.x - a.x;
    var dy = b.y - a.y;
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    var ux = dx / len;
    var uy = dy / len;
    var bend = Math.min(42, len * 0.16) * (hashNumber(a.key + b.key) % 2 ? 1 : -1);
    // Start and end just outside the node, so lines do not pierce the halo.
    var ax = a.x + ux * (a.r + 1.5);
    var ay = a.y + uy * (a.r + 1.5);
    var bx = b.x - ux * (b.r + 1.5);
    var by = b.y - uy * (b.r + 1.5);
    var mx = (ax + bx) / 2 - uy * bend;
    var my = (ay + by) / 2 + ux * bend;
    var d = 'M' + fmt(ax) + ' ' + fmt(ay) + 'Q' + fmt(mx) + ' ' + fmt(my) + ' ' + fmt(bx) + ' ' + fmt(by);
    var group = el('g', { 'class': 'edge-group' + (link.k === 'supersede' ? ' supersede' : '') });
    // Two passes: a wide faint halo and the axon itself. Cheaper than a filter
    // and it keeps the line glowing without touching the text layer.
    group.appendChild(el('path', { 'class': 'edge-glow', d: d }));
    group.appendChild(el('path', { 'class': 'edge', d: d }));
    edgeLayer.appendChild(group);
    edgeEls.push({ g: group, a: link.s, b: link.t });
  });

  /* ------------------------------------------------------------ nodes */

  nodes.forEach(function (node) {
    var cls = 'node ' + node.type + ' k-' + node.kind;
    if (node.hub) cls += ' hub';
    if (node.status === 'superseded') cls += ' superseded';
    if (node.status === 'retracted') cls += ' retracted';
    node.baseClass = cls;

    var group = el('g', { 'class': cls, 'tabindex': '0', role: 'button' });
    group.appendChild(el('circle', {
      'class': 'halo',
      cx: node.x,
      cy: node.y,
      r: fmt(node.r * node.haloScale),
      fill: 'url(#glow-' + node.kind + ')'
    }));
    if (node.hub) {
      group.appendChild(el('circle', { 'class': 'ring', cx: node.x, cy: node.y, r: fmt(node.r + 5) }));
    }
    group.appendChild(el('circle', { 'class': 'core', cx: node.x, cy: node.y, r: node.r }));
    if (node.type === 'entity' && node.r >= 10) {
      group.appendChild(el('circle', { 'class': 'nucleus', cx: node.x, cy: node.y, r: fmt(node.r * 0.42) }));
    }

    var title = el('title');
    title.textContent = node.full || node.label;
    group.appendChild(title);

    group.addEventListener('pointerenter', function (event) { hover(node, event); });
    group.addEventListener('pointerleave', function () { unhover(); });
    group.addEventListener('focus', function () { hover(node, null); });
    group.addEventListener('blur', function () { unhover(); });
    group.addEventListener('click', function (event) {
      event.stopPropagation();
      select(selected === node.key ? null : node.key);
    });
    group.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        select(selected === node.key ? null : node.key);
      }
    });

    nodeLayer.appendChild(group);

    var label = el('text', {
      x: node.labelAt.x,
      y: node.labelAt.y,
      'text-anchor': node.labelAt.anchor,
      'dominant-baseline': 'central',
      'class': 'lbl ' + node.type + (node.labelAt.on ? '' : ' off')
    });
    label.textContent = node.label;
    labelLayer.appendChild(label);

    node.el = group;
    node.lblEl = label;
    node.lblOn = node.labelAt.on;
  });

  /* ------------------------------------------------------------ tooltip */

  function setTooltip(node, event) {
    tooltip.textContent = '';
    var kind = h('div', 'tt-kind');
    if (node.type === 'entity') {
      kind.appendChild(h('span', 'badge k-entity', '实体 · ' + (node.etype || 'concept')));
    } else {
      kind.appendChild(h('span', 'badge k-' + node.kind, DATA.kinds[node.kind] || node.kind));
      if (node.status !== 'active') {
        kind.appendChild(document.createTextNode(' '));
        kind.appendChild(h('span', 'badge warn plain', node.status === 'superseded' ? '已替换' : '已撤回'));
      }
    }
    tooltip.appendChild(kind);
    tooltip.appendChild(h('div', 'tt-title', node.full || node.label));

    if (node.type === 'entity') {
      var cards = Object.keys(neighbors[node.key]).filter(function (key) { return key.indexOf('c:') === 0; });
      tooltip.appendChild(h('div', 'tt-snip', cards.length + ' 张卡片 · ' + (node.projects.length ? node.projects.join(' / ') : '未归档')));
      tooltip.appendChild(h('div', 'tt-meta', 'first ' + (node.firstSeen || '—') + ' · last ' + (node.lastSeen || '—')));
    } else {
      if (node.snippet) tooltip.appendChild(h('div', 'tt-snip', node.snippet));
      tooltip.appendChild(h('div', 'tt-meta', node.id + ' · ' + node.project + ' · ' + node.created));
    }
    tooltip.classList.add('on');
    position(node, event);
  }

  function position(node, event) {
    var rect = stage.getBoundingClientRect();
    var x;
    var y;
    if (event && event.clientX) {
      x = event.clientX - rect.left + 16;
      y = event.clientY - rect.top + 14;
    } else {
      var box = node.el.getBoundingClientRect();
      x = box.left - rect.left + box.width / 2 + 14;
      y = box.top - rect.top - 8;
    }
    var w = tooltip.offsetWidth;
    var hh = tooltip.offsetHeight;
    if (x + w > rect.width - 10) x = Math.max(10, x - w - 30);
    if (y + hh > rect.height - 10) y = Math.max(10, y - hh - 24);
    tooltip.style.left = x + 'px';
    tooltip.style.top = y + 'px';
  }

  var hovered = null;
  function hover(node, event) {
    hovered = node;
    setTooltip(node, event);
    if (!node.lblOn) node.lblEl.classList.remove('off');
  }
  function unhover() {
    hovered = null;
    tooltip.classList.remove('on');
    refresh();
  }

  /* ------------------------------------------------------------ panel */

  function badge(kindClass, text, plain) {
    return h('span', 'badge ' + kindClass + (plain ? ' plain' : ''), text);
  }

  function chip(text, onclick) {
    var node = h('span', 'chip' + (onclick ? '' : ' static'), text);
    if (onclick) node.addEventListener('click', onclick);
    return node;
  }

  function renderPanel(node) {
    panel.textContent = '';
    var close = h('button', 'close', '×');
    close.title = '关闭 (Esc)';
    close.addEventListener('click', function () { select(null); });
    panel.appendChild(close);

    if (node.type === 'entity') {
      panel.appendChild(h('div', 'eyebrow', '实体 entity · ' + (node.etype || 'concept')));
      panel.appendChild(h('h2', null, node.full || node.label));
      var row = h('div', 'row');
      if (node.hub) row.appendChild(badge('k-mint', '跨项目枢纽'));
      row.appendChild(badge('k-entity', Object.keys(neighbors[node.key]).length + ' 条连线'));
      panel.appendChild(row);

      var dl = h('dl');
      var pairs = [
        ['首次出现', node.firstSeen || '—'],
        ['最近出现', node.lastSeen || '—'],
        ['别名', (node.aliases || []).join(' · ') || '—'],
        ['项目', (node.projects || []).join(' · ') || '—'],
        ['id', node.slug]
      ];
      pairs.forEach(function (pair) {
        dl.appendChild(h('dt', null, pair[0]));
        dl.appendChild(h('dd', null, pair[1]));
      });
      panel.appendChild(dl);

      if (node.mentions && node.mentions.length) {
        panel.appendChild(h('h3', null, '提及时间线'));
        var list = h('ul', 'mentions');
        node.mentions.forEach(function (mention) {
          var li = h('li');
          li.appendChild(h('span', 'd', mention.d));
          li.appendChild(h('span', null, mention.note));
          var key = 'c:' + mention.cardId;
          if (byKey[key]) li.addEventListener('click', function () { select(key); });
          list.appendChild(li);
        });
        panel.appendChild(list);
      }
      panel.hidden = false;
      return;
    }

    panel.appendChild(h('div', 'eyebrow', '记忆卡片 memory card'));
    panel.appendChild(h('h2', null, node.full || node.label));
    var badges = h('div', 'row');
    badges.appendChild(badge('k-' + node.kind, DATA.kinds[node.kind] || node.kind));
    if (node.status !== 'active') {
      badges.appendChild(badge('warn', node.status === 'superseded' ? '已替换 superseded' : '已撤回 retracted', true));
    }
    badges.appendChild(badge('plain', node.confidence, true));
    panel.appendChild(badges);

    var meta = h('dl');
    [['项目', node.project], ['日期', node.created], ['id', node.id]].forEach(function (pair) {
      meta.appendChild(h('dt', null, pair[0]));
      meta.appendChild(h('dd', null, pair[1]));
    });
    panel.appendChild(meta);

    if (node.body) panel.appendChild(h('p', 'body', node.body));

    if (node.entities && node.entities.length) {
      panel.appendChild(h('h3', null, '提到的实体'));
      var chips = h('div', 'chips');
      node.entities.forEach(function (entity) {
        var key = 'e:' + entity.slug;
        chips.appendChild(chip(entity.name, byKey[key] ? function () { select(key); } : null));
      });
      panel.appendChild(chips);
    }

    var chain = []
    if (node.supersedes && node.supersedes.length) chain.push(['替换了', node.supersedes]);
    if (node.supersededBy) chain.push(['被替换为', [node.supersededBy]]);
    if (chain.length) {
      panel.appendChild(h('h3', null, '替换链'));
      var chainBox = h('div', 'chips');
      chain.forEach(function (entry) {
        entry[1].forEach(function (id) {
          var other = byKey['c:' + id];
          var label = entry[0] + ' ' + (other ? (other.full || other.label) : id);
          chainBox.appendChild(chip(label, other ? function () { select(other.key); } : null));
        });
      });
      panel.appendChild(chainBox);
    }
    panel.hidden = false;
  }

  /* ------------------------------------------------------------ state */

  function matches(node, q) {
    if (q === '') return true;
    if (String(node.label).toLowerCase().indexOf(q) !== -1) return true;
    if (String(node.full).toLowerCase().indexOf(q) !== -1) return true;
    if (node.type === 'card') {
      if (String(node.id).toLowerCase().indexOf(q) !== -1) return true;
      for (var i = 0; i < node.entities.length; i++) {
        if (String(node.entities[i].name).toLowerCase().indexOf(q) !== -1) return true;
      }
    } else {
      if (String(node.slug).toLowerCase().indexOf(q) !== -1) return true;
    }
    return false;
  }

  function refresh() {
    var q = searchBox.value.trim().toLowerCase();
    var project = projectBox.value;
    var filtering = q !== '' || project !== '*';
    var visible = {};
    var hitCount = 0;

    nodes.forEach(function (node) {
      var cls = node.baseClass;
      var show = true;
      var hit = false;
      if (selected) {
        if (node.key === selected || neighbors[selected][node.key]) {
          cls += ' lit';
          show = true;
        } else {
          cls += ' dim';
          show = false;
        }
      } else if (filtering) {
        var okProject = project === '*' || node.projects.indexOf(project) !== -1;
        var okQuery = matches(node, q);
        if (okProject && okQuery) {
          if (q !== '') { cls += ' hit'; hit = true; hitCount++; }
        } else {
          cls += ' dim';
          show = false;
        }
      }
      if (node.key === selected) cls += ' sel';
      node.el.setAttribute('class', cls);
      visible[node.key] = show;

      var labelCls = 'lbl ' + node.type + (show && (node.lblOn || hit || node.key === selected) ? '' : ' off') + (show ? '' : ' dim');
      node.lblEl.setAttribute('class', labelCls);
    });

    edgeEls.forEach(function (edge) {
      var cls = 'edge-group' + (String(edge.g.getAttribute('class')).indexOf('supersede') !== -1 ? ' supersede' : '');
      if (selected) {
        if (visible[edge.a] && visible[edge.b]) cls += ' lit';
        else cls += ' dim';
      } else if (!visible[edge.a] || !visible[edge.b]) {
        cls += ' dim';
      }
      edge.g.setAttribute('class', cls);
    });

    var label = document.getElementById('match-bar');
    if (filtering && q !== '') {
      if (!label) {
        label = h('div', 'badge plain');
        label.id = 'match-bar';
        countsBox.parentNode.insertBefore(label, countsBox.nextSibling);
      }
      label.textContent = '匹配 ' + hitCount + ' / ' + nodes.length;
      label.hidden = false;
    } else if (label) {
      label.hidden = true;
    }
  }

  function select(key) {
    selected = key;
    if (!key) {
      panel.hidden = true;
      refresh();
      return;
    }
    var node = byKey[key];
    if (!node) return;
    renderPanel(node);
    // Bring the node into view if it sits outside the viewport.
    var box = node.el.getBoundingClientRect();
    var frame = stage.getBoundingClientRect();
    if (box.left < frame.left || box.right > frame.right || box.top < frame.top || box.bottom > frame.bottom) {
      var ctm = canvas.getScreenCTM();
      view.x += (frame.left + frame.width / 2 - box.left - box.width / 2) / (ctm ? ctm.a : 1);
      view.y += (frame.top + frame.height / 2 - box.top - box.height / 2) / (ctm ? ctm.a : 1);
      applyView();
    }
    refresh();
  }

  /* ------------------------------------------------------------ view */

  function applyView() {
    viewport.setAttribute(
      'transform',
      'translate(' + fmt(view.x) + ' ' + fmt(view.y) + ') scale(' + (Math.round(view.k * 1000) / 1000) + ')'
    );
  }

  function toUser(event) {
    var ctm = canvas.getScreenCTM();
    var point = canvas.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    if (!ctm) return { x: 0, y: 0 };
    var local = point.matrixTransform(ctm.inverse());
    return { x: local.x, y: local.y };
  }

  function zoomAt(point, factor) {
    var k = Math.min(4.5, Math.max(0.35, view.k * factor));
    var ratio = k / view.k;
    view.x = point.x - ratio * (point.x - view.x);
    view.y = point.y - ratio * (point.y - view.y);
    view.k = k;
    applyView();
  }

  canvas.addEventListener('wheel', function (event) {
    event.preventDefault();
    zoomAt(toUser(event), Math.exp(-event.deltaY * 0.0016));
  }, { passive: false });

  document.getElementById('zoom-in').addEventListener('click', function () { zoomAt({ x: 700, y: 430 }, 1.3); });
  document.getElementById('zoom-out').addEventListener('click', function () { zoomAt({ x: 700, y: 430 }, 1 / 1.3); });
  document.getElementById('zoom-fit').addEventListener('click', function () {
    view = { k: 1, x: 0, y: 0 };
    applyView();
  });

  var drag = null;
  canvas.addEventListener('pointerdown', function (event) {
    if (event.target.closest && event.target.closest('.node')) return;
    drag = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y, moved: false };
    canvas.classList.add('panning');
    if (canvas.setPointerCapture) canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', function (event) {
    if (!drag) return;
    var ctm = canvas.getScreenCTM();
    var scale = ctm ? ctm.a : 1;
    var dx = (event.clientX - drag.x) / scale;
    var dy = (event.clientY - drag.y) / scale;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    view.x = drag.vx + dx;
    view.y = drag.vy + dy;
    applyView();
  });
  canvas.addEventListener('pointerup', function () {
    var moved = drag ? drag.moved : false;
    drag = null;
    canvas.classList.remove('panning');
    if (!moved) select(null);
  });
  canvas.addEventListener('pointercancel', function () {
    drag = null;
    canvas.classList.remove('panning');
  });

  /* ------------------------------------------------------------ filters */

  var all = h('option', null, '全部项目 · ' + DATA.counts.cards);
  all.value = '*';
  projectBox.appendChild(all);
  DATA.projects.forEach(function (project) {
    var option = h('option', null, project.slug + ' · ' + project.count);
    option.value = project.slug;
    projectBox.appendChild(option);
  });
  projectBox.addEventListener('change', refresh);
  searchBox.addEventListener('input', refresh);

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      if (document.activeElement === searchBox && searchBox.value !== '') {
        searchBox.value = '';
        refresh();
        return;
      }
      select(null);
      searchBox.blur();
    } else if (event.key === '/' && document.activeElement !== searchBox) {
      event.preventDefault();
      searchBox.focus();
    } else if (event.key === 'f' && document.activeElement !== searchBox) {
      view = { k: 1, x: 0, y: 0 };
      applyView();
    }
  });

  applyView();
  refresh();
  if (pendingNode) {
    var linked = nodes.filter(function (node) {
      return node.key === pendingNode || node.id === pendingNode || node.slug === pendingNode;
    })[0];
    if (linked) select(linked.key);
  }
})();
`
}

/* ---------------------------------------------------------------- render */

function escapeForScript(json) {
  // `</script>` inside a card title would end the block; < is escaped everywhere
  // because it only ever appears inside a JSON string.
  return json
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

function stamp() {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  )
}

/**
 * Render the whole vault as one offline HTML page.
 *
 * @param {{ cards?: object[], entities?: object[], projects?: object[], generatedAt?: string }} input
 * @returns {string} a complete, self-contained HTML document
 */
export function renderGraphHtml({ cards = [], entities = [], projects = [], generatedAt = '' } = {}) {
  const payload = toPayload({
    cards,
    entities,
    projects,
    generatedAt: generatedAt || stamp(),
  })
  const dataJson = escapeForScript(JSON.stringify(payload))
  const title = `记忆图 · ${payload.counts.cards} cards / ${payload.counts.entities} entities`

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>${title.replace(/</g, '&lt;')}</title>
<style>${CSS}</style>
</head>
<body>
${BODY}
<script>${clientScript(dataJson)}</script>
</body>
</html>
`
}

/** Content hash of the rendered page, handy for "did anything change". */
export function graphDigest(html) {
  return crypto.createHash('sha256').update(html, 'utf8').digest('hex').slice(0, 12)
}
