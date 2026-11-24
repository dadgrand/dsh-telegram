// 15-overlay.js — the paper-plane launcher and the frame-level overlay window
// (DESIGN-v0.2 2, 3.2, 7.1).
//
// `OverlayRoot` is the single `shell.overlay` entry registered by
// 90-register.js. It owns:
//
//   1. the launcher in the top-right corner. It sits below the Conversation
//      header (`--dsh-frame-overlay-top` + 56px) and is moved by
//      `--tg-launcher-top` / `--tg-launcher-right`, so it never covers a host
//      control (DESIGN-v0.2 2.3);
//   2. the open flag. The flag lives above the component on purpose: the frame
//      renders `shell.overlay` beside the columns (AppFrame.tsx:281), so
//      switching main panels does not remount the entry and the window stays
//      open. The module mirror also survives a slot remount in the same page;
//   3. the backdrop, the dialog frame, Escape, the Tab focus trap and the focus
//      return to the launcher (DESIGN-v0.2 2.4);
//   4. the selection surface of the t4 wave: the mode toggle, the object chips
//      (kind · id · title), the marquee that selects every object the drawn
//      region intersects, and the comment window of 68-comment.js. The
//      selection state itself lives in 65-selection.js; this file only wires
//      DOM events to it.
//
// The core screen is `TelegramPanel` from 20-panel.js: the dialog adds no
// second copy of the list, thread, composer, profile or sign-in screen. The
// panes receive `selectionMode` / `selectedRefs` / `onToggleSelection` so a
// click toggles an object only while the mode is on.
//
// `.overlayLayer > *` forces `pointer-events: auto` on the root element, so the
// root sets `pointerEvents: 'none'` inline and each interactive node opts back
// in (DESIGN-v0.2 2.2). No portal, no second application: the overlay stays
// inside the frame.

// Stable DOM id of the dialog; the launcher's aria-controls points at it.
const OVERLAY_DOM_ID = 'dsh-telegram-overlay'
const OVERLAY_ROOT_TITLE_ID = OVERLAY_DOM_ID + '-title'
const FOCUSABLE_SELECTOR = 'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])'

// The open flag, kept above the entry (see the module comment).
const overlaySession = { open: false }

function isEditableTarget(target) {
  if (target === null || target === undefined || typeof target !== 'object') return false
  const tag = typeof target.tagName === 'string' ? target.tagName.toUpperCase() : ''
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return target.isContentEditable === true
}

function focusableElements(root) {
  if (root === null || root === undefined || typeof root.querySelectorAll !== 'function') return []
  const found = root.querySelectorAll(FOCUSABLE_SELECTOR)
  const nodes = []
  for (let index = 0; index < found.length; index += 1) {
    const node = found[index]
    if (node === null || node === undefined) continue
    if (node.hidden === true) continue
    if (typeof node.getAttribute === 'function' && node.getAttribute('aria-hidden') === 'true') continue
    nodes.push(node)
  }
  return nodes
}

// The glyph is our own currentColor SVG (DESIGN-v0.2 2.3); no icon package.
function PaperPlaneIcon(props) {
  const size = props !== null && props !== undefined && props.size === 'small' ? 16 : 18
  return h(
    'svg',
    {
      className: 'tg-launcher-glyph',
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      'aria-hidden': 'true',
      focusable: 'false',
    },
    h('path', {
      fill: 'currentColor',
      d: 'M21.4 2.5 2.5 9.9c-.8.3-.8 1.4 0 1.7l4.8 1.7 1.8 5.4c.24.72 1.16.9 1.68.34l2.42-2.62 4.2 3.05c.66.48 1.6.13 1.76-.68l2.95-14.9c.16-.8-.53-1.47-1.3-1.24ZM9.1 13.2l8.6-7-6.9 7.8-.2 2.9-1.5-3.7Z',
    }),
  )
}

// The dot mirrors DESIGN-v0.2 2.3: error for connection_failed, warning while
// the account is not usable yet, nothing in connected.
function launcherTone(state) {
  if (isRecord(state) !== true) return ''
  if (state.status === 'connection_failed') return 'error'
  if (state.configured === false) return 'warn'
  if (state.loggedIn !== true) return 'warn'
  return ''
}

function Launcher(props) {
  const t = props.t
  const tone = typeof props.tone === 'string' ? props.tone : ''
  const open = props.open === true
  return h(
    'button',
    {
      type: 'button',
      ref: props.buttonRef,
      className: classNameOf('tg-launcher', { 'is-warn': tone === 'warn', 'is-error': tone === 'error', 'is-hidden': open }),
      style: { pointerEvents: 'auto' },
      'data-dsh-telegram': 'launcher',
      'data-state': tone === '' ? 'ok' : tone,
      'aria-label': t('overlay.launcherAria'),
      'aria-expanded': open === true ? 'true' : 'false',
      'aria-haspopup': 'dialog',
      'aria-controls': OVERLAY_DOM_ID,
      title: t('overlay.launcherTitle'),
      onClick: props.onToggle,
    },
    h(PaperPlaneIcon, {}),
    tone === 'warn' ? h('span', { className: 'tg-launcher-dot is-warn', 'aria-hidden': 'true' }) : null,
    tone === 'error' ? h('span', { className: 'tg-launcher-dot is-error', 'aria-hidden': 'true' }) : null,
  )
}

// One `/status` read for the state dot while the overlay is closed; the open
// overlay owns polling itself (DESIGN-v0.2 7.7). Failures leave the dot empty.
function useLauncherHealth(ctx, open) {
  const state = useState(null)
  const load = useCallback(function () {
    return apiRequest('GET', apiUrl(ROUTES.status)).then(function (reply) {
      if (reply !== null && reply !== undefined && reply.ok === true) {
        const data = reply.data
        const host = isRecord(data) && isRecord(data.state) ? data.state : isRecord(data) ? data : null
        state[1](host)
      }
      return reply
    })
  }, [])
  useEffect(function () {
    if (open === true) return function () {}
    if (documentVisible() !== true) return function () {}
    load()
    return function () {
      abortRequests(ROUTES.status)
    }
  }, [open, load])
  return { tone: launcherTone(state[0]), refresh: load }
}

// `useState` + a module mirror: switching main panels does not remount the
// entry, and a remount inside the page keeps the same open/closed state.
function useOverlayState() {
  const pair = useState(overlaySession.open)
  const setOpen = useCallback(function (next) {
    const value = next === true
    overlaySession.open = value
    pair[1](value)
  }, [])
  const toggle = useCallback(function () {
    setOpen(overlaySession.open !== true)
  }, [setOpen])
  const close = useCallback(function () {
    setOpen(false)
  }, [setOpen])
  return { open: pair[0], toggle: toggle, close: close, setOpen: setOpen }
}

//#region Selection surface (t4; model in 65-selection.js)

// One chip: kind · id · title, with a remove control. The dialog and the bar
// render the same shape so the two never drift.
function SelectionChip(props) {
  const t = props.t
  const item = props.item
  const ref = selectionRefOfDescriptor(item)
  const label = selectionChipLabel(item, t)
  const kind = isRecord(item) && typeof item.kind === 'string' ? item.kind : ''
  return h(
    'span',
    {
      className: 'tg-overlay-chip',
      key: ref,
      'data-tg-chip-kind': kind,
      'data-tg-chip-ref': ref,
      title: label,
    },
    h('span', { className: 'tg-overlay-chip-kind' }, t(SELECTION_KIND_KEYS[kind] || 'selection.kind.other')),
    h('span', { className: 'tg-overlay-chip-id' }, selectionChipIdOf(item)),
    h('span', { className: 'tg-overlay-chip-label' }, selectionChipTitleOf(item)),
    h(
      'button',
      {
        type: 'button',
        className: 'tg-overlay-chip-remove',
        'aria-label': t('selection.remove', { label: label }),
        onClick: function () {
          props.onRemove(item)
        },
      },
      '\u00d7',
    ),
  )
}

function selectionLimitText(t, count, dropped, maxObjects) {
  if (dropped > 0) return t('selection.limitWarning', { max: maxObjects, dropped: dropped })
  if (count >= maxObjects) return t('selection.limitFull', { max: maxObjects })
  return ''
}

function OverlaySelectionBar(props) {
  const t = props.t
  const items = Array.isArray(props.items) ? props.items : []
  const maxObjects = clampInt(props.maxObjects, 1, 200, LIMITS.selectionMaxObjects)
  const dropped = typeof props.dropped === 'number' && props.dropped > 0 ? props.dropped : 0
  const limitText = selectionLimitText(t, items.length, dropped, maxObjects)
  const chips = items.map(function (item) {
    return h(SelectionChip, {
      key: selectionRefOfDescriptor(item),
      item: item,
      t: t,
      onRemove: function (value) {
        props.onRemove(value)
      },
    })
  })
  return h(
    'div',
    { className: 'tg-overlay-selection', role: 'status', 'data-dsh-telegram': 'selection' },
    h('span', { className: 'tg-overlay-selection-label' }, t('selection.count', { count: items.length })),
    h('div', { className: 'tg-overlay-selection-list', 'data-dsh-telegram': 'selection-chips' }, chips),
    h(
      'div',
      { className: 'tg-overlay-selection-actions' },
      limitText !== ''
        ? h('span', { className: 'tg-overlay-limit', role: 'status', 'data-dsh-telegram': 'selection-limit' }, limitText)
        : null,
      h(
        'button',
        {
          type: 'button',
          className: 'tg-btn',
          'data-dsh-telegram': 'selection-comment',
          onClick: function () {
            props.onOpenComment()
          },
        },
        t('selection.comment'),
      ),
      h(
        'button',
        {
          type: 'button',
          className: 'tg-btn',
          'data-dsh-telegram': 'selection-clear',
          onClick: function () {
            props.onClear()
          },
        },
        t('selection.clear'),
      ),
    ),
  )
}

function OverlayToolbar(props) {
  const t = props.t
  const selection = props.selection
  const mode = selection.mode === true
  const count = Array.isArray(selection.items) ? selection.items.length : 0
  return h(
    'div',
    {
      className: 'tg-overlay-toolbar',
      role: 'toolbar',
      'aria-label': t('selection.aria'),
      'data-dsh-telegram': 'selection-toolbar',
    },
    h(
      'button',
      {
        type: 'button',
        className: classNameOf('tg-btn', 'tg-overlay-select-toggle', { 'is-primary': mode }),
        'data-dsh-telegram': 'selection-toggle',
        'aria-pressed': mode === true ? 'true' : 'false',
        title: mode === true ? t('selection.toggleOffHint') : t('selection.toggleOnHint'),
        onClick: function () {
          selection.toggleMode()
        },
      },
      mode === true ? t('selection.toggleOff') : t('selection.toggleOn'),
    ),
    h(
      'span',
      { className: 'tg-overlay-toolbar-hint', 'data-dsh-telegram': 'selection-hint' },
      mode === true ? t('selection.modeHint') : t('selection.count', { count: count }),
    ),
    count > 0
      ? h(
          'button',
          {
            type: 'button',
            className: 'tg-btn',
            'data-dsh-telegram': 'open-comment',
            onClick: function () {
              props.onOpenComment()
            },
          },
          t('selection.comment'),
        )
      : null,
  )
}

// The marquee band and the comment window are the two DOM-only pieces of the
// selection wave; the model and the serializer stay in 65-selection.js.
function OverlayCommentWindow(props) {
  return h(CommentDialog, props)
}

//#endregion

function OverlayRoot(props) {
  const safeProps = isRecord(props) ? props : {}
  const ctx = safeProps.ctx
  const slot = isRecord(safeProps.slot) ? safeProps.slot : null
  const i18n = useI18n(ctx, slot)
  const t = i18n.t
  const lang = i18n.lang
  const overlay = useOverlayState()
  const open = overlay.open
  const health = useLauncherHealth(ctx, open)
  const launcherRef = useRef(null)
  const panelRef = useRef(null)
  const screenRef = useRef(null)
  const selection = useSelection()
  const activeSession = useActiveSession(ctx, open)
  const bandPair = useState(null)
  const dragRef = useRef(null)
  const noticePair = useState('')
  const sendBusyPair = useState(false)
  const sendErrorPair = useState('')
  const modePair = useState('queue')
  const capturedAtRef = useRef('')

  const selectedRefs = selection.items.map(function (item) {
    return selectionRefOfDescriptor(item)
  })
  const limitText = selectionLimitText(t, selection.items.length, selection.dropped, LIMITS.selectionMaxObjects)

  // The comment text and the "is the window open" flag live in the module
  // mirror inside 65 so a remount cannot lose a half-typed prompt.
  if (selection.commentOpen === true && capturedAtRef.current === '') {
    capturedAtRef.current = new Date().toISOString()
  }
  if (selection.commentOpen !== true) capturedAtRef.current = ''
  const promptText = selection.commentOpen === true
    ? buildPrompt(selection.items, selection.note, {
        capturedAt: capturedAtRef.current === '' ? new Date().toISOString() : capturedAtRef.current,
        promptMaxChars: LIMITS.promptMaxChars,
        noteMaxChars: LIMITS.noteMaxChars,
        maxObjects: LIMITS.selectionMaxObjects,
        textPerObject: LIMITS.selectionTextPerObject,
      })
    : ''

  // Toast lifetime belongs to the overlay; any producer only sets the notice.
  useEffect(function () {
    if (noticePair[0] === '') return function () {}
    if (typeof setTimeout !== 'function') return function () {}
    const timer = setTimeout(function () {
      noticePair[1]('')
    }, TOAST_MS)
    return function () {
      clearTimeout(timer)
    }
  }, [noticePair[0]])

  // The profile "Select" action is explicit: it toggles the profile object even
  // outside the selection mode, because the user named the object directly.
  const selectProfile = useCallback(function (profile) {
    const descriptor = selectionDescriptorOfProfile(profile)
    if (descriptor === null) return
    selection.toggle(descriptor)
  }, [selection.toggle])

  const toggleSelection = useCallback(function (descriptor) {
    if (selection.mode !== true) return
    if (isRecord(descriptor) !== true) return
    const result = selection.toggle(descriptor)
    if (result !== null && result !== undefined && result.dropped > 0) {
      noticePair[1](t('selection.limitWarning', { max: LIMITS.selectionMaxObjects, dropped: result.dropped }))
    }
  }, [selection.mode, selection.toggle, t])

  const openComment = useCallback(function () {
    if (selection.items.length === 0) return
    sendErrorPair[1]('')
    selection.openComment()
  }, [selection.items.length, selection.openComment])

  const closeComment = useCallback(function () {
    selection.closeComment()
    sendErrorPair[1]('')
  }, [selection.closeComment])

  const discardComment = useCallback(function () {
    selection.setNote('')
    sendErrorPair[1]('')
    selection.closeComment()
  }, [selection.setNote, selection.closeComment])

  const clearSelection = useCallback(function () {
    selection.clear()
    sendErrorPair[1]('')
    selection.setNote('')
  }, [selection.clear, selection.setNote])

  const performCopy = useCallback(function () {
    copyPromptToClipboard(promptText).then(function (copied) {
      noticePair[1](copied === true ? t('comment.copied') : t('comment.copyFailed'))
    })
  }, [promptText, t])

  // The only path from the UI into the session. It is reachable from the Send
  // click of the comment window (and from the "Open in a new session" click
  // when there is no active session); nothing calls it from an effect.
  const performSend = useCallback(function () {
    if (sendBusyPair[0] === true) return
    if (promptText === '') {
      sendErrorPair[1](t('comment.promptEmpty'))
      return
    }
    if (activeSession === null) {
      if (openPromptInNewSession(ctx, promptText) === true) {
        noticePair[1](t('comment.draftOpened'))
        selection.setNote('')
        selection.clear()
        selection.closeComment()
        return
      }
      sendErrorPair[1](t('comment.noWorkspace'))
      return
    }
    const target = activeSession
    sendBusyPair[1](true)
    sendErrorPair[1]('')
    sendPromptToSession(ctx, target.id, promptText, modePair[0]).then(function (result) {
      sendBusyPair[1](false)
      if (result.ok === true) {
        noticePair[1](t('comment.sent', { title: target.title }))
        selection.setNote('')
        selection.clear()
        selection.closeComment()
        return
      }
      const detail = errorText({ code: result.code, message: result.message }, t)
      sendErrorPair[1](t('comment.error', { message: detail }))
    })
  }, [promptText, activeSession, ctx, t, modePair[0], sendBusyPair[0], selection.setNote, selection.clear, selection.closeComment])

  // Alt+Shift+T toggles the overlay without a shortcut service; typing into a
  // field is never intercepted (DESIGN-v0.2 2.3).
  useEffect(function () {
    if (typeof document === 'undefined' || document === null || typeof document.addEventListener !== 'function') return function () {}
    function onKeyDown(event) {
      if (event === null || event === undefined) return
      if (event.altKey !== true || event.shiftKey !== true) return
      if (event.ctrlKey === true || event.metaKey === true) return
      const key = typeof event.key === 'string' ? event.key.toLowerCase() : ''
      const code = typeof event.code === 'string' ? event.code : ''
      if (key !== 't' && code !== 'KeyT') return
      if (isEditableTarget(event.target) === true) return
      if (typeof event.preventDefault === 'function') event.preventDefault()
      overlay.toggle()
    }
    document.addEventListener('keydown', onKeyDown)
    return function () {
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [overlay.toggle])

  // Escape closes the overlay, except when a nested layer (sign-out
  // confirmation, comment window) holds a blocker. Tab is trapped inside the
  // dialog; closing returns focus to the element that opened it (the launcher,
  // normally).
  useEffect(function () {
    if (open !== true) return function () {}
    if (typeof document === 'undefined' || document === null) return function () {}
    const previous = document.activeElement
    const panel = panelRef.current
    const initial = focusableElements(panel)
    if (initial.length > 0) {
      try {
        initial[0].focus()
      } catch (error) {
        // A focus call on a detached node is not an overlay failure.
      }
    } else if (panel !== null && panel !== undefined && typeof panel.focus === 'function') {
      panel.focus()
    }
    function onKeyDown(event) {
      if (event === null || event === undefined) return
      if (event.key === 'Escape') {
        if (hasEscapeBlocker() === true) return
        if (typeof event.preventDefault === 'function') event.preventDefault()
        overlay.close()
        return
      }
      if (event.key !== 'Tab') return
      const current = focusableElements(panelRef.current)
      if (current.length === 0) return
      const first = current[0]
      const last = current[current.length - 1]
      const activeNode = document.activeElement
      const inside = panelRef.current !== null && panelRef.current !== undefined && typeof panelRef.current.contains === 'function'
        ? panelRef.current.contains(activeNode)
        : false
      if (event.shiftKey === true) {
        if (inside !== true || activeNode === first) {
          if (typeof event.preventDefault === 'function') event.preventDefault()
          last.focus()
        }
      } else if (inside !== true || activeNode === last) {
        if (typeof event.preventDefault === 'function') event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return function () {
      document.removeEventListener('keydown', onKeyDown, true)
      const target = previous !== null && previous !== undefined && previous.isConnected !== false ? previous : launcherRef.current
      if (target !== null && target !== undefined && typeof target.focus === 'function') {
        try {
          target.focus()
        } catch (error) {
          // The previous element may be gone; the launcher is the fallback.
        }
      }
    }
  }, [open, overlay.close])

  // ---- marquee (DESIGN-v0.2 5.3) ----

  function marqueePoint(event) {
    const container = screenRef.current
    if (container === null || container === undefined || typeof container.getBoundingClientRect !== 'function') return null
    let box
    try {
      box = container.getBoundingClientRect()
    } catch (error) {
      return null
    }
    if (box === null || box === undefined) return null
    const clientX = typeof event.clientX === 'number' ? event.clientX : 0
    const clientY = typeof event.clientY === 'number' ? event.clientY : 0
    return { x: clientX - box.left, y: clientY - box.top, box: box }
  }

  // Pointer capture is an enhancement for a real drag (it keeps the band
  // updating when the pointer leaves the panel). It must NOT be taken on
  // pointerdown: capture retargets the following pointerup/click to this screen,
  // so a single click on a chat row or a message row would never reach its own
  // onClick and click-to-select would be dead (D4 of the t9 verification).
  function capturePointer(event) {
    try {
      if (event !== null && event !== undefined && event.currentTarget !== null && event.currentTarget !== undefined
        && typeof event.currentTarget.setPointerCapture === 'function' && typeof event.pointerId === 'number') {
        event.currentTarget.setPointerCapture(event.pointerId)
        return true
      }
    } catch (error) {
      // Pointer capture is an enhancement; the band still renders without it.
    }
    return false
  }

  function releasePointer(event, pointerId) {
    try {
      const id = typeof pointerId === 'number'
        ? pointerId
        : event !== null && event !== undefined && typeof event.pointerId === 'number'
          ? event.pointerId
          : null
      if (id !== null && event !== null && event !== undefined && event.currentTarget !== null && event.currentTarget !== undefined
        && typeof event.currentTarget.releasePointerCapture === 'function') {
        event.currentTarget.releasePointerCapture(id)
      }
    } catch (error) {
      // Releasing a capture the browser already dropped is harmless.
    }
  }

  function onScreenPointerDown(event) {
    if (selection.mode !== true) return
    if (event === null || event === undefined) return
    if (typeof event.button === 'number' && event.button !== 0) return
    if (selectionStartsDrag(event.target) !== true) return
    const point = marqueePoint(event)
    if (point === null) return
    // A drag candidate only: the browser keeps the pointerup/click on the row
    // until the gesture actually becomes a marquee in onScreenPointerMove.
    dragRef.current = {
      startX: point.x,
      startY: point.y,
      active: false,
      box: point.box,
      pointerId: typeof event.pointerId === 'number' ? event.pointerId : null,
      target: event.target === undefined ? null : event.target,
      captured: false,
    }
  }

  function onScreenPointerMove(event) {
    const drag = dragRef.current
    if (drag === null || drag === undefined) return
    const point = marqueePoint(event)
    if (point === null) return
    const dx = Math.abs(point.x - drag.startX)
    const dy = Math.abs(point.y - drag.startY)
    if (drag.active !== true) {
      if (dx < SELECTION_DRAG_THRESHOLD_PX && dy < SELECTION_DRAG_THRESHOLD_PX) return
      // The gesture is a real marquee now; capture so moves outside the panel
      // still update the band. This is the first and only capture of the drag.
      drag.active = true
      if (drag.pointerId === null && typeof event.pointerId === 'number') drag.pointerId = event.pointerId
      drag.captured = capturePointer(event) === true
    }
    drag.box = point.box
    if (typeof event.preventDefault === 'function') event.preventDefault()
    bandPair[1](selectionBandRect(drag.startX, drag.startY, point.x, point.y, point.box))
  }

  function onScreenPointerUp(event) {
    const drag = dragRef.current
    dragRef.current = null
    if (drag !== null && drag !== undefined && drag.captured === true) releasePointer(event, drag.pointerId)
    if (drag === null || drag === undefined) return
    if (drag.active !== true) {
      // No marquee: the browser dispatches the click on the original row (no
      // capture was taken), and the row's own onClick runs onToggleSelection.
      // Hit-testing here too would toggle the object twice.
      bandPair[1](null)
      return
    }
    const point = marqueePoint(event)
    const band = point === null ? null : selectionBandRect(drag.startX, drag.startY, point.x, point.y, drag.box)
    bandPair[1](null)
    selectionSuppressNextClick()
    if (band === null) return
    // `selectionBandRect` is container-relative (it also carries the viewport
    // origin as pageX/pageY), while `collectSelectionHits` reads node rects from
    // getBoundingClientRect(), which are viewport-relative. Hand it the viewport
    // rectangle or a marquee drawn around the rows misses everything by the
    // panel offset.
    const hitBand = {
      left: band.pageX,
      top: band.pageY,
      right: band.pageX + band.width,
      bottom: band.pageY + band.height,
      width: band.width,
      height: band.height,
    }
    const descriptors = collectSelectionHits(screenRef.current, hitBand, selection.resolveRef)
    if (descriptors.length === 0) {
      noticePair[1](t('selection.emptyRegion'))
      return
    }
    const result = selection.addMany(descriptors)
    if (result.dropped > 0) {
      noticePair[1](t('selection.limitWarning', { max: LIMITS.selectionMaxObjects, dropped: result.dropped }))
    }
  }

  function onScreenPointerCancel(event) {
    const drag = dragRef.current
    dragRef.current = null
    if (drag !== null && drag !== undefined && drag.captured === true) releasePointer(event, drag.pointerId)
    bandPair[1](null)
  }

  const backdrop = open === true
    ? h('div', {
        className: 'tg-overlay-backdrop',
        style: { pointerEvents: 'auto' },
        'data-dsh-telegram': 'backdrop',
        'aria-hidden': 'true',
        onClick: function () {
          if (hasEscapeBlocker() === true) return
          overlay.close()
        },
      })
    : null

  const toolbar = h(OverlayToolbar, {
    t: t,
    selection: selection,
    onOpenComment: openComment,
  })

  const screen = h(
    'div',
    {
      className: classNameOf('tg-overlay-screen', { 'is-selecting': selection.mode === true }),
      'data-dsh-telegram': 'screen',
      ref: screenRef,
      onPointerDown: onScreenPointerDown,
      onPointerMove: onScreenPointerMove,
      onPointerUp: onScreenPointerUp,
      onPointerCancel: onScreenPointerCancel,
    },
    h(TelegramPanel, {
      ctx: ctx,
      slot: slot,
      t: t,
      lang: lang,
      active: true,
      onClose: overlay.close,
      onSelectProfile: selectProfile,
      selectionMode: selection.mode === true,
      selectedRefs: selectedRefs,
      onToggleSelection: selection.mode === true ? toggleSelection : undefined,
      onRegisterSelection: selection.noteDescriptor,
    }),
    bandPair[0] === null || bandPair[0] === undefined
      ? null
      : h('div', {
          className: 'tg-selection-marquee',
          'data-dsh-telegram': 'marquee',
          'aria-hidden': 'true',
          style: {
            left: bandPair[0].left + 'px',
            top: bandPair[0].top + 'px',
            width: bandPair[0].width + 'px',
            height: bandPair[0].height + 'px',
          },
        }),
  )

  const selectionBar = selection.items.length > 0
    ? h(OverlaySelectionBar, {
        t: t,
        items: selection.items,
        dropped: selection.dropped,
        maxObjects: LIMITS.selectionMaxObjects,
        onRemove: function (item) {
          selection.remove(selectionRefOfDescriptor(item))
        },
        onClear: clearSelection,
        onOpenComment: openComment,
      })
    : null

  const commentWindow = selection.commentOpen === true
    ? h(OverlayCommentWindow, {
        t: t,
        items: selection.items,
        note: selection.note,
        prompt: promptText,
        promptMaxChars: LIMITS.promptMaxChars,
        noteMaxChars: LIMITS.noteMaxChars,
        target: activeSession,
        mode: modePair[0],
        busy: sendBusyPair[0] === true,
        error: sendErrorPair[0],
        limitWarning: limitText,
        onNote: selection.setNote,
        onMode: function (next) {
          modePair[1](next === 'steer' ? 'steer' : 'queue')
        },
        onRemove: function (item) {
          selection.remove(selectionRefOfDescriptor(item))
        },
        onClear: clearSelection,
        onSend: performSend,
        onOpenNew: performSend,
        onCopy: performCopy,
        onRequestClose: closeComment,
        onDiscard: discardComment,
      })
    : null

  const dialog = open === true
    ? h(
        'section',
        {
          className: 'tg-overlay-panel',
          style: { pointerEvents: 'auto' },
          id: OVERLAY_DOM_ID,
          ref: panelRef,
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': OVERLAY_ROOT_TITLE_ID,
          'data-dsh-telegram': 'overlay',
          tabIndex: -1,
        },
        h('h2', { className: 'tg-visually-hidden', id: OVERLAY_ROOT_TITLE_ID }, t('overlay.title')),
        h(
          'div',
          { className: 'tg-overlay-body' },
          toolbar,
          screen,
          selectionBar,
          commentWindow,
          noticePair[0] !== ''
            ? h('span', { className: 'tg-overlay-toast', role: 'status', 'data-dsh-telegram': 'overlay-toast' }, noticePair[0])
            : null,
        ),
      )
    : null

  return h(
    'div',
    { className: 'tg-overlay-root', style: { pointerEvents: 'none' }, 'data-dsh-telegram': 'overlay-root' },
    h(Launcher, {
      t: t,
      open: open,
      tone: health.tone,
      buttonRef: launcherRef,
      onToggle: overlay.toggle,
    }),
    backdrop,
    dialog,
  )
}
