import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const clientPath = fileURLToPath(new URL('../client.js', import.meta.url))
const clientSource = readFileSync(clientPath, 'utf8')
const original = '原始草稿'
const rewritten = '保留原意的清楚草稿'
const changedWarning = '改写期间草稿发生了变化：请检查插入的改写结果，再决定是否发送。'
const insertionFailure = '改写结果没有写入输入框，当前内容已保留。'
const settingsKey = 'dsh-human-readable.settings.v1'

// These are write-back contract mocks, not a React renderer or browser proof.
// State updates persist, but renders are explicit; effects run after each render
// and their cleanups run on dependency changes/unmount. No reconciliation,
// StrictMode, concurrent scheduling, DOM events, or real editor is simulated.
function hookMock() {
  const cells = []
  const updatesAfterUnmount = []
  let cursor = 0
  let effects = []
  let unmounted = false
  function cell(kind, initialize) {
    const index = cursor++
    if (!cells[index]) cells[index] = { kind, ...initialize() }
    assert.equal(cells[index].kind, kind)
    return cells[index]
  }
  const React = {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({
      type,
      props: { ...props, children: children.flatMap((child) => Array.isArray(child) ? child.flat(Infinity) : [child]) },
    }),
    useRef: (value) => cell('ref', () => ({ current: value })),
    useState(initial) {
      const state = cell('state', () => ({ value: typeof initial === 'function' ? initial() : initial }))
      return [state.value, (next) => {
        if (unmounted) {
          updatesAfterUnmount.push(next)
          return
        }
        state.value = typeof next === 'function' ? next(state.value) : next
      }]
    },
    useEffect(effect, dependencies) {
      const state = cell('effect', () => ({}))
      if (!state.dependencies || !dependencies || dependencies.length !== state.dependencies.length ||
          dependencies.some((value, index) => !Object.is(value, state.dependencies[index]))) {
        effects.push(() => {
          state.cleanup?.()
          state.dependencies = dependencies
          state.cleanup = effect()
        })
      }
    },
  }
  return {
    React,
    updatesAfterUnmount,
    render(Component, props) {
      assert.equal(unmounted, false, 'cannot render an unmounted component')
      cursor = 0
      effects = []
      const tree = Component(props)
      for (const effect of effects) effect()
      return tree
    },
    unmount() {
      if (unmounted) return
      unmounted = true
      for (const state of cells) state.cleanup?.()
    },
  }
}

function clockMock() {
  let now = 0
  let nextId = 0
  const timers = new Map()
  return {
    setTimeout(callback, delay) {
      const id = ++nextId
      timers.set(id, { callback, at: now + delay })
      return id
    },
    clearTimeout: (id) => timers.delete(id),
    clear: () => timers.clear(),
    advance(milliseconds) {
      const end = now + milliseconds
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        const [id, timer] = next
        now = timer.at
        timers.delete(id)
        timer.callback()
      }
      now = end
    },
  }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function response(body, status = 200) {
  return { status, ok: status >= 200 && status < 300, json: async () => body }
}

const success = (text = rewritten, form) => ({ ok: true, value: { text, ...(form ? { form } : {}) } })

function elements(tree) {
  if (!tree || typeof tree !== 'object') return []
  return [tree, ...(tree.props?.children || []).flatMap(elements)]
}

function textOf(tree) {
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree)
  return (tree?.props?.children || []).map(textOf).join('')
}

function mount(t, {
  draft = original,
  snapshotKey = 'text',
  writers = ['setDraft', 'setText'],
  acceptInsertion = true,
  locale = 'zh-CN',
  storedSettings = null,
  storageError = false,
  blank = false,
} = {}) {
  const hooks = hookMock()
  const settingsHooks = hookMock()
  let currentHooks = hooks
  const clock = clockMock()
  const registrations = new Map()
  const disposers = []
  const requests = []
  const writes = []
  const captures = []
  const insertions = []
  const unexpectedActions = []
  const storageWrites = []
  const listeners = new Map()
  let storageValue = storedSettings
  let currentDraft = draft
  let sessionBlank = blank
  let plugin
  let tree
  let settingsTree
  const React = new Proxy(hooks.React, {
    get: (_target, name) => currentHooks.React[name],
  })

  vm.runInNewContext(clientSource, {
    window: { __ModuleLoader__: { load(module) {
      assert.equal(module.id, '@local/dsh-human-readable')
      assert.equal(plugin, undefined, 'load the real factory once')
      plugin = module.factory((name) => {
        assert.equal(name, 'react', 'no extra runtime dependencies')
        return React
      })
    } } },
    navigator: { language: locale },
    localStorage: {
      getItem(key) {
        assert.equal(key, settingsKey)
        if (storageError) throw new Error('storage unavailable')
        return storageValue
      },
      setItem(key, value) {
        assert.equal(key, settingsKey)
        if (storageError) throw new Error('storage unavailable')
        storageValue = value
        storageWrites.push(JSON.parse(value))
      },
    },
    document: {
      activeElement: null,
      addEventListener(type, callback) {
        if (!listeners.has(type)) listeners.set(type, new Set())
        listeners.get(type).add(callback)
      },
      removeEventListener(type, callback) { listeners.get(type)?.delete(callback) },
    },
    console: { info() {}, error() {} },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    fetch(url, options) {
      const pending = deferred()
      requests.push({ url, options, ...pending })
      return pending.promise
    },
  }, { filename: clientPath })

  plugin.apply({
    locale: { getSnapshot: () => ({ active: locale }), subscribe: () => () => {} },
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    slots: {
      inject: (_name, callback) => callback(),
      register(metadata, Component) {
        registrations.set(metadata.name, Component)
        return () => registrations.delete(metadata.name)
      },
    },
  })
  const Component = registrations.get('conversation.input.right')
  assert.equal(typeof Component, 'function', 'obtain the button only through slot registration')
  const Settings = registrations.get('settings.section')
  assert.equal(typeof Settings, 'function')
  const actions = {
    captureInsertion() {
      const token = { offset: currentDraft.length }
      captures.push({ draft: currentDraft, token })
      return token
    },
    insertText(text, token) {
      insertions.push({ text, token })
      if (!acceptInsertion) return false
      // Model an editor inserting at its captured caret, not replacing the draft.
      currentDraft = currentDraft.slice(0, token.offset) + text + currentDraft.slice(token.offset)
      return true
    },
  }
  for (const method of writers) {
    actions[method] = (text) => {
      writes.push({ method, text })
      currentDraft = text
    }
  }
  const writerNames = new Set(['setDraft', 'setText', 'captureInsertion', 'insertText'])
  const props = {
    sessionId: 'test-session',
    useInput: (selector) => selector({ [snapshotKey]: currentDraft }),
    useSession: (selector) => selector({ blank: sessionBlank }),
    // All non-writer action calls (including any send/submit API) are recorded,
    // without assuming or adding a particular production send API name.
    inputActions: new Proxy(actions, {
      get(target, name) {
        if (writerNames.has(name)) return target[name]
        return (...args) => unexpectedActions.push({ name, args })
      },
    }),
  }
  const harness = {
    requests, writes, captures, insertions, unexpectedActions, storageWrites,
    updatesAfterUnmount: hooks.updatesAfterUnmount,
    get draft() { return currentDraft },
    get storedSettings() { return storageValue === null ? null : JSON.parse(storageValue) },
    get button() {
      return elements(tree).find((node) => node.type === 'button' && node.props.className === 'dhr-button').props
    },
    get notice() {
      const alert = elements(tree).find((node) => node.props?.role === 'alert')
      return alert ? textOf(alert) : null
    },
    get renderedText() { return textOf(tree) },
    get settingsTree() { return settingsTree },
    get settingsText() { return textOf(settingsTree) },
    get settingRows() { return settingsTree.props.children.filter((node) => node?.props?.key !== 'head') },
    get shortcutButton() {
      return elements(settingsTree).find((node) => node.type === 'button' && node.props.key === 'record')?.props
    },
    get clearShortcutButton() {
      return elements(settingsTree).find((node) => node.type === 'button' && node.props.key === 'clear')?.props
    },
    render() { tree = hooks.render(Component, props) },
    renderSettings() {
      currentHooks = settingsHooks
      try { settingsTree = settingsHooks.render(Settings, {}) }
      finally { currentHooks = hooks }
    },
    keydown(event) {
      const delivered = { ...event, defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true }, stopPropagation() { this.stopped = true } }
      for (const callback of [...(listeners.get('keydown') || [])]) callback(delivered)
      return delivered
    },
    editDraft(text) { currentDraft = text; harness.render() },
    setBlank(value) { sessionBlank = value; harness.render() },
    advance(milliseconds) { clock.advance(milliseconds); harness.render() },
    unmount() { hooks.unmount(); settingsHooks.unmount() },
  }
  t.after(() => {
    harness.unmount()
    for (const dispose of disposers.reverse()) dispose()
    clock.clear()
    assert.deepEqual(unexpectedActions, [], 'never invoke non-writer/send actions')
    assert.deepEqual(hooks.updatesAfterUnmount, [], 'never set state after unmount')
    assert.deepEqual(settingsHooks.updatesAfterUnmount, [], 'never update settings after unmount')
  })
  harness.render()
  return harness
}

async function finish(harness, pending, reply = success(), status = 200) {
  assert.equal(harness.requests.length, 1)
  harness.requests[0].resolve(response(reply, status))
  await pending
  harness.render()
}

function assertNoWrite(harness) {
  assert.deepEqual(harness.writes, [])
  assert.deepEqual(harness.captures, [])
  assert.deepEqual(harness.insertions, [])
}

function assertRewriteOnly(harness, sentDraft) {
  assert.equal(harness.requests.length, 1, 'no extra fetch to a send endpoint')
  assert.equal(harness.requests[0].url, 'dsh-human-readable/rewrite')
  assert.equal(harness.requests[0].options.method, 'POST')
  const payload = JSON.parse(harness.requests[0].options.body)
  assert.equal(payload.sessionId, 'test-session')
  assert.equal(payload.draft, sentDraft)
  assert.deepEqual(Object.keys(payload).sort(), ['draft', 'sessionId'],
    'the client must not send retired user budget settings')
  assert.deepEqual(harness.unexpectedActions, [], 'no send/submit action was called')
}

for (const { locale, shortcutLabel, modelLabel } of [
  { locale: 'zh-CN', shortcutLabel: '快捷键', modelLabel: '跟随当前会话' },
  { locale: 'en-US', shortcutLabel: 'Shortcut', modelLabel: 'Current session' },
]) {
  test(`${locale} settings contain only shortcut controls and the model-following explanation`, (t) => {
    const h = mount(t, { locale })
    h.renderSettings()
    assert.deepEqual(h.settingRows.map((row) => row.props.key), ['shortcut', 'model'])
    assert.equal(elements(h.settingsTree).filter((node) => node.type === 'input').length, 0)
    assert.doesNotMatch(h.settingsText, /上下文轮数|token|Context turns/i)
    assert.match(h.settingsText, new RegExp(shortcutLabel))
    assert.match(h.settingsText, new RegExp(modelLabel))
    assert.match(textOf(h.settingRows.find((row) => row.props.key === 'shortcut')), /Alt\+H/)
    assert.deepEqual(h.storageWrites, [], 'rendering alone does not migrate or rewrite storage')
  })
}

for (const shortcut of ['ctrl+shift+k', 'cmd+alt+r', '']) {
  test(`retired numeric settings are removed while preserving shortcut ${JSON.stringify(shortcut)}`, async (t) => {
    const h = mount(t, { storedSettings: JSON.stringify({
      rounds: 0, contextTokens: 200, migratedContextTokens: true, shortcut,
    }) })
    assert.deepEqual(h.storedSettings, { shortcut })
    assert.deepEqual(h.storageWrites, [{ shortcut }])
    h.renderSettings()
    assert.match(textOf(h.settingRows.find((row) => row.props.key === 'shortcut')),
      shortcut === '' ? /未设置/ : new RegExp(shortcut.split('+').map((part) => part[0].toUpperCase() + part.slice(1)).join('\\+')))
    const pending = h.button.onClick()
    await finish(h, pending)
    assertRewriteOnly(h, original)
    assert.deepEqual(h.storedSettings, { shortcut })
    assert.equal(h.storageWrites.length, 1, 'subsequent reads do not repeat the migration')
  })
}

test('legacy settings without a shortcut retain Alt+H and remove numeric fields', (t) => {
  const h = mount(t, { storedSettings: JSON.stringify({ rounds: 2, contextTokens: 1500 }) })
  assert.deepEqual(h.storedSettings, { shortcut: 'alt+h' })
  h.renderSettings()
  assert.match(textOf(h.settingRows.find((row) => row.props.key === 'shortcut')), /Alt\+H/)
})

test('malformed or unavailable settings storage uses the default without numeric request fields', async (t) => {
  for (const options of [{ storedSettings: '{' }, { storageError: true }]) {
    await t.test(options.storageError ? 'unavailable' : 'malformed', async (t) => {
      const h = mount(t, options)
      h.renderSettings()
      assert.match(textOf(h.settingRows.find((row) => row.props.key === 'shortcut')), /Alt\+H/)
      const pending = h.button.onClick()
      await finish(h, pending)
      assertRewriteOnly(h, original)
    })
  }
})

test('recording and clearing a shortcut persists only the shortcut', (t) => {
  const h = mount(t, { storedSettings: JSON.stringify({ rounds: 1, contextTokens: 500, shortcut: 'alt+h' }) })
  h.renderSettings()
  h.shortcutButton.onClick()
  h.renderSettings()
  const recorded = h.keydown({ key: 'K', ctrlKey: true, shiftKey: true })
  assert.equal(recorded.defaultPrevented, true)
  assert.equal(recorded.stopped, true)
  assert.deepEqual(h.storedSettings, { shortcut: 'ctrl+shift+k' })
  h.renderSettings()
  assert.match(h.settingsText, /Ctrl\+Shift\+K/)
  h.clearShortcutButton.onClick()
  h.renderSettings()
  assert.deepEqual(h.storedSettings, { shortcut: '' })
  assert.equal(h.clearShortcutButton, undefined)
  assert.match(h.settingsText, /未设置/)
})

for (const draft of ['', ' \t\n ']) {
  test(`empty/whitespace draft ${JSON.stringify(draft)} is disabled and does not fetch`, async (t) => {
    const h = mount(t, { draft })
    assert.equal(h.button.disabled, true)
    // Calling even the disabled button's handler must remain a no-op.
    await h.button.onClick()
    h.render()
    assert.deepEqual(h.requests, [])
    assertNoWrite(h)
    assert.equal(h.draft, draft)
    assert.equal(h.notice, null)
  })
}

test('a blank session disables the button, explains why, and ignores the shortcut', async (t) => {
  const h = mount(t, { blank: true })
  assert.equal(h.button.disabled, true)
  assert.match(h.button.title, /先发一条消息/)
  const blocked = h.keydown({ key: 'h', altKey: true })
  assert.equal(blocked.defaultPrevented, false, 'the shortcut must not run without context')
  await h.button.onClick()
  h.render()
  assert.deepEqual(h.requests, [])
  assertNoWrite(h)
  assert.equal(h.draft, original)
})

test('the no-context gate lifts after the first message is sent', async (t) => {
  const h = mount(t, { blank: true })
  assert.equal(h.button.disabled, true)
  h.setBlank(false)
  assert.equal(h.button.disabled, false)
  assert.doesNotMatch(h.button.title, /先发一条消息/)
  const pending = h.button.onClick()
  await finish(h, pending)
  assert.deepEqual(h.writes, [{ method: 'setDraft', text: rewritten }])
})

test('an empty draft keeps its own disabled reason on a blank session', (t) => {
  const h = mount(t, { blank: true, draft: '   ' })
  assert.equal(h.button.disabled, true)
  assert.match(h.button.title, /先写点什么/)
})

test('two clicks from the same render share the in-flight guard and fetch once', async (t) => {
  const h = mount(t)
  const onClick = h.button.onClick
  const first = onClick()
  const second = onClick() // No intervening render: busy in this closure is still false.
  assert.equal(h.requests.length, 1)
  await second
  h.render()
  assert.equal(h.button.disabled, true)
  assertNoWrite(h)
  await finish(h, first)
  assert.deepEqual(h.writes, [{ method: 'setDraft', text: rewritten }])
  assert.equal(h.button.disabled, false)
  assertRewriteOnly(h, original)
})

for (const { method, writers, snapshotKey } of [
  { method: 'setDraft', writers: ['setDraft', 'setText'], snapshotKey: 'text' },
  { method: 'setText', writers: ['setText'], snapshotKey: 'draft' },
]) {
  test(`unchanged draft writes once with ${method}, without sending`, async (t) => {
    const h = mount(t, { writers, snapshotKey })
    const pending = h.button.onClick()
    await finish(h, pending, success(` \n${rewritten}\t `))
    assert.deepEqual(h.writes, [{ method, text: rewritten }])
    assert.deepEqual(h.captures, [])
    assert.deepEqual(h.insertions, [])
    assert.equal(h.draft, rewritten)
    assert.equal(h.button.disabled, false)
    assert.equal(h.notice, null)
    h.advance(800) // The mock writer's new snapshot has been explicitly rendered.
    assert.equal(h.notice, null, 'successful write is not reported as an insertion failure')
    assert.equal(h.writes.length, 1)
    assertRewriteOnly(h, original)
  })
}

test('identical trimmed output writes nothing but explains that the draft already stands alone', async (t) => {
  const draft = ` \t${original}\n `
  const h = mount(t, { draft })
  const pending = h.button.onClick()
  await finish(h, pending, success(`\n${original}  `, 'unchanged'))
  h.advance(800)
  assertNoWrite(h)
  assert.equal(h.draft, draft, 'even the original surrounding whitespace is preserved')
  assert.match(h.notice, /草稿已经能独立看懂，未改动/)
  assert.equal(h.button.disabled, false)
  assertRewriteOnly(h, draft)
})

test('an identical rewrite after the draft changed is still reported, not silent', async (t) => {
  const h = mount(t)
  const pending = h.button.onClick()
  const newDraft = '等待时新写的内容'
  h.editDraft(newDraft)
  await finish(h, pending, success(original, 'unchanged'))
  assert.equal(h.draft, newDraft)
  assert.match(h.notice, /草稿已变化，这次结果没有写入/)
  assertNoWrite(h)
})

test('an unchanged result without the form marker reports that no rewrite was produced', async (t) => {
  const h = mount(t)
  const pending = h.button.onClick()
  await finish(h, pending, success(original))
  h.advance(800)
  assertNoWrite(h)
  assert.match(h.notice, /没有生成改写，草稿已保留/)
})

test('editing while waiting captures the current insertion and never replaces the new draft', async (t) => {
  const h = mount(t)
  const pending = h.button.onClick()
  const newDraft = '等待时新写的内容：'
  h.editDraft(newDraft)
  assert.deepEqual(h.captures, [], 'capture happens after the reply, not at request start')
  await finish(h, pending)
  assert.deepEqual(h.writes, [], 'neither replacement writer may overwrite the new draft')
  assert.equal(h.captures.length, 1)
  assert.equal(h.captures[0].draft, newDraft)
  assert.equal(h.insertions.length, 1)
  assert.equal(h.insertions[0].text, rewritten)
  assert.equal(h.insertions[0].token, h.captures[0].token, 'pass through the captured token unchanged')
  assert.equal(h.draft, newDraft + rewritten)
  assert.equal(h.notice, changedWarning)
  assertRewriteOnly(h, original)
})

test('without replacement writers an unchanged draft uses the existing insertion fallback', async (t) => {
  const h = mount(t, { writers: [] })
  const pending = h.button.onClick()
  await finish(h, pending)
  assert.deepEqual(h.writes, [])
  assert.equal(h.captures.length, 1)
  assert.equal(h.insertions.length, 1)
  assert.equal(h.insertions[0].token, h.captures[0].token)
  assert.equal(h.draft, original + rewritten)
  assert.equal(h.notice, null, 'unchanged-draft fallback has no changed-draft warning')
  assertRewriteOnly(h, original)
})

for (const changed of [false, true]) {
  test(`rejected insertion preserves ${changed ? 'the new draft' : 'the original draft without setters'}`, async (t) => {
    const h = mount(t, { writers: changed ? ['setDraft', 'setText'] : [], acceptInsertion: false })
    const pending = h.button.onClick()
    const preserved = changed ? '刚修改的新草稿' : original
    if (changed) h.editDraft(preserved)
    await finish(h, pending)
    assert.equal(h.draft, preserved)
    assert.deepEqual(h.writes, [], 'do not fall back to replacement after insertText returns false')
    assert.equal(h.captures.length, 1)
    assert.equal(h.insertions.length, 1)
    assert.equal(h.insertions[0].token, h.captures[0].token)
    assert.equal(h.notice, insertionFailure)
    assert.equal(h.button.disabled, false)
  })
}

for (const failure of [
  { name: 'model ok:false', body: { ok: false, error: { message: '模型拒绝改写' } }, status: 200, notice: '模型拒绝改写' },
  { name: 'HTTP 401', status: 401, notice: '登录状态失效，刷新页面后再试' },
  { name: 'HTTP 403 with an edited draft', status: 403, notice: '登录状态失效，刷新页面后再试', changed: true },
  { name: 'HTTP 500', status: 500, notice: 'HTTP 500' },
  { name: 'fetch promise rejection with an edited draft', network: true, changed: true },
]) {
  test(`${failure.name} preserves the draft and does not write`, async (t) => {
    const h = mount(t)
    const pending = h.button.onClick()
    const preserved = failure.changed ? '请求期间修改后的草稿' : original
    if (failure.changed) h.editDraft(preserved)
    if (failure.network) {
      h.requests[0].reject(new Error('network unavailable'))
      await pending
      h.render()
      assert.match(h.notice, /network unavailable/)
    } else {
      // A valid success body on a rejected HTTP response must still never write.
      await finish(h, pending, failure.body || success(), failure.status)
      assert.equal(h.notice, failure.notice)
    }
    assert.equal(h.draft, preserved)
    assertNoWrite(h)
    assert.equal(h.button.disabled, false)
  })
}

for (const stage of ['fetch', 'response.json']) {
  test(`unmount while awaiting ${stage} prevents all write-back and state updates`, async (t) => {
    const h = mount(t)
    const pending = h.button.onClick()
    let resolveReply
    if (stage === 'response.json') {
      const body = deferred()
      const enteredJson = deferred()
      h.requests[0].resolve({
        status: 200,
        ok: true,
        json() { enteredJson.resolve(); return body.promise },
      })
      await enteredJson.promise // A deterministic barrier, not a guessed microtask delay.
      resolveReply = () => body.resolve(success())
    } else {
      resolveReply = () => h.requests[0].resolve(response(success()))
    }
    h.unmount()
    resolveReply()
    await pending
    assert.equal(h.draft, original)
    assertNoWrite(h)
    assert.deepEqual(h.updatesAfterUnmount, [])
    assertRewriteOnly(h, original)
  })
}
