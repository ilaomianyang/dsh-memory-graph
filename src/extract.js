/**
 * Distillation: raw episodes -> typed memory cards.
 *
 * This is the only place that calls a model, and it is always explicit: the
 * agent runs it through the `memory_distill` tool, or a scheduled job does.
 * Capture itself never calls a model, so nothing is lost while the extractor
 * is unconfigured.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CARD_KINDS, CONFIDENCE } from './vault.js'

const SYSTEM_PROMPT = `You distill conversation transcripts into durable long-term memory.

Extract only what would still matter weeks later. Ignore chatter, tool mechanics,
restatements of the same fact, and anything already captured.

Card kinds:
- decision: a choice that was made, plus why. Include the alternative that was rejected when it is visible.
- fact: a stable property of the world, the project, or the system. Not a transient state.
- preference: how the user wants things done, in their own terms. If the user said how they want
  something to work, that is a preference even when a decision was made in the same breath.
- open_question: something unresolved, with what would settle it.
- note: anything else durable worth keeping.

Rules:
1. Each card must be self-contained: a reader with no other context must understand it.
2. Language: write each card in the language of the user message it came from, never translated.
   A Chinese user message produces a Chinese title and a Chinese body, even when the assistant
   answered in English or the surrounding transcript is mostly English.
3. A card title is one short sentence, no trailing period.
4. A body is 1-4 sentences: what, why, and what it replaced. No preamble.
5. entities: the concrete things involved — projects, files, tools, services, people, concepts.
   Short canonical names, reuse the same name every time. Prefer 1-4 entities.
6. confidence: "user_stated" if the user said it, "verified" if a tool result or the world confirmed it,
   "inferred" if you concluded it yourself.
7. If a card makes an existing memory wrong or obsolete, put that memory's exact id (from the
   "existing memories" list) in supersedes. Do not supersede a card that is merely related.
8. project: set it to the project named in the header of the episode the card came from. Never
   copy the project of another episode in the same batch.
9. valid_from: the date of the episode, YYYY-MM-DD.
10. A transcript often contains mid-course corrections ("no, I meant", "不是", "改成", "其实").
    Record the final state, never the corrected-away one; when the reversal matters, say what it replaced.
11. If nothing durable happened, return {"cards":[]} and say why in "skipped".

Use the kind that fits, and do not collapse everything into one kind: a batch of
distinct events usually yields a mix.

Return JSON only, no prose and no code fences:
{"cards":[{"kind":"decision","project":"...","title":"...","body":"...","entities":["..."],"confidence":"user_stated","supersedes":["c-..."],"valid_from":"YYYY-MM-DD"}],"skipped":"..."}`

function fmtEpisode(entry, index) {
  const { record } = entry
  const lines = [`#${index + 1} [${record.t}] project=${record.project}${record.turn != null ? ` turn=${record.turn}` : ''}`]
  if (record.user) lines.push(`USER: ${record.user}`)
  if (record.assistant) lines.push(`ASSISTANT: ${record.assistant}`)
  if (record.tools) lines.push(`TOOLS_USED: ${record.tools}`)
  return lines.join('\n')
}

function existingBlock(cards, projects) {
  const scoped = new Set(projects)
  const relevant = cards
    .filter((card) => card.status === 'active')
    .filter((card) => scoped.size === 0 || scoped.has(card.project))
    .slice(-60)
  if (relevant.length === 0) return ''
  return [
    '',
    'Existing memories for these projects (use these exact ids in supersedes when one becomes wrong):',
    ...relevant.map((card) => `- ${card.id} · ${card.project} · ${card.kind} · ${card.title}`),
  ].join('\n')
}

export function buildPrompt(episodes, existingCards, project) {
  const transcript = episodes.map(fmtEpisode).join('\n\n')
  const projects = [...new Set([project, ...episodes.map((entry) => entry.record.project)].filter(Boolean))]
  const scope =
    projects.length === 1
      ? `Distill these ${episodes.length} episode(s) from project "${projects[0]}".`
      : `Distill these ${episodes.length} episode(s). They come from ${projects.length} projects ` +
        `(${projects.join(', ')}); every card must name its own project in "project".`
  const user = [
    scope,
    existingBlock(existingCards, projects),
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
      project: typeof raw.project === 'string' && raw.project.trim() !== '' ? raw.project.trim() : null,
      supersedes: Array.isArray(raw.supersedes)
        ? raw.supersedes.filter((s) => typeof s === 'string' && /^c-/.test(s)).slice(0, 8)
        : [],
      validFrom: typeof raw.valid_from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.valid_from) ? raw.valid_from : null,
    })
  }
  return { cards, skipped: typeof parsed.skipped === 'string' ? parsed.skipped : null }
}

/**
 * Where the harness keeps its own named secrets, if it has one. DeepSeek Harness
 * stores per-provider keys in `<DSH_HOME>/.credentials.yaml` under `refs:` and
 * resolves them internally, so they never appear in `process.env`. Reading the
 * one name the user configured makes the extractor work without asking anyone to
 * duplicate a key into a shell environment.
 */
function credentialStorePath() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, '.credentials.yaml')
}

/**
 * Read one named secret out of the credential store. Only the requested name is
 * looked at; the value is returned and never logged, audited or stored.
 */
export function readCredentialRef(name, file = credentialStorePath()) {
  if (!name) return ''
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
  let inRefs = false
  for (const line of text.split('\n')) {
    if (/^refs:\s*$/.test(line)) {
      inRefs = true
      continue
    }
    if (inRefs && /^\S/.test(line)) inRefs = false
    if (!inRefs) continue
    const match = /^\s+([A-Za-z0-9_.-]+)\s*:\s*(.+?)\s*$/.exec(line)
    if (match && match[1] === name) return match[2].replace(/^['"]|['"]$/g, '')
  }
  return ''
}

/**
 * @returns {{key: string, source: string, looked: string[]}} where the key came
 * from, described in words safe to show a user and to put in a report.
 */
export function resolveKeyInfo(cfg) {
  const { apiKey, apiKeyEnv } = cfg.extractor
  const store = credentialStorePath()
  const looked = []
  if (apiKey) return { key: apiKey, source: 'config extractor.apiKey', looked }
  if (apiKeyEnv && process.env[apiKeyEnv]) return { key: process.env[apiKeyEnv], source: `env ${apiKeyEnv}`, looked }
  if (apiKeyEnv) {
    looked.push(`env ${apiKeyEnv}`, `${store} refs.${apiKeyEnv}`)
    const stored = readCredentialRef(apiKeyEnv)
    if (stored) return { key: stored, source: `credential store refs.${apiKeyEnv}`, looked }
  }
  return { key: '', source: '', looked }
}

function resolveKey(cfg) {
  return resolveKeyInfo(cfg).key
}

/**
 * The thinking level of a Settings model selection. The harness stores it as
 * `reasoningEffort` (an opaque id); older shapes nested it under `reasoning` as
 * a string or `{id, name}` record, so all three are accepted.
 */
export function selectionEffort(selection) {
  const direct = selection?.reasoningEffort
  if (typeof direct === 'string') return direct
  const value = selection?.reasoning
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && typeof value.id === 'string') return value.id
  return ''
}

/**
 * The two harness services a harness-transport distillation borrows: the `llm`
 * caller, and whatever model 设置 → 模型 has selected right now.
 *
 * Both are optional on purpose. A profile without them still runs the plugin —
 * the http transport needs neither, and the harness transport reports what is
 * missing instead of throwing. Resolved at call time, so switching models in
 * Settings takes effect on the next run.
 */
export function extractorServices(ctx) {
  try {
    const llm = ctx?.get?.('llm', false) ?? undefined
    const selection = ctx?.get?.('agentDefaultModel', false)?.currentSelection?.() ?? undefined
    return { llm, selection }
  } catch {
    return { llm: undefined, selection: undefined }
  }
}

/**
 * The route one harness-transport call takes: the provider/model pair chosen in
 * this plugin's settings, or the model currently selected in Settings → Models.
 * Reusing that selection is the whole point of the harness transport: the route,
 * its key and its base URL already exist, so the extractor holds no secret.
 * @returns {{provider: string, model: string, effort: string, source: string}}
 */
export function resolveRoute(cfg, selection) {
  const { useCurrentModel, provider, model, reasoningEffort } = cfg.extractor
  if (!useCurrentModel) {
    if (!provider || !model) {
      throw new Error(
        'extractor.useCurrentModel is off, so extractor.provider and extractor.model are both required.',
      )
    }
    return { provider, model, effort: reasoningEffort, source: 'config extractor.provider/model' }
  }
  if (!selection?.provider || !selection?.model) {
    throw new Error(
      'No model is selected in Settings → Models, so the extractor has no route to borrow. ' +
        'Pick a model there, or set extractor.provider and extractor.model and turn extractor.useCurrentModel off.',
    )
  }
  return {
    provider: selection.provider,
    model: selection.model,
    // An explicit setting wins, so a big thinking budget can be reserved for
    // distillation without changing the model the conversation itself uses.
    effort: reasoningEffort || selectionEffort(selection),
    source: 'Settings → Models selection',
  }
}

/** Split OpenAI-shaped messages into the harness's system prompt plus one user input. */
function splitMessages(messages) {
  const join = (list) => list.map((message) => message.content).join('\n\n')
  return {
    system: join(messages.filter((message) => message.role === 'system')),
    input: join(messages.filter((message) => message.role !== 'system')),
  }
}

/**
 * Call a route the Settings page already owns, through the harness LLM service.
 *
 * The service resolves the adapter, the base URL and the credential, so a
 * custom provider added in Settings works here with no configuration at all, and
 * the key never passes through this plugin.
 */
async function callHarnessModel(cfg, messages, { signal, llm, selection } = {}) {
  if (!llm || typeof llm.prepareCall !== 'function') {
    throw new Error(
      'This harness build exposes no llm service to plugins, so set extractor.transport = "http" to post to an endpoint directly.',
    )
  }
  const route = resolveRoute(cfg, selection)
  const { system, input } = splitMessages(messages)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), cfg.extractor.timeoutMs)
  const onAbort = () => controller.abort()
  signal?.addEventListener?.('abort', onAbort, { once: true })

  try {
    const { effort } = route
    // Sampling is left alone: the borrowed route owns it, and some providers
    // reject an explicit temperature when they are in a thinking mode.
    const controls = {
      maxTokens: cfg.extractor.maxOutputTokens,
      ...(effort === '' ? {} : { reasoningEffort: effort }),
    }
    // prepareCall validates the controls against this exact route before any
    // I/O, so an effort the route does not offer fails here with its own error
    // instead of halfway through a paid call.
    const call = await llm.prepareCall(
      { provider: route.provider, model: route.model, ...controls },
      controller.signal,
      (proposed) => ({ ...proposed, ...controls }),
    )
    const options = {
      ...call.config,
      messages: [{ role: 'user', content: [{ type: 'text', text: input }] }],
      system,
      signal: controller.signal,
    }
    let text = ''
    let usage = null
    let finish = null
    for await (const chunk of call.stream(options)) {
      if (chunk?.type === 'text-delta') text += chunk.text
      else if (chunk?.type === 'usage') usage = chunk.usage ?? null
      else if (chunk?.type === 'finish') finish = chunk.reason ?? null
    }
    const kind = finish?.kind
    if (kind === 'error' || kind === 'aborted') {
      const failure = finish.failure ?? {}
      if (controller.signal.aborted) {
        // Either the caller cancelled us or our own timer fired; say which,
        // because the fix is different (wait longer vs. run less work).
        const why = signal?.aborted
          ? 'was cancelled before the route answered'
          : `timed out after ${cfg.extractor.timeoutMs} ms`
        throw new Error(
          `Extractor call to ${route.provider}/${route.model} ${why}; raise extractor.timeoutMs or distill fewer episodes per run.`,
        )
      }
      throw new Error(
        `Extractor call failed on ${route.provider}/${route.model} (${failure.code ?? kind}): ${failure.message ?? 'the route ended the stream without a reason'}`,
      )
    }
    if (kind === 'tool-calls') {
      throw new Error('Extractor answered with a tool call instead of JSON. Try a different model for distillation.')
    }
    if (kind === 'max-tokens') {
      throw truncated(
        `Extractor output reached maxOutputTokens (${cfg.extractor.maxOutputTokens}); raise it or distill fewer episodes per run.`,
      )
    }
    if (text.trim() === '') throw new Error('Extractor returned an empty completion.')
    return {
      content: text,
      usage,
      model: `${route.provider}/${route.model}`,
      keySource: `${route.source}${effort === '' ? '' : ` · effort ${effort}`}`,
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
  }
}

/** Post to an OpenAI-compatible endpoint with this plugin's own key. */
export async function callHttpModel(cfg, messages, { signal } = {}) {
  const { key, source, looked } = resolveKeyInfo(cfg)
  if (key === '') {
    const where = looked.length > 0 ? looked.join(' or ') : 'config extractor.apiKey'
    throw new Error(
      `No API key for the extractor. Looked in ${where}. Set the env var, add the name to the harness credential store, or set config extractor.apiKey.`,
    )
  }
  const url = `${cfg.extractor.baseUrl}${cfg.extractor.path}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), cfg.extractor.timeoutMs)
  const onAbort = () => controller.abort()
  signal?.addEventListener?.('abort', onAbort, { once: true })

  const body = { model: cfg.extractor.model, messages, temperature: cfg.extractor.temperature, max_tokens: cfg.extractor.maxOutputTokens, stream: false }

  const post = (extra) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ ...body, ...extra }),
      signal: controller.signal,
    })

  try {
    // Ask for strict JSON, but not every OpenAI-compatible endpoint implements
    // response_format: a proxy that rejects the field gets one retry without it.
    let response = await post({ response_format: { type: 'json_object' } })
    let text = await response.text()
    if (response.status === 400 && /response_format|json_object/i.test(text)) {
      response = await post({})
      text = await response.text()
    }
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
    if (data?.choices?.[0]?.finish_reason === 'length') {
      // Same situation as the harness route's max-tokens finish: the answer is
      // cut off mid-JSON, so ask for less instead of blaming the parser.
      throw truncated(
        `Extractor output reached maxOutputTokens (${cfg.extractor.maxOutputTokens}); raise it or distill fewer episodes per run.`,
      )
    }
    if (typeof content !== 'string' || content.trim() === '') {
      throw new Error('Extractor returned an empty completion.')
    }
    return { content, usage: data?.usage ?? null, model: data?.model ?? cfg.extractor.model, keySource: source }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
  }
}

/**
 * One model call for distillation, over the configured transport.
 * @param {object} cfg resolved plugin config
 * @param {Array<{role: string, content: string}>} messages prompt built by {@link buildPrompt}
 * @param {{signal?: AbortSignal, llm?: object, selection?: object}} options harness
 *   service handle and the current Settings model selection, both used by the
 *   harness transport and ignored by the HTTP one
 */
export async function callModel(cfg, messages, { signal, llm, selection } = {}) {
  return cfg.extractor.transport === 'http'
    ? callHttpModel(cfg, messages, { signal })
    : callHarnessModel(cfg, messages, { signal, llm, selection })
}

/**
 * The project a batch belongs to when a card does not say: the most frequent
 * project among the episodes, with the most recent one winning a tie.
 */
function dominantProject(entries) {
  const counts = new Map()
  let best = null
  let bestCount = 0
  for (const entry of entries) {
    const project = entry.record?.project
    if (!project) continue
    const count = (counts.get(project) ?? 0) + 1
    counts.set(project, count)
    if (count >= bestCount) {
      best = project
      bestCount = count
    }
  }
  return best
}

/** Stable code for "the model ran out of output budget part-way through". */
const TRUNCATED = 'EXTRACTOR_TRUNCATED'

/** Rough output cost of one episode: a card, sometimes two. */
const OUTPUT_TOKENS_PER_EPISODE = 320

function truncated(message) {
  const error = new Error(message)
  error.code = TRUNCATED
  return error
}

/** How many episodes to send in one call so the answer fits the output budget. */
export function plannedBatchSize(cfg, total) {
  const budget = Math.floor((cfg.extractor.maxOutputTokens || 0) / OUTPUT_TOKENS_PER_EPISODE)
  const fit = Number.isFinite(budget) && budget > 0 ? budget : 1
  return Math.max(1, Math.min(total, fit))
}

/**
 * Read undistilled episodes, extract cards, persist them.
 * @returns {Promise<object>} a report the tool renders verbatim
 */
export async function distill({ cfg, vault, redactor, project, dryRun = false, signal, llm, selection }) {
  if (!cfg.extractor.enabled) {
    return {
      ok: false,
      reason:
        'Extractor is disabled. Set config extractor.enabled = true; the default transport reuses the model selected in Settings → Models.',
    }
  }

  const entries = await vault.readUndistilled(cfg.extractor.maxEpisodesPerRun)
  if (entries.length === 0) {
    return { ok: true, episodes: 0, written: 0, reason: 'Every episode has already been distilled.' }
  }

  const known = await vault.listCards({ includeRetracted: true })
  // One run can span several projects. The batch is scoped by the projects the
  // episodes actually name, and each card is filed under its own project; the
  // dominant project is only the fallback when a card forgets to say.
  const batchProjects = [...new Set(entries.map((entry) => entry.record.project).filter(Boolean))]
  const dominant = dominantProject(entries) || cfg.defaultProject

  // One call per batch, not per run: 40 episodes would ask for more cards than
  // any sane maxOutputTokens allows, and a truncated answer loses the lot.
  const size = plannedBatchSize(cfg, entries.length)
  const planned = Math.ceil(entries.length / size)

  const run = { calls: 0, usage: null, model: null, keySource: null }
  const skippedNotes = []

  /** Ask for one batch, halving and retrying when the output budget ran out. */
  const ask = async (chunk) => {
    const projects = [...new Set(chunk.map((entry) => entry.record.project).filter(Boolean))]
    const scoped = project || (projects.length === 1 ? projects[0] : dominant)
    const context = [...known, ...written.map((card) => card.card).filter(Boolean)]
    let answer
    try {
      answer = await callModel(cfg, buildPrompt(chunk, context, scoped), { signal, llm, selection })
    } catch (error) {
      // A single episode that still overflows is a real failure; with more than
      // one, the honest fix is to ask for less at a time rather than to give up.
      if (chunk.length > 1 && error?.code === TRUNCATED) {
        const half = Math.ceil(chunk.length / 2)
        return [...(await ask(chunk.slice(0, half))), ...(await ask(chunk.slice(half)))]
      }
      throw error
    }
    run.calls += 1
    run.model ??= answer.model
    run.keySource ??= answer.keySource
    run.usage = sumUsage(run.usage, answer.usage)
    return [{ chunk, answer }]
  }

  const written = []
  const proposed = []
  const queue = [...entries]
  const report = () => ({
    episodes: dryRun ? Math.min(size, entries.length) : entries.length - queue.length,
    remaining: queue.length,
    batches: { planned, done: run.calls, size },
    skipped: skippedNotes.length === 0 ? null : skippedNotes.join('; ').slice(0, 400),
    usage: run.usage,
    model: run.model,
    keySource: run.keySource,
  })

  while (queue.length > 0) {
    const chunk = queue.splice(0, size)
    let answers
    try {
      answers = await ask(chunk)
    } catch (error) {
      // Keep whatever already landed: a later batch failing does not undo it.
      return {
        ok: false,
        reason: error.message,
        written: written.length,
        cards: written,
        projects: [...new Set(written.map((card) => card.project))],
        ...report(),
      }
    }

    for (const { chunk: part, answer } of answers) {
      const parsed = parseCards(answer.content)
      if (parsed.skipped) skippedNotes.push(parsed.skipped)
      if (dryRun) {
        proposed.push(...parsed.cards)
        continue
      }
      const allowed = new Set([...part.map((entry) => entry.record.project), cfg.defaultProject])
      const partProjects = [...new Set(part.map((entry) => entry.record.project).filter(Boolean))]
      const fallback = project || (partProjects.length === 1 ? partProjects[0] : dominant)
      for (const draft of parsed.cards) {
        const title = redactor.redact(draft.title).text
        const body = redactor.redact(draft.body).text
        const entities = draft.entities.map((entity) => redactor.redact(entity).text)
        const cardProject =
          project || (draft.project && allowed.has(draft.project) ? draft.project : null) || fallback
        const result = await vault.saveCard({
          ...draft,
          title,
          body,
          entities,
          project: cardProject,
          source: {
            kind: 'distill',
            episodes: part.map((entry) => `${entry.file}#${entry.line}`).slice(0, 50),
            model: answer.model,
          },
        })
        written.push({
          id: result.card.id,
          kind: result.card.kind,
          project: result.card.project,
          title: result.card.title,
          deduped: result.deduped,
          supersedes: draft.supersedes,
          card: result.card,
        })
      }
      // Mark per batch: a run that dies half-way should not redo the batches
      // that already landed.
      await vault.markDistilled(part)
    }
    // A dry run is a preview of one batch; batching the rest would spend the
    // user's tokens to say the same thing.
    if (dryRun) break
  }

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      projects: batchProjects,
      proposed,
      ...report(),
    }
  }

  await vault.regenerateReadme()
  await vault.regenerateGraph?.()
  await vault.audit(
    'distill',
    `projects=${batchProjects.join(',') || dominant} episodes=${entries.length} cards=${written.length} batches=${run.calls} model=${run.model} via=${cfg.extractor.transport} route=${run.keySource}`,
  )

  return {
    ok: true,
    written: written.length,
    cards: written.map(({ card, ...rest }) => rest),
    projects: [...new Set(written.map((card) => card.project))],
    vault: cfg.vaultDir,
    ...report(),
  }
}

/** Add two usage reports without assuming any single field is present. */
function sumUsage(total, next) {
  if (!next) return total
  if (!total) return { ...next }
  const out = { ...total }
  for (const [key, value] of Object.entries(next)) {
    if (typeof value === 'number') out[key] = (typeof out[key] === 'number' ? out[key] : 0) + value
  }
  return out
}
