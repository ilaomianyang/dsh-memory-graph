/**
 * The model-facing surface. Seven small tools, all explicit.
 *
 * Nothing here runs on its own: retrieval only happens when the agent decides
 * to ask, which keeps memory out of the context (and out of the attention
 * budget) on the turns that do not need it.
 */
import path from 'node:path'
import { searchCards, timelineCards } from './search.js'
import { distill, resolveRoute } from './extract.js'
import { CARD_KINDS, CONFIDENCE, slugify } from './vault.js'

const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true }

function json(args, value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
}

function projectFor(ctx, exec, cfg) {
  try {
    const sessions = ctx.get?.('sessions', false)
    const session = sessions?.get?.(exec?.agent?.id)
    const cwd = session?.header?.cwd ?? session?.meta?.cwd ?? session?.cwd
    if (typeof cwd === 'string' && cwd.trim() !== '') {
      const base = path.basename(cwd.replace(/[\\/]+$/, ''))
      if (base !== '') return base
    }
  } catch {
    // No sessions service, or the agent has no session: fall through.
  }
  return cfg.defaultProject
}

function formatHits(hits) {
  if (hits.length === 0) return 'No memories matched.'
  return hits
    .map((hit) => {
      const card = hit.card
      const status = card.status === 'active' ? '' : ` [${card.status}]`
      const via = hit.via === 'keyword' ? '' : ` <${hit.via}>`
      return [
        `${card.id} · ${String(card.created).slice(0, 10)} · ${card.kind} · ${card.project}${status}${via}`,
        `  ${card.title}`,
        hit.snippet ? `  ${hit.snippet}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    })
    .join('\n\n')
}

/**
 * The harness services the extractor borrows its route from. Both are optional:
 * without them the extractor can still post to an endpoint itself, so their
 * absence is a reason to report, never to fail the surrounding operation.
 */
function extractorServices(ctx) {
  try {
    const llm = ctx.get?.('llm', false) ?? undefined
    const selection = ctx.get?.('agentDefaultModel', false)?.currentSelection?.() ?? undefined
    return { llm, selection }
  } catch {
    return { llm: undefined, selection: undefined }
  }
}

/** One line describing what a distill call would do right now, for memory_stats. */
function describeExtractor(ctx, cfg) {
  if (!cfg.extractor.enabled) return 'extractor: off (nothing calls a model)'
  if (cfg.extractor.transport === 'http') {
    return `extractor: http ${cfg.extractor.baseUrl}${cfg.extractor.path} model=${cfg.extractor.model}`
  }
  const { llm, selection } = extractorServices(ctx)
  try {
    const route = resolveRoute(cfg, selection)
    const effort = route.effort === '' ? '' : ` effort=${route.effort}`
    const model = `${route.provider}/${route.model}`
    return `extractor: ${llm ? 'harness' : 'harness (no llm service!)'} ${model}${effort} · ${route.source}`
  } catch (error) {
    return `extractor: harness · ${error.message}`
  }
}

export function registerTools(ctx, { cfg, vault, redactor }) {
  const disposers = []

  /**
   * README and graph.html are derived views: rendered from the cards, never the
   * source of truth. A view that fails to render must not fail the write that
   * triggered it — the card is already on disk and the next write rebuilds it.
   */
  async function refreshViews() {
    for (const render of [vault.regenerateReadme, vault.regenerateGraph]) {
      if (typeof render !== 'function') continue
      try {
        await render.call(vault)
      } catch (error) {
        ctx.logger?.warn?.(`[memory-graph] could not render a vault view: ${error?.message ?? error}`)
      }
    }
  }

  /* ---------------------------------------------------------------- search */
  disposers.push(
    ctx.tools.register({
      name: 'memory_search',
      description:
        'Search long-term memory that persists across sessions and across projects. Use it before asking the user to repeat something, and whenever they refer to an earlier decision, a past conversation, a preference, or "the thing we did before". Results are memories with ids: call memory_get for one in full. Returns nothing useful on topics never discussed; that is not an error.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to recall, in natural language. Chinese or English.' },
          project: { type: 'string', description: 'Limit to one project slug. Omit to search every project.' },
          kinds: {
            type: 'array',
            items: { type: 'string', enum: CARD_KINDS },
            description: 'Restrict to these card kinds.',
          },
          limit: { type: 'integer', minimum: 1, maximum: 40, description: 'Max results. Default 8.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      output: {
        schema: OUTPUT_SCHEMA,
        render: (args, value) => json(args, value.text ?? value),
      },
      async execute(args, exec) {
        const cards = await vault.listCards()
        const hits = searchCards(cards, args.query, {
          limit: args.limit ?? cfg.retrieval.limit,
          hops: cfg.retrieval.hops,
          snippetChars: cfg.retrieval.snippetChars,
          project: args.project ?? null,
          kinds: args.kinds ?? null,
        })
        const value = {
          count: hits.length,
          vault: vault.dir,
          currentProject: projectFor(ctx, exec, cfg),
          text: hits.length === 0
            ? `No memories matched "${args.query}".`
            : `${hits.length} memories:\n\n${formatHits(hits)}`,
        }
        return value
      },
    }),
  )

  /* ---------------------------------------------------------------- get */
  disposers.push(
    ctx.tools.register({
      name: 'memory_get',
      description:
        'Read one memory card in full, plus the entities it is linked to. Use after memory_search or memory_timeline returns an id you need the details of.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Card id, e.g. c-20261102-ab12cd.' } },
        required: ['id'],
        additionalProperties: false,
      },
      output: { schema: OUTPUT_SCHEMA, render: (args, value) => json(args, value.text ?? value) },
      async execute(args) {
        const card = await vault.getCard(String(args.id))
        if (!card) return { found: false, text: `No card with id ${args.id}.` }
        const entities = []
        for (const slug of card.entities ?? []) {
          const entity = await vault.readEntity(slug)
          if (entity) entities.push({ name: entity.name, slug, type: entity.type, mentions: entity.mentions.length })
        }
        return {
          found: true,
          card,
          entities,
          text: [
            `${card.id} · ${card.kind} · ${card.project} · ${card.status}`,
            `title: ${card.title}`,
            `created: ${card.created}  valid: ${card.validFrom ?? '?'} → ${card.validTo ?? 'now'}`,
            `confidence: ${card.confidence}`,
            card.supersedes?.length ? `supersedes: ${card.supersedes.join(', ')}` : '',
            card.supersededBy ? `superseded by: ${card.supersededBy}` : '',
            `entities: ${(card.entities ?? []).join(', ') || '—'}`,
            '',
            card.body,
          ]
            .filter((line) => line !== '')
            .join('\n'),
        }
      },
    }),
  )

  /* ---------------------------------------------------------------- timeline */
  disposers.push(
    ctx.tools.register({
      name: 'memory_timeline',
      description:
        'Chronological view of memories, newest first. Use for "how did this develop", "what changed", "what did we decide then, and what is it now". Keeps superseded cards visible on purpose, so the revision chain stays readable.',
      parameters: {
        type: 'object',
        properties: {
          entity: { type: 'string', description: 'Only memories mentioning this entity (name or slug).' },
          project: { type: 'string', description: 'Only this project.' },
          from: { type: 'string', description: 'YYYY-MM-DD lower bound.' },
          to: { type: 'string', description: 'YYYY-MM-DD upper bound.' },
          limit: { type: 'integer', minimum: 1, maximum: 200 },
        },
        additionalProperties: false,
      },
      output: { schema: OUTPUT_SCHEMA, render: (args, value) => json(args, value.text ?? value) },
      async execute(args) {
        const cards = await vault.listCards()
        const list = timelineCards(cards, {
          limit: args.limit ?? cfg.retrieval.timelineLimit,
          project: args.project ?? null,
          entity: args.entity ?? null,
          from: args.from ?? null,
          to: args.to ?? null,
        })
        const text =
          list.length === 0
            ? 'No memories in that range.'
            : list
                .map((card) => {
                  const chain = card.supersededBy ? ` → superseded by ${card.supersededBy}` : ''
                  return `${String(card.created).slice(0, 10)} · ${card.kind} · ${card.project} · ${card.id}${card.status === 'active' ? '' : ` [${card.status}]`}\n  ${card.title}${chain}`
                })
                .join('\n')
        return { count: list.length, text }
      },
    }),
  )

  /* ---------------------------------------------------------------- graph */
  disposers.push(
    ctx.tools.register({
      name: 'memory_graph',
      description:
        'Walk the memory graph around one node. Given an entity name, an entity slug or a card id, list the memories it is part of and the neighbouring entities that share those memories, with the reason for each link. Use it when the question is "what else is connected to this" and you have no keyword to search for. An edge here means two things were mentioned in the same memory; it is not a claim that one caused the other.',
      parameters: {
        type: 'object',
        properties: {
          node: { type: 'string', description: 'Entity name, entity slug, or a card id (c-...).' },
          depth: { type: 'integer', minimum: 1, maximum: 2, description: 'Hops to expand. Default 1.' },
          limit: { type: 'integer', minimum: 1, maximum: 60, description: 'Max memories listed. Default 12.' },
        },
        required: ['node'],
        additionalProperties: false,
      },
      output: { schema: OUTPUT_SCHEMA, render: (args, value) => json(args, value.text ?? value) },
      async execute(args) {
        const depth = args.depth ?? 1
        const limit = args.limit ?? 12
        const node = String(args.node ?? '').trim()
        const cards = await vault.listCards()
        const entities = await vault.listEntities()
        const bySlug = new Map(entities.map((entity) => [entity.slug, entity]))

        // Resolve the seed: a card id, an exact entity, or a loose name match.
        let seeds = []
        const asCard = cards.find((card) => card.id === node)
        if (asCard) {
          seeds = (asCard.entities ?? []).filter((slug) => bySlug.has(slug))
        } else {
          const wanted = slugify(node)
          const lower = node.toLowerCase()
          const exact = entities.find(
            (entity) =>
              entity.slug === wanted ||
              entity.name.toLowerCase() === lower ||
              entity.aliases.some((alias) => String(alias).toLowerCase() === lower),
          )
          seeds = exact
            ? [exact.slug]
            : entities
                .filter((entity) => entity.name.toLowerCase().includes(lower) || entity.slug.includes(wanted))
                .slice(0, 3)
                .map((entity) => entity.slug)
        }

        if (seeds.length === 0) {
          return { found: false, node, text: `Nothing in memory is linked to "${node}".` }
        }

        const visited = new Set()
        const frontier = [...seeds]
        const reached = []
        for (let hop = 0; hop < depth && frontier.length > 0; hop++) {
          const next = []
          for (const slug of frontier) {
            if (visited.has(slug)) continue
            visited.add(slug)
            const entity = bySlug.get(slug)
            if (!entity) continue
            const linked = cards.filter((card) => card.status !== 'retracted' && (card.entities ?? []).includes(slug))
            reached.push({ slug, entity, linked })
            for (const card of linked) {
              for (const other of card.entities ?? []) {
                if (!visited.has(other) && bySlug.has(other)) next.push(other)
              }
            }
          }
          frontier.length = 0
          frontier.push(...next)
        }

        const primary = reached[0]
        const memories = []
        const seenCards = new Set()
        for (const entry of reached) {
          for (const card of entry.linked) {
            if (seenCards.has(card.id)) continue
            seenCards.add(card.id)
            memories.push(card)
          }
        }
        memories.sort((a, b) => String(b.created).localeCompare(String(a.created)))

        const neighbours = new Map()
        for (const card of memories) {
          for (const slug of card.entities ?? []) {
            if (visited.has(slug)) continue
            neighbours.set(slug, (neighbours.get(slug) ?? 0) + 1)
          }
        }
        const rankedNeighbours = [...neighbours.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)

        const lines = []
        lines.push(
          asCard
            ? `card ${asCard.id} · ${asCard.kind} · ${asCard.title}`
            : `entity "${primary.entity.name}" · ${asCard ? '' : `${primary.entity.mentions.length} mention(s)`}`.trim(),
        )
        lines.push('')
        lines.push(`memories (${Math.min(memories.length, limit)} of ${memories.length}):`)
        for (const card of memories.slice(0, limit)) {
          const mark = card.status === 'active' ? '' : ` [${card.status}]`
          lines.push(`  ${String(card.created).slice(0, 10)} · ${card.kind} · ${card.project} · ${card.id}${mark} — ${card.title}`)
        }
        if (rankedNeighbours.length > 0) {
          lines.push('')
          lines.push('neighbours (things sharing those memories):')
          lines.push(`  ${rankedNeighbours.map(([slug, count]) => `${bySlug.get(slug)?.name ?? slug} (${count})`).join(' · ')}`)
        }
        return {
          found: true,
          node,
          seeds,
          nodes: reached.map((entry) => ({ slug: entry.slug, name: entry.entity.name, type: entry.entity.type })),
          memories: memories.slice(0, limit).map((card) => ({ id: card.id, kind: card.kind, title: card.title, created: card.created, project: card.project })),
          neighbours: rankedNeighbours.map(([slug, count]) => ({ slug, name: bySlug.get(slug)?.name ?? slug, shared: count })),
          text: lines.join('\n'),
        }
      },
    }),
  )

  /* ---------------------------------------------------------------- remember */
  disposers.push(
    ctx.tools.register({
      name: 'memory_remember',
      description:
        'Store one durable memory the user would not want to lose: a decision and its reason, a stable fact, a preference about how they want things done, or an unresolved question. Write it so it still makes sense with no conversation around it. Do not store transient state, restatements, or anything already covered by an existing card.',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: CARD_KINDS },
          title: { type: 'string', description: 'One short sentence, no trailing period, self-contained.' },
          body: { type: 'string', description: '1-4 sentences: what, why, and what it replaced if anything.' },
          entities: {
            type: 'array',
            items: { type: 'string' },
            description: 'Concrete things involved: projects, files, tools, people, concepts. Canonical short names.',
          },
          confidence: { type: 'string', enum: CONFIDENCE },
          supersedes: {
            type: 'array',
            items: { type: 'string' },
            description: 'Ids of cards this one makes obsolete. They are marked superseded, never deleted.',
          },
          project: { type: 'string', description: 'Project slug. Defaults to the current project.' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['kind', 'title', 'body'],
        additionalProperties: false,
      },
      output: { schema: OUTPUT_SCHEMA, render: (args, value) => json(args, value.text ?? value) },
      async execute(args, exec) {
        const project = args.project ? slugify(args.project) : projectFor(ctx, exec, cfg)
        const title = redactor.redact(String(args.title))
        const body = redactor.redact(String(args.body))
        const entities = (args.entities ?? []).map((entity) => redactor.redact(String(entity)).text)
        const { card, deduped, entities: linked } = await vault.saveCard({
          kind: args.kind,
          title: title.text,
          body: body.text,
          entities,
          confidence: args.confidence ?? 'user_stated',
          supersedes: args.supersedes ?? [],
          tags: args.tags ?? [],
          project,
          source: { kind: 'agent', project },
        })
        await refreshViews()
        const redactions = title.hits.length + body.hits.length
        return {
          ok: true,
          id: card.id,
          deduped,
          project,
          entities: linked,
          redactions,
          text:
            `${deduped ? 'Re-confirmed existing card' : 'Saved'} ${card.id} (${card.kind}, ${project})\n` +
            `  ${card.title}\n` +
            `  entities: ${linked.join(', ') || '—'}` +
            (redactions > 0 ? `\n  redacted ${redactions} sensitive fragment(s) before writing` : ''),
        }
      },
    }),
  )

  /* ---------------------------------------------------------------- forget */
  disposers.push(
    ctx.tools.register({
      name: 'memory_forget',
      description:
        'Remove a memory. "retract" keeps the card and its trace but marks it withdrawn, so the model stops relying on it and the user can see what was withdrawn; "purge" deletes the file. Prefer retract; use purge only when the user asks for the content to be gone.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          mode: { type: 'string', enum: ['retract', 'purge'], description: 'Default retract.' },
          reason: { type: 'string', description: 'Why it is being forgotten; recorded in the audit log.' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      output: { schema: OUTPUT_SCHEMA, render: (args, value) => json(args, value.text ?? value) },
      async execute(args) {
        const mode = args.mode === 'purge' ? 'purge' : 'retract'
        if (mode === 'purge') {
          const done = await vault.purgeCard(String(args.id))
          await refreshViews()
          return { ok: done, text: done ? `Purged ${args.id}.` : `No card with id ${args.id}.` }
        }
        const card = await vault.retractCard(String(args.id), args.reason)
        await refreshViews()
        return {
          ok: Boolean(card),
          text: card ? `Retracted ${card.id} "${card.title}". The card and its history stay readable.` : `No card with id ${args.id}.`,
        }
      },
    }),
  )

  /* ---------------------------------------------------------------- distill */
  disposers.push(
    ctx.tools.register({
      name: 'memory_distill',
      description:
        'Turn captured raw episodes into memory cards using a model. By default it borrows the model selected in Settings → Models, so it needs no key of its own. Run it after a long work session, or when the user asks what you have learned lately. Returns a clear reason when it is not configured.',
      parameters: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Attribute new cards to this project. Default: the newest episode project.' },
          dryRun: { type: 'boolean', description: 'Show what would be written without writing it.' },
        },
        additionalProperties: false,
      },
      output: { schema: OUTPUT_SCHEMA, render: (args, value) => json(args, value.text ?? value) },
      async execute(args, exec) {
        const report = await distill({
          cfg,
          vault,
          redactor,
          project: args.project ?? projectFor(ctx, exec, cfg),
          dryRun: Boolean(args.dryRun),
          signal: exec?.signal,
          ...extractorServices(ctx),
        })
        const lines = []
        if (!report.ok) lines.push(`Not distilled: ${report.reason}`)
        else if (report.episodes === 0) lines.push(report.reason ?? 'Nothing new to distill.')
        else {
          lines.push(`Read ${report.episodes} episode(s) → ${report.written} card(s)${report.dryRun ? ' (dry run, nothing written)' : ''}.`)
          for (const card of report.cards ?? report.proposed ?? []) {
            lines.push(`  ${card.id ?? '(proposed)'} · ${card.kind} · ${card.title}${card.deduped ? ' (re-confirmed)' : ''}`)
          }
          if (report.skipped) lines.push(`  skipped: ${report.skipped}`)
          if (report.model) lines.push(`  model: ${report.model}${report.keySource ? ` · ${report.keySource}` : ''}`)
          if (report.usage) lines.push(`  tokens: ${JSON.stringify(report.usage)}`)
        }
        // Distillation is the biggest writer of all: without this the graph and
        // the README would only catch up on the next remember/forget.
        if (report.ok && !report.dryRun && report.episodes > 0) await refreshViews()
        return { ...report, text: lines.join('\n') }
      },
    }),
  )

  /* ---------------------------------------------------------------- stats */
  disposers.push(
    ctx.tools.register({
      name: 'memory_stats',
      description:
        'Where the memory vault lives and what it contains: card counts by kind and status, entities, projects, captured episodes, last distillation, privacy rule count. Use to confirm memory is actually working.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: OUTPUT_SCHEMA, render: (args, value) => json(args, value.text ?? value) },
      async execute() {
        const stats = await vault.stats()
        const text = [
          `vault: ${stats.vaultDir}`,
          `cards: ${stats.cards.active} active / ${stats.cards.superseded} superseded / ${stats.cards.retracted} retracted (${stats.cards.total} total)`,
          `kinds: ${JSON.stringify(stats.cards.byKind)}`,
          `entities: ${stats.entities}`,
          `projects: ${stats.projects.join(', ') || '—'}`,
          `episodes: ${stats.episodes.records} records in ${stats.episodes.files} file(s)`,
          `last distill: ${stats.distill.lastRun ?? 'never'}`,
          describeExtractor(ctx, cfg),
          `privacy rules: ${stats.privacy.rules}`,
          `views: README.md and graph.html in the vault root (open the HTML directly, no server needed)`,
        ].join('\n')
        return { ...stats, text }
      },
    }),
  )

  return disposers
}
