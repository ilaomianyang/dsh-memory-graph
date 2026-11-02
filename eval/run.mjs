/**
 * Retrieval eval: score the real searchCards against a seeded vault.
 *
 *   node eval/run.mjs
 *
 * Metrics
 *   recall@1   the top hit is one of the expected cards
 *   recall@k   |expected ∩ top-k| / |expected|, averaged over the questions
 *   MRR        1 / rank of the first expected card (0 when nothing is found)
 *   negative   a question about something the vault never recorded counts as a
 *              false positive when its top hit still carries real weight
 *
 * A temporal question passes only when the card that is still true is in the
 * top-k AND no superseded card outranks it: finding both and picking the stale
 * one is the failure this category exists to catch.
 *
 * The history group (kind "history" in questions.json) is scored on its own and
 * never enters the numbers above. Each pair asks about one topic twice, once
 * about the past and once about now; a side passes when its expected card is in
 * the top-k and the card that answers the other half of the pair is not above
 * it, and a pair passes only when both sides do. Its gate (pair accuracy >= 0.8)
 * is separate.
 *
 * The thresholds are part of the task, not of the tuning: a run below them
 * exits non-zero and leaves the vault on disk for inspection.
 */
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { searchCards } from '../src/search.js'
import { FIXTURE_CARDS, bridgeEntities, seed } from './seed.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const LIMIT = 5
const HOPS = 1
/** A negative question "hit something" only above this score: the recency fallback tops out near 0.05. */
const NEGATIVE_SCORE = 0.5
const GATE_RECALL5 = 0.8
const GATE_NEGATIVE_FP = 1
/** Share of history pairs that must get both eras right. */
const GATE_PAIRS = 0.8

const KINDS = ['keyword', 'entity-bridge', 'temporal', 'negative']
const HISTORY_KIND = 'history'

/* ------------------------------------------------------------------ helpers */

const results = []
function check(name, fn) {
  try {
    fn()
    results.push({ ok: true, name })
  } catch (error) {
    results.push({ ok: false, name, message: error.message })
  }
}

function width(text) {
  let n = 0
  for (const char of String(text)) {
    const code = char.codePointAt(0)
    n += code > 0x1100 && (code <= 0x115f || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe6f) || (code >= 0xff00 && code <= 0xff60)) ? 2 : 1
  }
  return n
}

function pad(text, size, align = 'left') {
  const fill = ' '.repeat(Math.max(0, size - width(text)))
  return align === 'right' ? `${fill}${text}` : `${text}${fill}`
}

const fixed = (value, digits = 2) => (Number.isFinite(value) ? value.toFixed(digits) : '-')

function table(headers, rows) {
  const sizes = headers.map((header, i) =>
    Math.max(width(header), ...rows.map((row) => width(row[i] ?? ''))),
  )
  const line = (cells) => cells.map((cell, i) => pad(cell, sizes[i], i === 0 ? 'left' : 'right')).join('  ')
  return [
    line(headers),
    sizes.map((size) => '-'.repeat(size)).join('  '),
    ...rows.map(line),
  ].join('\n')
}

/* ------------------------------------------------------------------ scoring */

/**
 * @returns {{
 *   id: string, kind: string, query: string, results: object[], ranks: number[],
 *   top1: number, recall1: number, recall5: number, reciprocalRank: number,
 *   demoteOk: boolean, pass: boolean, falsePositive: boolean
 * }}
 */
function evaluate(question, cards) {
  const options = { limit: LIMIT, hops: HOPS }
  if (question.project) options.project = question.project
  if (question.kinds) options.kinds = question.kinds
  const hits = searchCards(cards, question.query, options)

  const rankOf = (id) => {
    const at = hits.findIndex((hit) => hit.card.id === id)
    return at === -1 ? 0 : at + 1
  }
  const ranks = (question.expect ?? []).map(rankOf)
  const found = ranks.filter((rank) => rank > 0)
  const best = found.length > 0 ? Math.min(...found) : 0

  const recall5 = ranks.length === 0 ? 0 : ranks.filter((rank) => rank > 0 && rank <= LIMIT).length / ranks.length
  const top1 = hits.length > 0 && (question.expect ?? []).includes(hits[0].card.id) ? 1 : 0
  const reciprocalRank = best > 0 ? 1 / best : 0

  // No superseded card may sit above a card that is still true.
  let demoteOk = true
  for (const stale of question.demote ?? []) {
    const staleRank = rankOf(stale)
    if (staleRank === 0) continue
    for (const rank of ranks) {
      if (rank > 0 && rank > staleRank) demoteOk = false
    }
  }

  const temporal = question.kind === 'temporal'
  const negative = question.kind === 'negative'
  const falsePositive = negative && hits.length > 0 && hits[0].score >= NEGATIVE_SCORE

  // History pairs: the expected card has to be found AND has to outrank the card
  // that answers the other half of the pair. Returning both and ordering them
  // wrongly is exactly the failure a "which era is this?" question can hide.
  const rivalRanks = (question.rival ?? []).map(rankOf)
  const rivalOk = rivalRanks.every((rank) => rank === 0 || rank > best)

  return {
    id: question.id,
    kind: question.kind,
    pair: question.pair ?? null,
    side: question.side ?? null,
    query: question.query,
    results: hits,
    ranks,
    rivalRanks,
    rivalOk,
    top1: negative ? 0 : top1,
    recall1: negative ? 0 : top1,
    recall5: negative ? 0 : recall5,
    reciprocalRank: negative ? 0 : reciprocalRank,
    demoteOk,
    pass: negative
      ? !falsePositive
      : question.kind === HISTORY_KIND
        ? recall5 === 1 && rivalOk
        : temporal
          ? recall5 === 1 && demoteOk
          : top1 === 1,
    falsePositive,
    fallback: hits.length > 0 && hits.every((hit) => hit.via === 'recency'),
    topScore: hits[0]?.score ?? 0,
  }
}

const mean = (values) => (values.length === 0 ? 0 : values.reduce((sum, n) => sum + n, 0) / values.length)

/* --------------------------------------------------------------------- main */

const wanted = JSON.parse(await fsp.readFile(path.join(HERE, 'questions.json'), 'utf8'))
const { dir, cards, stats } = await seed()
const byId = new Map(cards.map((card) => [card.id, card]))
const bridges = bridgeEntities(cards)
const mainQuestions = wanted.questions.filter((question) => question.kind !== HISTORY_KIND)
const historyQuestions = wanted.questions.filter((question) => question.kind === HISTORY_KIND)
/** Chains are counted from the fixture itself, not written down twice. */
const chains = FIXTURE_CARDS.filter((card) => (card.supersedes ?? []).length > 0)

/* ------------------------------------------------------- the eval set itself */

check(`fixture has ${stats.cards.total} cards`, () => {
  assert.ok(stats.cards.total >= 30 && stats.cards.total <= 40, String(stats.cards.total))
})
check('fixture covers all five kinds', () => {
  for (const kind of ['decision', 'fact', 'open_question', 'preference', 'note']) {
    assert.ok((stats.cards.byKind[kind] ?? 0) > 0, `${kind} missing`)
  }
})
check('fixture spans three projects', () => {
  assert.deepEqual([...stats.projects].sort(), ['blog-engine', 'infra', 'memory-graph'])
})
check(`fixture has ${bridges.length} cross-project entities (need 6)`, () => {
  assert.ok(bridges.length >= 6, bridges.map((bridge) => bridge.slug).join(','))
})
check(`fixture has ${chains.length} supersede chains`, () => {
  const superseded = cards.filter((card) => card.status === 'superseded')
  assert.equal(superseded.length, chains.length)
  assert.ok(superseded.every((card) => card.supersededBy && byId.has(card.supersededBy)))
})
check('fixture has one retracted card', () => {
  assert.equal(cards.filter((card) => card.status === 'retracted').length, 1)
})
check(`${mainQuestions.length} scored questions, all well formed`, () => {
  assert.equal(mainQuestions.length, 25)
  const ids = new Set()
  for (const question of mainQuestions) {
    assert.ok(!ids.has(question.id), `duplicate id ${question.id}`)
    ids.add(question.id)
    assert.ok(KINDS.includes(question.kind), `${question.id}: bad kind ${question.kind}`)
    assert.ok(typeof question.query === 'string' && question.query.trim() !== '', `${question.id}: empty query`)
    assert.ok(Array.isArray(question.expect), `${question.id}: expect must be an array`)
    if (question.kind === 'negative') assert.equal(question.expect.length, 0, `${question.id}: negatives expect nothing`)
    else assert.ok(question.expect.length > 0, `${question.id}: no expected card`)
  }
})
check('every expected id exists in the fixture', () => {
  for (const question of wanted.questions) {
    for (const id of [...question.expect, ...(question.demote ?? []), ...(question.rival ?? [])]) {
      assert.ok(byId.has(id), `${question.id}: unknown card ${id}`)
    }
  }
})
const bridgeQuestions = wanted.questions.filter((q) => q.kind === 'entity-bridge')
check('entity-bridge questions name an entity shared by two projects', () => {
  for (const question of bridgeQuestions) {
    const needle = question.query.toLowerCase().replace(/-/g, ' ')
    const named = bridges.filter((bridge) => needle.includes(bridge.slug) || needle.includes(bridge.slug.replace(/-/g, ' ')))
    assert.ok(named.length > 0, `${question.id}: query names none of ${bridges.map((b) => b.slug).join(',')}`)
  }
})
check('most entity-bridge questions expect cards from several projects', () => {
  const multi = bridgeQuestions.filter((question) => new Set(question.expect.map((id) => byId.get(id).project)).size >= 2)
  // e5 is deliberately the single-answer case: the earliest card lives in one
  // project, the newer ones in another, and only the entity connects them.
  assert.ok(multi.length >= bridgeQuestions.length - 1, `${multi.length} of ${bridgeQuestions.length} span projects`)
})
check('temporal questions agree with the supersede chains', () => {
  for (const question of wanted.questions.filter((q) => q.kind === 'temporal')) {
    const expected = byId.get(question.expect[0])
    for (const id of question.demote ?? []) {
      assert.equal(byId.get(id).status, 'superseded', `${question.id}: ${id} is not superseded`)
      assert.equal(expected.status, 'active', `${question.id}: expects a card that is not active`)
    }
    if (question.mode === 'history') {
      assert.equal(expected.status, 'superseded', `${question.id}: a history question must expect the retired card`)
    } else {
      assert.equal(expected.status, 'active', `${question.id}: expects a card that is not active`)
    }
  }
})
check(`${historyQuestions.length} history questions form ${historyQuestions.length / 2} complete pairs`, () => {
  const byPair = new Map()
  for (const question of historyQuestions) {
    assert.ok(typeof question.pair === 'string' && question.pair !== '', `${question.id}: no pair`)
    assert.ok(['history', 'current'].includes(question.side), `${question.id}: bad side ${question.side}`)
    const list = byPair.get(question.pair) ?? []
    list.push(question)
    byPair.set(question.pair, list)
  }
  assert.ok(byPair.size >= 4, `only ${byPair.size} pairs, need at least 4`)
  for (const [pair, list] of byPair) {
    assert.equal(list.length, 2, `pair ${pair} has ${list.length} sides`)
    assert.deepEqual(list.map((question) => question.side).sort(), ['current', 'history'], `pair ${pair}: sides`)
    for (const question of list) {
      assert.equal(question.expect.length, 1, `${question.id}: one expected card`)
      assert.equal(question.rival.length, 1, `${question.id}: one rival card`)
      const other = list.find((candidate) => candidate.id !== question.id)
      assert.equal(question.rival[0], other.expect[0], `${question.id}: the rival is not the other side's answer`)
      assert.notEqual(question.expect[0], question.rival[0], `${question.id}: expect and rival are the same card`)
    }
  }
})
check('history sides expect the retired card, current sides the one that replaced it', () => {
  for (const question of historyQuestions) {
    const expected = byId.get(question.expect[0])
    const rival = byId.get(question.rival[0])
    if (question.side === 'history') {
      assert.equal(expected.status, 'superseded', `${question.id}: a history side must expect the retired card`)
      assert.equal(rival.status, 'active', `${question.id}: its rival must be the active card`)
    } else {
      assert.equal(expected.status, 'active', `${question.id}: a current side must expect the active card`)
      assert.equal(rival.status, 'superseded', `${question.id}: its rival must be the retired card`)
    }
  }
})

/* ---------------------------------------------------------------- the run */

const scored = mainQuestions.map((question) => evaluate(question, cards))
const historyScored = historyQuestions.map((question) => evaluate(question, cards))

/** A pair counts only when both of its sides pass. */
const pairs = [...new Set(historyScored.map((item) => item.pair))].map((pair) => {
  const sides = historyScored.filter((item) => item.pair === pair)
  return { pair, sides, pass: sides.every((item) => item.pass) }
})
const pairAccuracy = pairs.length === 0 ? 0 : pairs.filter((pair) => pair.pass).length / pairs.length

const groups = KINDS.map((kind) => {
  const list = scored.filter((item) => item.kind === kind)
  const negatives = list.filter((item) => item.kind === 'negative')
  const answers = list.filter((item) => item.kind !== 'negative')
  return {
    kind,
    total: list.length,
    recall1: mean(answers.map((item) => item.recall1)),
    recall5: mean(answers.map((item) => item.recall5)),
    mrr: mean(answers.map((item) => item.reciprocalRank)),
    temporalRule: kind === 'temporal' ? list.filter((item) => item.recall5 === 1 && item.demoteOk).length : null,
    falsePositives: negatives.filter((item) => item.falsePositive).length,
    /** Negatives that fell through to the recency fallback: correctly "nothing found". */
    fallback: negatives.filter((item) => item.fallback).length,
    negatives: negatives.length,
    failed: list.filter((item) => !item.pass).length,
  }
})

const answers = scored.filter((item) => item.kind !== 'negative')
const negatives = scored.filter((item) => item.kind === 'negative')

const overall = {
  recall1: mean(answers.map((item) => item.recall1)),
  recall5: mean(answers.map((item) => item.recall5)),
  mrr: mean(answers.map((item) => item.reciprocalRank)),
  falsePositives: negatives.filter((item) => item.falsePositive).length,
}

const recallPass = overall.recall5 >= GATE_RECALL5
const negativePass = overall.falsePositives <= GATE_NEGATIVE_FP
const historyPass = pairAccuracy >= GATE_PAIRS
const passed = recallPass && negativePass && historyPass

/* ---------------------------------------------------------------- report */

const out = []
out.push('memory-graph · retrieval eval')
out.push(`vault ${dir}`)
out.push(
  `cards ${stats.cards.total} · kinds ${Object.entries(stats.cards.byKind).map(([k, n]) => `${k} ${n}`).join(', ')} · ` +
    `active ${stats.cards.active} / superseded ${stats.cards.superseded} / retracted ${stats.cards.retracted}`,
)
out.push(
  `entities ${stats.entities} · cross-project bridges ${bridges.length}: ${bridges.map((b) => `${b.slug}(${b.projects.length})`).join(', ')}`,
)
out.push(`retrieval limit ${LIMIT}, hops ${HOPS} · negative false-positive threshold score >= ${NEGATIVE_SCORE}`)
out.push('')
out.push('-- fixture and eval set --')
for (const item of results) {
  out.push(`  ${item.ok ? 'ok  ' : 'FAIL'} ${item.name}${item.ok ? '' : `: ${item.message}`}`)
}
const fixtureOk = results.every((item) => item.ok)

out.push('')
out.push('-- score by question type --')
out.push(
  table(
    ['题型', 'n', 'recall@1', 'recall@5', 'MRR', '备注'],
    [
      ...groups.map((group) => [
        group.kind,
        String(group.total),
        group.kind === 'negative' ? '-' : fixed(group.recall1),
        group.kind === 'negative' ? '-' : fixed(group.recall5),
        group.kind === 'negative' ? '-' : fixed(group.mrr),
        group.kind === 'negative'
          ? `误报 ${group.falsePositives}/${group.negatives} · 兜底 ${group.fallback}`
          : group.kind === 'temporal'
            ? `时序规则 ${group.temporalRule}/${group.total}`
            : group.failed > 0
              ? `未过 ${group.failed}`
              : '',
      ]),
      [
        '全部',
        String(scored.length),
        fixed(overall.recall1),
        fixed(overall.recall5),
        fixed(overall.mrr),
        `负面误报 ${overall.falsePositives}/${negatives.length}`,
      ],
    ],
  ),
)

out.push('')
out.push('-- per question --')
for (const item of scored) {
  const rankText = item.ranks.length === 0 ? '' : ` ranks ${item.ranks.map((rank) => rank || 'missing').join(',')}`
  const demote = item.kind === 'temporal' ? ` demote ${item.demoteOk ? 'ok' : 'VIOLATED'}` : ''
  const marker = item.pass ? 'ok  ' : 'MISS'
  out.push(`  ${marker} ${pad(item.id, 3)} ${pad(item.kind, 13)} ${item.query}${rankText}${demote}`)
}

const broken = [...scored, ...historyScored].filter((item) => !item.pass)
if (broken.length > 0) {
  out.push('')
  out.push('-- what a miss actually returned --')
  for (const item of broken) {
    out.push(`  ${item.id} · ${item.query}`)
    const expects = wanted.questions.find((q) => q.id === item.id)
    out.push(`     expect: ${(expects.expect ?? []).map((id) => `${id} ${byId.get(id).title}`).join(' | ') || '(nothing)'}`)
    if (expects.rival) out.push(`     rival:  ${expects.rival.map((id) => `${id} ${byId.get(id).title}`).join(' | ')}`)
    for (const [index, hit] of item.results.slice(0, 3).entries()) {
      out.push(`     #${index + 1}  ${fixed(hit.score, 3)}  ${hit.via.padEnd(16)} ${hit.card.id} ${hit.card.title}`)
    }
    if (item.results.length === 0) out.push('     (no results)')
  }
}

out.push('')
out.push('-- negative questions (the vault never recorded these) --')
for (const item of negatives) {
  const label = item.falsePositive ? 'FALSE POSITIVE' : item.fallback ? 'fallback only' : 'below threshold'
  out.push(`  ${pad(item.id, 3)} ${pad(fixed(item.topScore, 3), 5)} ${pad(label, 14)} ${item.query}`)
  const top = item.results[0]
  if (top) out.push(`      top hit: ${top.card.id} ${top.card.title}`)
}
out.push('')
out.push(`-- history pairs (${pairs.length} 对 · 问历史 vs 问现状 · 单独门槛 成对准确率 >= ${GATE_PAIRS}) --`)
out.push(
  table(
    ['题号', 'side', '问题', '期望卡名次', '对侧卡名次', '判定'],
    historyScored.map((item) => [
      item.id,
      item.side,
      item.query,
      item.ranks[0] ? String(item.ranks[0]) : 'missing',
      item.rivalRanks[0] ? String(item.rivalRanks[0]) : '-',
      item.pass ? 'ok' : 'MISS',
    ]),
  ),
)
for (const pair of pairs) {
  out.push(
    `  pair ${pair.pair}  ${pair.pass ? 'ok  ' : 'MISS'}  ${pair.sides.map((side) => `${side.id}:${side.pass ? 'ok' : 'MISS'}`).join('  ')}`,
  )
}
out.push(
  `  成对准确率 ${pairs.filter((pair) => pair.pass).length}/${pairs.length} = ${fixed(pairAccuracy)}  (gate >= ${GATE_PAIRS})   ${historyPass ? 'PASS' : 'FAIL'}`,
)

out.push('')
out.push(`means are over the ${answers.length} answerable questions; the ${negatives.length} negative ones only count false positives`)

out.push('')
out.push('-- verdict --')
out.push(`  recall@5   ${fixed(overall.recall5)}  (gate >= ${GATE_RECALL5})   ${recallPass ? 'PASS' : 'FAIL'}`)
out.push(`  negative   ${overall.falsePositives} / ${negatives.length} 误报  (gate <= ${GATE_NEGATIVE_FP})   ${negativePass ? 'PASS' : 'FAIL'}`)
out.push(
  `  history    ${pairs.filter((pair) => pair.pass).length} / ${pairs.length} 对  ${fixed(pairAccuracy)}  (gate >= ${GATE_PAIRS})   ${historyPass ? 'PASS' : 'FAIL'}`,
)
out.push(`  ${passed ? 'PASS' : 'FAIL'}`)

console.log(out.join('\n'))

if (passed && fixtureOk) {
  await fsp.rm(dir, { recursive: true, force: true })
  process.exitCode = 0
} else {
  console.log(`\nvault kept for inspection: ${dir}`)
  process.exitCode = 1
}
