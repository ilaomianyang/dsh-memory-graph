/**
 * Settings-form schema checks.
 *
 * The harness renders a plugin's Settings form straight from the `Config` schema
 * it exports, so the schema is part of the public surface. Two kinds of rot are
 * possible and both are silent: a field added to `src/config.js` but not to the
 * form (invisible setting), and a default that disagrees between the form and
 * the runtime (the form shows one thing, the plugin does another).
 *
 * The drift check below walks every leaf of the schema defaults and demands the
 * same value from `resolveConfig({})`, so adding a field in only one place fails
 * here instead of shipping.
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { Config } from '../src/schema.js'
import { DEFAULT_SKIP_PATTERNS, resolveConfig } from '../src/config.js'

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

const at = (object, dotted) => dotted.split('.').reduce((node, key) => node?.[key], object)

console.log('schema')

const defaults = Config({})

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
  assert.equal(Config({ extractor: { transport: 'http' } }).extractor.transport, 'http')
  assert.equal(Config({ extractor: { transport: 'harness' } }).extractor.transport, 'harness')
  assert.throws(() => Config({ extractor: { transport: 'openai' } }))
})

check('numeric bounds reject what the runtime would silently clamp', () => {
  assert.throws(() => Config({ extractor: { maxOutputTokens: 3000.5 } }), /256|multiple|step/)
  assert.throws(() => Config({ retrieval: { hops: 3 } }))
  // Values the runtime accepts must be accepted by the form too, or the form
  // cannot express a config the plugin supports.
  assert.equal(Config({ extractor: { maxOutputTokens: 3000 } }).extractor.maxOutputTokens, 3000)
  assert.equal(Config({ retrieval: { hops: 2 } }).retrieval.hops, 2)
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

console.log(process.exitCode === 1 ? '\nSOME CHECKS FAILED' : `\nall ${passed} checks passed`)
