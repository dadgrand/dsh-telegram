/**
 * Rules-of-Hooks regression gate for dsh-telegram (D1 + D3 of the t5 report).
 *
 * D1: the always-mounted `shell.overlay` entry crashed the first time the
 * overlay opened. `useActiveSession(ctx, open)` skipped `useSnapshot`'s
 * `useSyncExternalStore` while the overlay was closed, so the first open render
 * added a hook and React 19 aborted in the useSyncExternalStore effect-deps
 * comparison (TypeError: Cannot read properties of undefined (reading
 * 'length')). The plain VM React stubs used by the earlier suites could not see
 * this because they had no hook bookkeeping (D3).
 *
 * This file renders the *real* built bundle with the hook-order-checking stub
 * from test/helpers/hook-order.mjs and drives the overlay through repeated
 * open/close cycles: Alt+Shift+T, the launcher, the strip ×, the backdrop and
 * Escape. It runs three session states (no `sessions` service, an inactive
 * session list, an active session) and also checks TelegramPanel's hook order
 * across `active` values and CommentDialog's hook order with and without an
 * active-session target.
 *
 * The first test proves the gate itself: a fixture that reproduces the pre-fix
 * conditional-hook shape must be rejected with a changed hook sequence.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

import { createTrackedReact } from './helpers/hook-order.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const BUNDLE = path.join(ROOT, 'lib', 'client.js')
const SRC = path.join(ROOT, 'lib', 'client-src')

function read(relative) {
  return readFileSync(path.join(ROOT, relative), 'utf8')
}

function readFragment(name) {
  return readFileSync(path.join(SRC, name), 'utf8')
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
    document.listeners.push({
      type: type,
      fn: fn,
      capture: options === true || (options !== null && options !== undefined && options.capture === true),
    })
  }
  document.removeEventListener = function (type, fn) {
    const index = document.listeners.findIndex(function (entry) {
      return entry.type === type && entry.fn === fn
    })
    if (index >= 0) document.listeners.splice(index, 1)
  }
  document.createElement = createElementStub
  document.querySelector = function () {
    return null
  }
  return document
}

function loadBundle(tracked) {
  assert.ok(existsSync(BUNDLE), 'lib/client.js is missing; run node scripts/build-client.mjs first')
  const source = readFileSync(BUNDLE, 'utf8')
  const document = createDocumentStub()
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
    if (name === 'react') return tracked.React
    throw new Error('unexpected require: ' + name)
  })
  return { definition: captured, module: module, document: document }
}

function createContext(services) {
  const slotRegistrations = []
  const registry = services === undefined || services === null ? {} : services
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return dispose
    },
    locale: {
      register() {
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
      inject(_key, callback) {
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
  return { ctx: ctx, slotRegistrations: slotRegistrations }
}

function observableOf(state) {
  return {
    getSnapshot() {
      return state
    },
    subscribe() {
      return function () {}
    },
  }
}

function sessionsWith(state) {
  return { sessions: { list: observableOf(state) } }
}

function boot(services) {
  const tracked = createTrackedReact({ effects: true })
  const loaded = loadBundle(tracked)
  const fake = createContext(services)
  loaded.module.apply(fake.ctx)
  assert.equal(fake.slotRegistrations.length, 1)
  const slotComponent = fake.slotRegistrations[0].component
  const t = function (key) {
    return key
  }
  // Effects run inline in the stub, so every render starts from an empty
  // listener set and leaves exactly the handlers of the current state.
  const render = function () {
    loaded.document.listeners.length = 0
    return tracked.renderChecked('OverlayRoot', function () {
      const wrapper = slotComponent({ t: t, lang: 'en' })
      return wrapper.type(wrapper.props)
    })
  }
  return { tracked: tracked, loaded: loaded, fake: fake, render: render, t: t }
}

function dialogOf(tree) {
  return tree.children[2]
}

function bodyOf(tree) {
  return tree.children[2].children[1]
}

function panelOf(tree) {
  return bodyOf(tree).children[1].children[0]
}

function commentElementOf(tree) {
  const body = bodyOf(tree)
  return body.children[3] === undefined ? null : body.children[3]
}

function dispatchShortcut(loaded) {
  const handlers = loaded.document.listeners.filter(function (entry) {
    return entry.type === 'keydown' && entry.capture !== true && String(entry.fn).includes('altKey')
  })
  assert.ok(handlers.length > 0, 'the overlay registers its Alt+Shift+T listener')
  handlers[handlers.length - 1].fn({
    altKey: true,
    shiftKey: true,
    ctrlKey: false,
    metaKey: false,
    key: 't',
    code: 'KeyT',
    target: null,
    preventDefault() {},
  })
}

function dispatchEscape(loaded) {
  const handlers = loaded.document.listeners.filter(function (entry) {
    return entry.type === 'keydown' && entry.capture === true
  })
  assert.ok(handlers.length > 0, 'the open overlay registers its capture-phase Escape listener')
  handlers[handlers.length - 1].fn({ key: 'Escape', preventDefault() {} })
}

function sequenceOf(tracked, label) {
  const sequence = tracked.history.get(label)
  return sequence === undefined ? '' : sequence.join('>')
}

// Three open/close cycles per session state, each with a different open/close
// path. The tracked render throws as soon as the hook sequence differs from the
// previous render of the same component.
function runCycles(name, services) {
  const harness = boot(services)
  const sequences = []

  const measure = function (tree) {
    sequences.push(sequenceOf(harness.tracked, 'OverlayRoot'))
    return tree
  }

  let tree = measure(harness.render())
  assert.equal(dialogOf(tree), null, name + ': the overlay starts closed')

  // Cycle 1: open with Alt+Shift+T, select a profile (comment window), close
  // with the × in the panel strip.
  dispatchShortcut(harness.loaded)
  tree = measure(harness.render())
  assert.notEqual(dialogOf(tree), null, name + ': Alt+Shift+T opens the overlay')
  panelOf(tree).props.onSelectProfile({ kind: 'user', userId: '12345', title: 'Anna' })
  const withSelection = measure(harness.render())
  assert.notEqual(dialogOf(withSelection), null, name + ': the overlay stays open with a selection')
  const commentElement = commentElementOf(withSelection)
  assert.ok(commentElement !== null && commentElement !== undefined, name + ': the selection opens the comment window')

  // The comment window is its own component instance; render it with effects
  // off so its Escape blocker does not leak into the following overlay closes.
  harness.tracked.setEffects(false)
  const commentDialogElement = harness.tracked.renderChecked('OverlayCommentWindow', function () {
    return commentElement.type(commentElement.props)
  })
  const commentTree = harness.tracked.renderChecked('CommentDialog', function () {
    return commentDialogElement.type(commentDialogElement.props)
  })
  harness.tracked.setEffects(true)
  assert.equal(commentTree.props['data-dsh-telegram'], 'comment')

  // TelegramPanel's hook order must not depend on its `active` prop (the old
  // usePanelActive returned before useActivePanelId for an explicit value).
  const panelElement = panelOf(withSelection)
  harness.tracked.setEffects(false)
  harness.tracked.renderChecked('TelegramPanel', function () {
    return panelElement.type(Object.assign({}, panelElement.props, { active: true }))
  })
  harness.tracked.renderChecked('TelegramPanel', function () {
    return panelElement.type(Object.assign({}, panelElement.props, { active: undefined }))
  })
  harness.tracked.setEffects(true)

  panelOf(withSelection).props.onClose()
  tree = measure(harness.render())
  assert.equal(dialogOf(tree), null, name + ': the strip × closes the overlay')

  // Cycle 2: open with the launcher, close with the backdrop.
  tree.children[0].props.onToggle()
  tree = measure(harness.render())
  assert.notEqual(dialogOf(tree), null, name + ': the launcher opens the overlay')
  tree.children[1].props.onClick()
  tree = measure(harness.render())
  assert.equal(dialogOf(tree), null, name + ': the backdrop closes the overlay')

  // Cycle 3: open with Alt+Shift+T again, close with Escape.
  dispatchShortcut(harness.loaded)
  tree = measure(harness.render())
  assert.notEqual(dialogOf(tree), null, name + ': the second shortcut opens the overlay')
  dispatchEscape(harness.loaded)
  tree = measure(harness.render())
  assert.equal(dialogOf(tree), null, name + ': Escape closes the overlay')

  assert.equal(harness.tracked.violations.length, 0, name + ': no hook-order violation')
  const unique = new Set(sequences)
  assert.equal(unique.size, 1, name + ': OverlayRoot keeps one hook sequence across the cycles')
  assert.equal(sequences[0].split('>').length > 0, true, name + ': the sequence is recorded')

  return {
    overlaySequence: sequences[0],
    telegramSequence: sequenceOf(harness.tracked, 'TelegramPanel'),
    commentSequence: sequenceOf(harness.tracked, 'CommentDialog'),
  }
}

test('the hook-order gate rejects the pre-fix conditional useSyncExternalStore shape', () => {
  const tracked = createTrackedReact()

  // The pre-fix shape of 10-utils.useSnapshot: with no source the conditional
  // returned before the subscription hook, so the first open render added it.
  function usePreFixSnapshot(source) {
    if (source === null) return null
    return tracked.React.useSyncExternalStore(
      function () {
        return function () {}
      },
      function () {
        return 'snapshot'
      },
    )
  }

  function PreFixOverlayLike(props) {
    const session = usePreFixSnapshot(props.source)
    const pair = tracked.React.useState(0)
    return { session: session, count: pair[0] }
  }

  tracked.renderChecked('PreFixOverlayLike', function () {
    return PreFixOverlayLike({ source: null })
  })
  assert.throws(function () {
    tracked.renderChecked('PreFixOverlayLike', function () {
      return PreFixOverlayLike({ source: {} })
    })
  }, /hook order changed/)
  assert.equal(tracked.violations.length, 1)
  assert.deepEqual(tracked.violations[0].previous, ['useState'])
  assert.deepEqual(tracked.violations[0].current, ['useSyncExternalStore', 'useState'])
})

test('D1 regression: the real overlay keeps one hook sequence across open/close cycles', () => {
  const inactive = { ids: ['session-1'], byId: { 'session-1': { id: 'session-1', displayTitle: 'Idle', running: false, retainedBy: { mainView: 0 } } } }
  const active = { ids: ['session-1'], byId: { 'session-1': { id: 'session-1', displayTitle: 'Main session', running: false, retainedBy: { mainView: 1 } } } }

  const noSessions = runCycles('no sessions service', {})
  const inactiveSessions = runCycles('no active session', sessionsWith(inactive))
  const activeSession = runCycles('active session', sessionsWith(active))

  // The hook sequence must also be independent of the session state: closed ->
  // open with no sessions service still calls the subscription hook.
  assert.equal(inactiveSessions.overlaySequence, noSessions.overlaySequence)
  assert.equal(activeSession.overlaySequence, noSessions.overlaySequence)
  assert.equal(inactiveSessions.telegramSequence, noSessions.telegramSequence)
  assert.equal(activeSession.telegramSequence, noSessions.telegramSequence)
  assert.equal(inactiveSessions.commentSequence, noSessions.commentSequence)
  assert.equal(activeSession.commentSequence, noSessions.commentSequence)

  // A sanity check on the shape we compare: the Open/close sequence contains
  // the subscription hook that D1 used to skip.
  assert.ok(noSessions.overlaySequence.split('>').includes('useSyncExternalStore'))
  assert.ok(activeSession.overlaySequence.split('>').filter(function (name) {
    return name === 'useSyncExternalStore'
  }).length >= 1)
})

test('the snapshot helpers and the overlay path contain no conditional hook calls', () => {
  const utils = readFragment('10-utils.js')
  const comment = readFragment('68-comment.js')
  const panel = readFragment('20-panel.js')

  // The exact pre-fix guard that skipped the subscription hook is gone.
  assert.equal(/if\s*\(\s*useSyncExternalStore\s*===/.test(utils), false)
  assert.equal(utils.includes('useSessionsStore(enabled === false ? null : ctx)'), false)
  assert.ok(utils.includes('const useSnapshotSubscription = typeof useSyncExternalStore'))
  assert.ok(utils.includes('return useSnapshotSubscription(subscribe, getSnapshot, getSnapshot)'))
  assert.ok(comment.includes('useSessionsStore(ctx, enabled !== false)'))
  assert.ok(comment.includes('useActiveSession(ctx, enabled)'))

  // usePanelActive calls useActivePanelId before it can return the explicit
  // value (the second Rules-of-Hooks fix of this change).
  const hookIndex = panel.indexOf('const selected = useActivePanelId(ctx)')
  const returnIndex = panel.indexOf('if (explicit === false || explicit === true)')
  assert.ok(hookIndex >= 0, 'usePanelActive calls useActivePanelId')
  assert.ok(returnIndex > hookIndex, 'usePanelActive returns only after the hook call')

  // No fragment calls a hook directly from a conditional statement on one line
  // (`if (...) useX(...)` / `if (...) { useX(...)`).
  const conditionalHook = /if\s*\([^\n]*\)\s*(?:\{\s*)?(?:return\s+)?use[A-Z][A-Za-z0-9]*\s*\(/
  const fragments = readdirSync(SRC).filter(function (name) {
    return /^\d\d-[a-z-]+\.js$/.test(name)
  })
  assert.ok(fragments.length >= 13)
  for (const fragment of fragments) {
    const match = conditionalHook.exec(readFragment(fragment))
    assert.equal(match, null, fragment + ' calls a hook from a conditional statement: ' + (match === null ? '' : match[0]))
  }
})
