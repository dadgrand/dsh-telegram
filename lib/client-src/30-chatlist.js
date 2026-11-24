// 30-chatlist.js — the dialog list of the Telegram panel (DESIGN.md 7.2,
// DESIGN-v0.2 7.2).
//
// `useDialogs(ctx, active)` loads `/dialogs` and refreshes it every
// POLL_DIALOGS_MS while the overlay is open and the document visible. A local
// filter narrows the already-loaded titles after a DEBOUNCE_MS pause; the list
// itself is never re-requested per keystroke.
//
// A plain row click opens the chat; selecting the chat object for the agent is
// t4's job (`Shift`-click / checkbox), which is why this file contains no
// selection markup yet.

function chatSort(a, b) {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt
  return String(a.chatId) < String(b.chatId) ? -1 : String(a.chatId) > String(b.chatId) ? 1 : 0
}

// Response contract: { dialogs, chats, count, truncated, updatedAt }.
function dialogsOf(payload) {
  if (isRecord(payload) === false) return []
  const list = Array.isArray(payload.dialogs) ? payload.dialogs : Array.isArray(payload.chats) ? payload.chats : []
  return list.filter(function (chat) {
    return isRecord(chat) && typeof chat.chatId === 'string' && chat.chatId !== ''
  })
}

function useDialogs(ctx, active) {
  const chats = useState([])
  const loading = useState(true)
  const error = useState(null)
  const updatedAt = useState(0)
  const mounted = useRef(true)
  useEffect(function () {
    mounted.current = true
    return function () {
      mounted.current = false
    }
  }, [])
  const load = useCallback(function () {
    return apiRequest('GET', apiUrl(ROUTES.dialogs, { limit: LIMITS.dialogs })).then(function (reply) {
      if (mounted.current !== true) return null
      if (reply.ok === true) {
        const next = dialogsOf(reply.data).sort(chatSort)
        chats[1](next)
        error[1](null)
        updatedAt[1](typeof reply.data?.updatedAt === 'number' ? reply.data.updatedAt : Math.floor(Date.now() / 1000))
      } else if (reply.code !== 'aborted') {
        error[1]({ code: reply.code, message: reply.message, retryAfterMs: reply.retryAfterMs })
      }
      loading[1](false)
      return reply
    })
  }, [])
  const refresh = usePolling({ active: active, intervalMs: POLL_DIALOGS_MS, run: load })
  useEffect(function () {
    if (active !== true) return function () {}
    loading[1](true)
    refresh()
    return function () {
      abortRequests(ROUTES.dialogs)
    }
  }, [active, refresh])
  return {
    chats: chats[0],
    loading: loading[0],
    error: error[0],
    updatedAt: updatedAt[0],
    refresh: refresh,
  }
}

function ChatRow(props) {
  const chat = props.chat
  const selected = props.selected === true
  const t = props.t
  const lang = props.lang
  const unread = Number.isInteger(chat.unreadCount) ? chat.unreadCount : 0
  const last = isRecord(chat.lastMessage) ? chat.lastMessage : null
  const preview = last === null ? '' : typeof last.text === 'string' ? last.text : ''
  const descriptor = selectionDescriptorOfChat(chat)
  const selectionMode = props.selectionMode === true
  const marked = props.marked === true
  // Idempotent registry entry for the marquee (Map.set, see 65-selection.js).
  if (descriptor !== null && typeof props.onRegisterSelection === 'function') props.onRegisterSelection(descriptor)
  return h(
    'button',
    {
      type: 'button',
      className: classNameOf('tg-chatlist-row', { 'is-selected': selected, 'is-pinned': chat.pinned === true, 'is-marked': marked }),
      onClick: function () {
        if (selectionMode === true && descriptor !== null && typeof props.onToggleSelection === 'function') {
          props.onToggleSelection(descriptor)
          return
        }
        props.onSelect(chat)
      },
      'data-tg-sel': descriptor === null ? undefined : descriptor.ref,
      'data-tg-kind': 'chat',
      'data-tg-selected': marked ? 'true' : undefined,
      'aria-label': t('chatlist.rowAria', { title: chat.title }),
      'aria-current': selected ? 'true' : undefined,
      'aria-pressed': selectionMode === true ? (marked ? 'true' : 'false') : undefined,
      title: chat.title,
    },
    h(
      'span',
      { className: 'tg-chatlist-avatar', style: { background: avatarTokenOf(chat.chatId) }, 'aria-hidden': true },
      h('span', { className: 'tg-chatlist-glyph' }, initialOf(chat.title)),
    ),
    h('span', { className: 'tg-chatlist-name' }, chat.title),
    h(
      'span',
      { className: 'tg-chatlist-last' },
      last !== null && last.fromMe === true ? t('thread.you') + ': ' : '',
      preview,
    ),
    h(
      'span',
      { className: 'tg-chatlist-meta' },
      h('span', { className: 'tg-chatlist-time' }, formatTime(chat.updatedAt, lang)),
      unread > 0
        ? h('span', { className: 'tg-chatlist-unread', 'aria-label': t('chatlist.unreadAria', { count: unread }) }, unread > 99 ? '99+' : String(unread))
        : null,
      chat.pinned === true ? h('span', { className: 'tg-chatlist-flag' }, t('chatlist.pinned')) : null,
      chat.archived === true ? h('span', { className: 'tg-chatlist-flag' }, t('chatlist.archived')) : null,
      marked === true ? h('span', { className: 'tg-chatlist-mark', 'aria-hidden': 'true' }, '\u2713') : null,
    ),
  )
}

function ChatListSkeleton(props) {
  return h(
    'div',
    { className: 'tg-chatlist-skeleton', 'aria-busy': 'true', 'aria-label': props.t('chatlist.loading') },
    h('span', { className: 'tg-skeleton tg-chatlist-skeleton-row' }),
    h('span', { className: 'tg-skeleton tg-chatlist-skeleton-row' }),
    h('span', { className: 'tg-skeleton tg-chatlist-skeleton-row' }),
    h('span', { className: 'tg-skeleton tg-chatlist-skeleton-row' }),
  )
}

function ChatList(props) {
  const ctx = props.ctx
  const t = props.t
  const lang = props.lang
  const active = props.active
  const data = useDialogs(ctx, active)
  const filter = useDebounced('', DEBOUNCE_MS)
  const query = String(filter[2] === undefined || filter[2] === null ? '' : filter[2]).trim().toLowerCase()
  const visible = query === ''
    ? data.chats
    : data.chats.filter(function (chat) {
        return String(chat.title).toLowerCase().includes(query)
      })
  const selectedId = typeof props.selectedChatId === 'string' ? props.selectedChatId : null
  const listRef = useRef(null)
  useEffect(function () {
    if (listRef.current !== null && typeof filter[1] === 'function') {
      // Keeps the filter controlled without losing the local debounce.
    }
  }, [filter])
  return h(
    'div',
    { className: 'tg-chatlist', 'data-dsh-telegram': 'chatlist' },
    h(
      'div',
      { className: 'tg-chatlist-head', 'data-tg-noselect': 'true' },
      h('h3', { className: 'tg-chatlist-heading' }, t('chatlist.title')),
      h('input', {
        type: 'search',
        className: 'tg-input tg-chatlist-filter',
        value: filter[0],
        placeholder: t('chatlist.filterPlaceholder'),
        'aria-label': t('chatlist.filterAria'),
        onChange: function (event) {
          filter[1](event.target.value)
        },
      }),
      h(
        'button',
        { type: 'button', className: 'tg-btn tg-chatlist-refresh', onClick: data.refresh, disabled: data.loading === true },
        t('chatlist.refresh'),
      ),
    ),
    data.loading === true && data.chats.length === 0
      ? h(ChatListSkeleton, { t: t })
      : h(
          'div',
          { className: 'tg-scroll tg-chatlist-body', role: 'list', ref: listRef },
          data.error !== null
            ? h(
                'div',
                { className: 'tg-chatlist-error', role: 'alert' },
                errorText(data.error, t),
                h(
                  'button',
                  { type: 'button', className: 'tg-btn tg-chatlist-retry', onClick: data.refresh },
                  t('state.retry'),
                ),
              )
            : null,
          visible.length === 0 && data.loading !== true
            ? h('p', { className: 'tg-chatlist-state' }, data.chats.length === 0 ? t('chatlist.empty') : t('chatlist.noMatch'))
            : null,
          visible.map(function (chat) {
            const ref = selectionRefOfChat(chat)
            return h('div', { key: chat.chatId, role: 'listitem' }, h(ChatRow, {
              chat: chat,
              t: t,
              lang: lang,
              selected: chat.chatId === selectedId,
              marked: Array.isArray(props.selectedRefs) && props.selectedRefs.indexOf(ref) >= 0,
              selectionMode: props.selectionMode === true,
              onToggleSelection: props.onToggleSelection,
              onRegisterSelection: props.onRegisterSelection,
              onSelect: function (value) {
                props.onSelectChat(value.chatId, value)
              },
            }))
          }),
        ),
  )
}
