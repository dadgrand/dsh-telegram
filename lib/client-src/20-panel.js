// 20-panel.js — the Telegram panel composition reused by the overlay
// (DESIGN.md 6.2, DESIGN-v0.2 3.2, 7).
//
// This fragment owns the panel shell only: status polling, the connection
// strip, the sign-out confirmation, the error boundary and the three-pane
// layout. The panes themselves live in 30-chatlist.js, 40-thread.js,
// 50-composer.js, 55-profile.js and 60-login.js.
//
// `TelegramPanel({ ctx, active, slot, t, lang })` is the whole core screen. It
// renders list + thread + composer (or the sign-in screen) inside a plain
// container; t3 mounts it inside `shell.overlay` and t4 adds selection and the
// comment window around it. No slot registration happens here: the overlay row
// is owned by 90-register.js of the overlay wave (DESIGN-v0.2 3.3).
//
// Polling pauses when `active` is false or the document is hidden
// (DESIGN-v0.2 7.7). Every request goes through apiRequest, so a stale poll is
// aborted by the next one.

//#region Hooks

// Slot props may carry `t` when a registration passes `locale: NS`; otherwise
// the namespace-bound translator is used. The generated DICT is always the
// final fallback.
function useI18n(ctx, slotProps) {
  const language = activeLanguage(ctx)
  const supplied = slotProps !== null && slotProps !== undefined && typeof slotProps.t === 'function' ? slotProps.t : null
  const translate = useMemo(function () {
    return supplied === null ? boundTranslate(ctx) : supplied
  }, [supplied, ctx, language])
  return { t: translate, lang: language }
}

// The overlay is either open (`active === true`) or closed. The panel also
// follows `ctx.layout.panelInfo.activePanelId` when it is mounted as a main
// panel by an embedding host, so polling stops when another panel is selected.
// `useActivePanelId` is called unconditionally: returning before a hook based on
// the `explicit` prop is the same Rules-of-Hooks class of bug as D1.
function usePanelActive(ctx, explicit) {
  const selected = useActivePanelId(ctx)
  if (explicit === false || explicit === true) return explicit
  return selected === null || selected === PANEL_ID
}

//#endregion

//#region Status polling (DESIGN-v0.2 8.3, 7.7)

function applyHostStatus(store, payload) {
  const host = isRecord(payload) && isRecord(payload.state) ? payload.state : isRecord(payload) ? payload : null
  if (host === null) {
    store.set({
      engineStatus: 'error',
      error: { code: 'internal_error', message: '', retryAfterMs: null },
      updatedAt: Date.now(),
    })
    return
  }
  store.set({
    engineStatus: 'ready',
    host: host,
    configured: host.configured === true,
    engineAvailable: host.engineAvailable === true,
    connected: host.connected === true,
    loggedIn: host.loggedIn === true,
    loginStage: typeof host.loginStage === 'string' ? host.loginStage : 'idle',
    loginPhone: typeof host.phone === 'string' ? host.phone : '',
    status: typeof host.status === 'string' ? host.status : 'idle',
    proxy: isRecord(host.proxy) ? host.proxy : null,
    diagnostics: isRecord(host.diagnostics) ? host.diagnostics : null,
    config: isRecord(payload) && isRecord(payload.config) ? payload.config : store.get().config,
    error: host.lastError !== null && host.lastError !== undefined
      ? { code: host.lastError.code, message: host.lastError.message, retryAfterMs: null }
      : null,
    updatedAt: Date.now(),
  })
}

// The panel shell owns the engine/session snapshot; fragments never call
// /status themselves (DESIGN-v0.2 3.4 "keep the subscribed slice small").
function useHostStatus(ctx, store, active) {
  const attempt = useState(0)
  const refresh = useCallback(function () {
    attempt[1](function (current) {
      return current + 1
    })
  }, [])
  useEffect(function () {
    if (active !== true) return function () {}
    let cancelled = false
    let timer = null
    function load() {
      if (cancelled === true) return
      if (documentVisible() !== true) return
      store.set({ engineStatus: 'loading' })
      apiRequest('GET', apiUrl(ROUTES.status)).then(function (reply) {
        if (cancelled === true) return
        if (reply.ok === true) {
          applyHostStatus(store, reply.data)
          return
        }
        store.set({
          engineStatus: 'error',
          configured: reply.code === 'not_configured' ? false : store.get().configured,
          engineAvailable: reply.code === 'engine_unavailable' ? false : store.get().engineAvailable,
          loggedIn: false,
          connected: false,
          error: { code: reply.code, message: reply.message, retryAfterMs: reply.retryAfterMs },
          updatedAt: Date.now(),
        })
      })
    }
    load()
    if (typeof setInterval === 'function') {
      timer = setInterval(function () {
        if (documentVisible() === true) load()
      }, POLL_STATUS_MS)
    }
    const releaseVisibility = onVisibilityChange(function (visible) {
      if (visible === true) load()
    })
    return function () {
      cancelled = true
      if (timer !== null && typeof clearInterval === 'function') clearInterval(timer)
      releaseVisibility()
      abortRequests(ROUTES.status)
    }
  }, [ctx, store, active, attempt[0]])
  return refresh
}

//#endregion

//#region Header

function accountLabel(state) {
  const host = state.host
  if (host === null || host === undefined) return ''
  if (typeof host.title === 'string' && host.title !== '') return host.title
  if (typeof host.phone === 'string' && host.phone !== '') return host.phone
  return ''
}

function connectionKey(state) {
  if (state.configured === false) return 'state.notConfigured'
  if (state.engineAvailable === false) return 'state.engineUnavailable'
  if (state.status === 'connection_failed') return 'state.connectionFailed'
  if (state.engineStatus === 'loading' && state.host === null) return 'state.connecting'
  if (state.loggedIn === true && state.connected === true) return 'state.connected'
  if (state.loginStage === 'qr_waiting') return 'state.qrWaiting'
  if (state.loginStage === 'awaiting_2fa') return 'state.awaitingPassword'
  if (state.loginStage === 'code_sent') return 'state.awaitingCode'
  if (state.loggedIn !== true) return 'state.needsAuth'
  return 'state.connecting'
}

function connectionTone(state) {
  if (state.configured === false) return 'warn'
  if (state.engineAvailable === false) return 'warn'
  if (state.error !== null && state.error.code !== 'not_configured') return 'warn'
  if (state.status === 'connection_failed') return 'warn'
  if (state.loggedIn === true && state.connected === true) return 'ok'
  return 'idle'
}

function connectionText(t, state) {
  if (state.loggedIn === true && state.connected === true) {
    const account = accountLabel(state)
    return account === '' ? t('state.connected') : t('state.account', { name: account })
  }
  return t(connectionKey(state))
}

// «Sign out» is a user action: the POST /logout confirmation lives here
// (DESIGN-v0.2 7.4).
function ConnectionStrip(props) {
  const t = props.t
  const lang = props.lang
  const state = props.state
  const tone = connectionTone(state)
  const loggingOut = state.busy === 'logout'
  return h(
    'header',
    { className: 'tg-strip', 'data-dsh-telegram': 'strip' },
    h('h2', { className: 'tg-title' }, props.title !== undefined ? props.title : t('panel.title')),
    h(
      'span',
      { className: 'tg-strip-state' },
      h('span', { className: classNameOf('tg-dot', { 'is-ok': tone === 'ok', 'is-warn': tone === 'warn' }) }),
      h('span', { className: 'tg-strip-label', title: connectionText(t, state) }, connectionText(t, state)),
      state.updatedAt > 0
        ? h('span', { className: 'tg-strip-time' }, t('state.updated', { time: formatTime(Math.round(state.updatedAt / 1000), lang) }))
        : null,
    ),
    h(
      'div',
      { className: 'tg-strip-actions' },
      props.onProfile !== undefined
        ? h('button', { type: 'button', className: 'tg-btn', onClick: props.onProfile }, t('profile.open'))
        : null,
      h(
        'button',
        {
          type: 'button',
          className: 'tg-btn',
          'data-dsh-telegram': 'refresh',
          onClick: props.onRefresh,
          disabled: state.engineStatus === 'loading',
        },
        t('panel.refresh'),
      ),
      state.loggedIn === true
        ? h(
            'button',
            {
              type: 'button',
              className: classNameOf('tg-btn', 'is-danger', { 'is-busy': loggingOut }),
              'data-dsh-telegram': 'logout',
              onClick: props.onRequestLogout,
              disabled: loggingOut === true,
            },
            loggingOut === true ? t('logout.busy') : t('logout.button'),
          )
        : null,
      // The overlay passes onClose; a standalone panel keeps no close control of
      // its own (backwards compatible: absent prop = absent button).
      props.onClose !== undefined
        ? h(
            'button',
            {
              type: 'button',
              className: 'tg-icon-btn tg-strip-close',
              'data-dsh-telegram': 'close',
              'aria-label': t('overlay.close'),
              title: t('overlay.close'),
              onClick: props.onClose,
            },
            '\u00d7',
          )
        : null,
    ),
  )
}

function WarningStrip(props) {
  const t = props.t
  const text = typeof props.text === 'string' ? props.text : ''
  if (text === '') return null
  const tone = props.tone === 'error' ? 'error' : props.tone === 'warn' ? 'warn' : 'info'
  const retryAfterMs = typeof props.retryAfterMs === 'number' ? props.retryAfterMs : 0
  const retryLabel = typeof props.retryLabel === 'string' && props.retryLabel !== '' ? props.retryLabel : t('state.retry')
  return h(
    'div',
    { className: classNameOf('tg-warning', { 'is-error': tone === 'error', 'is-warn': tone === 'warn' }), role: tone === 'error' ? 'alert' : 'status' },
    h(
      'span',
      { className: 'tg-warning-text' },
      retryAfterMs > 0 ? t('state.retryAfter', { seconds: Math.ceil(retryAfterMs / 1000) }) + ' ' + text : text,
    ),
    typeof props.onRetry === 'function'
      ? h('button', { type: 'button', className: 'tg-btn tg-warning-retry', onClick: props.onRetry }, retryLabel)
      : null,
  )
}

function NotConfiguredNotice(props) {
  const t = props.t
  return h(
    'div',
    { className: 'tg-notice', 'data-dsh-telegram': 'not-configured' },
    h(
      'div',
      { className: 'tg-state' },
      h('h3', { className: 'tg-state-title' }, t('state.notConfiguredTitle')),
      h('p', { className: 'tg-state-body' }, t('state.notConfiguredBody')),
      h('p', { className: 'tg-state-hint' }, t('state.notConfiguredHint')),
    ),
  )
}

// A connection failure is diagnosable (DESIGN-v0.2 10.4): one hint line plus a
// disclosure with the secret-free Host diagnostics.
function ConnectionFailedNotice(props) {
  const t = props.t
  const state = props.state
  const host = isRecord(state.host) ? state.host : null
  const diagnostics = host !== null && isRecord(host.diagnostics) ? host.diagnostics : null
  const proxy = diagnostics !== null && isRecord(diagnostics.proxy) ? diagnostics.proxy : host !== null && isRecord(host.proxy) ? host.proxy : null
  const hint = proxy !== null && proxy.mode !== 'direct'
    ? t('state.proxyHint', { mode: String(proxy.mode), host: String(proxy.host), port: String(proxy.port) })
    : t('state.directHint')
  return h(
    'div',
    { className: 'tg-notice', 'data-dsh-telegram': 'connection-failed' },
    h(
      'div',
      { className: 'tg-state' },
      h('h3', { className: 'tg-state-title' }, t('state.connectionFailedTitle')),
      h('p', { className: 'tg-state-body' }, hint),
      diagnostics !== null
        ? h(
            'details',
            { className: 'tg-diagnostics' },
            h('summary', null, t('state.diagnostics')),
            h(
              'dl',
              null,
              h('dt', null, t('state.diagCode')),
              h('dd', null, String(diagnostics.code)),
              h('dt', null, t('state.diagPhase')),
              h('dd', null, String(diagnostics.phase)),
              h('dt', null, t('state.diagAttempts')),
              h('dd', null, String(diagnostics.attempts)),
              h('dt', null, t('state.diagLastError')),
              h('dd', null, String(diagnostics.lastError)),
            ),
          )
        : null,
      h('button', { type: 'button', className: 'tg-btn is-primary', onClick: props.onRetry }, t('state.retry')),
    ),
  )
}

// Escape closes the confirmation (DESIGN-v0.2 7.4). The blocker keeps the
// overlay from closing underneath this confirmation (10-utils).
function LogoutConfirm(props) {
  const t = props.t
  const busy = props.busy === true
  useEffect(function () {
    if (typeof document === 'undefined' || document === null || typeof document.addEventListener !== 'function') return function () {}
    const releaseBlocker = pushEscapeBlocker()
    function onKey(event) {
      if (event === null || event.key !== 'Escape') return
      if (busy === true) return
      props.onCancel()
    }
    document.addEventListener('keydown', onKey)
    return function () {
      releaseBlocker()
      try {
        document.removeEventListener('keydown', onKey)
      } catch (error) {
        // The document is already gone.
      }
    }
  }, [busy, props.onCancel])
  return h(
    'div',
    { className: 'tg-confirm', role: 'alertdialog', 'aria-label': t('logout.button'), 'data-dsh-telegram': 'logout-confirm' },
    h('p', { className: 'tg-confirm-text' }, t('logout.confirm')),
    h(
      'div',
      { className: 'tg-confirm-actions' },
      h(
        'button',
        { type: 'button', className: 'tg-btn is-danger', onClick: props.onConfirm, disabled: busy === true },
        busy === true ? t('logout.busy') : t('logout.confirmButton'),
      ),
      h('button', { type: 'button', className: 'tg-btn', onClick: props.onCancel, disabled: busy === true }, t('logout.cancel')),
    ),
  )
}

//#endregion

//#region Error boundary (DESIGN.md 7.3 last row)

class PanelErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { failed: false }
  }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(error) {
    try {
      console.error('[' + NS + '] panel component crashed:', error)
    } catch (loggingError) {
      // A console that refuses the log must not hide the failure screen.
    }
  }
  retry() {
    this.setState({ failed: false })
    if (typeof this.props.onRetry === 'function') this.props.onRetry()
  }
  render() {
    if (this.state.failed !== true) return this.props.children
    const t = typeof this.props.t === 'function' ? this.props.t : dictionaryTranslate('en')
    return h(
      'div',
      { className: 'tg-panel tg-panel-failed', role: 'alert' },
      h(
        'div',
        { className: 'tg-state' },
        h('h2', { className: 'tg-state-title' }, t('panel.errorTitle')),
        h('p', { className: 'tg-state-body' }, t('panel.errorBody')),
        h('button', { type: 'button', className: 'tg-btn is-primary', onClick: this.retry.bind(this) }, t('state.retry')),
      ),
    )
  }
}

//#endregion

//#region Named placeholders for a fragment that is not in the bundle yet

function PanelPlaceholder(props) {
  const name = typeof props.name === 'string' ? props.name : 'component'
  const fragment = typeof props.fragment === 'string' ? props.fragment : 'fragment'
  const label = typeof props.label === 'string' ? props.label : name
  return h(
    'div',
    { className: 'tg-state tg-state-placeholder', role: 'status' },
    h('h3', { className: 'tg-state-title' }, label),
    h('p', { className: 'tg-state-hint' }, name + ' — ' + fragment),
  )
}

function ChatListPane(props) {
  if (typeof ChatList === 'function') {
    return h(ChatList, {
      ctx: props.ctx,
      t: props.t,
      lang: props.lang,
      active: props.active,
      state: props.state,
      selectedChatId: props.selectedChatId,
      onSelectChat: props.onSelectChat,
      selectionMode: props.selectionMode,
      selectedRefs: props.selectedRefs,
      onToggleSelection: props.onToggleSelection,
      onRegisterSelection: props.onRegisterSelection,
    })
  }
  return h(PanelPlaceholder, { name: 'ChatList', fragment: '30-chatlist.js', label: props.t('chatlist.title') })
}

function ThreadPane(props) {
  if (typeof Thread === 'function') {
    return h(Thread, {
      ctx: props.ctx,
      t: props.t,
      lang: props.lang,
      active: props.active,
      state: props.state,
      chatId: props.chatId,
      replyTo: props.replyTo,
      onReplyTo: props.onReplyTo,
      onOpenProfile: props.onOpenProfile,
      selectionMode: props.selectionMode,
      selectedRefs: props.selectedRefs,
      onToggleSelection: props.onToggleSelection,
      onRegisterSelection: props.onRegisterSelection,
    })
  }
  return h(PanelPlaceholder, { name: 'Thread', fragment: '40-thread.js', label: props.t('thread.aria') })
}

function ComposerPane(props) {
  if (typeof Composer === 'function') {
    return h(Composer, {
      ctx: props.ctx,
      t: props.t,
      lang: props.lang,
      active: props.active,
      state: props.state,
      chatId: props.chatId,
      replyTo: props.replyTo,
      onSent: props.onSent,
    })
  }
  return h(PanelPlaceholder, { name: 'Composer', fragment: '50-composer.js', label: props.t('composer.send') })
}

function LoginPane(props) {
  if (typeof LoginScreen === 'function') {
    return h(LoginScreen, { ctx: props.ctx, t: props.t, lang: props.lang, active: props.active, state: props.state, onDone: props.onDone })
  }
  return h(PanelPlaceholder, { name: 'LoginScreen', fragment: '60-login.js', label: props.t('login.title') })
}

function ProfilePane(props) {
  if (typeof ProfileScreen === 'function') {
    return h(ProfileScreen, {
      ctx: props.ctx,
      t: props.t,
      lang: props.lang,
      active: props.active,
      state: props.state,
      target: props.target,
      onClose: props.onClose,
      onWrite: props.onWrite,
      onSelect: props.onSelect,
      selectionMode: props.selectionMode,
      selectedRefs: props.selectedRefs,
      onToggleSelection: props.onToggleSelection,
      onRegisterSelection: props.onRegisterSelection,
    })
  }
  return h(PanelPlaceholder, { name: 'ProfileScreen', fragment: '55-profile.js', label: props.t('profile.title') })
}

//#endregion

//#region PanelFrame — list / thread / composer, login, profile

function PanelFrame(props) {
  const ctx = props.ctx
  const store = props.store
  const t = props.t
  const lang = props.lang
  const active = props.active
  const state = useStore(store)
  const storedChatId = readLocal(STORAGE_CHAT, null)
  const selected = useState(typeof storedChatId === 'string' && storedChatId !== '' ? { chatId: storedChatId, title: null, kind: null } : null)
  const replyTo = useState(null)
  const pane = useState('list')
  const view = useState('chat')
  const profileTarget = useState(null)
  const confirmLogout = useState(false)
  const selectedChatId = selected[0] !== null && selected[0] !== undefined ? selected[0].chatId : null
  const notConfigured = state.configured === false || (state.error !== null && state.error.code === 'not_configured')
  const connectionFailed = state.status === 'connection_failed' || (state.error !== null && state.error.code === 'connection_failed')
  const engineMissing = state.engineAvailable === false
  const showLogin = state.loggedIn !== true

  const selectChat = useCallback(function (chatId, chat) {
    const id = typeof chatId === 'string' && chatId !== '' ? chatId : null
    const record = id === null ? null : {
      chatId: id,
      title: chat !== null && chat !== undefined && typeof chat.title === 'string' ? chat.title : null,
      kind: chat !== null && chat !== undefined && typeof chat.kind === 'string' ? chat.kind : null,
    }
    selected[1](record)
    store.set({ selectedChat: record })
    writeLocal(STORAGE_CHAT, id)
    replyTo[1](null)
    pane[1](id === null ? 'list' : 'thread')
    view[1]('chat')
  }, [store])

  // Profile navigation (DESIGN-v0.2 7.4): no target = the signed-in account,
  // `chatId` = a group/channel, `userId` = another user. A private dialog is
  // opened by user id, because its marked chat id is the user id and the Host
  // would otherwise describe it as a group.
  const openProfile = useCallback(function (target) {
    let next = isRecord(target) ? target : null
    const selectedKind = selected[0] !== null && selected[0] !== undefined && typeof selected[0].kind === 'string' ? selected[0].kind : null
    if (next !== null && selectedKind === 'user' && typeof next.chatId === 'string' && next.chatId !== '') {
      next = { userId: next.chatId, title: next.title }
    }
    profileTarget[1](next)
    view[1]('profile')
  }, [selected[0]])

  const closeProfile = useCallback(function () {
    profileTarget[1](null)
    view[1]('chat')
  }, [])

  // «Write» on a profile opens that conversation in the thread pane.
  const writeToProfile = useCallback(function (profile) {
    if (isRecord(profile) !== true) return
    const chatId = typeof profile.chatId === 'string' && profile.chatId !== ''
      ? profile.chatId
      : typeof profile.userId === 'string' && profile.userId !== ''
        ? profile.userId
        : null
    if (chatId === null) return
    selectChat(chatId, {
      title: typeof profile.title === 'string' ? profile.title : null,
      kind: typeof profile.kind === 'string' ? profile.kind : null,
    })
  }, [selectChat])

  const setReplyTo = useCallback(function (message) {
    if (message === null || message === undefined) {
      replyTo[1](null)
      return
    }
    replyTo[1]({
      id: typeof message.id === 'number' ? message.id : Number(message.id),
      text: typeof message.text === 'string' ? message.text : '',
      authorTitle: typeof message.authorTitle === 'string' ? message.authorTitle : null,
    })
    pane[1]('thread')
  }, [])

  const refresh = useCallback(function () {
    store.set({ error: null })
    if (typeof props.onRefresh === 'function') props.onRefresh()
  }, [props.onRefresh, store])

  const loginDone = useCallback(function () {
    if (typeof props.onRefresh === 'function') props.onRefresh()
  }, [props.onRefresh])

  const requestLogout = useCallback(function () {
    confirmLogout[1](true)
  }, [])

  const cancelLogout = useCallback(function () {
    confirmLogout[1](false)
  }, [])

  const performLogout = useCallback(function () {
    if (store.get().busy === 'logout') return
    store.set({ busy: 'logout' })
    apiRequest('POST', apiUrl(ROUTES.logout), { confirm: 'logout' }).then(function (reply) {
      if (reply.ok === true) {
        abortRequests(ROUTES.dialogs)
        abortRequests(ROUTES.messages)
        selected[1](null)
        replyTo[1](null)
        pane[1]('list')
        view[1]('chat')
        writeLocal(STORAGE_CHAT, null)
        store.set({
          busy: '',
          notice: t('state.signedOut'),
          error: null,
          host: null,
          configured: null,
          engineAvailable: null,
          connected: false,
          loggedIn: false,
          loginStage: 'idle',
          loginPhone: '',
          selectedChat: null,
        })
      } else {
        store.set({ busy: '', error: { code: reply.code, message: reply.message, retryAfterMs: reply.retryAfterMs } })
      }
      confirmLogout[1](false)
      if (typeof props.onRefresh === 'function') props.onRefresh()
    })
  }, [store, t, props.onRefresh])

  // The toast lifetime belongs to the shell: any producer only sets store.notice.
  useEffect(function () {
    if (state.notice === '') return function () {}
    if (typeof setTimeout !== 'function') return function () {}
    const timer = setTimeout(function () {
      store.set({ notice: '' })
    }, TOAST_MS)
    return function () {
      clearTimeout(timer)
    }
  }, [state.notice, store])

  const waitingForStatus = state.host === null && (state.engineStatus === 'loading' || state.engineStatus === 'error')
  const engineText = engineMissing === true
    ? t('state.engineUnavailable') + (isRecord(state.host) && isRecord(state.host.lastError) ? ': ' + state.host.lastError.message : '')
    : ''
  const errorTextValue = state.error !== null && notConfigured !== true && connectionFailed !== true ? errorText(state.error, t) : ''

  if (notConfigured === true) {
    return h(
      'section',
      { className: 'tg-panel', 'data-dsh-telegram': 'panel', role: 'region', 'aria-label': t('panel.aria') },
      h(ConnectionStrip, { t: t, lang: lang, state: state, onRefresh: refresh, onRequestLogout: requestLogout, onClose: props.onClose }),
      h(NotConfiguredNotice, { t: t }),
    )
  }

  return h(
    'section',
    { className: 'tg-panel', 'data-dsh-telegram': 'panel', role: 'region', 'aria-label': t('panel.aria') },
    h(ConnectionStrip, {
      t: t,
      lang: lang,
      state: state,
      onRefresh: refresh,
      onRequestLogout: requestLogout,
      onClose: props.onClose,
      onProfile: state.loggedIn === true
        ? function () {
            openProfile(null)
          }
        : undefined,
    }),
    engineText !== ''
      ? h(WarningStrip, { t: t, tone: 'warn', text: engineText, onRetry: refresh })
      : null,
    connectionFailed === true
      ? h(ConnectionFailedNotice, { t: t, state: state, onRetry: refresh })
      : null,
    errorTextValue !== '' && engineText === '' && connectionFailed !== true
      ? h(WarningStrip, { t: t, tone: 'error', text: errorTextValue, retryAfterMs: state.error.retryAfterMs, onRetry: refresh })
      : null,
    waitingForStatus === true
      ? h('div', { className: 'tg-notice', role: 'status' }, h('p', { className: 'tg-state-body' }, state.engineStatus === 'loading' ? t('panel.loading') : t('state.notConnected')))
      : view[0] === 'profile' && state.loggedIn === true
      ? h(ProfilePane, {
          ctx: ctx,
          t: t,
          lang: lang,
          active: active,
          state: state,
          target: profileTarget[0],
          onClose: closeProfile,
          onWrite: state.loggedIn === true ? writeToProfile : undefined,
          onSelect: typeof props.onSelectProfile === 'function' ? props.onSelectProfile : undefined,
          selectionMode: props.selectionMode,
          selectedRefs: props.selectedRefs,
          onToggleSelection: props.onToggleSelection,
          onRegisterSelection: props.onRegisterSelection,
        })
      : showLogin === true
        ? h(LoginPane, { ctx: ctx, t: t, lang: lang, active: active, state: state, onDone: loginDone })
        : h(
            'div',
            { className: 'tg-layout', 'data-pane': pane[0] },
            h(
              'div',
              { className: 'tg-pane tg-pane-list' },
              h(ChatListPane, {
                ctx: ctx,
                t: t,
                lang: lang,
                active: active,
                state: state,
                selectedChatId: selectedChatId,
                onSelectChat: selectChat,
                selectionMode: props.selectionMode,
                selectedRefs: props.selectedRefs,
                onToggleSelection: props.onToggleSelection,
                onRegisterSelection: props.onRegisterSelection,
              }),
            ),
            h(
              'div',
              { className: 'tg-pane tg-pane-thread' },
              h(
                'button',
                { type: 'button', className: 'tg-back', 'data-dsh-telegram': 'back', onClick: function () { pane[1]('list') } },
                t('chatlist.title'),
              ),
              h(ThreadPane, {
                ctx: ctx,
                t: t,
                lang: lang,
                active: active,
                state: state,
                chatId: selectedChatId,
                replyTo: replyTo[0],
                onReplyTo: setReplyTo,
                onOpenProfile: openProfile,
                selectionMode: props.selectionMode,
                selectedRefs: props.selectedRefs,
                onToggleSelection: props.onToggleSelection,
                onRegisterSelection: props.onRegisterSelection,
              }),
            ),
            h(
              'div',
              { className: 'tg-pane tg-pane-composer' },
              h(ComposerPane, {
                ctx: ctx,
                t: t,
                lang: lang,
                active: active,
                state: state,
                chatId: selectedChatId,
                replyTo: replyTo[0],
                onSent: function () {
                  store.set({ notice: t('composer.sent'), error: null })
                  replyTo[1](null)
                },
              }),
            ),
          ),
    state.notice !== ''
      ? h('span', { className: 'tg-toast', role: 'status' }, state.notice)
      : null,
    confirmLogout[0] === true
      ? h(LogoutConfirm, { t: t, busy: state.busy === 'logout', onConfirm: performLogout, onCancel: cancelLogout })
      : null,
  )
}

//#endregion

//#region TelegramPanel — the core screen an overlay embeds

function TelegramPanel(props) {
  const ctx = props.ctx
  const i18n = useI18n(ctx, props.slot)
  const t = typeof props.t === 'function' ? props.t : i18n.t
  const lang = typeof props.lang === 'string' ? props.lang : i18n.lang
  const storeRef = useRef(null)
  if (storeRef.current === null) storeRef.current = createPanelStore()
  const active = usePanelActive(ctx, props.active)
  const refreshStatus = useHostStatus(ctx, storeRef.current, active)
  const attempt = useState(0)
  const resetPanel = useCallback(function () {
    attempt[1](function (current) {
      return current + 1
    })
  }, [])
  // Stale requests of this panel die with it (DESIGN.md 7.2 abort pattern).
  useEffect(function () {
    return function () {
      abortRequests('')
    }
  }, [])
  return h(
    PanelErrorBoundary,
    { t: t, onRetry: resetPanel },
    h(PanelFrame, {
      key: 'tg-frame-' + attempt[0],
      slot: props.slot,
      ctx: ctx,
      store: storeRef.current,
      t: t,
      lang: lang,
      active: active,
      onRefresh: refreshStatus,
      onClose: typeof props.onClose === 'function' ? props.onClose : undefined,
      onSelectProfile: typeof props.onSelectProfile === 'function' ? props.onSelectProfile : undefined,
      selectionMode: props.selectionMode === true,
      selectedRefs: Array.isArray(props.selectedRefs) ? props.selectedRefs : [],
      onToggleSelection: typeof props.onToggleSelection === 'function' ? props.onToggleSelection : undefined,
      onRegisterSelection: typeof props.onRegisterSelection === 'function' ? props.onRegisterSelection : undefined,
    }),
  )
}

//#endregion
