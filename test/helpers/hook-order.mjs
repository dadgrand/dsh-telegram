/**
 * Hook-order checking React stub for the dsh-telegram client tests.
 *
 * The client half is a browser bundle with no real React in this repository, so
 * the tests render components by calling them directly with a stub. A plain
 * stub cannot see a Rules-of-Hooks violation: it happily runs whatever hook the
 * render path happens to reach. That is exactly how D1 (opening the overlay
 * crashed with `Cannot read properties of undefined (reading 'length')`)
 * survived the t3/t4 suites.
 *
 * This stub records the built-in hook calls of every checked render and compares
 * the sequence with the previous render of the same labelled component. A
 * differing sequence throws an Error that names both sequences, mirroring
 * React's "Rendered more/fewer hooks than during the previous render".
 *
 * Usage:
 *   const tracked = createTrackedReact({ effects: true })
 *   // pass `tracked.React` to the bundle's `require('react')`
 *   tracked.renderChecked('OverlayRoot', () => Component(props))
 *   tracked.measurements         // every measured { label, sequence }
 *   tracked.violations           // mismatches (also thrown)
 *
 * `setEffects(false)` disables inline effect execution; effects are executed
 * inline (cleanups are ignored) only for renders whose document listeners the
 * test needs to dispatch.
 */

export function createTrackedReact(options) {
  const settings = options === undefined || options === null ? {} : options
  let runEffects = settings.effects === true
  const history = new Map()
  const measurements = []
  const violations = []
  let current = null

  function record(name) {
    if (current === null) return
    current.sequence.push(name)
  }

  function begin(label) {
    if (current !== null) {
      throw new Error('nested tracked render: ' + label + ' started while ' + current.label + ' is rendering')
    }
    current = { label: String(label), sequence: [] }
  }

  function end() {
    const measured = current
    if (measured === null) throw new Error('end() called without begin()')
    current = null
    measurements.push(measured)
    const previous = history.get(measured.label)
    if (previous !== undefined && previous.join('>') !== measured.sequence.join('>')) {
      const violation = {
        label: measured.label,
        previous: previous.slice(),
        current: measured.sequence.slice(),
      }
      violations.push(violation)
      throw new Error(
        'hook order changed for ' + measured.label + '\n'
        + '  previous: ' + (previous.length === 0 ? '(none)' : previous.join(', ')) + '\n'
        + '  current:  ' + (measured.sequence.length === 0 ? '(none)' : measured.sequence.join(', ')),
      )
    }
    history.set(measured.label, measured.sequence)
    return measured.sequence
  }

  function renderChecked(label, render) {
    begin(label)
    let value
    try {
      value = render()
    } catch (error) {
      current = null
      throw error
    }
    end()
    return value
  }

  function useState(initial) {
    record('useState')
    let value = initial
    function set(next) {
      value = typeof next === 'function' ? next(value) : next
    }
    return [value, set]
  }

  function useRef(value) {
    record('useRef')
    return { current: value }
  }

  function useCallback(fn) {
    record('useCallback')
    return fn
  }

  function useMemo(factory) {
    record('useMemo')
    return factory()
  }

  function runEffect(fn) {
    if (runEffects !== true || typeof fn !== 'function') return
    fn()
  }

  function useEffect(fn) {
    record('useEffect')
    runEffect(fn)
  }

  function useLayoutEffect(fn) {
    record('useLayoutEffect')
    runEffect(fn)
  }

  function useInsertionEffect(fn) {
    record('useInsertionEffect')
    runEffect(fn)
  }

  function useSyncExternalStore(_subscribe, getSnapshot) {
    record('useSyncExternalStore')
    return getSnapshot()
  }

  function useReducer(_reducer, initial) {
    record('useReducer')
    return [initial, function () {}]
  }

  function useId() {
    record('useId')
    return 'react-id'
  }

  function createElement(type, props) {
    const children = Array.prototype.slice.call(arguments, 2)
    const resolved = Object.assign({}, props === undefined || props === null ? {} : props)
    if (children.length === 1) resolved.children = children[0]
    else if (children.length > 1) resolved.children = children
    return { type: type, props: resolved, children: children }
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

  const React = {
    createElement: createElement,
    Component: Component,
    useState: useState,
    useReducer: useReducer,
    useEffect: useEffect,
    useLayoutEffect: useLayoutEffect,
    useInsertionEffect: useInsertionEffect,
    useMemo: useMemo,
    useCallback: useCallback,
    useRef: useRef,
    useSyncExternalStore: useSyncExternalStore,
    useId: useId,
    Fragment: 'fragment',
  }

  return {
    React: React,
    renderChecked: renderChecked,
    measurements: measurements,
    violations: violations,
    history: history,
    setEffects(value) {
      runEffects = value === true
    },
  }
}
