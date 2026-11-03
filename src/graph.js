/**
 * Graph view: the whole vault as one self-contained HTML page.
 *
 * The output is deliberately a single file with inline CSS and inline script —
 * no network, no CDN, no font download, no build step. Double-click it and it
 * works; zip the vault and it still works. Nothing is fetched, so the page says
 * the same thing offline ten years from now.
 *
 * Layout is computed here, in Node, in three dimensions: every memory kind is
 * pulled toward a fixed direction of its own, so the vault fans out into slices
 * the way a stained neuron culture does, and entities settle in the seams
 * between the slices because they are pulled at the centroid of the cards that
 * mention them. Two runs over the same vault produce the same cloud (byte for
 * byte, generation stamp aside) — no Math.random, no wall clock, fixed
 * iteration count.
 *
 * The browser side owns the camera: it projects the cloud with a perspective
 * divide, sorts by depth and draws it with additive halos on a canvas. Rotation
 * is real rotation of real 3D points, which is why the parallax between front
 * and back cells reads as depth instead of as a z-index trick.
 */
import crypto from 'node:crypto'

/**
 * Five card kinds, one hue each: cool, dark-background glow tones taken from
 * the reference culture dish. Entity cells get their own near-white.
 */
export const KIND_COLORS = {
  decision: '#a78bfa',
  fact: '#2ee0d0',
  open_question: '#e879f9',
  preference: '#fb923c',
  note: '#34d399',
}

const KIND_LABELS = {
  decision: '决策 decision',
  fact: '事实 fact',
  open_question: '待解 open_question',
  preference: '偏好 preference',
  note: '记录 note',
}

/** The faint names that float beside each slice in the cloud. */
const KIND_SHORT = {
  decision: '决策记忆',
  fact: '事实知识',
  open_question: '未决疑问',
  preference: '偏好态度',
  note: '工作记录',
  entity: '实体枢纽',
}

/**
 * One fixed direction per kind. These are constants, not seeds: the slices are
 * always in the same place relative to each other, so two vaults look like
 * siblings and the same vault looks identical twice. Mostly horizontal, so the
 * cloud fills a wide frame instead of a tall one.
 */
const CLUSTER_DIR = {
  decision: [-0.82, -0.56, 0.32],
  fact: [0.78, -0.44, 0.5],
  open_question: [0.06, 0.94, -0.42],
  preference: [-0.56, 0.62, -0.58],
  note: [0.44, -0.06, -0.86],
  entity: [0, 0, 0],
}

const WORLD = {
  /** The cloud is normalised to this radius; x is stretched so it reads wide. */
  stretchX: 1.5,
  /** Fixed, so the picture is a pure function of the vault. */
  iterations: 240,
  /** Linked cells want to sit about this far apart (normalised units). */
  linkLength: 0.21,
  /** Repulsion is cut off here; beyond it the pair force is zero. */
  cutoff: 0.6,
  /** Two cells never share a spot: hard floor for the separation pass. */
  separation: 0.085,
}

/* ---------------------------------------------------------------- helpers */

function round4(n) {
  return Math.round(n * 10000) / 10000
}

function clampText(text, max) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, max - 1).trimEnd()}…`
}

/**
 * Rough advance width, no font metrics in Node: CJK is full-width, latin about
 * 0.6em. Only used to pre-truncate the label baked into the payload — the
 * browser measures for real before it draws.
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

/**
 * Radii are world units, not pixels: the browser multiplies them by the same
 * perspective factor as the position, so a cell shrinks as it recedes. The
 * numbers are tuned so a leaf card lands around 5 px and a busy hub around
 * 17 px on an 860 px tall canvas at rest.
 */
function cardRadius(degree) {
  return round4(0.0052 + Math.min(0.0050, Math.sqrt(degree) * 0.0013))
}

function entityRadius(degree) {
  return round4(0.0115 + Math.min(0.0125, Math.sqrt(degree) * 0.0029))
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
      // Entities are not a memory kind, so they are not pulled to a slice: the
      // cards that mention them decide where they land.
      cluster: 'entity',
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
    const kind = String(card.kind ?? 'note')
    const node = {
      key: `c:${card.id}`,
      type: 'card',
      kind,
      cluster: CLUSTER_DIR[kind] ? kind : 'note',
      label: String(card.title ?? '（无标题 untitled）'),
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

  // An entity is not a memory kind, but a cloud where two thirds of the cells are
  // pale white is a cloud of white dots. Each one takes the kind of the cards that
  // mention it, so a hub glows in the colour of the region it lives in.
  const kindTally = new Map()
  for (const link of links) {
    if (link.k !== 'mention') continue
    const entity = bySlug.get(link.t.slice(2))
    const card = byId.get(link.s.slice(2))
    if (!entity || !card) continue
    const bucket = kindTally.get(entity.key) ?? {}
    bucket[card.kind] = (bucket[card.kind] ?? 0) + 1
    kindTally.set(entity.key, bucket)
  }

  for (const node of nodes) {
    if (node.type === 'entity') {
      const bucket = kindTally.get(node.key)
      let best = null
      let bestCount = 0
      for (const kind of Object.keys(bucket ?? {})) {
        if (bucket[kind] > bestCount) {
          best = kind
          bestCount = bucket[kind]
        }
      }
      if (best) node.kind = best
    }
  }

  for (const node of nodes) {
    node.r = node.type === 'entity' ? entityRadius(node.degree) : cardRadius(node.degree)
    node.haloScale = node.type === 'entity' ? 3.6 : 4.2
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
 * Deterministic 3D force layout.
 *
 * Three forces plus one pass:
 *   - springs along links, so a card stays near the entities it mentions;
 *   - short-range repulsion with a cutoff, so cells breathe without paying an
 *     O(n^2) bill for the pairs that are already far apart;
 *   - a pull toward its kind's fixed direction (cards) or toward the centroid of
 *     its neighbours (entities) — this is what turns a ball into slices;
 *   - a hard separation pass, so no two cells occupy the same point.
 *
 * Everything is seeded from a hash of the node keys, so the same vault always
 * settles into the same cloud.
 */
function layoutGraph3D(nodes, links) {
  const n = nodes.length
  if (n === 0) return
  const index = new Map(nodes.map((node, i) => [node.key, i]))
  const px = new Float64Array(n)
  const py = new Float64Array(n)
  const pz = new Float64Array(n)
  const fx = new Float64Array(n)
  const fy = new Float64Array(n)
  const fz = new Float64Array(n)
  const rng = makeRng(hashString(nodes.map((node) => node.key).join('|')))

  const perCluster = new Map()
  for (const node of nodes) perCluster.set(node.cluster, (perCluster.get(node.cluster) ?? 0) + 1)

  // Seed each cell inside its own slice: the cluster pull only has to tidy up,
  // not to invent the fan from a featureless ball.
  const slots = new Map()
  for (let i = 0; i < n; i++) {
    const node = nodes[i]
    const dir = CLUSTER_DIR[node.cluster] ?? [0, 0, 0]
    const slot = (slots.get(node.cluster) ?? 0) + 1
    slots.set(node.cluster, slot)
    const total = perCluster.get(node.cluster) ?? 1
    const ring = 0.1 + 0.34 * Math.sqrt(slot / total)
    const angle = slot * 2.399963229728653 + (hashString(node.key) % 1000) / 159.15
    px[i] = dir[0] * 0.6 + Math.cos(angle) * ring + (rng() - 0.5) * 0.05
    py[i] = dir[1] * 0.6 + Math.sin(angle) * ring * 0.78 + (rng() - 0.5) * 0.05
    pz[i] = dir[2] * 0.6 + Math.cos(angle * 1.618) * ring + (rng() - 0.5) * 0.05
  }

  const edges = []
  for (const link of links) {
    const a = index.get(link.s)
    const b = index.get(link.t)
    if (a === undefined || b === undefined) continue
    edges.push([a, b, link.k === 'supersede' ? 1.3 : 1])
  }

  // Entity -> the cards that mention it. Recomputed every iteration from the
  // current positions: cheap (O(edges)) and it lets a shared entity slide into
  // the seam between two slices instead of picking one.
  const entityLinks = []
  for (let i = 0; i < n; i++) if (nodes[i].type === 'entity') entityLinks.push(i)

  const cut2 = WORLD.cutoff * WORLD.cutoff
  const k2 = 0.055 * 0.055
  let temperature = 0.34

  for (let iter = 0; iter < WORLD.iterations; iter++) {
    fx.fill(0)
    fy.fill(0)
    fz.fill(0)

    for (let i = 0; i < n; i++) {
      const xi = px[i]
      const yi = py[i]
      const zi = pz[i]
      for (let j = i + 1; j < n; j++) {
        let dx = xi - px[j]
        let dy = yi - py[j]
        let dz = zi - pz[j]
        const d2 = dx * dx + dy * dy + dz * dz
        if (d2 > cut2) continue
        if (d2 < 1e-6) {
          dx = (rng() - 0.5) * 0.01
          dy = (rng() - 0.5) * 0.01
          dz = (rng() - 0.5) * 0.01
        }
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.001
        // Linear fade to zero at the cutoff keeps the force continuous.
        const force = (k2 / (d * d)) * (1 - d / WORLD.cutoff) * 0.0001
        const ux = dx / d
        const uy = dy / d
        const uz = dz / d
        fx[i] += ux * force
        fy[i] += uy * force
        fz[i] += uz * force
        fx[j] -= ux * force
        fy[j] -= uy * force
        fz[j] -= uz * force
      }
    }

    for (const [a, b, weight] of edges) {
      const dx = px[b] - px[a]
      const dy = py[b] - py[a]
      const dz = pz[b] - pz[a]
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.001
      const force = (d - WORLD.linkLength * weight) * 0.42
      const ux = dx / d
      const uy = dy / d
      const uz = dz / d
      fx[a] += ux * force
      fy[a] += uy * force
      fz[a] += uz * force
      fx[b] -= ux * force
      fy[b] -= uy * force
      fz[b] -= uz * force
    }

    for (let i = 0; i < n; i++) {
      const node = nodes[i]
      if (node.type === 'card') {
        const dir = CLUSTER_DIR[node.cluster] ?? [0, 0, 0]
        fx[i] += (dir[0] * 1.06 - px[i]) * 0.062
        fy[i] += (dir[1] * 1.06 - py[i]) * 0.062
        fz[i] += (dir[2] * 1.06 - pz[i]) * 0.062
      } else {
        // Centroid of the neighbours, not of the whole graph.
        const around = node.around ?? []
        if (around.length > 0) {
          let sx = 0
          let sy = 0
          let sz = 0
          for (const other of around) {
            sx += px[other]
            sy += py[other]
            sz += pz[other]
          }
          const inv = 1 / around.length
          fx[i] += (sx * inv - px[i]) * 0.16
          fy[i] += (sy * inv - py[i]) * 0.16
          fz[i] += (sz * inv - pz[i]) * 0.16
        }
      }
      // Weak gravity: without it the slices drift apart into a flat pancake.
      fx[i] -= px[i] * 0.014
      fy[i] -= py[i] * 0.014
      fz[i] -= pz[i] * 0.014
    }

    for (let i = 0; i < n; i++) {
      const d = Math.sqrt(fx[i] * fx[i] + fy[i] * fy[i] + fz[i] * fz[i]) || 1
      const step = Math.min(d, temperature)
      px[i] += (fx[i] / d) * step
      py[i] += (fy[i] / d) * step
      pz[i] += (fz[i] / d) * step
    }

    // Hard separation every few iterations, so the cloud never has to untangle
    // a pile of coincident cells at the end.
    if (iter % 5 === 4) {
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const min = WORLD.separation
          let dx = px[j] - px[i]
          let dy = py[j] - py[i]
          let dz = pz[j] - pz[i]
          const d2 = dx * dx + dy * dy + dz * dz
          if (d2 >= min * min) continue
          if (d2 < 1e-8) {
            dx = (rng() - 0.5) * 0.02
            dy = (rng() - 0.5) * 0.02
            dz = (rng() - 0.5) * 0.02
          }
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.001
          const push = (min - d) / 2
          px[i] -= (dx / d) * push
          py[i] -= (dy / d) * push
          pz[i] -= (dz / d) * push
          px[j] += (dx / d) * push
          py[j] += (dy / d) * push
          pz[j] += (dz / d) * push
        }
      }
    }

    temperature = Math.max(0.012, temperature * 0.978)
  }

  // Normalise: centre on the middle of the bounding box (not the centroid — a
  // dense knot on one side would push the cloud off the middle of the frame),
  // then scale each axis to its own target so the browser only has to know the
  // world is a box about 2.5 x 1.9 x 1.6 units.
  let x0 = Infinity
  let x1 = -Infinity
  let y0 = Infinity
  let y1 = -Infinity
  let z0 = Infinity
  let z1 = -Infinity
  for (let i = 0; i < n; i++) {
    x0 = Math.min(x0, px[i])
    x1 = Math.max(x1, px[i])
    y0 = Math.min(y0, py[i])
    y1 = Math.max(y1, py[i])
    z0 = Math.min(z0, pz[i])
    z1 = Math.max(z1, pz[i])
  }
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  const cz = (z0 + z1) / 2
  // The force layout has no reason to fill a box, so normalise each axis to its
  // own target instead of to one sphere: the cloud then fills a 16:9 frame (and
  // the narrow sidebar iframe) no matter how the slices happened to settle.
  const axis = (lo, hi, target) => {
    const half = Math.max((hi - lo) / 2, 1e-6)
    return target / half
  }
  const sx = axis(x0, x1, 1.25)
  const sy = axis(y0, y1, 0.95)
  const sz = axis(z0, z1, 0.8)

  for (let i = 0; i < n; i++) {
    nodes[i].x = round4((px[i] - cx) * sx)
    nodes[i].y = round4((py[i] - cy) * sy)
    nodes[i].z = round4((pz[i] - cz) * sz)
  }
}

/**
 * Adjacency the layout needs: an entity is pulled to the centroid of the cards
 * that mention it. Built before the layout runs, because the pull is part of it.
 */
function attachNeighborhoods(nodes, links) {
  const index = new Map(nodes.map((node, i) => [node.key, i]))
  for (const node of nodes) node.around = []
  for (const link of links) {
    const a = index.get(link.s)
    const b = index.get(link.t)
    if (a === undefined || b === undefined) continue
    if (nodes[a].type === 'entity') nodes[a].around.push(b)
    if (nodes[b].type === 'entity') nodes[b].around.push(a)
  }
}

/* ---------------------------------------------------------------- payload */

function toPayload({ cards, entities, projects, generatedAt }) {
  const model = buildModel({ cards, entities, projects })
  attachNeighborhoods(model.nodes, model.links)
  layoutGraph3D(model.nodes, model.links)

  const nodes = model.nodes.map((node) => {
    const base = {
      key: node.key,
      type: node.type,
      kind: node.kind,
      cluster: node.cluster,
      // Pre-truncated for the common case; the browser re-measures before it
      // draws and hides whatever does not fit instead of overlapping it.
      label: truncateToWidth(node.label, node.type === 'entity' ? 11.5 : 10.5, node.type === 'entity' ? 138 : 126),
      full: node.label,
      x: node.x,
      y: node.y,
      z: node.z,
      // World radius: the renderer multiplies it by the same perspective factor
      // as the position, which is what makes distant cells smaller.
      r: node.r,
      // The renderer draws the halo at r * haloScale.
      haloScale: node.haloScale,
      degree: node.degree,
      projects: node.projects,
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

  // The 90th-percentile distance from the centre. The renderer fits the cloud to
  // the frame with it: a bounding sphere would leave a fifth of the frame empty
  // because a handful of outliers sit far out, and this survives rotation, so the
  // view does not breathe while the cloud turns.
  const distances = nodes
    .map((node) => Math.hypot(node.x, node.y, node.z))
    .sort((a, b) => a - b)
  const radius90 = round4(distances.length ? distances[Math.floor(distances.length * 0.9)] ?? distances.at(-1) : 1)

  return {
    generatedAt,
    counts,
    kinds: KIND_LABELS,
    short: KIND_SHORT,
    radius90: radius90 > 0 ? radius90 : 1,
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
  --bg-0: #05080c;
  --bg-1: #0a1218;
  --bg-2: #16222e;
  --scene-a: #08131c;
  --scene-b: #01030a;
  --fg: #e8eef5;
  --fg-dim: #8fa2b6;
  --line: rgba(148, 163, 184, 0.18);
  --edge: rgba(148, 163, 184, 0.30);
  --mint: #6ee7b7;
  --entity: #bcd8f2;
  --panel: rgba(10, 18, 24, 0.9);
  --chip: rgba(148, 163, 184, 0.12);
  --shadow: 0 18px 44px rgba(0, 0, 0, 0.6);
  --k-decision: #a78bfa;
  --k-fact: #2ee0d0;
  --k-open_question: #e879f9;
  --k-preference: #fb923c;
  --k-note: #34d399;`,
  light: `
  color-scheme: light;
  --bg-0: #e8eef5;
  --bg-1: #f7fafc;
  --bg-2: #ffffff;
  --scene-a: #fbfdff;
  --scene-b: #d7e1ec;
  --fg: #101820;
  --fg-dim: #4d6076;
  --line: rgba(16, 24, 32, 0.16);
  --edge: rgba(16, 24, 32, 0.26);
  --mint: #0b8f6b;
  --entity: #1b4a6b;
  --panel: rgba(255, 255, 255, 0.94);
  --chip: rgba(16, 24, 32, 0.055);
  --shadow: 0 18px 44px rgba(16, 24, 32, 0.2);
  --k-decision: #6d28d9;
  --k-fact: #0a7f78;
  --k-open_question: #a21caf;
  --k-preference: #b45309;
  --k-note: #0f7a5a;`,
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
  background: var(--scene-b);
}
#scene {
  position: absolute; inset: 0; width: 100%; height: 100%; display: block;
  touch-action: none; cursor: grab;
}
#scene.dragging { cursor: grabbing; }

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
  #panel { width: auto; left: 14px; right: 14px; }
  input[type="search"] { width: 130px; }
}
/* The app embeds this page in a ~380x520 sidebar frame: keep the chrome from
   eating the picture. */
@media (max-width: 560px) {
  header { gap: 8px; padding: 8px 10px 9px; }
  .brand span.en { display: none; }
  .counts { display: none; }
  input[type="search"] { width: 108px; }
  #zoom-in, #zoom-out { display: none; }
  footer { padding: 6px 10px 7px; font-size: 10px; }
  #legend { gap: 3px 10px; }
}
@media (prefers-reduced-motion: reduce) {
  #tooltip { transition: none; }
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
        <button id="zoom-in" title="推近">+</button>
        <button id="zoom-out" title="拉远">−</button>
        <button id="zoom-fit" title="复位 (f)">复位</button>
      </div>
    </div>
  </header>
  <main>
    <div id="stage">
      <canvas id="scene" role="img" aria-label="记忆图"></canvas>
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
    <div id="hint">拖动旋转 · 滚轮推拉 · 双击复位 · 点击神经元看详情 · Esc 清除 · / 搜索</div>
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
  var nodes = DATA.nodes;
  var KINDS = ['decision', 'fact', 'open_question', 'preference', 'note'];
  var CONFIDENCE_LABELS = {
    user_stated: '用户明说 user_stated',
    verified: '已验证 verified',
    inferred: '推断 inferred'
  };
  var FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Microsoft YaHei", "PingFang SC", sans-serif';

  var scene = document.getElementById('scene');
  var ctx = scene.getContext('2d');
  var stage = document.getElementById('stage');
  var tooltip = document.getElementById('tooltip');
  var panel = document.getElementById('panel');
  var emptyBox = document.getElementById('empty');
  var legendBox = document.getElementById('legend');
  var countsBox = document.getElementById('counts');
  var searchBox = document.getElementById('search');
  var projectBox = document.getElementById('project');

  var byKey = {};
  var neighbors = {};
  var selected = null;
  var hovered = null;
  var W = 0;
  var H = 0;
  var DPR = 1;
  var dirty = true;

  /* ------------------------------------------------------------ theme */

  var THEME_KEY = 'dsh-memory-graph-theme';
  var themeButton = document.getElementById('theme');
  var PAL = null;
  var sprites = {};
  var glowCanvas = document.createElement('canvas');
  var glowCtx = glowCanvas.getContext('2d');
  var reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  function storedTheme() {
    try { return localStorage.getItem(THEME_KEY) || 'auto'; } catch (error) { return 'auto' }
  }

  function isDark() {
    var attr = document.documentElement.getAttribute('data-theme');
    if (attr === 'dark') return true;
    if (attr === 'light') return false;
    return !(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
  }

  function token(styles, name, fallback) {
    var value = styles.getPropertyValue(name);
    value = value ? String(value).trim() : '';
    return value || fallback;
  }

  function parseColor(input) {
    var text = String(input || '').trim();
    if (text.charAt(0) === '#') {
      var hex = text.slice(1);
      if (hex.length === 3) hex = hex.charAt(0) + hex.charAt(0) + hex.charAt(1) + hex.charAt(1) + hex.charAt(2) + hex.charAt(2);
      var value = parseInt(hex, 16);
      if (value === value) return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
    }
    var match = text.match(/([0-9.]+)[,\\s]+([0-9.]+)[,\\s]+([0-9.]+)/);
    if (match) return [Number(match[1]), Number(match[2]), Number(match[3])];
    return [148, 163, 184];
  }

  function rgba(rgb, alpha) {
    return 'rgba(' + Math.round(rgb[0]) + ',' + Math.round(rgb[1]) + ',' + Math.round(rgb[2]) + ',' + alpha + ')';
  }

  // A radial-gradient sprite per kind, drawn once. 339 radial gradients per
  // frame is what makes naive canvas glow crawl; blitting a sprite is cheap.
  function haloSprite(rgb) {
    var size = 128;
    var canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    var paint = canvas.getContext('2d');
    var gradient = paint.createRadialGradient(64, 64, 0, 64, 64, 64);
    gradient.addColorStop(0, rgba(rgb, 0.8));
    gradient.addColorStop(0.16, rgba(rgb, 0.34));
    gradient.addColorStop(0.34, rgba(rgb, 0.11));
    gradient.addColorStop(0.62, rgba(rgb, 0.032));
    gradient.addColorStop(1, rgba(rgb, 0));
    paint.fillStyle = gradient;
    paint.fillRect(0, 0, size, size);
    return canvas;
  }

  function readPalette() {
    var styles = getComputedStyle(document.documentElement);
    var palette = {
      dark: isDark(),
      kinds: {},
      rgb: {},
      entity: token(styles, '--entity', '#f2f7fd'),
      edge: token(styles, '--edge', 'rgba(148,163,184,0.3)'),
      mint: token(styles, '--mint', '#6ee7b7'),
      fg: token(styles, '--fg', '#e8eef5'),
      bg0: token(styles, '--bg-0', '#05080c'),
      sceneA: token(styles, '--scene-a', '#0c1a22'),
      sceneB: token(styles, '--scene-b', '#04070a')
    };
    KINDS.forEach(function (kind) { palette.kinds[kind] = token(styles, '--k-' + kind, '#94a3b8') });
    palette.kinds.entity = palette.entity;
    Object.keys(palette.kinds).forEach(function (kind) {
      palette.rgb[kind] = parseColor(palette.kinds[kind]);
    });
    // Entities borrow the hue of the region they live in, but washed towards the
    // foreground colour: a hub should read as the paler, bigger cousin of a card.
    palette.soft = {};
    var pale = palette.dark ? [235, 245, 255] : [250, 252, 255];
    KINDS.forEach(function (kind) {
      var rgb = palette.rgb[kind];
      palette.soft[kind] = [
        rgb[0] + (pale[0] - rgb[0]) * 0.42,
        rgb[1] + (pale[1] - rgb[1]) * 0.42,
        rgb[2] + (pale[2] - rgb[2]) * 0.42,
      ];
    });
    palette.soft.entity = parseColor(palette.entity);
    palette.rgbMint = parseColor(palette.mint);
    palette.rgbFg = parseColor(palette.fg);
    return palette;
  }

  function rgbOf(node) {
    return node.type === 'entity' ? PAL.soft[node.kind] || PAL.rgb[node.kind] : PAL.rgb[node.kind];
  }

  function spriteOf(node) {
    return node.type === 'entity' ? sprites['soft:' + node.kind] || sprites[node.kind] : sprites[node.kind];
  }

  function rebuildSprites() {
    PAL = readPalette();
    sprites = {};
    Object.keys(PAL.kinds).forEach(function (kind) {
      sprites[kind] = haloSprite(PAL.rgb[kind]);
    });
    KINDS.forEach(function (kind) {
      sprites['soft:' + kind] = haloSprite(PAL.soft[kind]);
    });
    var background = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    PAL.background = background;
    dirty = true;
  }

  function applyTheme(mode) {
    if (mode === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', mode);
    themeButton.textContent = mode === 'dark' ? '☾' : mode === 'light' ? '☀' : '◐';
    themeButton.title = '主题：' + (mode === 'auto' ? '跟随系统' : mode === 'dark' ? '深色' : '浅色');
    rebuildSprites();
  }

  themeButton.addEventListener('click', function () {
    var next = storedTheme() === 'auto' ? 'dark' : storedTheme() === 'dark' ? 'light' : 'auto';
    try { localStorage.setItem(THEME_KEY, next); } catch (error) { /* private mode */ }
    applyTheme(next);
  });

  /* ------------------------------------------------------------ graph data */

  nodes.forEach(function (node) {
    byKey[node.key] = node;
    neighbors[node.key] = {};
    node.vis = 1;
    node.hit = false;
    node.proj = { sx: 0, sy: 0, sr: 1, k: 1, z: 0 };
  });
  DATA.links.forEach(function (link) {
    if (!byKey[link.s] || !byKey[link.t]) return;
    neighbors[link.s][link.t] = true;
    neighbors[link.t][link.s] = true;
  });

  function h(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  // Deterministic pseudo-randomness for the dendrites and the edge bends: a
  // pure function of the cell key, so the same vault draws the same hairs.
  function hash32(text) {
    var value = 2166136261;
    for (var i = 0; i < text.length; i++) {
      value ^= text.charCodeAt(i);
      value = Math.imul(value, 16777619);
    }
    return value >>> 0;
  }

  function hairsFor(node) {
    if (node.hairs) return node.hairs;
    var seed = hash32(node.key);
    var count = 3 + (seed % 5);
    var out = [];
    for (var i = 0; i < count; i++) {
      var a = (seed >>> ((i % 8) * 4)) & 1023;
      var b = (seed >>> ((i * 3 + 5) % 24)) & 511;
      var c = (seed >>> ((i * 5 + 3) % 24)) & 511;
      out.push([
        i * 2.39996 + (a / 1023) * 0.9,
        ((b / 511) - 0.5) * 1.7,
        3.4 + (c / 511) * 2.8,
        ((a / 1023) - 0.5) * 1.6
      ]);
    }
    node.hairs = out;
    return out;
  }

  /* ------------------------------------------------------------ camera */

  var CAM_START = { yaw: 0.62, pitch: -0.26, dolly: 1 };
  var cam = { yaw: CAM_START.yaw, pitch: CAM_START.pitch, dolly: CAM_START.dolly };
  var DIST = 3.1;
  var frame = { cy: 1, sy: 0, cp: 1, sp: 0, R: 300, cx: 0, cy: 0 };
  var focus = null;
  var still = false;

  function clamp(value, lo, hi) {
    return value < lo ? lo : value > hi ? hi : value;
  }

  function syncFrame() {
    frame.cy = Math.cos(cam.yaw);
    frame.sy = Math.sin(cam.yaw);
    frame.cp = Math.cos(cam.pitch);
    frame.sp = Math.sin(cam.pitch);
    // Fit the cloud to the frame: radius90 is the rotation-invariant radius that
    // holds nine cells in ten, so this keeps the same margins at any angle and in
    // the narrow sidebar iframe.
    var reach = DATA.radius90 || 1;
    frame.R = (Math.min(W, H * 1.45) * 0.44) / (reach * 1.12) * cam.dolly;
    frame.cx = W / 2;
    frame.cyy = H / 2;
  }

  function projectPoint(x, y, z, out) {
    var x1 = x * frame.cy - z * frame.sy;
    var z1 = x * frame.sy + z * frame.cy;
    var y1 = y * frame.cp - z1 * frame.sp;
    var z2 = y * frame.sp + z1 * frame.cp;
    var k = DIST / (DIST - z2);
    out.sx = frame.cx + x1 * frame.R * k;
    out.sy = frame.cyy + y1 * frame.R * k * 0.94;
    out.k = k;
    out.z = z2;
    return out;
  }

  var scratch = { sx: 0, sy: 0, k: 1, z: 0 };

  function projectInto(node) {
    var x1 = node.x * frame.cy - node.z * frame.sy;
    var z1 = node.x * frame.sy + node.z * frame.cy;
    var y1 = node.y * frame.cp - z1 * frame.sp;
    var z2 = node.y * frame.sp + z1 * frame.cp;
    var k = DIST / (DIST - z2);
    var p = node.proj;
    p.x1 = x1;
    p.y1 = y1;
    p.z = z2;
    p.k = k;
    p.sx = frame.cx + x1 * frame.R * k;
    p.sy = frame.cyy + y1 * frame.R * k * 0.94;
    p.sr = node.r * frame.R * k;
    // Depth cue: front cells are big and bright, back cells small, dim and
    // defocused. k spans about 0.74 (far) .. 1.54 (near).
    p.depth = clamp((k - 0.74) / 0.8, 0, 1);
    return p;
  }

  function resetCamera() {
    cam.yaw = CAM_START.yaw;
    cam.pitch = CAM_START.pitch;
    cam.dolly = CAM_START.dolly;
    focus = null;
    dirty = true;
  }

  // Turn the cloud so the given cell faces the viewer. Used by deep links and
  // by clicks: a selected neuron should never be on the far side.
  function focusOn(node, instant) {
    var radius = Math.sqrt(node.x * node.x + node.y * node.y + node.z * node.z) || 0.001;
    var targetYaw = Math.atan2(node.x, node.z);
    var front = Math.sqrt(Math.max(0.0001, node.x * node.x + node.z * node.z));
    var targetPitch = clamp(Math.atan2(node.y, front), -1.15, 1.15);
    if (instant || reduced) {
      cam.yaw = targetYaw;
      cam.pitch = targetPitch;
      focus = null;
      dirty = true;
      return;
    }
    focus = { yaw: targetYaw, pitch: targetPitch, t: 0 };
  }

  /* ------------------------------------------------------------ drawing */

  var order = [];
  var hairQueue = [];
  var placed = [];
  var lastInteraction = 0;

  function background() {
    var styles = PAL;
    var gradient = ctx.createRadialGradient(W * 0.5, H * 0.42, 0, W * 0.5, H * 0.5, Math.max(W, H) * 0.78);
    gradient.addColorStop(0, styles.sceneA);
    gradient.addColorStop(1, styles.sceneB);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, W, H);
  }

  function visibleAlpha(node) {
    var alpha = node.proj.depth;
    var eased = 0.1 + 0.9 * alpha * alpha * (3 - 2 * alpha);
    if (node.vis === 0) eased *= 0.24;
    if (node.status === 'retracted') eased *= 0.42;
    return eased;
  }

  function drawEdges() {
    var links = DATA.links;
    var i;
    var link;
    var a;
    var b;
    var lit = 0;
    var normal = 0;
    ctx.lineCap = 'round';
    ctx.globalCompositeOperation = 'source-over';

    for (var pass = 0; pass < 3; pass++) {
      var any = false;
      ctx.beginPath();
      for (i = 0; i < links.length; i++) {
        link = links[i];
        a = byKey[link.s];
        b = byKey[link.t];
        if (!a || !b) continue;
        var state = a.vis === 2 && b.vis === 2 ? 2 : a.vis === 0 || b.vis === 0 ? 0 : 1;
        if (state !== pass) continue;
        var dx = b.proj.sx - a.proj.sx;
        var dy = b.proj.sy - a.proj.sy;
        var len = Math.sqrt(dx * dx + dy * dy);
        if (len < 1 || len > Math.max(W, H) * 1.6) continue;
        var bend = ((hash32(a.key + b.key) % 200) / 100 - 1) * Math.min(34, len * 0.14);
        var ux = dx / (len || 1);
        var uy = dy / (len || 1);
        var ax = a.proj.sx + ux * a.proj.sr * 0.9;
        var ay = a.proj.sy + uy * a.proj.sr * 0.9;
        var bx = b.proj.sx - ux * b.proj.sr * 0.9;
        var by = b.proj.sy - uy * b.proj.sr * 0.9;
        var mx = (ax + bx) / 2 - uy * bend;
        var my = (ay + by) / 2 + ux * bend;
        ctx.moveTo(ax, ay);
        ctx.quadraticCurveTo(mx, my, bx, by);
        any = true;
        if (pass === 2) lit += 1;
        else normal += 1;
      }
      if (!any) continue;
      if (pass === 0) {
        ctx.strokeStyle = PAL.edge;
        ctx.globalAlpha = 0.09;
        ctx.lineWidth = 1;
        ctx.stroke();
      } else if (pass === 1) {
        ctx.strokeStyle = PAL.edge;
        ctx.globalAlpha = 0.2;
        ctx.lineWidth = 0.85;
        ctx.stroke();
      } else {
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = PAL.mint;
        ctx.globalAlpha = 0.1;
        ctx.lineWidth = 4.4;
        ctx.stroke();
        ctx.globalAlpha = 0.42;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.globalCompositeOperation = 'source-over';
      }
    }

    // Axons: the few longest connections, drawn as pale hairlines straight across
    // the cloud. Real graphs have a handful of long-range links, and they are what
    // make the picture read as one connected nervous system instead of five islands.
    var far = [];
    for (i = 0; i < links.length; i++) {
      link = links[i];
      a = byKey[link.s];
      b = byKey[link.t];
      if (!a || !b || (a.vis === 0 && b.vis === 0)) continue;
      var fdx = b.proj.sx - a.proj.sx;
      var fdy = b.proj.sy - a.proj.sy;
      var flen = Math.sqrt(fdx * fdx + fdy * fdy);
      if (flen < Math.min(W, H) * 0.16) continue;
      far.push({ a: a, b: b, len: flen, bend: hash32(a.key + b.key) % 2 ? 1 : -1 });
    }
    if (far.length > 0) {
      far.sort(function (p, q) { return q.len - p.len });
      if (far.length > 26) far.length = 26;
      ctx.globalCompositeOperation = PAL.dark ? 'lighter' : 'source-over';
      ctx.beginPath();
      for (i = 0; i < far.length; i++) {
        var f = far[i];
        var fux = (f.b.proj.sx - f.a.proj.sx) / f.len;
        var fuy = (f.b.proj.sy - f.a.proj.sy) / f.len;
        var fcx = (f.a.proj.sx + f.b.proj.sx) / 2 - fuy * f.len * 0.16 * f.bend;
        var fcy = (f.a.proj.sy + f.b.proj.sy) / 2 + fux * f.len * 0.16 * f.bend;
        ctx.moveTo(f.a.proj.sx, f.a.proj.sy);
        ctx.quadraticCurveTo(fcx, fcy, f.b.proj.sx, f.b.proj.sy);
      }
      ctx.strokeStyle = PAL.fg;
      ctx.globalAlpha = PAL.dark ? 0.16 : 0.2;
      ctx.lineWidth = 0.9;
      ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.globalAlpha = 1;
  }

  function drawGlow() {
    var gw = glowCanvas.width;
    var gh = glowCanvas.height;
    if (gw === 0 || gh === 0) return;
    glowCtx.setTransform(1, 0, 0, 1, 0, 0);
    glowCtx.globalCompositeOperation = 'source-over';
    glowCtx.clearRect(0, 0, gw, gh);
    glowCtx.globalCompositeOperation = PAL.dark ? 'lighter' : 'source-over';
    var scale = gw / Math.max(1, W);
    glowCtx.setTransform(scale, 0, 0, scale, 0, 0);

    for (var i = 0; i < order.length; i++) {
      var node = order[i];
      var p = node.proj;
      var alpha = visibleAlpha(node);
      if (alpha < 0.02) continue;
      var lit = node.key === selected || node === hovered;
      var radius = p.sr * node.haloScale * (1 + (1 - p.depth) * 0.55) * (lit ? 1.9 : 1);
      if (radius < 1.2) continue;
      if (p.sx < -radius || p.sx > W + radius || p.sy < -radius || p.sy > H + radius) continue;
      glowCtx.globalAlpha = Math.min(1, alpha * (PAL.dark ? 0.5 : 0.26) * (lit ? 1.6 : 1));
      glowCtx.drawImage(spriteOf(node), p.sx - radius, p.sy - radius, radius * 2, radius * 2);
    }

    ctx.globalCompositeOperation = PAL.dark ? 'lighter' : 'source-over';
    ctx.globalAlpha = 1;
    ctx.drawImage(glowCanvas, 0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';
  }

  function drawCells() {
    for (var i = 0; i < order.length; i++) {
      var node = order[i];
      var p = node.proj;
      var alpha = visibleAlpha(node);
      var sr = p.sr;
      if (sr < 0.7) continue;
      if (p.sx < -sr - 2 || p.sx > W + sr + 2 || p.sy < -sr - 2 || p.sy > H + sr + 2) continue;
      var rgb = rgbOf(node);
      if (sr < 1.6) {
        // Too small for a body: one dot, still colour-coded.
        ctx.globalAlpha = alpha * 0.9;
        ctx.fillStyle = rgba(rgb, 1);
        ctx.fillRect(p.sx - 0.5, p.sy - 0.5, 1.4, 1.4);
        continue;
      }
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(p.sx, p.sy, sr, 0, 6.2832);
      ctx.fillStyle = rgba(rgb, 1);
      ctx.fill();

      if (node.status === 'superseded') {
        ctx.globalAlpha = alpha * 0.75;
        ctx.setLineDash([2.4, 2.4]);
        ctx.strokeStyle = rgba(PAL.rgbFg, 0.85);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, sr + 1.4, 0, 6.2832);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // The core: on black it is whitened so the soma reads as light, on paper it
      // is deepened so the same chip reads as ink instead of a donut.
      if (sr > 2.0) {
        ctx.globalAlpha = alpha * 0.92;
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, Math.max(0.8, sr * 0.45), 0, 6.2832);
        var core = PAL.dark ? [255, 255, 255] : [12, 20, 28];
        var mix = PAL.dark ? 0.72 : 0.34;
        ctx.fillStyle = rgba(
          [
            rgb[0] + (core[0] - rgb[0]) * mix,
            rgb[1] + (core[1] - rgb[1]) * mix,
            rgb[2] + (core[2] - rgb[2]) * mix,
          ],
          1,
        );
        ctx.fill();
      }

      if (node.key === selected) {
        ctx.globalAlpha = 0.85;
        ctx.strokeStyle = PAL.mint;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, sr * 1.9 + 3.5, 0, 6.2832);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  function drawHairs() {
    hairQueue.length = 0;
    for (var i = 0; i < order.length; i++) {
      var node = order[i];
      if (node.proj.sr < 2.4 && node.key !== selected && node !== hovered) continue;
      if (node.vis === 0) continue;
      hairQueue.push(node);
    }
    // Only the nearest and the biggest cells get dendrites: this is the LOD
    // that keeps a 339-cell cloud at 60fps.
    if (hairQueue.length > 96) {
      hairQueue.sort(function (a, b) { return b.proj.sr - a.proj.sr });
      hairQueue.length = 96;
    }

    ctx.globalCompositeOperation = 'source-over';
    ctx.lineCap = 'round';
    for (var k = 0; k < hairQueue.length; k++) {
      var cell = hairQueue[k];
      var p = cell.proj;
      var alpha = visibleAlpha(cell);
      if (alpha < 0.05) continue;
      var hairs = hairsFor(cell);
      var rgb = rgbOf(cell);
      var emphasis = cell.key === selected || cell === hovered ? 1.7 : 1;
      ctx.strokeStyle = rgba(rgb, 0.34 * alpha * (PAL.dark ? 1 : 0.85));
      ctx.lineWidth = clamp(p.sr * 0.07, 0.4, 1.1) * emphasis;
      ctx.beginPath();
      for (var j = 0; j < hairs.length; j++) {
        var hair = hairs[j];
        var ce = Math.cos(hair[1]);
        var dirx = ce * Math.cos(hair[0]);
        var diry = Math.sin(hair[1]);
        var dirz = ce * Math.sin(hair[0]);
        var reach = cell.r * hair[2];
        projectPoint(cell.x + dirx * reach, cell.y + diry * reach, cell.z + dirz * reach, scratch);
        var ex = scratch.sx;
        var ey = scratch.sy;
        var dx = ex - p.sx;
        var dy = ey - p.sy;
        var len = Math.sqrt(dx * dx + dy * dy) || 1;
        // Bend the hair sideways in screen space: a straight spoke looks like a
        // diagram, a bowed one looks like an axon.
        var cx = p.sx + dx * 0.55 - (dy / len) * len * 0.22 * hair[3];
        var cy = p.sy + dy * 0.55 + (dx / len) * len * 0.22 * hair[3];
        var sx0 = p.sx + (dx / len) * p.sr * 1.05;
        var sy0 = p.sy + (dy / len) * p.sr * 1.05;
        ctx.moveTo(sx0, sy0);
        ctx.quadraticCurveTo(cx, cy, ex, ey);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function labelBox(text, size, weight) {
    ctx.font = weight + ' ' + size + 'px ' + FONT;
    var width = ctx.measureText(text).width;
    return { w: width, h: size * 1.16 };
  }

  function drawText(text, x, y, color, alpha, size, weight, halo) {
    ctx.font = weight + ' ' + size + 'px ' + FONT;
    ctx.globalAlpha = alpha;
    if (halo) {
      ctx.lineWidth = Math.max(2.4, size * 0.26);
      ctx.strokeStyle = halo;
      ctx.lineJoin = 'round';
      ctx.strokeText(text, x, y);
    }
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  function collides(box) {
    for (var i = 0; i < placed.length; i++) {
      var other = placed[i];
      if (box.x1 <= other.x0 || other.x1 <= box.x0 || box.y1 <= other.y0 || other.y1 <= box.y0) continue;
      return true;
    }
    return false;
  }

  function tryLabel(node, priority) {
    var p = node.proj;
    var size = node.type === 'entity' ? 11.5 : 10.5;
    var weight = node.type === 'entity' ? 600 : 500;
    var box = labelBox(node.label, size, weight);
    var gap = p.sr + 6;
    var candidates = [
      [p.sx + gap, p.sy, 'start'],
      [p.sx - gap, p.sy, 'end'],
      [p.sx, p.sy + gap + size * 0.7, 'middle'],
      [p.sx, p.sy - gap - size * 0.2, 'middle'],
      [p.sx + gap * 0.75, p.sy - gap * 0.75, 'start'],
      [p.sx - gap * 0.75, p.sy - gap * 0.75, 'end']
    ];
    for (var i = 0; i < candidates.length; i++) {
      var x = candidates[i][0];
      var y = candidates[i][1];
      var anchor = candidates[i][2];
      var left = anchor === 'start' ? x : anchor === 'end' ? x - box.w : x - box.w / 2;
      var rect = {
        x0: left - 2,
        x1: left + box.w + 2,
        y0: y - box.h * 0.82,
        y1: y + box.h * 0.22
      };
      if (rect.x0 < 6 || rect.x1 > W - 6 || rect.y0 < 6 || rect.y1 > H - 6) continue;
      if (collides(rect)) continue;
      placed.push(rect);
      var alpha = 0.62 + 0.34 * p.depth;
      var color = node.type === 'entity' ? PAL.fg : PAL.kinds[node.kind];
      drawText(node.label, x, y, color, Math.min(1, alpha + (priority === 0 ? 0.3 : 0)), size, weight, PAL.bg0);
      return true;
    }
    return false;
  }

  function drawLabels() {
    placed.length = 0;
    ctx.textBaseline = 'alphabetic';
    ctx.globalCompositeOperation = 'source-over';

    // Reserve the cells themselves first: a label on top of a glowing soma is
    // unreadable, and in a 339-cell cloud that was most of them.
    for (var c = 0; c < order.length; c++) {
      var cell0 = order[c];
      if (cell0.vis === 0) continue;
      var box0 = cell0.proj.sr + (cell0.type === 'entity' ? 5 : 3);
      placed.push({
        x0: cell0.proj.sx - box0,
        x1: cell0.proj.sx + box0,
        y0: cell0.proj.sy - box0,
        y1: cell0.proj.sy + box0,
      });
    }

    // Faint slice names first: they are furniture, not data. Each name sits just
    // outside the outermost cell of its own slice, so it names the region instead
    // of landing in the middle of it.
    var sums = {};
    for (var i = 0; i < order.length; i++) {
      var node = order[i];
      if (node.vis === 0) continue;
      var entry = sums[node.cluster] || (sums[node.cluster] = { x: 0, y: 0, n: 0, far: null, farD: -1 });
      entry.x += node.proj.sx;
      entry.y += node.proj.sy;
      entry.n += 1;
    }
    // Second pass: how far each slice spills from its own centre, and where its
    // most outlying cell is. Needs the centroid, hence two passes.
    Object.keys(sums).forEach(function (cluster) {
      var bucket = sums[cluster];
      bucket.x /= bucket.n;
      bucket.y /= bucket.n;
    });
    for (i = 0; i < order.length; i++) {
      var cell = order[i];
      if (cell.vis === 0) continue;
      var bucket = sums[cell.cluster];
      if (!bucket) continue;
      var spread = Math.hypot(cell.proj.sx - bucket.x, cell.proj.sy - bucket.y);
      if (spread > bucket.farD) {
        bucket.farD = spread;
        bucket.far = cell.proj;
      }
    }
    var size = W < 560 ? 10 : 11.5;
    Object.keys(sums).forEach(function (cluster) {
      var bucket = sums[cluster];
      if (bucket.n < 3 || !bucket.far) return;
      // Outward from the slice's own centre, so the name hugs its region.
      var dx = bucket.far.sx - bucket.x;
      var dy = bucket.far.sy - bucket.y;
      var len = Math.hypot(dx, dy) || 1;
      var text = DATA.short[cluster] || cluster;
      ctx.font = '600 ' + size + 'px ' + FONT;
      var width = ctx.measureText(text).width;
      var steps = [18, 34, 52, 74, 100];
      for (var s = 0; s < steps.length; s++) {
        var reach = bucket.far.sr + bucket.farD + steps[s];
        var lx = clamp(bucket.x + (dx / len) * reach, 18 + width / 2, W - 18 - width / 2);
        var ly = clamp(bucket.y + (dy / len) * reach, 22, H - 14);
        var rect = { x0: lx - width / 2 - 4, x1: lx + width / 2 + 4, y0: ly - size, y1: ly + size * 0.4 };
        if (rect.x0 < 4 || rect.x1 > W - 4) continue;
        if (collides(rect)) continue;
        placed.push(rect);
        drawText(text, lx, ly, PAL.kinds[cluster] || PAL.fg, 0.4, size, 600, null);
        break;
      }
    });

    // Then the labels that carry information, best first.
    var wanted = [];
    if (selected && byKey[selected]) {
      wanted.push({ node: byKey[selected], priority: 0 });
      Object.keys(neighbors[selected]).forEach(function (key) {
        if (byKey[key]) wanted.push({ node: byKey[key], priority: 1 });
      });
    }
    if (hovered) wanted.push({ node: hovered, priority: 0 });
    for (i = 0; i < nodes.length; i++) {
      if (nodes[i].hit) wanted.push({ node: nodes[i], priority: 1 });
    }
    if (!selected) {
      for (i = 0; i < nodes.length; i++) {
        var candidate = nodes[i];
        if (candidate.type === 'entity' && candidate.degree >= 2 && candidate.vis !== 0) {
          wanted.push({ node: candidate, priority: 2 });
        }
      }
    }
    wanted.sort(function (a, b) {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return b.node.degree - a.node.degree;
    });
    var budget = W < 560 ? 6 : 14;
    for (i = 0; i < wanted.length && budget > 0; i++) {
      var item = wanted[i].node;
      if (item.vis === 0) continue;
      if (item.proj.sx < 4 || item.proj.sx > W - 4 || item.proj.sy < 4 || item.proj.sy > H - 4) continue;
      if (tryLabel(item, wanted[i].priority)) budget -= 1;
    }
    ctx.globalAlpha = 1;
  }

  function render() {
    if (!PAL || W === 0 || H === 0) return;
    syncFrame();
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    background();

    order.length = 0;
    for (var i = 0; i < nodes.length; i++) {
      projectInto(nodes[i]);
      order.push(nodes[i]);
    }
    order.sort(function (a, b) { return a.proj.z - b.proj.z });

    drawEdges();
    drawGlow();
    drawCells();
    drawHairs();
    drawLabels();
  }

  /* ------------------------------------------------------------ layout */

  function resize() {
    var rect = stage.getBoundingClientRect();
    W = Math.max(1, Math.round(rect.width));
    H = Math.max(1, Math.round(rect.height));
    DPR = Math.min(1.75, window.devicePixelRatio || 1);
    scene.width = Math.round(W * DPR);
    scene.height = Math.round(H * DPR);
    scene.style.width = W + 'px';
    scene.style.height = H + 'px';
    glowCanvas.width = Math.max(1, Math.round(W * 0.5));
    glowCanvas.height = Math.max(1, Math.round(H * 0.5));
    dirty = true;
    render();
  }

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
      var cards = Object.keys(neighbors[node.key]).filter(function (key) { return key.indexOf('c:') === 0 });
      tooltip.appendChild(h('div', 'tt-snip', cards.length + ' 张卡片 · ' + (node.projects.length ? node.projects.join(' / ') : '未归档')));
      tooltip.appendChild(h('div', 'tt-meta', '首次 ' + (node.firstSeen || '—') + ' · 最近 ' + (node.lastSeen || '—')));
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
      x = node.proj.sx + 16;
      y = node.proj.sy - 10;
    }
    var w = tooltip.offsetWidth;
    var hh = tooltip.offsetHeight;
    if (x + w > rect.width - 10) x = Math.max(10, x - w - 30);
    if (y + hh > rect.height - 10) y = Math.max(10, y - hh - 24);
    tooltip.style.left = x + 'px';
    tooltip.style.top = y + 'px';
  }

  function hover(node, event) {
    hovered = node;
    setTooltip(node, event);
    dirty = true;
  }

  function unhover() {
    if (!hovered) return;
    hovered = null;
    tooltip.classList.remove('on');
    dirty = true;
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
    close.addEventListener('click', function () { select(null) });
    panel.appendChild(close);

    if (node.type === 'entity') {
      panel.appendChild(h('div', 'eyebrow', '实体 entity · ' + (node.etype || 'concept')));
      panel.appendChild(h('h2', null, node.full || node.label));
      var row = h('div', 'row');
      if (node.hub) row.appendChild(badge('k-mint', '跨项目枢纽'));
      row.appendChild(badge('k-entity', Object.keys(neighbors[node.key]).length + ' 条连线'));
      panel.appendChild(row);

      var dl = h('dl');
      [
        ['首次出现', node.firstSeen || '—'],
        ['最近出现', node.lastSeen || '—'],
        ['别名', (node.aliases || []).join(' · ') || '—'],
        ['项目', (node.projects || []).join(' · ') || '—'],
        ['id', node.slug]
      ].forEach(function (pair) {
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
          if (byKey[key]) li.addEventListener('click', function () { select(key) });
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
    badges.appendChild(badge('plain', CONFIDENCE_LABELS[node.confidence] || node.confidence, true));
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
        chips.appendChild(chip(entity.name, byKey[key] ? function () { select(key) } : null));
      });
      panel.appendChild(chips);
    }

    var chain = [];
    if (node.supersedes && node.supersedes.length) chain.push(['替换了', node.supersedes]);
    if (node.supersededBy) chain.push(['被替换为', [node.supersededBy]]);
    if (chain.length) {
      panel.appendChild(h('h3', null, '替换链'));
      var chainBox = h('div', 'chips');
      chain.forEach(function (entry) {
        entry[1].forEach(function (id) {
          var other = byKey['c:' + id];
          var label = entry[0] + ' ' + (other ? (other.full || other.label) : id);
          chainBox.appendChild(chip(label, other ? function () { select(other.key) } : null));
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
    } else if (String(node.slug).toLowerCase().indexOf(q) !== -1) {
      return true;
    }
    return false;
  }

  function refresh() {
    var q = searchBox.value.trim().toLowerCase();
    var project = projectBox.value;
    var filtering = q !== '' || project !== '*';
    var hitCount = 0;

    nodes.forEach(function (node) {
      node.vis = 1;
      node.hit = false;
      if (selected) {
        if (node.key === selected || neighbors[selected][node.key]) node.vis = 2;
        else node.vis = 0;
      } else if (filtering) {
        var okProject = project === '*' || node.projects.indexOf(project) !== -1;
        var okQuery = matches(node, q);
        if (okProject && okQuery) {
          if (q !== '') {
            node.hit = true;
            hitCount += 1;
          }
        } else {
          node.vis = 0;
        }
      }
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
    dirty = true;
  }

  function select(key, instant) {
    selected = key;
    if (!key) {
      panel.hidden = true;
      refresh();
      return;
    }
    var node = byKey[key];
    if (!node) return;
    renderPanel(node);
    focusOn(node, instant);
    refresh();
  }

  /* ------------------------------------------------------------ input */

  function hitTest(x, y) {
    var best = null;
    var bestScore = -1;
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (node.vis === 0) continue;
      var p = node.proj;
      var dx = x - p.sx;
      var dy = y - p.sy;
      var reach = Math.max(7, p.sr + 4);
      var d2 = dx * dx + dy * dy;
      if (d2 > reach * reach) continue;
      // Front-most wins when two cells overlap on screen.
      var score = p.depth - d2 / (reach * reach) * 0.35;
      if (score > bestScore) {
        bestScore = score;
        best = node;
      }
    }
    return best;
  }

  function touch() {
    lastInteraction = Date.now();
  }

  var drag = null;
  scene.addEventListener('pointerdown', function (event) {
    touch();
    drag = { x: event.clientX, y: event.clientY, yaw: cam.yaw, pitch: cam.pitch, moved: false };
    scene.classList.add('dragging');
    if (scene.setPointerCapture) scene.setPointerCapture(event.pointerId);
  });

  scene.addEventListener('pointermove', function (event) {
    if (drag) {
      var dx = event.clientX - drag.x;
      var dy = event.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      cam.yaw = drag.yaw + dx * 0.0075;
      cam.pitch = clamp(drag.pitch + dy * 0.006, -1.25, 1.25);
      focus = null;
      dirty = true;
      if (hovered) unhover();
      return;
    }
    var rect = scene.getBoundingClientRect();
    var found = hitTest(event.clientX - rect.left, event.clientY - rect.top);
    scene.style.cursor = found ? 'pointer' : 'grab';
    if (found !== hovered) {
      if (found) hover(found, event);
      else unhover();
    } else if (found) {
      position(found, event);
    }
  });

  scene.addEventListener('pointerup', function (event) {
    var moved = drag ? drag.moved : false;
    drag = null;
    scene.classList.remove('dragging');
    touch();
    if (moved) return;
    var rect = scene.getBoundingClientRect();
    var found = hitTest(event.clientX - rect.left, event.clientY - rect.top);
    select(found ? found.key : null);
  });

  scene.addEventListener('pointercancel', function () {
    drag = null;
    scene.classList.remove('dragging');
  });

  scene.addEventListener('pointerleave', function () {
    unhover();
  });

  scene.addEventListener('wheel', function (event) {
    event.preventDefault();
    touch();
    cam.dolly = clamp(cam.dolly * Math.exp(-event.deltaY * 0.0013), 0.42, 3.4);
    dirty = true;
  }, { passive: false });

  scene.addEventListener('dblclick', function () {
    resetCamera();
  });

  document.getElementById('zoom-in').addEventListener('click', function () {
    cam.dolly = clamp(cam.dolly * 1.22, 0.42, 3.4);
    dirty = true;
  });
  document.getElementById('zoom-out').addEventListener('click', function () {
    cam.dolly = clamp(cam.dolly / 1.22, 0.42, 3.4);
    dirty = true;
  });
  document.getElementById('zoom-fit').addEventListener('click', function () {
    resetCamera();
  });

  document.addEventListener('keydown', function (event) {
    var typing = document.activeElement === searchBox;
    if (event.key === 'Escape') {
      if (typing && searchBox.value !== '') {
        searchBox.value = '';
        refresh();
        return;
      }
      select(null);
      searchBox.blur();
    } else if (event.key === '/' && !typing) {
      event.preventDefault();
      searchBox.focus();
    } else if (!typing) {
      if (event.key === 'ArrowLeft') { cam.yaw -= 0.09; dirty = true; touch(); event.preventDefault() }
      else if (event.key === 'ArrowRight') { cam.yaw += 0.09; dirty = true; touch(); event.preventDefault() }
      else if (event.key === 'ArrowUp') { cam.pitch = clamp(cam.pitch - 0.07, -1.25, 1.25); dirty = true; touch(); event.preventDefault() }
      else if (event.key === 'ArrowDown') { cam.pitch = clamp(cam.pitch + 0.07, -1.25, 1.25); dirty = true; touch(); event.preventDefault() }
      else if (event.key === '+' || event.key === '=') { cam.dolly = clamp(cam.dolly * 1.15, 0.42, 3.4); dirty = true; touch() }
      else if (event.key === '-' || event.key === '_') { cam.dolly = clamp(cam.dolly / 1.15, 0.42, 3.4); dirty = true; touch() }
      else if (event.key === 'f') { resetCamera() }
    }
  });

  /* ------------------------------------------------------------ chrome */

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

  [
    ['decision', '决策'], ['fact', '事实'], ['open_question', '待解'],
    ['preference', '偏好'], ['note', '记录']
  ].forEach(function (pair) {
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
  sup.appendChild(h('span', 'dot ringed i-mint'));
  sup.appendChild(h('span', null, '虚线 = 已被替换'));
  legendBox.appendChild(sup);

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

  /* ------------------------------------------------------------ boot */

  // The address bar can pin a theme, stop the drift, and open one cell:
  // #dark, #light, #still, and #dark&<card id or entity slug>.
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
    else if (part === 'still') still = true;
    else if (part) pendingNode = part;
  });
  applyTheme(initialTheme);

  if (nodes.length === 0) {
    emptyBox.hidden = false;
    return;
  }

  if (window.ResizeObserver) {
    new ResizeObserver(function () { resize() }).observe(stage);
  } else {
    window.addEventListener('resize', resize);
  }
  resize();
  refresh();
  if (pendingNode) {
    var linked = nodes.filter(function (node) {
      return node.key === pendingNode || node.id === pendingNode || node.slug === pendingNode;
    })[0];
    // A deep link opens the cell facing the camera, with no easing, so a
    // screenshot of it is stable.
    if (linked) select(linked.key, true);
  }

  if (window.matchMedia) {
    var media = window.matchMedia('(prefers-color-scheme: light)');
    var onChange = function () {
      if (storedTheme() === 'auto') rebuildSprites();
    };
    if (media.addEventListener) media.addEventListener('change', onChange);
    else if (media.addListener) media.addListener(onChange);
  }

  var lastTime = 0;
  function loop(time) {
    var dt = lastTime ? Math.min(64, time - lastTime) : 16;
    lastTime = time;
    var moving = false;

    if (focus) {
      var dYaw = focus.yaw - cam.yaw;
      while (dYaw > Math.PI) dYaw -= Math.PI * 2;
      while (dYaw < -Math.PI) dYaw += Math.PI * 2;
      var dPitch = focus.pitch - cam.pitch;
      var step = Math.min(1, dt / 90) * 0.55;
      cam.yaw += dYaw * step;
      cam.pitch += dPitch * step;
      // Snap when close: a camera that creeps forever never settles, and an
      // unsettled camera means a screenshot that never repeats.
      if (Math.abs(dYaw) < 0.005 && Math.abs(dPitch) < 0.005) {
        cam.yaw = focus.yaw;
        cam.pitch = focus.pitch;
        focus = null;
      }
      moving = true;
      dirty = true;
    } else if (!still && !reduced && !drag && Date.now() - lastInteraction > 2400) {
      // Idle drift: slow enough to read as breathing, not as spinning.
      cam.yaw += dt * 0.00007;
      moving = true;
      dirty = true;
    }

    if (dirty || moving) {
      dirty = false;
      render();
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
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
  const title = `记忆图 · ${payload.counts.cards} 张卡片 / ${payload.counts.entities} 个实体`

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
