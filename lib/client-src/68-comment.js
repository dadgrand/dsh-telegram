// 68-comment.js — the comment window and prompt delivery into the active DSH
// session (DESIGN-v0.2 4, 6; t4 contract).
//
// Delivery is the documented DSH path and nothing else:
//
//   ctx.sessions.using(sessionId, { source: 'dsh-telegram', signal }, ref =>
//     ref.ready.then(() => ref.binding.session.prompt([{ type: 'text', text }],
//                        'queue' | 'steer', signal)))
//
// `using` retains the exact Client generation, `binding.session.prompt` is the
// Host `@Remote('prompt')` call (DESIGN-v0.2 4.2), and the plugin adds no HTTP
// route, no event type and no second transport for prompts.
//
// The "active session" is the row with `retainedBy.mainView > 0`, which is the
// host's own definition (DESIGN-v0.2 4.1). No such row means there is no
// destination: the window says so in plain words and offers the documented
// fallback, `uiWorkspace.startSession(undefined, { prompt, whenDraftExists:
// 'append' })`, which prefills a composer for the user to send (4.3). Without
// the Workspace UI the prompt is offered for copying instead.
//
// Confirmation: `sendPromptToSession` is reachable only from the Send click in
// `CommentDialog` → the overlay's single `performSend` callback. Nothing here
// sends from an effect, a timer or a shortcut, and a closed window sends
// nothing. A Send click therefore *is* the explicit confirmation.
//
// Every rendered Telegram string is a React text node: no
// `dangerouslySetInnerHTML`, no markup injection. The prompt text itself comes
// from `buildPrompt` in 65-selection.js, which sanitizes and labels the
// untrusted Telegram payload.

const SESSION_SOURCE = 'dsh-telegram'
const COMMENT_TITLE_ID = 'dsh-telegram-comment-title'

function messageOfError(error) {
  if (error === null || error === undefined) return ''
  if (typeof error === 'string') return error
  if (typeof error === 'object' && typeof error.message === 'string') return error.message
  return ''
}

// `retainedBy.mainView > 0` — the same row DocumentTitle and ui-session use to
// decide which conversation is "open".
function activeSessionOf(state) {
  if (isRecord(state) !== true) return null
  const ids = Array.isArray(state.ids) ? state.ids : []
  const byId = isRecord(state.byId) ? state.byId : {}
  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index]
    const row = byId[id]
    if (isRecord(row) !== true) continue
    const retainedBy = isRecord(row.retainedBy) ? row.retainedBy : {}
    const mainView = typeof retainedBy.mainView === 'number' ? retainedBy.mainView : 0
    if (mainView <= 0) continue
    const title = typeof row.displayTitle === 'string' && row.displayTitle !== '' ? row.displayTitle : String(id)
    return { id: String(id), title: title, running: row.running === true }
  }
  return null
}

function useActiveSession(ctx, enabled) {
  // While the overlay is closed there is nothing to send to, so the
  // subscription is dropped — but the hook sequence stays identical on every
  // render (useSessionsStore -> useSnapshot always calls the subscription
  // hook). Skipping the hook itself crashed the slot entry on first open (D1).
  const state = useSessionsStore(ctx, enabled !== false)
  return activeSessionOf(state)
}

// RemoteResult is `{ ok: true, value }` or `{ ok: false, error }`; the session
// face is documented as `RemoteResult<{ accepted: true }>`. A test or an older
// build may hand back `{ ok: true, data }`, which is accepted as success too.
function promptFailureOf(result) {
  if (result === null || result === undefined) return { code: 'prompt_failed', message: '' }
  if (isRecord(result) !== true) return { code: 'prompt_failed', message: '' }
  if (result.ok === true) return null
  const error = isRecord(result.error) ? result.error : null
  return {
    code: error !== null && typeof error.code === 'string' && error.code !== '' ? error.code : 'prompt_failed',
    message: error !== null && typeof error.message === 'string' ? error.message : '',
  }
}

// Resolves to a plain result, never rejects: the overlay only renders it.
function sendPromptToSession(ctx, sessionId, text, mode, signal) {
  const sessions = ctx !== null && ctx !== undefined && typeof ctx.get === 'function' ? ctx.get('sessions') : null
  if (sessions === null || sessions === undefined || typeof sessions.using !== 'function') {
    return Promise.resolve({ ok: false, code: 'sessions_unavailable', message: '' })
  }
  if (typeof sessionId !== 'string' || sessionId === '') {
    return Promise.resolve({ ok: false, code: 'no_session', message: '' })
  }
  if (typeof text !== 'string' || text.trim() === '') {
    return Promise.resolve({ ok: false, code: 'empty_prompt', message: '' })
  }
  const useMode = mode === 'steer' ? 'steer' : 'queue'
  const options = signal === undefined || signal === null
    ? { source: SESSION_SOURCE }
    : { source: SESSION_SOURCE, signal: signal }
  let pending
  try {
    pending = sessions.using(sessionId, options, function (reference) {
      return Promise.resolve(reference.ready).then(function (binding) {
        const target = isRecord(binding) && isRecord(binding.session) ? binding.session : null
        if (target === null || typeof target.prompt !== 'function') {
          return { ok: false, error: { code: 'sessions_unavailable', message: '' } }
        }
        return target.prompt([{ type: 'text', text: text }], useMode, signal)
      })
    })
  } catch (error) {
    return Promise.resolve({ ok: false, code: 'prompt_failed', message: messageOfError(error) })
  }
  return Promise.resolve(pending).then(
    function (result) {
      const failure = promptFailureOf(result)
      if (failure === null) return { ok: true, code: '', message: '' }
      return { ok: false, code: failure.code, message: failure.message }
    },
    function (error) {
      return { ok: false, code: 'prompt_failed', message: messageOfError(error) }
    },
  )
}

// DESIGN-v0.2 4.3: with no active session the prompt goes into the composer of
// a (reused) blank session; the user stays in control of sending it.
function openPromptInNewSession(ctx, text) {
  if (typeof text !== 'string' || text.trim() === '') return false
  const workspace = ctx !== null && ctx !== undefined && typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : null
  if (workspace === null || workspace === undefined || typeof workspace.startSession !== 'function') return false
  try {
    workspace.startSession(undefined, { prompt: text, whenDraftExists: 'append' })
    return true
  } catch (error) {
    return false
  }
}

function copyPromptToClipboard(text) {
  if (typeof text !== 'string' || text === '') return Promise.resolve(false)
  try {
    const clipboard = typeof navigator !== 'undefined' && navigator !== null ? navigator.clipboard : null
    if (clipboard === null || clipboard === undefined || typeof clipboard.writeText !== 'function') return Promise.resolve(false)
    return Promise.resolve(clipboard.writeText(text)).then(
      function () {
        return true
      },
      function () {
        return false
      },
    )
  } catch (error) {
    return Promise.resolve(false)
  }
}

// The comment window. It is a non-modal dialog *inside* the overlay dialog: the
// Telegram panel stays usable, and a Shift-click or a second marquee updates
// the chips while the window is open (DESIGN-v0.2 5.2). It pushes an Escape
// blocker so Escape closes the window, not the whole overlay.
function CommentDialog(props) {
  const t = typeof props.t === 'function' ? props.t : dictionaryTranslate('en')
  const items = Array.isArray(props.items) ? props.items : []
  const note = typeof props.note === 'string' ? props.note : ''
  const prompt = typeof props.prompt === 'string' ? props.prompt : ''
  const target = isRecord(props.target) ? props.target : null
  const busy = props.busy === true
  const error = typeof props.error === 'string' ? props.error : ''
  const limitWarning = typeof props.limitWarning === 'string' ? props.limitWarning : ''
  const mode = props.mode === 'steer' ? 'steer' : 'queue'
  const noteMax = clampInt(props.noteMaxChars, 100, 2000, LIMITS.noteMaxChars)
  const promptMax = clampInt(props.promptMaxChars, 200, 20000, LIMITS.promptMaxChars)
  const discardPair = useState(false)
  const textareaRef = useRef(null)
  const canSend = prompt !== '' && target !== null && busy !== true
  const canOpenNew = prompt !== '' && target === null && busy !== true && typeof props.onOpenNew === 'function'

  // Closing a window with a typed comment asks inline; an empty comment closes
  // silently and keeps the selection (DESIGN-v0.2 6.2).
  function requestClose() {
    if (busy === true) return
    if (note.trim() !== '') {
      discardPair[1](true)
      return
    }
    if (typeof props.onRequestClose === 'function') props.onRequestClose()
  }

  // Focus the textarea on open (DESIGN-v0.2 6.2). A missing browser (tests,
  // SSR) is not an error.
  useEffect(function () {
    const node = textareaRef.current
    if (node === null || node === undefined || typeof node.focus !== 'function') return
    try {
      node.focus()
    } catch (errorValue) {
      // The node may already be detached.
    }
  }, [])

  // Escape closes this layer, not the overlay. With a non-empty comment the
  // user gets an inline confirmation instead of losing the text.
  useEffect(function () {
    if (typeof document === 'undefined' || document === null || typeof document.addEventListener !== 'function') {
      return function () {}
    }
    const releaseBlocker = pushEscapeBlocker()
    function onKeyDown(event) {
      if (event === null || event === undefined) return
      if (event.key !== 'Escape') return
      if (typeof event.preventDefault === 'function') event.preventDefault()
      if (discardPair[0] === true) {
        discardPair[1](false)
        return
      }
      requestClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return function () {
      releaseBlocker()
      try {
        document.removeEventListener('keydown', onKeyDown)
      } catch (listenerError) {
        // The document is already gone.
      }
    }
  }, [discardPair[0], note, busy, props.onRequestClose])

  const chips = items.map(function (item) {
    const ref = selectionRefOfDescriptor(item)
    const label = selectionChipLabel(item, t)
    const kind = isRecord(item) && typeof item.kind === 'string' ? item.kind : ''
    return h(
      'span',
      {
        className: 'tg-overlay-chip',
        key: ref === '' ? label : ref,
        'data-tg-chip-kind': kind,
        'data-tg-chip-ref': ref,
        title: label,
      },
      h('span', { className: 'tg-overlay-chip-label' }, label),
      h(
        'button',
        {
          type: 'button',
          className: 'tg-overlay-chip-remove',
          'aria-label': t('overlay.removeSelection', { title: label }),
          onClick: function () {
            if (typeof props.onRemove === 'function') props.onRemove(item)
          },
        },
        '\u00d7',
      ),
    )
  })

  let targetLabel = t('comment.noSession')
  if (target !== null) {
    targetLabel = target.running === true ? t('comment.targetRunning', { title: target.title }) : t('comment.target', { title: target.title })
  }

  return h(
    'section',
    {
      className: 'tg-comment',
      role: 'dialog',
      'aria-modal': 'false',
      'aria-labelledby': COMMENT_TITLE_ID,
      'data-dsh-telegram': 'comment',
      'data-tg-noselect': 'true',
    },
    h(
      'header',
      { className: 'tg-comment-head' },
      h('h3', { className: 'tg-comment-title', id: COMMENT_TITLE_ID }, t('comment.title')),
      h('span', { className: classNameOf('tg-comment-target', { 'is-missing': target === null }), 'data-dsh-telegram': 'comment-target' }, targetLabel),
      h(
        'button',
        {
          type: 'button',
          className: 'tg-icon-btn tg-comment-close',
          'data-dsh-telegram': 'comment-close',
          'aria-label': t('comment.close'),
          title: t('comment.close'),
          onClick: function () {
            requestClose()
          },
        },
        '\u00d7',
      ),
    ),
    h(
      'div',
      { className: 'tg-comment-chips', 'data-dsh-telegram': 'comment-chips' },
      chips,
      h(
        'button',
        {
          type: 'button',
          className: 'tg-btn tg-comment-clear',
          'data-dsh-telegram': 'comment-clear',
          onClick: function () {
            if (typeof props.onClear === 'function') props.onClear()
          },
        },
        t('selection.clear'),
      ),
    ),
    limitWarning !== ''
      ? h('p', { className: 'tg-comment-warning', role: 'status', 'data-dsh-telegram': 'comment-limit' }, limitWarning)
      : null,
    h('textarea', {
      ref: textareaRef,
      className: 'tg-textarea tg-comment-note',
      rows: 3,
      placeholder: t('comment.placeholder'),
      'aria-label': t('comment.noteAria'),
      'data-dsh-telegram': 'comment-note',
      value: note,
      disabled: busy === true,
      onChange: function (event) {
        const value = event !== null && event !== undefined && event.target !== undefined ? event.target.value : ''
        if (typeof props.onNote === 'function') props.onNote(typeof value === 'string' ? value : '')
      },
    }),
    h(
      'div',
      { className: 'tg-comment-meta' },
      h('span', { className: 'tg-counter' }, t('comment.counter', { count: note.length, max: noteMax })),
      h('span', { className: 'tg-comment-untrusted' }, t('comment.untrusted')),
      h('span', { className: 'tg-counter' }, t('comment.promptCounter', { count: prompt.length, max: promptMax })),
    ),
    h(
      'details',
      { className: 'tg-comment-preview', 'data-dsh-telegram': 'comment-preview' },
      h('summary', null, t('comment.preview')),
      h('pre', { className: 'tg-comment-prompt' }, prompt === '' ? t('comment.promptEmpty') : prompt),
    ),
    target !== null && target.running === true
      ? h(
          'div',
          { className: 'tg-comment-modes', role: 'group', 'aria-label': t('comment.modeAria') },
          h(
            'label',
            { className: 'tg-comment-mode' },
            h('input', {
              type: 'radio',
              name: 'tg-comment-mode',
              value: 'queue',
              checked: mode === 'queue',
              onChange: function () {
                if (typeof props.onMode === 'function') props.onMode('queue')
              },
            }),
            t('comment.modeQueue'),
          ),
          h(
            'label',
            { className: 'tg-comment-mode' },
            h('input', {
              type: 'radio',
              name: 'tg-comment-mode',
              value: 'steer',
              checked: mode === 'steer',
              onChange: function () {
                if (typeof props.onMode === 'function') props.onMode('steer')
              },
            }),
            t('comment.modeSteer'),
          ),
        )
      : null,
    error !== ''
      ? h('p', { className: 'tg-comment-error', role: 'alert', 'data-dsh-telegram': 'comment-error' }, error)
      : null,
    discardPair[0] === true
      ? h(
          'div',
          { className: 'tg-comment-discard', role: 'alertdialog', 'aria-label': t('comment.discard') },
          h('p', { className: 'tg-comment-discard-text' }, t('comment.discard')),
          h(
            'div',
            { className: 'tg-comment-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'tg-btn',
                'data-dsh-telegram': 'comment-discard-keep',
                onClick: function () {
                  discardPair[1](false)
                },
              },
              t('comment.discardKeep'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'tg-btn is-danger',
                'data-dsh-telegram': 'comment-discard-confirm',
                onClick: function () {
                  discardPair[1](false)
                  if (typeof props.onDiscard === 'function') props.onDiscard()
                },
              },
              t('comment.discardConfirm'),
            ),
          ),
        )
      : null,
    discardPair[0] === true
      ? null
      : h(
          'div',
          { className: 'tg-comment-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'tg-btn',
              'data-dsh-telegram': 'comment-cancel',
              onClick: function () {
                requestClose()
              },
            },
            t('comment.cancel'),
          ),
          target === null && typeof props.onCopy === 'function'
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'tg-btn',
                  'data-dsh-telegram': 'comment-copy',
                  onClick: function () {
                    props.onCopy()
                  },
                },
                t('comment.copy'),
              )
            : null,
          target !== null
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'tg-btn is-primary tg-comment-send',
                  'data-dsh-telegram': 'comment-send',
                  'aria-busy': busy === true ? 'true' : undefined,
                  disabled: canSend !== true,
                  onClick: function () {
                    if (canSend !== true) return
                    props.onSend()
                  },
                },
                busy === true ? t('comment.sending') : t('comment.send', { title: target.title }),
              )
            : h(
                'button',
                {
                  type: 'button',
                  className: 'tg-btn is-primary tg-comment-send',
                  'data-dsh-telegram': 'comment-open-new',
                  'aria-busy': busy === true ? 'true' : undefined,
                  disabled: canOpenNew !== true,
                  onClick: function () {
                    if (canOpenNew !== true) return
                    props.onOpenNew()
                  },
                },
                busy === true ? t('comment.sending') : t('comment.openNew'),
              ),
        ),
  )
}
