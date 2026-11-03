/**
 * Settings-form schema checks.
 *
 * The harness draws this plugin's page in 设置 (Settings) from the `Config`
 * schema it exports: `@deepseek-ai/dsh-settings` keeps only the fields marked
 * `.volatile()` and serves those as one editable form. Two kinds of rot are
 * possible and both are silent: a field added to `src/config.js` but not to the
 * form (invisible setting), and a default that disagrees between the form and
 * the runtime (the form shows one thing, the plugin does another).
 *
 * The drift check below walks every leaf of the schema defaults and demands the
 * same value from `resolveConfig({})`, so adding a field in only one place fails
 * here instead of shipping.
 *
 * The last three checks are about the split that makes the page possible at all:
 * a leaf is either volatile (live-editable in Settings) or structural (read once
 * while activating, so editing it remounts the plugin). `client.js` declares the
 * page's fields; the two descriptions must agree, or the page shows a knob the
 * host refuses to write, or misses a knob the host serves.
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { Config } from '../src/schema.js'
import { DEFAULT_SKIP_PATTERNS, resolveConfig, unwrapConfig } from '../src/config.js'

// client.js is a browser bundle; imported under Node it only publishes its
// field table on globalThis (see the entry-point guard at the bottom of it).
await import('../client.js')
const spec = globalThis.__memoryGraphFormSpec

let passed = 0
const check = (name, fn) => {
  try {
    fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    console.log(`  FAIL ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

const walk = (value, prefix = '') => {
  const leaves = []
  for (const [key, child] of Object.entries(value)) {
    const at = prefix === '' ? key : `${prefix}.${key}`
    if (child !== null && typeof child === 'object' && !Array.isArray(child)) leaves.push(...walk(child, at))
    else leaves.push([at, child])
  }
  return leaves
}

/** Every leaf node of a schema with its dotted path and its node. */
const schemaLeaves = (node, prefix = []) => {
  if (!node) return []
  if (node.type === 'object') {
    return Object.entries(node.dict ?? {}).flatMap(([key, child]) => schemaLeaves(child, [...prefix, key]))
  }
  return [{ path: prefix.join('.'), node }]
}

const at = (object, dotted) => dotted.split('.').reduce((node, key) => node?.[key], object)

console.log('schema')

// `Config({})` validates to frozen `{ get() }` refs for every live leaf, so all
// value comparisons go through `unwrapConfig` — the same seam `src/config.js`
// uses when the plugin reads its configuration.
const defaults = unwrapConfig(Config({}))

check('an empty config block is valid and yields the documented defaults', () => {
  assert.equal(defaults.enabled, true)
  assert.equal(defaults.vaultDir, '')
  assert.equal(defaults.extractor.enabled, false)
  assert.equal(defaults.extractor.transport, 'harness')
  assert.equal(defaults.extractor.useCurrentModel, true)
  assert.equal(defaults.extractor.reasoningEffort, '')
  assert.deepEqual(defaults.capture.skipPatterns, [...DEFAULT_SKIP_PATTERNS])
})

check('every field the plugin normalises also has a default in the form', () => {
  const runtime = resolveConfig({})
  // vaultDir is the one leaf that must differ: the form holds the user's raw
  // text ('' means "the default vault") while the runtime holds an absolute path.
  const skip = new Set(['vaultDir'])
  const drift = []
  for (const [key, value] of walk(defaults)) {
    if (skip.has(key)) continue
    const actual = at(runtime, key)
    if (JSON.stringify(actual) !== JSON.stringify(value)) {
      drift.push(`${key}: form ${JSON.stringify(value)} vs runtime ${JSON.stringify(actual)}`)
    }
  }
  assert.deepEqual(drift, [], `settings form and runtime defaults disagree:\n${drift.join('\n')}`)
})

check('and no runtime default hides behind a missing form field', () => {
  // The other direction: a knob `src/config.js` understands but the form never
  // shows is an invisible setting, which is just as bad as a dead one.
  const runtime = resolveConfig({})
  const shown = new Set(walk(defaults).map(([key]) => key))
  const hidden = walk(runtime)
    .map(([key]) => key)
    .filter((key) => key !== 'vaultDir' && !shown.has(key))
  assert.deepEqual(hidden, [])
})

check('the runtime still fills what the form leaves blank', () => {
  const runtime = resolveConfig({})
  assert.equal(runtime.vaultDir, path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', 'dsh-memory'))
  // A blank model is a real answer in harness mode: `resolveRoute` says what is
  // missing instead of quietly calling a different model than the user picked.
  assert.equal(runtime.extractor.model, '')
  // And http mode keeps its friendly default.
  assert.equal(resolveConfig({ extractor: { transport: 'http' } }).extractor.model, 'deepseek-chat')
})

check('the transport union accepts exactly the two documented values', () => {
  assert.equal(unwrapConfig(Config({ extractor: { transport: 'http' } })).extractor.transport, 'http')
  assert.equal(unwrapConfig(Config({ extractor: { transport: 'harness' } })).extractor.transport, 'harness')
  assert.throws(() => Config({ extractor: { transport: 'openai' } }))
})

check('numeric bounds reject what the runtime would silently clamp', () => {
  assert.throws(() => Config({ extractor: { maxOutputTokens: 3000.5 } }), /256|multiple|step/)
  assert.throws(() => Config({ retrieval: { hops: 3 } }))
  // Values the runtime accepts must be accepted by the form too, or the form
  // cannot express a config the plugin supports.
  assert.equal(unwrapConfig(Config({ extractor: { maxOutputTokens: 3000 } })).extractor.maxOutputTokens, 3000)
  assert.equal(unwrapConfig(Config({ retrieval: { hops: 2 } })).retrieval.hops, 2)
})

check('the inline key is marked secret so the form can mask it', () => {
  const json = Config.toJSON()
  const text = JSON.stringify(json)
  assert.match(text, /"apiKey"/)
  assert.match(text, /"secret"/)
  assert.equal(Object.keys(json.refs ?? {}).length > 0, true, 'a schema with refs is what the Settings form projects')
})

check('every setting appears in the projected schema', () => {
  const text = JSON.stringify(Config.toJSON())
  const names = [
    'enabled',
    'vaultDir',
    'defaultProject',
    'crossProject',
    'capture',
    'userChars',
    'assistantChars',
    'includeToolOutput',
    'minChars',
    'skipPatterns',
    'privacy',
    'useDefaultPatterns',
    'denyPatterns',
    'redactEmails',
    'redactPaths',
    'extractor',
    'transport',
    'useCurrentModel',
    'provider',
    'reasoningEffort',
    'baseUrl',
    'path',
    'model',
    'apiKeyEnv',
    'apiKey',
    'maxOutputTokens',
    'temperature',
    'timeoutMs',
    'maxEpisodesPerRun',
    'retrieval',
    'limit',
    'hops',
    'snippetChars',
    'timelineLimit',
  ]
  const missing = names.filter((name) => !text.includes(`"${name}"`))
  assert.deepEqual(missing, [])
})

check('a distilling config round-trips from the form into the runtime', () => {
  const runtime = resolveConfig(Config({ extractor: { enabled: true, transport: 'harness', reasoningEffort: 'high' } }))
  assert.equal(runtime.extractor.enabled, true)
  assert.equal(runtime.extractor.transport, 'harness')
  assert.equal(runtime.extractor.reasoningEffort, 'high')
})

// ---------------------------------------------------------------------------
// The volatile / structural split
// ---------------------------------------------------------------------------

const leaves = schemaLeaves(Config)
const live = leaves.filter((leaf) => leaf.node.meta?.volatile === true)
const structural = leaves.filter((leaf) => leaf.node.meta?.volatile !== true)

check('the live knobs are volatile, which is the only thing 设置 can write', () => {
  // `volatileForm()` in dsh-settings returns undefined unless some leaf is
  // volatile, and an undefined form means the entry does not appear in 设置 at
  // all — this is the check that would have caught the empty settings page.
  assert.equal(
    live.length,
    spec.paths.length,
    `expected one volatile leaf per page field, found ${live.length} live leaves for ${spec.paths.length} fields`,
  )
  assert.equal(
    structural.length,
    4,
    `only enabled / vaultDir / defaultProject / crossProject stay ordinary, found ${structural.length}`,
  )
  assert.deepEqual(
    live.map((leaf) => leaf.path).sort(),
    [...spec.paths].sort(),
    'the page and the schema must serve the same live fields',
  )
})

check('the structural knobs stay ordinary so a change remounts the plugin', () => {
  // They are consumed while activating (register tools, mkdir the vault, tag the
  // session). A live write could not take effect, so they must not be volatile —
  // and the page must say so instead of offering a switch that does nothing.
  assert.deepEqual(structural.map((leaf) => leaf.path).sort(), ['crossProject', 'defaultProject', 'enabled', 'vaultDir'])
  for (const knob of spec.structural) {
    assert.ok(!spec.paths.includes(knob), `${knob} is structural and must not be on the Settings page`)
  }
})

check('the page agrees with the schema about numbers', () => {
  const byPath = new Map(leaves.map((leaf) => [leaf.path, leaf.node]))
  for (const section of spec.sections) {
    for (const field of section.fields) {
      const node = byPath.get(field.path.join('.'))
      assert.ok(node, `page field ${field.path.join('.')} is not in the schema`)
      if (field.type !== 'number') continue
      const bounds = node.meta ?? {}
      assert.equal(field.min, bounds.min, `${field.path.join('.')}: page min disagrees with the schema`)
      assert.equal(field.max, bounds.max, `${field.path.join('.')}: page max disagrees with the schema`)
    }
  }
})

check('every page field is rendered from something the form serves', () => {
  const seen = new Set()
  for (const section of spec.sections) {
    for (const field of section.fields) {
      const key = field.path.join('.')
      assert.ok(!seen.has(key), `${key} is rendered twice`)
      assert.ok(field.label, `${key} has no label`)
      seen.add(key)
    }
  }
  assert.equal(seen.size, spec.paths.length)
})

console.log(process.exitCode === 1 ? '\nSOME CHECKS FAILED' : `\nall ${passed} checks passed`)
