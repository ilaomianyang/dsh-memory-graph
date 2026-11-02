/**
 * Client-page checks.
 *
 * `client.js` is the Settings page: it registers a `settings.section`, reads the
 * served form through `configForms`, and turns edits into path operations. None
 * of that is reachable from the harness test runner — the browser bundle needs a
 * DOM and React — so this file mounts the component under a small React
 * stand-in and drives it the way a click would.
 *
 * What it is worth: the write contract. A page that renders but wires the wrong
 * path, drops a knob, or sends a value the host rejects looks perfectly fine on
 * screen. These checks assert the exact operations that leave the page.
 */
import assert from 'node:assert/strict'

await import('../client.js')

const client = globalThis.__memoryGraphClient
const spec = globalThis.__memoryGraphFormSpec

let passed = 0
const check = async (name, fn) => {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    console.log(`  FAIL ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

// ---------------------------------------------------------------------------
// A React just big enough for one component with useState/useRef/useEffect
// ---------------------------------------------------------------------------

const createReact = () => {
  let current = null
  const react = {
    createElement(type, props, ...children) {
      const flat = []
      const push = (child) => {
        if (Array.isArray(child)) {
          for (const item of child) push(item)
          return
        }
        if (child === null || child === undefined || typeof child === 'boolean') return
        flat.push(child)
      }
      for (const child of children) push(child)
      return { type, props: props || {}, children: flat }
    },
    useState(initial) {
      return current.useState(initial)
    },
    useRef(initial) {
      return current.useRef(initial)
    },
    useEffect(fn, deps) {
      return current.useEffect(fn, deps)
    },
  }
  return { react, bind: (instance) => { current = instance } }
}

const mount = (Component, runtime = createReact()) => {
  const instance = {
    runtime,
    hooks: [],
    cursor: 0,
    tree: null,
    dirty: false,
    flushing: false,
    pending: [],
    useState(initial) {
      const index = this.cursor++
      if (!(index in this.hooks)) {
        this.hooks[index] = { kind: 'state', value: typeof initial === 'function' ? initial() : initial }
      }
      const hook = this.hooks[index]
      const set = (next) => {
        const value = typeof next === 'function' ? next(hook.value) : next
        if (Object.is(value, hook.value)) return
        hook.value = value
        this.dirty = true
        if (!this.flushing) this.flush()
      }
      return [hook.value, set]
    },
    useRef(initial) {
      const index = this.cursor++
      if (!(index in this.hooks)) this.hooks[index] = { kind: 'ref', current: initial }
      return this.hooks[index]
    },
    useEffect(fn, deps) {
      const index = this.cursor++
      const previous = this.hooks[index]
      const changed =
        !previous ||
        !deps ||
        !previous.deps ||
        deps.length !== previous.deps.length ||
        deps.some((dep, at) => !Object.is(dep, previous.deps[at]))
      if (changed) {
        const hook = { kind: 'effect', deps, fn, cleanup: previous ? previous.cleanup : undefined }
        this.hooks[index] = hook
        this.pending.push(hook)
      }
    },
    render() {
      runtime.bind(this)
      this.cursor = 0
      this.pending = []
      this.tree = Component()
      const effects = this.pending
      this.pending = []
      for (const effect of effects) {
        if (typeof effect.cleanup === 'function') effect.cleanup()
        const cleanup = effect.fn()
        effect.cleanup = typeof cleanup === 'function' ? cleanup : undefined
      }
    },
    flush() {
      if (this.flushing) return
      this.flushing = true
      let guard = 0
      try {
        do {
          this.dirty = false
          this.render()
        } while (this.dirty && ++guard < 40)
      } finally {
        this.flushing = false
      }
    },
    act(fn) {
      fn()
      this.flush()
    },
    /** Let a queued write settle, then redraw with its answer. */
    async settle() {
      await new Promise((resolve) => setTimeout(resolve, 0))
      this.flush()
    },
    unmount() {
      for (const hook of this.hooks) {
        if (hook && hook.kind === 'effect' && typeof hook.cleanup === 'function') hook.cleanup()
      }
    },
  }
  instance.flush()
  return instance
}

// ---------------------------------------------------------------------------
// A stand-in for the settings service
// ---------------------------------------------------------------------------

const makeForm = (value, options = {}) => {
  const listeners = new Set()
  const calls = []
  return {
    snapshot: {
      status: options.status || 'ready',
      value,
      base: value,
      user: options.user || {},
      revision: 1,
      writable: options.writable !== false,
    },
    calls,
    getSnapshot() {
      return this.snapshot
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    mutate(ops, revision) {
      calls.push({ ops, revision })
      return Promise.resolve(options.accept !== false)
    },
    patch(next) {
      this.snapshot = { ...this.snapshot, ...next }
      for (const listener of listeners) listener()
    },
  }
}

const makeCtx = (form) => ({
  get: (name) =>
    name === 'configForms'
      ? {
          get: () => form,
          describe: () => ({
            getSnapshot: () => ({ status: 'ready', view: { namespaces: [{ ns: 'memory-graph' }] } }),
          }),
        }
      : undefined,
  slots: { inject() {}, register() {} },
  fiber: { entry: { id: 'client:memory-graph' } },
})

/** Mount the page over one form controller. */
const render = (form) => {
  const runtime = createReact()
  const Page = client.createPage(makeCtx(form), runtime.react)
  return mount(Page, runtime)
}

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------

const walk = (node, visit) => {
  if (!node || typeof node !== 'object') return
  visit(node)
  for (const child of node.children || []) walk(child, visit)
}

const nodes = (tree) => {
  const out = []
  walk(tree, (node) => out.push(node))
  return out
}

const control = (tree, key) => nodes(tree).find((node) => node.props && node.props['data-field'] === key)
const row = (tree, key) => nodes(tree).find((node) => node.props && node.props['data-path'] === key)
const byClass = (tree, name) =>
  nodes(tree).filter(
    (node) => typeof (node.props && node.props.className) === 'string' && node.props.className.split(' ').includes(name),
  )
const text = (node) => {
  if (typeof node === 'string') return node
  if (!node || typeof node !== 'object') return ''
  return (node.children || []).map(text).join('')
}

const saveButton = (tree) => byClass(tree, 'mg-btn')[0]
const barText = (tree) => text(byClass(tree, 'mg-msg')[0])

/** What a fresh install serves. */
const SERVED = {
  enabled: true,
  vaultDir: '',
  defaultProject: 'shared',
  crossProject: true,
  capture: {
    enabled: true,
    userChars: 1500,
    assistantChars: 1500,
    includeToolOutput: false,
    minChars: 12,
    skipPatterns: ['^Compacted', 'runtime context'],
  },
  privacy: { useDefaultPatterns: true, denyPatterns: [], redactEmails: true, redactPaths: true },
  extractor: {
    enabled: false,
    transport: 'harness',
    useCurrentModel: true,
    provider: '',
    reasoningEffort: '',
    baseUrl: '',
    path: '',
    model: '',
    apiKeyEnv: '',
    apiKey: '',
    maxOutputTokens: 8000,
    temperature: 0.2,
    timeoutMs: 120000,
    maxEpisodesPerRun: 40,
  },
  retrieval: { limit: 8, hops: 1, snippetChars: 320, timelineLimit: 20 },
}

const clone = (value) => JSON.parse(JSON.stringify(value))
const visibleFields = (value) => spec.sections.flatMap((section) => section.fields.filter((field) => !field.visible || field.visible(value)))

console.log('client')

await check('the page renders every knob the served value makes visible', () => {
  const instance = render(makeForm(clone(SERVED)))
  try {
    const expected = visibleFields(SERVED)
    // The harness route hides the seven http-only knobs and the provider field.
    assert.equal(expected.length, 21, `expected 21 visible fields, spec says ${expected.length}`)
    for (const field of expected) {
      const key = field.path.join('.')
      assert.ok(control(instance.tree, key), `${key} has no control on the page`)
      assert.ok(row(instance.tree, key), `${key} has no row on the page`)
    }
    assert.equal(byClass(instance.tree, 'mg-card').length, spec.sections.length)
    // Nothing about the page is a structural knob.
    for (const key of spec.structural) assert.equal(row(instance.tree, key), undefined, `${key} must not be on the page`)
  } finally {
    instance.unmount()
  }
})

await check('the four sections are all there, each with a title', () => {
  const instance = render(makeForm(clone(SERVED)))
  try {
    const titles = byClass(instance.tree, 'mg-card-t').map(text)
    assert.equal(titles.length, 4)
    for (const title of titles) assert.ok(title.length > 0)
  } finally {
    instance.unmount()
  }
})

await check('a switch renders the served value, not the default', () => {
  const value = clone(SERVED)
  value.capture.enabled = false
  const instance = render(makeForm(value))
  try {
    assert.equal(control(instance.tree, 'capture.enabled').props['data-on'], 'false')
    assert.equal(control(instance.tree, 'privacy.redactEmails').props['data-on'], 'true')
  } finally {
    instance.unmount()
  }
})

await check('the http-only knobs appear only on the http route', () => {
  const value = clone(SERVED)
  const harness = render(makeForm(value))
  try {
    assert.equal(control(harness.tree, 'extractor.baseUrl'), undefined)
    assert.equal(control(harness.tree, 'extractor.apiKey'), undefined)
    assert.equal(control(harness.tree, 'extractor.provider'), undefined)
    assert.equal(control(harness.tree, 'extractor.reasoningEffort').props.value, '')
  } finally {
    harness.unmount()
  }

  const http = render(makeForm(value))
  try {
    const select = control(http.tree, 'extractor.transport')
    assert.equal(select.props.value, 'harness')
    http.act(() => select.props.onChange({ target: { value: 'http' } }))
    for (const key of ['extractor.baseUrl', 'extractor.apiKey', 'extractor.model', 'extractor.temperature', 'extractor.apiKeyEnv']) {
      assert.ok(control(http.tree, key), `${key} should be visible on the http route`)
    }
    // The inline key is a password field: a key must never sit in plain text.
    assert.equal(control(http.tree, 'extractor.apiKey').props.type, 'password')
    // Following the current model is a harness idea; provider stays hidden.
    assert.equal(control(http.tree, 'extractor.useCurrentModel'), undefined)
    assert.equal(control(http.tree, 'extractor.provider'), undefined)
  } finally {
    http.unmount()
  }
})

await check('nothing is dirty on arrival, so save is disabled', () => {
  const instance = render(makeForm(clone(SERVED)))
  try {
    assert.equal(saveButton(instance.tree).props.disabled, true)
    assert.equal(barText(instance.tree), '')
  } finally {
    instance.unmount()
  }
})

await check('a switch becomes one unsaved change and one path set', async () => {
  const form = makeForm(clone(SERVED))
  const instance = render(form)
  try {
    instance.act(() => control(instance.tree, 'capture.enabled').props.onClick())
    assert.equal(control(instance.tree, 'capture.enabled').props['data-on'], 'false')
    assert.equal(saveButton(instance.tree).props.disabled, false)
    assert.match(barText(instance.tree), /\b1\b/)

    instance.act(() => saveButton(instance.tree).props.onClick())
    await instance.settle()

    assert.equal(form.calls.length, 1)
    assert.deepEqual(form.calls[0].ops, [{ op: 'set', path: ['capture', 'enabled'], value: false }])
    // The revision is left to the controller: only it knows the latest one after
    // a write that raced with another tab.
    assert.equal(form.calls[0].revision, undefined)
    assert.equal(byClass(instance.tree, 'mg-msg')[0].props['data-kind'], 'ok')
    assert.ok(barText(instance.tree).length > 0, 'a save says so')
    assert.equal(saveButton(instance.tree).props.disabled, true, 'the bar clears after a save')
  } finally {
    instance.unmount()
  }
})

await check('a list knob is split on newlines and trimmed', async () => {
  const form = makeForm(clone(SERVED))
  const instance = render(form)
  try {
    const area = control(instance.tree, 'capture.skipPatterns')
    assert.equal(area.props.value, '^Compacted\nruntime context')
    instance.act(() => area.props.onChange({ target: { value: ' one \n\n two \n' } }))
    instance.act(() => saveButton(instance.tree).props.onClick())
    await instance.settle()
    assert.deepEqual(form.calls[0].ops, [{ op: 'set', path: ['capture', 'skipPatterns'], value: ['one', 'two'] }])
  } finally {
    instance.unmount()
  }
})

await check('a number the host would refuse never reaches the wire', async () => {
  const form = makeForm(clone(SERVED))
  const instance = render(form)
  try {
    instance.act(() => control(instance.tree, 'capture.userChars').props.onChange({ target: { value: '10' } }))
    instance.act(() => saveButton(instance.tree).props.onClick())
    await instance.settle()
    assert.equal(form.calls.length, 0)
    assert.equal(byClass(instance.tree, 'mg-msg')[0].props['data-kind'], 'error')
  } finally {
    instance.unmount()
  }
})

await check('a number typed as a string is sent as a number', async () => {
  const form = makeForm(clone(SERVED))
  const instance = render(form)
  try {
    instance.act(() => control(instance.tree, 'retrieval.limit').props.onChange({ target: { value: '12' } }))
    instance.act(() => saveButton(instance.tree).props.onClick())
    await instance.settle()
    assert.deepEqual(form.calls[0].ops, [{ op: 'set', path: ['retrieval', 'limit'], value: 12 }])
    assert.equal(typeof form.calls[0].ops[0].value, 'number')
  } finally {
    instance.unmount()
  }
})

await check('an override is badged and can be restored with an unset', async () => {
  const form = makeForm(clone(SERVED), { user: { capture: { enabled: true } } })
  const instance = render(form)
  try {
    const badges = () => byClass(row(instance.tree, 'capture.enabled'), 'mg-badge').map(text)
    assert.equal(badges().length, 1, 'an overridden value is badged even when unchanged')
    assert.equal(byClass(row(instance.tree, 'capture.enabled'), 'mg-link').length, 0)

    instance.act(() => control(instance.tree, 'capture.enabled').props.onClick())
    assert.equal(badges().length, 2, 'custom + unsaved')
    const link = byClass(row(instance.tree, 'capture.enabled'), 'mg-link')[0]
    assert.ok(link, 'a dirty override offers a restore')

    instance.act(() => link.props.onClick())
    await instance.settle()
    assert.deepEqual(form.calls[0].ops, [{ op: 'unset', path: ['capture', 'enabled'] }])
  } finally {
    instance.unmount()
  }
})

await check('an empty inline key is skipped instead of cleared', async () => {
  const value = clone(SERVED)
  value.extractor.transport = 'http'
  value.extractor.apiKey = ''
  const form = makeForm(value)
  const instance = render(form)
  try {
    // Touching it and leaving it blank must not write anything: a secret never
    // rides back from the host, so "" is "unchanged", not "delete".
    instance.act(() => control(instance.tree, 'extractor.apiKey').props.onChange({ target: { value: '' } }))
    instance.act(() => control(instance.tree, 'extractor.maxOutputTokens').props.onChange({ target: { value: '4000' } }))
    instance.act(() => saveButton(instance.tree).props.onClick())
    await instance.settle()
    assert.deepEqual(form.calls[0].ops, [{ op: 'set', path: ['extractor', 'maxOutputTokens'], value: 4000 }])
  } finally {
    instance.unmount()
  }
})

await check('a refused write is reported and the page re-reads', async () => {
  const form = makeForm(clone(SERVED), { accept: false })
  const instance = render(form)
  try {
    instance.act(() => control(instance.tree, 'privacy.redactPaths').props.onClick())
    instance.act(() => saveButton(instance.tree).props.onClick())
    await instance.settle()
    assert.equal(form.calls.length, 1)
    assert.equal(byClass(instance.tree, 'mg-msg')[0].props['data-kind'], 'error')
    // The draft is dropped so the next click cannot send a stale value.
    assert.equal(saveButton(instance.tree).props.disabled, true)
  } finally {
    instance.unmount()
  }
})

await check('a redraw from the host does not resurrect a stale draft', () => {
  const value = clone(SERVED)
  const form = makeForm(value)
  const instance = render(form)
  try {
    instance.act(() => control(instance.tree, 'capture.minChars').props.onChange({ target: { value: '40' } }))
    const next = clone(value)
    next.retrieval.limit = 5
    form.patch({ value: next })
    instance.flush()
    assert.equal(control(instance.tree, 'retrieval.limit').props.value, '5', 'a host value shows through')
    assert.equal(control(instance.tree, 'capture.minChars').props.value, '40', 'the unsaved edit survives')
  } finally {
    instance.unmount()
  }
})

await check('an unserved namespace explains itself instead of showing an empty form', () => {
  const instance = render(makeForm(undefined, { status: 'unavailable' }))
  try {
    assert.equal(byClass(instance.tree, 'mg-card').length, 0)
    const title = text(byClass(instance.tree, 'mg-state-t')[0])
    assert.ok(title.length > 0)
    const body = text(instance.tree)
    assert.ok(body.includes('memory-graph'), 'the panel names the entry id it looked for')
  } finally {
    instance.unmount()
  }
})

await check('a read-only host disables the save button', () => {
  const instance = render(makeForm(clone(SERVED), { writable: false }))
  try {
    instance.act(() => control(instance.tree, 'capture.enabled').props.onClick())
    assert.equal(saveButton(instance.tree).props.disabled, true)
    assert.equal(saveButton(instance.tree).props.onClick !== undefined, true)
  } finally {
    instance.unmount()
  }
})

await check('the stylesheet is one labelled <style> element', () => {
  const created = []
  const previous = globalThis.document
  globalThis.document = {
    head: { appendChild: (node) => created.push(node) },
    getElementById: (id) => created.find((node) => node.id === id) || null,
    createElement: () => ({ dataset: {}, textContent: '' }),
  }
  try {
    client.ensureStyle()
    client.ensureStyle()
    assert.equal(created.length, 1, 'a second mount reuses the element instead of adding another')
    const style = created[0]
    assert.equal(style.id, client.STYLE_ID)
    // Untagged styles are collected by the host into whichever package
    // materialises next and deleted on reload, which would strip this page.
    assert.equal(style.dataset.plugin, client.PACKAGE_NAME)
    assert.ok(style.textContent.includes('.mg-row'))
  } finally {
    globalThis.document = previous
  }
})

await check('the entry point is a plain bundle, not a module', async () => {
  // The loader evaluates the bundle as a script: a stray `export` is a syntax
  // error there, and `require` is the only dependency channel.
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  assert.ok(!/^\s*export\s/m.test(source), 'client.js must not use export statements')
  assert.ok(!/^\s*import\s/m.test(source), 'client.js must not use import statements')
  assert.ok(source.includes('window.__ModuleLoader__.load'), 'client.js must register through the module loader')
  assert.ok(source.includes("require('react')"), 'react comes from the frozen require table')
})

console.log(process.exitCode === 1 ? '\nSOME CHECKS FAILED' : `\nall ${passed} checks passed`)
