// 40-thread.js — the message history of the selected chat (DESIGN.md 7.2,
// DESIGN-v0.2 7.3).
//
// `useMessages(ctx, chatId, active)` keeps one page of newest messages plus any
// older pages the user requested, merges new poll results by message id, and
// refreshes every POLL_THREAD_MS while the overlay is open, this chat is
// selected and the document is visible. Requests of a previous chat are
// cancelled on switch (chatId in the request key, plus a per-run guard).
//
// Messages never contain HTML: text is rendered as React text nodes, so a
// Telegram message cannot inject markup.

function mergeMessages(previous, page, newestFirst) {
  const byId = new Map()
  const all = previous.concat(page)
  for (let index = 0; index < all.length; index += 1) {
    const message = all[index]
    if (isRecord(message) === false || Number.isInteger(message.id) === false) continue
    byId.set(message.id, message)
  }
  const merged = Array.from(byId.values())
  merged.sort(function (a, b) {
    if (a.date !== b.date) return a.date - b.date
    return a.id - b.id
  })
  // A long scrollback is bounded; the oldest messages fall off the top.
  if (merged.length > 400) merged.splice(0, merged.length - 400)
  if (newestFirst === true) merged.reverse()
  return merged
}

function messageListOf(payload) {
  if (isRecord(payload) === false) return []
  const list = Array.isArray(payload.messages) ? payload.messages : []
  return list.filter(function (message) {
    return isRecord(message) && Number.isInteger(message.id) && message.id > 0
  })
}

function useMessages(ctx, chatId, active) {
  const messages = useState([])
  const loading = useState(false)
  const error = useState(null)
  const hasMore = useState(false)
  const chatRef = useRef(chatId)
  chatRef.current = chatId

  const loadNewest = useCallback(function () {
    const target = chatId
    if (typeof target !== 'string' || target === '') {
      messages[1]([])
      hasMore[1](false)
      loading[1](false)
      return Promise.resolve(null)
    }
    return apiRequest('GET', apiUrl(ROUTES.messages, { chatId: target, limit: LIMITS.messages })).then(function (reply) {
      if (chatRef.current !== target) return reply
      if (reply.ok === true) {
        const page = messageListOf(reply.data)
        messages[1](function (previous) {
          return mergeMessages(previous, page, false)
        })
        hasMore[1](reply.data?.hasMore === true)
        error[1](null)
      } else if (reply.code !== 'aborted') {
        error[1]({ code: reply.code, message: reply.message, retryAfterMs: reply.retryAfterMs })
      }
      loading[1](false)
      return reply
    })
  }, [chatId])

  const loadEarlier = useCallback(function () {
    const target = chatId
    if (typeof target !== 'string' || target === '' || messages[0].length === 0) return Promise.resolve(null)
    const before = messages[0][0].id
    return apiRequest('GET', apiUrl(ROUTES.messages, { chatId: target, limit: LIMITS.messages, before: before })).then(function (reply) {
      if (chatRef.current !== target) return reply
      if (reply.ok === true) {
        const page = messageListOf(reply.data)
        messages[1](function (previous) {
          return mergeMessages(previous, page, false)
        })
        hasMore[1](reply.data?.hasMore === true)
        error[1](null)
      } else if (reply.code !== 'aborted') {
        error[1]({ code: reply.code, message: reply.message, retryAfterMs: reply.retryAfterMs })
      }
      return reply
    })
  }, [chatId])

  // Reset when the chat changes; the newest page is fetched immediately.
  useEffect(function () {
    messages[1]([])
    hasMore[1](false)
    error[1](null)
    loading[1](typeof chatId === 'string' && chatId !== '')
    if (typeof chatId === 'string' && chatId !== '') loadNewest()
    return function () {
      abortRequests(ROUTES.messages)
    }
  }, [chatId, loadNewest])

  const refresh = usePolling({ active: active === true && typeof chatId === 'string' && chatId !== '', intervalMs: POLL_THREAD_MS, run: loadNewest })
  useEffect(function () {
    if (active !== true || typeof chatId !== 'string' || chatId === '') return function () {}
    refresh()
    return function () {}
  }, [active, chatId, refresh])

  return {
    messages: messages[0],
    loading: loading[0],
    error: error[0],
    hasMore: hasMore[0],
    loadEarlier: loadEarlier,
    refresh: refresh,
  }
}

function MediaChip(props) {
  const media = props.media
  const t = props.t
  const lang = props.lang
  if (isRecord(media) === false) return null
  const kind = typeof media.kind === 'string' && MEDIA_KINDS.includes(media.kind) ? media.kind : 'other'
  const details = []
  if (typeof media.name === 'string' && media.name !== '') details.push(media.name)
  if (Number.isFinite(media.sizeBytes) && media.sizeBytes > 0) details.push(formatBytes(media.sizeBytes, lang))
  if (Number.isFinite(media.width) && Number.isFinite(media.height) && media.width > 0 && media.height > 0) {
    details.push(String(media.width) + '×' + String(media.height))
  }
  if (Number.isFinite(media.durationSec) && media.durationSec > 0) details.push(formatDuration(media.durationSec))
  return h(
    'span',
    { className: 'tg-thread-media', 'aria-label': t('thread.mediaAria') },
    h('span', { className: 'tg-thread-media-name' }, t('thread.media.' + kind)),
    details.length > 0 ? h('span', { className: 'tg-thread-media-meta' }, details.join(' · ')) : null,
  )
}

function DaySeparator(props) {
  return h('div', { className: 'tg-thread-day', role: 'separator' }, formatDay(props.date, props.t))
}

function MessageRow(props) {
  const message = props.message
  const t = props.t
  const lang = props.lang
  const fromMe = message.fromMe === true
  const author = typeof message.authorTitle === 'string' && message.authorTitle !== '' ? message.authorTitle : null
  const descriptor = selectionDescriptorOfMessage(props.chatId, message, props.chat)
  const selectionMode = props.selectionMode === true
  const marked = props.marked === true
  if (descriptor !== null && typeof props.onRegisterSelection === 'function') props.onRegisterSelection(descriptor)
  return h(
    'article',
    {
      className: classNameOf('tg-thread-row', { 'is-from-me': fromMe, 'is-pinned': message.pinned === true, 'is-marked': marked }),
      'aria-label': t('thread.messageAria', { id: message.id }),
      'data-tg-sel': descriptor === null ? undefined : descriptor.ref,
      'data-tg-kind': 'message',
      'data-tg-selected': marked ? 'true' : undefined,
      'aria-pressed': selectionMode === true ? (marked ? 'true' : 'false') : undefined,
      onClick: function () {
        if (selectionMode !== true || descriptor === null) return
        if (typeof props.onToggleSelection === 'function') props.onToggleSelection(descriptor)
      },
    },
    fromMe === false
      ? h(
          'span',
          { className: 'tg-thread-avatar', style: { background: avatarTokenOf(message.authorId ?? message.chatId) }, 'aria-hidden': true },
          h('span', { className: 'tg-thread-glyph' }, initialOf(author ?? t('thread.unknownAuthor'))),
        )
      : null,
    h(
      'div',
      { className: 'tg-thread-message' },
      fromMe === false && author !== null && props.showAuthor === true
        ? typeof props.onOpenSender === 'function' && typeof message.authorId === 'string' && message.authorId !== ''
          ? h(
              'button',
              {
                type: 'button',
                className: 'tg-thread-author tg-thread-author-btn',
                'data-dsh-telegram': 'sender-profile',
                title: t('profile.open'),
                onClick: function (event) {
                  if (event !== null && event !== undefined && typeof event.stopPropagation === 'function') event.stopPropagation()
                  props.onOpenSender(message)
                },
              },
              author,
            )
          : h('span', { className: 'tg-thread-author' }, author)
        : null,
      Number.isInteger(message.replyToId)
        ? h('span', { className: 'tg-thread-reply' }, t('thread.replyTo', { id: message.replyToId }))
        : null,
      typeof message.text === 'string' && message.text !== ''
        ? h('p', { className: 'tg-thread-text' }, message.text)
        : null,
      h(MediaChip, { media: message.media, t: t, lang: lang }),
      marked === true
        ? h('span', { className: 'tg-thread-mark-selected', 'aria-hidden': 'true' }, '\u2713')
        : null,
      h(
        'span',
        { className: 'tg-thread-time' },
        fromMe === true ? t('thread.you') + ' · ' : '',
        formatTime(message.date, lang),
        message.editedAt !== null && message.editedAt !== undefined ? h('span', { className: 'tg-thread-mark is-edited' }, ' ' + t('thread.edited')) : null,
        message.pinned === true ? h('span', { className: 'tg-thread-mark is-reply' }, ' · ' + t('thread.pinned')) : null,
      ),
    ),
    fromMe === true
      ? h(
          'span',
          { className: 'tg-thread-avatar', style: { background: avatarTokenOf('me') }, 'aria-hidden': true },
          h('span', { className: 'tg-thread-glyph' }, initialOf(props.selfTitle ?? t('thread.you'))),
        )
      : null,
  )
}

function ThreadSkeleton(props) {
  return h(
    'div',
    { className: 'tg-thread-skeleton', 'aria-busy': 'true', 'aria-label': props.t('thread.loading') },
    h('span', { className: 'tg-skeleton tg-thread-skeleton-row' }),
    h('span', { className: 'tg-skeleton tg-thread-skeleton-row' }),
    h('span', { className: 'tg-skeleton tg-thread-skeleton-row' }),
  )
}

function groupMessages(messages) {
  const groups = []
  let lastDay = null
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    const day = dayKeyOf(message.date) + ':' + new Date(message.date * 1000).toDateString()
    if (day !== lastDay) {
      groups.push({ kind: 'day', date: message.date, key: 'day-' + String(message.id) })
      lastDay = day
    }
    groups.push({ kind: 'message', message: message, key: 'msg-' + String(message.id) })
  }
  return groups
}

function Thread(props) {
  const ctx = props.ctx
  const t = props.t
  const lang = props.lang
  const active = props.active
  const chatId = typeof props.chatId === 'string' ? props.chatId : null
  const data = useMessages(ctx, chatId, active)
  const scrollRef = useRef(null)
  const stickRef = useRef(true)
  const selectedChat = isRecord(props.state) && isRecord(props.state.selectedChat) ? props.state.selectedChat : null
  const chatTitle = selectedChat !== null && typeof selectedChat.title === 'string' ? selectedChat.title : ''
  const selfTitle = isRecord(props.state) && isRecord(props.state.host) && typeof props.state.host.title === 'string' ? props.state.host.title : t('thread.you')

  useEffect(function () {
    stickRef.current = true
  }, [chatId])

  useLayoutEffect(function () {
    const element = scrollRef.current
    if (element === null || element === undefined) return
    if (stickRef.current !== true) return
    element.scrollTop = element.scrollHeight
  }, [data.messages, chatId])

  if (chatId === null) {
    return h(
      'div',
      { className: 'tg-thread' },
      h('div', { className: 'tg-thread-empty', role: 'status' }, t('thread.chooseChat')),
    )
  }

  const groups = groupMessages(data.messages)
  const showAuthor = selectedChat !== null && (selectedChat.kind === 'chat' || selectedChat.kind === 'channel')

  return h(
    'div',
    { className: 'tg-thread', 'data-dsh-telegram': 'thread' },
    h(
      'div',
      { className: 'tg-thread-head', 'data-tg-noselect': 'true' },
      h('span', { className: 'tg-chatlist-heading' }, chatTitle !== '' ? chatTitle : t('thread.aria')),
      typeof props.onOpenProfile === 'function'
        ? h(
            'button',
            {
              type: 'button',
              className: 'tg-btn tg-thread-profile',
              'data-dsh-telegram': 'chat-profile',
              onClick: function () {
                props.onOpenProfile({ chatId: chatId, title: chatTitle })
              },
            },
            t('profile.open'),
          )
        : null,
      data.hasMore === true
        ? h(
            'button',
            { type: 'button', className: 'tg-btn tg-thread-earlier', onClick: data.loadEarlier, disabled: data.loading === true },
            t('thread.loadEarlier'),
          )
        : null,
    ),
    h(
      'div',
      {
        className: 'tg-scroll tg-thread-body',
        role: 'log',
        'aria-live': 'polite',
        'aria-label': t('thread.aria'),
        ref: scrollRef,
        onScroll: function (event) {
          const element = event.currentTarget
          stickRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24
        },
      },
      data.loading === true && data.messages.length === 0 ? h(ThreadSkeleton, { t: t }) : null,
      data.error !== null
        ? h(
            'div',
            { className: 'tg-thread-state', role: 'alert' },
            errorText(data.error, t),
            h('button', { type: 'button', className: 'tg-btn', onClick: data.refresh }, t('state.retry')),
          )
        : null,
      data.messages.length === 0 && data.loading !== true
        ? h('p', { className: 'tg-thread-empty' }, t('thread.empty'))
        : null,
      groups.map(function (group) {
        if (group.kind === 'day') return h(DaySeparator, { key: group.key, date: group.date, t: t })
        const messageRef = selectionRefOfMessage(chatId, group.message)
        return h(MessageRow, {
          key: group.key,
          message: group.message,
          chatId: chatId,
          chat: selectedChat,
          t: t,
          lang: lang,
          showAuthor: showAuthor,
          selfTitle: selfTitle,
          selected: false,
          marked: Array.isArray(props.selectedRefs) && messageRef !== '' && props.selectedRefs.indexOf(messageRef) >= 0,
          selectionMode: props.selectionMode === true,
          onToggleSelection: props.onToggleSelection,
          onRegisterSelection: props.onRegisterSelection,
          onSelect: function () {
            if (typeof props.onReplyTo === 'function') props.onReplyTo(group.message)
          },
          onOpenSender: typeof props.onOpenProfile === 'function'
            ? function (message) {
                if (typeof message.authorId !== 'string' || message.authorId === '') return
                props.onOpenProfile({
                  userId: message.authorId,
                  title: typeof message.authorTitle === 'string' ? message.authorTitle : null,
                })
              }
            : undefined,
        })
      }),
    ),
  )
}
