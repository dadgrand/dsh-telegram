// 50-composer.js — the outgoing-message composer (DESIGN.md 7.2,
// DESIGN-v0.2 7.3).
//
// `useComposer(chatId)` keeps a text-only draft per chat in `localStorage`
// (`dsh-telegram.draft.<chatId>`), never a session or a token. The textarea grows
// up to six rows; `Ctrl/Cmd+Enter` sends; the counter uses the Host limit 4096.
// Sending is one explicit user action through POST /send.

function useComposer(chatId) {
  const key = typeof chatId === 'string' && chatId !== '' ? STORAGE_DRAFT + chatId : ''
  const text = useState('')
  const sending = useState(false)
  const error = useState(null)

  useEffect(function () {
    const stored = key === '' ? '' : readLocal(key, '')
    text[1](typeof stored === 'string' ? stored : '')
    error[1](null)
  }, [key])

  const change = useCallback(function (value) {
    const next = String(value === undefined || value === null ? '' : value)
    text[1](next)
    if (key !== '') writeLocal(key, next)
  }, [key])

  const clear = useCallback(function () {
    text[1]('')
    if (key !== '') writeLocal(key, null)
  }, [key])

  const send = useCallback(function (options) {
    const body = typeof text[0] === 'string' ? text[0].trim() : ''
    if (body === '' || typeof chatId !== 'string' || chatId === '') return Promise.resolve(null)
    if (Array.from(body).length > LIMITS.textMax) return Promise.resolve(null)
    if (sending[0] === true) return Promise.resolve(null)
    sending[1](true)
    error[1](null)
    const payload = { chatId: chatId, text: body }
    if (isRecord(options) && Number.isInteger(options.replyTo)) payload.replyTo = options.replyTo
    return apiRequest('POST', apiUrl(ROUTES.send), payload).then(function (reply) {
      sending[1](false)
      if (reply.ok === true) {
        clear()
        return reply
      }
      if (reply.code !== 'aborted') error[1]({ code: reply.code, message: reply.message, retryAfterMs: reply.retryAfterMs })
      return reply
    })
  }, [chatId, text[0], sending[0], clear])

  return {
    text: text[0],
    sending: sending[0],
    error: error[0],
    setText: change,
    clear: clear,
    send: send,
    remaining: Math.max(0, LIMITS.textMax - Array.from(typeof text[0] === 'string' ? text[0] : '').length),
  }
}

function Composer(props) {
  const t = props.t
  const chatId = typeof props.chatId === 'string' ? props.chatId : null
  const composer = useComposer(chatId)
  const textareaRef = useRef(null)
  const replyTo = isRecord(props.replyTo) ? props.replyTo : null
  const enabled = chatId !== null && isRecord(props.state) && props.state.loggedIn === true
  const empty = composer.text.trim() === ''

  useLayoutEffect(function () {
    const element = textareaRef.current
    if (element === null || element === undefined) return
    element.style.height = 'auto'
    const line = 18
    element.style.height = Math.min(6 * line + 12, Math.max(52, element.scrollHeight)) + 'px'
  }, [composer.text])

  function submit() {
    if (enabled !== true || empty === true) return
    composer.send(replyTo !== null ? { replyTo: replyTo.id } : undefined).then(function (reply) {
      if (reply !== null && reply.ok === true && typeof props.onSent === 'function') props.onSent(reply.data)
    })
  }

  if (chatId === null) {
    return h(
      'div',
      { className: 'tg-composer' },
      h('p', { className: 'tg-composer-disabled' }, t('composer.chooseChat')),
    )
  }

  return h(
    'form',
    {
      className: 'tg-composer',
      'data-dsh-telegram': 'composer',
      onSubmit: function (event) {
        event.preventDefault()
        submit()
      },
    },
    replyTo !== null
      ? h(
          'div',
          { className: 'tg-composer-head' },
          h(
            'span',
            { className: 'tg-composer-reply', title: replyTo.text },
            t('composer.reply', { id: replyTo.id, text: truncate(replyTo.text, 80) }),
          ),
          h(
            'button',
            { type: 'button', className: 'tg-btn tg-composer-reply-clear', onClick: function () { if (typeof props.onClearReply === 'function') props.onClearReply() } },
            t('composer.replyClear'),
          ),
        )
      : null,
    h(
      'div',
      { className: 'tg-composer-body' },
      h(
        'label',
        { className: 'tg-composer-field' },
        h('span', { className: 'tg-visually-hidden' }, t('composer.aria')),
        h('textarea', {
          ref: textareaRef,
          className: 'tg-textarea tg-composer-textarea',
          value: composer.text,
          rows: 2,
          placeholder: t('composer.placeholder'),
          disabled: enabled !== true || composer.sending === true,
          'aria-label': t('composer.aria'),
          onChange: function (event) {
            composer.setText(event.target.value)
          },
          onKeyDown: function (event) {
            if (event.key !== 'Enter') return
            if (event.ctrlKey !== true && event.metaKey !== true) return
            event.preventDefault()
            submit()
          },
        }),
      ),
      composer.error !== null
        ? h('div', { className: 'tg-login-error', role: 'alert' }, errorText(composer.error, t))
        : null,
    ),
    h(
      'div',
      { className: 'tg-composer-foot' },
      h('span', { className: 'tg-composer-hint' }, enabled === true ? t('composer.hint') : t('composer.disabled')),
      h(
        'span',
        { className: classNameOf('tg-composer-counter', { 'is-over': composer.remaining === 0 && empty !== true }) },
        String(Array.from(composer.text).length) + ' / ' + String(LIMITS.textMax),
      ),
      h(
        'button',
        {
          type: 'submit',
          className: 'tg-btn is-primary tg-composer-send',
          disabled: enabled !== true || empty === true || composer.sending === true,
          'aria-busy': composer.sending === true ? 'true' : undefined,
        },
        composer.sending === true ? t('composer.sending') : t('composer.send'),
      ),
    ),
  )
}
