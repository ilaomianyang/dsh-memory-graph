/**
 * Distillation: raw episodes -> typed memory cards.
 *
 * This is the only place that calls a model, and it is always explicit: the
 * agent runs it through the `memory_distill` tool, or a scheduled job does.
 * Capture itself never calls a model, so nothing is lost while the extractor
 * is unconfigured.
 */
import { CARD_KINDS, CONFIDENCE } from './vault.js'

const SYSTEM_PROMPT = `You distill conversation transcripts into durable long-term memory.

Extract only what would still matter weeks later. Ignore chatter, tool mechanics,
restatements of the same fact, and anything already captured.

Card kinds:
- decision: a choice that was made, plus why. Include the alternative that was rejected when it is visible.
- fact: a stable property of the world, the project, or the system. Not a transient state.
- preference: how the user wants things done, in their own terms.
- open_question: something unresolved, with what would settle it.
- note: anything else durable worth keeping.

Rules:
1. Each card must be self-contained: a reader with no other context must understand it.
2. Write in the language the user wrote in. Chinese input -> Chinese cards, English input -> English.
3. A card title is one short sentence, no trailing period.
4. A body is 1-4 sentences: what, why, and what it replaced. No preamble.
5. entities: the concrete things involved — projects, files, tools, services, people, concepts.
   Short canonical names, reuse the same name every time. Prefer 1-4 entities.
6. confidence: "user_stated" if the user said it, "verified" if a tool result or the world confirmed it,
   "inferred" if you concluded it yourself.
7. If a card makes an existing memory wrong or obsolete, put that memory's exact id (from the
   "existing memories" list) in supersedes. Do not supersede a card that is merely related.
8. If nothing durable happened, return {"cards":[]} and say why in "skipped".

Return JSON only, no prose and no code fences:
{"cards":[{"kind":"decision","title":"...","body":"...","entities":["..."],"confidence":"user_stated","supersedes":["c-..."],"valid_from":"YYYY-MM-DD"}],"skipped":"..."}`

function fmtEpisode(entry, index) {
  const { record } = entry
  const lines = [`#${index + 1} [${record.t}] project=${record.project}${record.turn != null ? ` turn=${record.turn}` : ''}`]
  if (record.user) lines.push(`USER: ${record.user}`)
  if (record.assistant) lines.push(`ASSISTANT: ${record.assistant}`)
  if (record.tools) lines.push(`TOOLS_USED: ${record.tools}`)
  return lines.join('\n')
}

function existingBlock(cards, project) {
  const relevant = cards
    .filter((card) => card.status === 'active')
    .filter((card) => card.project === project)
    .slice(-60)
  if (relevant.length === 0) return ''
  return [
    '',
    'Existing memories for this project (use these exact ids in supersedes when one becomes wrong):',
    ...relevant.map((card) => `- ${card.id} · ${card.kind} · ${card.title}`),
  ].join('\n')
}

export function buildPrompt(episodes, existingCards, project) {
  const transcript = episodes.map(fmtEpisode).join('\n\n')
  const user = [
    `Distill these ${episodes.length} episode(s) from project "${project}".`,
    existingBlock(existingCards, project),
    '',
    'Transcript:',
    '<transcript>',
    transcript,
    '</transcript>',
  ].join('\n')
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ]
}

function extractJson(text) {
  const source = String(text ?? '').trim()
  if (source === '') return null

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(source)
  const candidates = []
  if (fenced) candidates.push(fenced[1].trim())
  candidates.push(source)

  const firstBrace = source.indexOf('{')
  const lastBrace = source.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace > firstBrace) candidates.push(source.slice(firstBrace, lastBrace + 1))

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch {
      // try the next shape
    }
  }
  return null
}

export function parseCards(text) {
  const parsed = extractJson(text)
  if (parsed === null) return { cards: [], skipped: 'model output was not JSON', raw: String(text ?? '').slice(0, 600) }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.cards) ? parsed.cards : []
  const cards = []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const title = String(raw.title ?? '').trim()
    if (title === '') continue
    const kind = CARD_KINDS.includes(raw.kind) ? raw.kind : 'note'
    const confidence = CONFIDENCE.includes(raw.confidence) ? raw.confidence : 'inferred'
    cards.push({
      kind,
      title: title.slice(0, 160),
      body: String(raw.body ?? '').trim().slice(0, 2000),
      entities: Array.isArray(raw.entities)
        ? raw.entities.filter((e) => typeof e === 'string' && e.trim() !== '').slice(0, 8)
        : [],
      confidence,
      supersedes: Array.isArray(raw.supersedes)
        ? raw.supersedes.filter((s) => typeof s === 'string' && /^c-/.test(s)).slice(0, 8)
        : [],
      validFrom: typeof raw.valid_from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.valid_from) ? raw.valid_from : null,
    })
  }
  return { cards, skipped: typeof parsed.skipped === 'string' ? parsed.skipped : null }
}

function resolveKey(cfg) {
  if (cfg.extractor.apiKey) return cfg.extractor.apiKey
  const envName = cfg.extractor.apiKeyEnv
  if (envName && process.env[envName]) return process.env[envName]
  return ''
}

export async function callModel(cfg, messages, { signal } = {}) {
  const key = resolveKey(cfg)
  if (key === '') {
    throw new Error(
      `No API key for the extractor. Set env ${cfg.extractor.apiKeyEnv} (or config extractor.apiKey).`,
    )
  }
  const url = `${cfg.extractor.baseUrl}${cfg.extractor.path}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), cfg.extractor.timeoutMs)
  const onAbort = () => controller.abort()
  signal?.addEventListener?.('abort', onAbort, { once: true })

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: cfg.extractor.model,
        messages,
        temperature: cfg.extractor.temperature,
        max_tokens: cfg.extractor.maxOutputTokens,
        stream: false,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    })
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`Extractor HTTP ${response.status} from ${url}: ${text.slice(0, 400)}`)
    }
    let data
    try {
      data = JSON.parse(text)
    } catch {
      throw new Error(`Extractor returned non-JSON response: ${text.slice(0, 300)}`)
    }
    const content =
      data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? data?.output_text ?? ''
    if (typeof content !== 'string' || content.trim() === '') {
      throw new Error('Extractor returned an empty completion.')
    }
    return { content, usage: data?.usage ?? null, model: data?.model ?? cfg.extractor.model }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
  }
}

/**
 * Read undistilled episodes, extract cards, persist them.
 * @returns {Promise<object>} a report the tool renders verbatim
 */
export async function distill({ cfg, vault, redactor, project, dryRun = false, signal }) {
  if (!cfg.extractor.enabled) {
    return {
      ok: false,
      reason: 'Extractor is disabled. Set config extractor.enabled = true and point extractor at an OpenAI-compatible endpoint.',
    }
  }

  const limit = cfg.extractor.maxEpisodesPerRun
  const entries = await vault.readUndistilled(limit)
  if (entries.length === 0) {
    return { ok: true, episodes: 0, written: 0, reason: 'Every episode has already been distilled.' }
  }

  const cards = await vault.listCards({ includeRetracted: true })
  const scopedProject = project || entries[entries.length - 1]?.record?.project || cfg.defaultProject
  const messages = buildPrompt(entries, cards, scopedProject)
  const { content, usage } = await callModel(cfg, messages, { signal })
  const { cards: parsed, skipped, raw } = parseCards(content)

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      episodes: entries.length,
      proposed: parsed,
      skipped,
      usage,
      raw: parsed.length === 0 ? raw : undefined,
    }
  }

  const written = []
  for (const draft of parsed) {
    const title = redactor.redact(draft.title).text
    const body = redactor.redact(draft.body).text
    const entities = draft.entities.map((entity) => redactor.redact(entity).text)
    const result = await vault.saveCard({
      ...draft,
      title,
      body,
      entities,
      project: scopedProject,
      source: {
        kind: 'distill',
        episodes: entries.map((entry) => `${entry.file}#${entry.line}`).slice(0, 50),
        model: cfg.extractor.model,
      },
    })
    written.push({
      id: result.card.id,
      kind: result.card.kind,
      title: result.card.title,
      deduped: result.deduped,
      supersedes: draft.supersedes,
    })
  }

  await vault.markDistilled(entries)
  await vault.regenerateReadme()
  await vault.audit(
    'distill',
    `project=${scopedProject} episodes=${entries.length} cards=${written.length} model=${cfg.extractor.model}`,
  )

  return {
    ok: true,
    episodes: entries.length,
    written: written.length,
    cards: written,
    skipped,
    usage,
    vault: cfg.vaultDir,
  }
}
