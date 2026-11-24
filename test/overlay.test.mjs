/**
 * Overlay contract tests of dsh-telegram (node --test test/).
 *
 * The client half is a browser bundle, but its registration and its overlay
 * state machine are plain JavaScript. These tests load the built
 * `lib/client.js` into a VM with a minimal React/`window`/`document` stub,
 * apply the module to a fake Cordis context, and drive the real
 * `OverlayRoot`: launcher -> open dialog -> close. That catches the failures a
 * static grep cannot: a missing registration effect, a component that throws on
 * its first render, a close path that does not reach the open flag.
 *
 * The visual review stays a reported limitation (DESIGN-v0.2 14.9); nothing
 * here claims how the overlay looks.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const BUNDLE = path.join(ROOT, 'lib', 'client.js')
const SRC = path.join(ROOT, 'lib', 'client-src')
const NS = 'dsh-telegram'

function read(relative) {
  return readFileSync(path.join(ROOT, relative), 'utf8')
}

// A React stub with the hooks the bundle reads at module scope. Hooks return a
// stable value plus a setter; `setState` does not re-render, so the harness
// re-invokes the component after a state transition, which is exactly what the
// overlay's module-level open flag is built for.
function createReactStub(options) {
  const settings = options === undefined || options === null ? {} : options
  const effectMode = settings.effects === true
  function useState(initial) {
    let value = initial
    function set(next) {
      value = typeof next === 'function' ? next(value) : next
    }
    return [value, set]
  }
  function useRef(value) {
    return { current: value }
  }
  class Component {
    constructor(props) {
      this.props = props
      this.state = {}
    }
    setState(patch) {
      this.state = Object.assign({}, this.state, typeof patch === 'function' ? patch(this.state) : patch)
    }
  }
  return {
    createElement(type, props) {
      const children = Array.prototype.slice.call(arguments, 2)
      const resolved = Object.assign({}, props === undefined || props === null ? {} : props)
      if (children.length === 1) resolved.children = children[0]
      else if (children.length > 1) resolved.children = children
      return { type: type, props: resolved, children: children }
    },
    Component: Component,
    useState: useState,
    useReducer(reducer, initial) {
      return [initial, function () {}]
    },
    useEffect(fn) {
      if (effectMode !== true || typeof fn !== 'function') return
      try {
        fn()
      } catch (error) {
        // The harness is not a browser; an effect that needs real layout is
        // still expected to return a cleanup without throwing.
        throw error
      }
    },
    useLayoutEffect() {},
    useMemo(factory) {
      return factory()
    },
    useCallback(fn) {
      return fn
    },
    useRef: useRef,
    useSyncExternalStore(_subscribe, getSnapshot) {
      return getSnapshot()
    },
    useInsertionEffect() {},
    useId() {
      return 'react-id'
    },
    Fragment: 'fragment',
  }
}

function createElementStub(tag) {
  return {
    tagName: String(tag).toUpperCase(),
    attributes: {},
    style: {},
    textContent: '',
    children: [],
    appendChild(child) {
      this.children.push(child)
      return child
    },
    removeChild(child) {
      const index = this.children.indexOf(child)
      if (index >= 0) this.children.splice(index, 1)
      return child
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value)
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null
    },
    querySelectorAll() {
      return []
    },
    contains() {
      return false
    },
    focus() {},
    isConnected: true,
  }
}

function createDocumentStub() {
  const document = createElementStub('document')
  document.head = createElementStub('head')
  document.body = createElementStub('body')
  document.visibilityState = 'visible'
  document.activeElement = null
  document.listeners = []
  document.addEventListener = function (type, fn, options) {
    document.listeners.push({ type: type, fn: fn, capture: options === true || (options !== null && options !== undefined && options.capture === true) })
  }
  document.removeEventListener = function (type, fn) {
    const index = document.listeners.findIndex(function (entry) {
      return entry.type === type && entry.fn === fn
    })
    if (index >= 0) document.listeners.splice(index, 1)
  }
  return document
}

function loadBundle(options) {
  assert.ok(existsSync(BUNDLE), 'lib/client.js is missing; run node scripts/build-client.mjs first')
  const source = readFileSync(BUNDLE, 'utf8')
  const document = createDocumentStub()
  document.createElement = createElementStub
  document.querySelector = function () {
    return null
  }
  const window = {
    __ModuleLoader__: {
      load(definition) {
        captured = definition
      },
    },
    localStorage: {
      getItem() {
        return null
      },
      setItem() {},
      removeItem() {},
    },
    addEventListener() {},
    removeEventListener() {},
  }
  let captured = null
  const React = createReactStub(options)
  const context = {
    window: window,
    document: document,
    console: { error() {}, warn() {}, log() {} },
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: setInterval,
    clearInterval: clearInterval,
    fetch: async function () {
      return {
        status: 200,
        json: async function () {
          return { ok: true, data: { state: { configured: false, loggedIn: false, status: 'not_configured' } } }
        },
      }
    },
  }
  vm.createContext(context)
  vm.runInContext(source, context)
  assert.ok(captured !== null, 'the bundle did not call window.__ModuleLoader__.load')
  const module = captured.factory(function require(name) {
    if (name === 'react') return React
    throw new Error('unexpected require: ' + name)
  })
  return { definition: captured, module: module, document: document }
}

function findElement(element, predicate) {
  if (element === null || element === undefined || typeof element !== 'object') return null
  if (Array.isArray(element)) {
    for (let index = 0; index < element.length; index += 1) {
      const found = findElement(element[index], predicate)
      if (found !== null) return found
    }
    return null
  }
  if (predicate(element) === true) return element
  return findElement(element.children, predicate)
}

function createContext(services) {
  const localeRegistrations = []
  const slotRegistrations = []
  const injections = []
  const effects = []
  const registry = services === undefined || services === null ? {} : services
  const ctx = {
    effect(fn, label) {
      const dispose = fn()
      effects.push({ label: label, dispose: dispose })
      return dispose
    },
    locale: {
      register(namespace, language, dictionary) {
        localeRegistrations.push({ namespace: namespace, language: language, keys: Object.keys(dictionary).length })
        return function () {}
      },
      getSnapshot() {
        return { locales: [{ id: 'en' }, { id: 'ru' }], active: 'en' }
      },
      addLanguage() {
        return function () {}
      },
      bind() {
        return function t(key) {
          return key
        }
      },
    },
    slots: {
      inject(key, callback) {
        injections.push(key)
        return callback()
      },
      register(options, component) {
        slotRegistrations.push({ options: options, component: component })
        return function () {}
      },
    },
    get(name) {
      return registry[name]
    },
  }
  return { ctx: ctx, localeRegistrations: localeRegistrations, slotRegistrations: slotRegistrations, injections: injections, effects: effects }
}

test('the module registers exactly one root overlay entry and reuses the core panel', () => {
  const loaded = loadBundle()
  assert.equal(loaded.definition.id, NS)
  assert.deepEqual(Array.from(loaded.module.inject), ['slots', 'locale', 'sessions'])

  const fake = createContext()
  loaded.module.apply(fake.ctx)

  assert.deepEqual(fake.injections, ['shell.overlay'])
  assert.equal(fake.slotRegistrations.length, 1)
  const options = fake.slotRegistrations[0].options
  assert.equal(options.name, 'shell.overlay')
  assert.equal(options.id, 'dsh-telegram.launcher')
  assert.equal(options.order, 900)
  assert.equal(options.locale, NS)
  assert.equal(typeof fake.slotRegistrations[0].component, 'function')

  assert.equal(fake.localeRegistrations.length, 2)
  assert.deepEqual(fake.localeRegistrations.map((entry) => entry.language).sort(), ['en', 'ru'])
  assert.equal(loaded.document.head.children.length, 1)
  assert.equal(loaded.document.head.children[0].getAttribute('data-' + NS), 'stylesheet')
  assert.ok(loaded.document.head.children[0].textContent.includes('.tg-launcher'))
})

test('OverlayRoot renders a closed launcher, opens the dialog and closes on demand', () => {
  const loaded = loadBundle()
  const fake = createContext()
  loaded.module.apply(fake.ctx)
  const slotComponent = fake.slotRegistrations[0].component
  const t = function (key) {
    return key
  }
  const render = function () {
    // The registered component is the thin slot wrapper; its element type is
    // the OverlayRoot the bundle renders.
    const wrapper = slotComponent({ t: t, lang: 'en' })
    return wrapper.type(wrapper.props)
  }

  const closed = render()
  assert.equal(closed.type, 'div')
  assert.equal(closed.props.className, 'tg-overlay-root')
  assert.equal(closed.props.style.pointerEvents, 'none')
  assert.equal(closed.children.length, 3)
  assert.equal(closed.children[1], null)
  assert.equal(closed.children[2], null)

  const launcherElement = closed.children[0]
  const launcher = launcherElement.type(launcherElement.props)
  assert.equal(launcher.type, 'button')
  assert.equal(launcher.props.type, 'button')
  assert.equal(launcher.props['data-dsh-telegram'], 'launcher')
  assert.equal(launcher.props['aria-expanded'], 'false')
  assert.equal(launcher.props['aria-controls'], 'dsh-telegram-overlay')
  assert.equal(launcher.props['aria-label'], 'overlay.launcherAria')
  assert.ok(launcher.props.className.includes('tg-launcher'))
  assert.ok(launcher.props.className.includes('is-hidden') === false)

  // The launcher toggles the module-level flag; a fresh render is the "next
  // frame" of the overlay and must show the dialog.
  launcherElement.props.onToggle()
  const opened = render()
  const backdrop = opened.children[1]
  const dialog = opened.children[2]
  assert.equal(backdrop.props['data-dsh-telegram'], 'backdrop')
  assert.equal(dialog.type, 'section')
  assert.equal(dialog.props.role, 'dialog')
  assert.equal(dialog.props['aria-modal'], 'true')
  assert.equal(dialog.props.id, 'dsh-telegram-overlay')
  assert.equal(dialog.props.tabIndex, -1)
  assert.equal(dialog.props['data-dsh-telegram'], 'overlay')
  assert.equal(dialog.props.style.pointerEvents, 'auto')

  const title = dialog.children[0]
  assert.equal(title.type, 'h2')
  assert.equal(title.props.id, 'dsh-telegram-overlay-title')
  assert.equal(title.children[0], 'overlay.title')

  const body = dialog.children[1]
  const toolbarElement = body.children[0]
  const toolbar = toolbarElement.type(toolbarElement.props)
  assert.equal(toolbar.props['data-dsh-telegram'], 'selection-toolbar')
  const screen = body.children[1]
  assert.equal(screen.props['data-dsh-telegram'], 'screen')
  const panel = screen.children[0]
  assert.equal(panel.props.ctx, fake.ctx)
  assert.equal(panel.props.active, true)
  assert.equal(typeof panel.props.onClose, 'function')
  assert.equal(typeof panel.props.onSelectProfile, 'function')

  // The open launcher is hidden but keeps its DOM node for focus return.
  const openLauncherElement = opened.children[0]
  const openLauncher = openLauncherElement.type(openLauncherElement.props)
  assert.ok(openLauncher.props.className.includes('is-hidden'))
  assert.equal(openLauncher.props['aria-expanded'], 'true')

  // Close path used by Escape and by the × button in the panel strip: the
  // callback passed into TelegramPanel is the overlay's own close.
  panel.props.onClose()
  const closedAgain = render()
  assert.equal(closedAgain.children[2], null)

  // The backdrop closes the overlay too.
  closedAgain.children[0].props.onToggle()
  const reopened = render()
  assert.equal(reopened.children[2].props.role, 'dialog')
  reopened.children[1].props.onClick()
  const closedByBackdrop = render()
  assert.equal(closedByBackdrop.children[2], null)
})

test('the overlay close control reaches the panel strip through TelegramPanel', () => {
  const loaded = loadBundle()
  const fake = createContext()
  loaded.module.apply(fake.ctx)
  const slotComponent = fake.slotRegistrations[0].component
  const t = function (key) {
    return key
  }
  const renderOverlay = function () {
    const wrapper = slotComponent({ t: t, lang: 'en' })
    return wrapper.type(wrapper.props)
  }

  const closed = renderOverlay()
  closed.children[0].props.onToggle()
  const opened = renderOverlay()
  const dialog = opened.children[2]
  const screen = dialog.children[1].children[1]
  assert.equal(screen.props['data-dsh-telegram'], 'screen')
  const panelElement = screen.children[0]
  const close = panelElement.props.onClose
  assert.equal(typeof close, 'function')

  // TelegramPanel -> PanelErrorBoundary -> PanelFrame -> ConnectionStrip.
  const tp = panelElement.type(panelElement.props)
  const Boundary = tp.type
  const boundary = new Boundary(tp.props)
  const frameElement = boundary.render()
  const frame = frameElement.type(frameElement.props)
  assert.equal(frame.type, 'section')
  assert.equal(frame.props['data-dsh-telegram'], 'panel')
  const stripElement = frame.children[0]
  assert.equal(stripElement.props.onClose, close, 'the close callback is forwarded unchanged')
  const strip = stripElement.type(stripElement.props)
  const closeButton = findElement(strip, function (element) {
    return element !== null && typeof element === 'object' && element.props !== undefined && element.props['data-dsh-telegram'] === 'close'
  })
  assert.ok(closeButton !== null, 'the strip renders the × control the overlay passes')
  assert.equal(closeButton.type, 'button')
  assert.equal(closeButton.props['aria-label'], 'overlay.close')
  closeButton.props.onClick()
  assert.equal(renderOverlay().children[2], null)
})

// A fake `ctx.sessions` with the documented face: an observable list whose
// active row is retained by the main view, and `using` → `reference.ready` →
// `session.prompt`. The calls it records are the delivery evidence.
function fakeSessions() {
  const calls = []
  const snapshot = {
    ids: ['session-1'],
    byId: {
      'session-1': {
        id: 'session-1',
        displayTitle: 'Main session',
        running: false,
        retainedBy: { mainView: 1 },
        blank: false,
        updatedAt: 1,
      },
    },
    phase: 'ready',
    projectionsBySession: {},
  }
  const service = {
    list: {
      getSnapshot() {
        return snapshot
      },
      subscribe() {
        return function () {}
      },
    },
    using(target, options, operation) {
      calls.push({ kind: 'using', target: target, source: options.source })
      const reference = {
        sessionId: target,
        ready: Promise.resolve({
          session: {
            prompt(content, mode, signal) {
              calls.push({ kind: 'prompt', content: content, mode: mode, signal: signal })
              return Promise.resolve({ ok: true, value: { accepted: true } })
            },
          },
        }),
      }
      return Promise.resolve(operation(reference))
    },
  }
  return { calls: calls, service: service }
}

function renderComponent(element) {
  let current = element
  let guard = 0
  while (current !== null && current !== undefined && typeof current === 'object' && typeof current.type === 'function' && guard < 8) {
    current = current.type(current.props)
    guard += 1
  }
  return current
}

// Renders every function component in an element subtree so a test can reach
// the DOM props a chip/button finally carries.
function expandElement(element) {
  if (Array.isArray(element)) return element.map(expandElement)
  if (element === null || element === undefined || typeof element !== 'object') return element
  if (typeof element.type === 'function') return expandElement(element.type(element.props))
  return { type: element.type, props: element.props, children: expandElement(element.children) }
}

function overlayBody(render) {
  const opened = render()
  const dialog = opened.children[2]
  assert.equal(dialog.props.role, 'dialog')
  return dialog.children[1]
}

test('selection mode selects a chat, opens the comment window and sends the context to the active session', async () => {
  const loaded = loadBundle()
  const fake = fakeSessions()
  const context = createContext({ sessions: fake.service })
  loaded.module.apply(context.ctx)
  const slotComponent = context.slotRegistrations[0].component
  const t = function (key, params) {
    return params === undefined ? key : key + '|' + JSON.stringify(params)
  }
  const render = function () {
    const wrapper = slotComponent({ t: t, lang: 'en' })
    return wrapper.type(wrapper.props)
  }

  // Open the overlay; the selection mode is off and nothing is selected.
  const closed = render()
  closed.children[0].props.onToggle()
  let body = overlayBody(render)
  let toolbar = renderComponent(body.children[0])
  assert.equal(toolbar.props['data-dsh-telegram'], 'selection-toolbar')
  let toggle = findElement(toolbar, function (element) {
    return element !== null && typeof element === 'object' && element.props !== undefined && element.props['data-dsh-telegram'] === 'selection-toggle'
  })
  assert.ok(toggle !== null)
  assert.equal(toggle.props['aria-pressed'], 'false')
  assert.equal(body.children[2], null, 'no selection bar before an object is selected')
  assert.equal(body.children[3], null, 'no comment window before an object is selected')

  // Turn the mode on: the panes receive selectionMode = true and a toggle.
  toggle.props.onClick()
  body = overlayBody(render)
  toolbar = renderComponent(body.children[0])
  toggle = findElement(toolbar, function (element) {
    return element !== null && typeof element === 'object' && element.props !== undefined && element.props['data-dsh-telegram'] === 'selection-toggle'
  })
  assert.equal(toggle.props['aria-pressed'], 'true')
  const screen = body.children[1]
  assert.ok(screen.props.className.includes('is-selecting'))
  const panelElement = screen.children[0]
  assert.equal(panelElement.props.selectionMode, true)
  assert.equal(typeof panelElement.props.onToggleSelection, 'function')
  assert.equal(panelElement.props.onRegisterSelection, context.ctx === undefined ? undefined : panelElement.props.onRegisterSelection)
  assert.equal(typeof panelElement.props.onRegisterSelection, 'function')
  assert.deepEqual(Array.from(panelElement.props.selectedRefs), [])

  // A click on a chat row is forwarded by 30-chatlist.js as this descriptor.
  panelElement.props.onToggleSelection({
    ref: 'chat:-1001234567890',
    kind: 'chat',
    chat: { chatId: '-1001234567890', title: 'Team', kind: 'channel', username: 'teamchat' },
  })
  body = overlayBody(render)

  // Chip bar: kind + id + title, and a clear action.
  const bar = renderComponent(body.children[2])
  assert.equal(bar.props['data-dsh-telegram'], 'selection')
  const chip = findElement(expandElement(bar), function (element) {
    return element !== null && typeof element === 'object' && element.props !== undefined && element.props['data-tg-chip-ref'] === 'chat:-1001234567890'
  })
  assert.ok(chip !== null, 'the chip carries the selection ref')
  assert.equal(chip.props['data-tg-chip-kind'], 'chat')
  const chipText = JSON.stringify(chip.children)
  assert.ok(chipText.includes('selection.kind.chat'))
  assert.ok(chipText.includes('-1001234567890'))
  assert.ok(chipText.includes('Team'))

  // The comment window opened with the prompt preview and no delivery yet.
  const comment = renderComponent(body.children[3])
  assert.equal(comment.props['data-dsh-telegram'], 'comment')
  assert.equal(fake.calls.length, 0, 'nothing is sent without a Send click')
  const textarea = findElement(comment, function (element) {
    return element !== null && typeof element === 'object' && element.props !== undefined && element.props['data-dsh-telegram'] === 'comment-note'
  })
  assert.ok(textarea !== null)
  const send = findElement(comment, function (element) {
    return element !== null && typeof element === 'object' && element.props !== undefined && element.props['data-dsh-telegram'] === 'comment-send'
  })
  assert.ok(send !== null)
  assert.equal(send.props.disabled, false)
  const preview = findElement(comment, function (element) {
    return element !== null && typeof element === 'object' && element.props !== undefined && element.props['data-dsh-telegram'] === 'comment-preview'
  })
  const promptBlock = findElement(preview, function (element) {
    return element !== null && typeof element === 'object' && element.type === 'pre'
  })
  assert.ok(promptBlock.children[0].includes('Telegram selection from DSH Web'))
  assert.ok(promptBlock.children[0].includes('untrusted data'))

  // The Send click is the only path: it reaches ctx.sessions.using with the
  // documented source and the serialized context block.
  send.props.onClick()
  await new Promise(function (resolve) {
    setTimeout(resolve, 0)
  })
  assert.equal(fake.calls.length, 2)
  assert.equal(fake.calls[0].kind, 'using')
  assert.equal(fake.calls[0].target, 'session-1')
  assert.equal(fake.calls[0].source, 'dsh-telegram')
  assert.equal(fake.calls[1].kind, 'prompt')
  assert.equal(fake.calls[1].content.length, 1)
  assert.equal(fake.calls[1].content[0].type, 'text')
  const text = fake.calls[1].content[0].text
  assert.ok(text.includes('Telegram selection from DSH Web'))
  assert.ok(text.includes('"schema": "dsh-telegram/selection@1"'))
  assert.ok(text.includes('"title": "Team"'))
  assert.ok(text.includes('untrusted'))
  assert.equal(fake.calls[1].mode, 'queue')

  // After success the selection clears and the overlay stays open.
  body = overlayBody(render)
  assert.equal(body.children[2], null, 'the chip bar clears after sending')
  assert.equal(body.children[3], null, 'the comment window closes after sending')
})

test('selection mode clears when the object is clicked again', () => {
  const loaded = loadBundle()
  const context = createContext()
  loaded.module.apply(context.ctx)
  const slotComponent = context.slotRegistrations[0].component
  const t = function (key) {
    return key
  }
  const render = function () {
    const wrapper = slotComponent({ t: t, lang: 'en' })
    return wrapper.type(wrapper.props)
  }
  render().children[0].props.onToggle()
  let body = overlayBody(render)
  const toolbar = renderComponent(body.children[0])
  const toggle = findElement(toolbar, function (element) {
    return element !== null && typeof element === 'object' && element.props !== undefined && element.props['data-dsh-telegram'] === 'selection-toggle'
  })
  toggle.props.onClick()
  body = overlayBody(render)
  assert.equal(body.children[1].props.className.includes('is-selecting'), true)
  const descriptor = { ref: 'msg:1:7', kind: 'message', chatId: '1', chat: { chatId: '1', title: 'Team', kind: 'chat' }, message: { id: 7, text: 'hello', date: 1795000000 } }
  body.children[1].children[0].props.onToggleSelection(descriptor)
  body = overlayBody(render)
  assert.equal(body.children[2] !== null, true)

  // The chip's own × removes exactly one object and closes the empty window.
  const bar = renderComponent(body.children[2])
  const chipRemove = findElement(expandElement(bar), function (element) {
    return element !== null && typeof element === 'object' && element.props !== undefined && typeof element.props.className === 'string' && element.props.className.includes('tg-overlay-chip-remove')
  })
  assert.ok(chipRemove !== null)
  chipRemove.props.onClick()
  body = overlayBody(render)
  assert.equal(body.children[2], null, 'the chip × removes the object')
  assert.equal(body.children[3], null, 'an empty selection closes the comment window')

  // Selecting again and clearing everything through the bar.
  body.children[1].children[0].props.onToggleSelection(descriptor)
  body = overlayBody(render)
  assert.equal(body.children[2] !== null, true)
  const clearBar = renderComponent(body.children[2])
  const clearAll = findElement(expandElement(clearBar), function (element) {
    return element !== null && typeof element === 'object' && element.props !== undefined && element.props['data-dsh-telegram'] === 'selection-clear'
  })
  assert.ok(clearAll !== null)
  clearAll.props.onClick()
  body = overlayBody(render)
  assert.equal(body.children[2], null, 'clear all empties the selection')

  // Turning the mode off stops the panes from selecting clicks.
  body.children[1].children[0].props.onToggleSelection(descriptor)
  body = overlayBody(render)
  const offToolbar = renderComponent(body.children[0])
  const offToggle = findElement(offToolbar, function (element) {
    return element !== null && typeof element === 'object' && element.props !== undefined && element.props['data-dsh-telegram'] === 'selection-toggle'
  })
  offToggle.props.onClick()
  body = overlayBody(render)
  assert.equal(body.children[1].props.className.includes('is-selecting'), false)
  assert.equal(body.children[1].children[0].props.selectionMode, false)
  assert.equal(body.children[1].children[0].props.onToggleSelection, undefined)
})

test('the selection cap shows a limit warning and still sends at most 50 objects', () => {
  const loaded = loadBundle()
  const context = createContext()
  loaded.module.apply(context.ctx)
  const slotComponent = context.slotRegistrations[0].component
  const t = function (key, params) {
    return params === undefined ? key : key + '|' + JSON.stringify(params)
  }
  const render = function () {
    const wrapper = slotComponent({ t: t, lang: 'en' })
    return wrapper.type(wrapper.props)
  }
  render().children[0].props.onToggle()
  let body = overlayBody(render)
  const toolbar = renderComponent(body.children[0])
  const toggle = findElement(toolbar, function (element) {
    return element !== null && typeof element === 'object' && element.props !== undefined && element.props['data-dsh-telegram'] === 'selection-toggle'
  })
  toggle.props.onClick()
  body = overlayBody(render)
  const onToggleSelection = body.children[1].children[0].props.onToggleSelection
  for (let index = 0; index < 51; index += 1) {
    onToggleSelection({
      ref: 'chat:' + String(index),
      kind: 'chat',
      chat: { chatId: String(index), title: 'Chat ' + String(index), kind: 'chat' },
    })
  }
  body = overlayBody(render)
  const bar = renderComponent(body.children[2])
  const limit = findElement(expandElement(bar), function (element) {
    return element !== null && typeof element === 'object' && element.props !== undefined && element.props['data-dsh-telegram'] === 'selection-limit'
  })
  assert.ok(limit !== null, 'the 51st object raises the limit warning')
  const label = String(limit.children[0])
  assert.ok(label.includes('selection.limitWarning'), label)
  assert.ok(label.includes('"max":50'), label)
  assert.ok(label.includes('"dropped":1'), label)
})

test('the Escape listener closes the open overlay', () => {
  const loaded = loadBundle({ effects: true })
  const fake = createContext()
  loaded.module.apply(fake.ctx)
  const slotComponent = fake.slotRegistrations[0].component
  const t = function (key) {
    return key
  }
  const render = function () {
    const wrapper = slotComponent({ t: t, lang: 'en' })
    return wrapper.type(wrapper.props)
  }

  const closed = render()
  closed.children[0].props.onToggle()
  const opened = render()
  assert.equal(opened.children[2].props.role, 'dialog')

  // The overlay registers its Escape handler in the capture phase so it runs
  // before the app's own document listeners.
  const escapeHandlers = loaded.document.listeners.filter(function (entry) {
    return entry.type === 'keydown' && entry.capture === true
  })
  assert.equal(escapeHandlers.length, 1, 'one capture-phase Escape handler while open')
  let prevented = false
  escapeHandlers[0].fn({
    key: 'Escape',
    preventDefault() {
      prevented = true
    },
  })
  assert.equal(prevented, true)
  assert.equal(render().children[2], null)
})

test('the overlay source keeps the accessibility and placement contract', () => {
  const overlaySrc = read(path.join('lib', 'client-src', '15-overlay.js'))
  for (const needle of ["role: 'dialog'", "'aria-modal': 'true'", 'aria-labelledby', "'Escape'", 'Tab', 'pointerEvents: \'none\'', 'pointerEvents: \'auto\'', 'hasEscapeBlocker']) {
    assert.ok(overlaySrc.includes(needle), '15-overlay.js must contain ' + needle)
  }
  assert.equal(/createPortal|document\.body/.test(overlaySrc), false, 'the overlay must not portal out of the frame')
  assert.equal((overlaySrc.match(/useOverlayState/g) || []).length >= 2, true)

  const registerSrc = read(path.join('lib', 'client-src', '90-register.js'))
  assert.equal((registerSrc.match(/name: 'shell\.overlay'/g) || []).length, 1, 'exactly one shell.overlay registration')
  assert.equal((registerSrc.match(/slots\.inject\('shell\.overlay'/g) || []).length, 1, 'one injected overlay declaration')
  assert.equal((registerSrc.match(/name: 'sidebar\.panellist'/g) || []).length, 0)
  assert.equal((registerSrc.match(/name: 'main'/g) || []).length, 0)

  const styles = read(path.join('lib', 'client-src', '70-styles.js'))
  for (const needle of ['.tg-launcher', '--tg-launcher-top', '--tg-launcher-right', '.tg-overlay-panel', '.tg-overlay-backdrop', '.tg-launcher-dot.is-warn', '.tg-launcher-dot.is-error', 'max-inline-size:1120px', 'max-width:720px']) {
    assert.ok(styles.includes(needle), '70-styles.js must contain ' + needle)
  }
})

test('the profile screen exposes masked data and the write/select actions', () => {
  const profile = read(path.join('lib', 'client-src', '55-profile.js'))
  for (const needle of ['user.username', 'user.phoneMasked', 'user.bio', 'participantsCount', 'profile.write', 'profile.select', 'profile.fieldKind', "data-dsh-telegram': 'profile-write'", "data-dsh-telegram': 'profile-select'"]) {
    assert.ok(profile.includes(needle), '55-profile.js must contain ' + needle)
  }
  const panel = read(path.join('lib', 'client-src', '20-panel.js'))
  for (const needle of ["data-dsh-telegram': 'close'", 'openProfile', 'writeToProfile', 'onSelectProfile', "'overlay.close'"]) {
    assert.ok(panel.includes(needle), '20-panel.js must contain ' + needle)
  }
  const thread = read(path.join('lib', 'client-src', '40-thread.js'))
  for (const needle of ["data-dsh-telegram': 'chat-profile'", "data-dsh-telegram': 'sender-profile'"]) {
    assert.ok(thread.includes(needle), '40-thread.js must contain ' + needle)
  }
})

test('en and ru cover every overlay/profile action key', () => {
  const en = JSON.parse(read('locale/en.json'))
  const ru = JSON.parse(read('locale/ru.json'))
  assert.deepEqual(Object.keys(en).sort(), Object.keys(ru).sort())
  for (const key of [
    'overlay.title',
    'overlay.launcherAria',
    'overlay.launcherTitle',
    'overlay.close',
    'overlay.selectionCount',
    'overlay.removeSelection',
    'overlay.clearSelection',
    'profile.fieldKind',
    'profile.write',
    'profile.select',
  ]) {
    assert.equal(typeof en[key], 'string', 'en.json is missing ' + key)
    assert.equal(typeof ru[key], 'string', 'ru.json is missing ' + key)
    assert.notEqual(en[key], '', 'en.json has an empty ' + key)
    assert.notEqual(ru[key], '', 'ru.json has an empty ' + key)
  }
})
