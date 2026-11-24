// 60-login.js — QR-first sign-in with the phone/code/2FA fallback
// (DESIGN-v0.2 9, DESIGN.md 3.4).
//
// Opening the panel with no session starts `POST /login/qr/start` immediately:
// the Host creates a dedicated client, runs GramJS `signInUserWithQrCode`, and
// publishes the next `tg://login?token=…` payload. This component polls
// `/login/qr/state?since=<seq>` every POLL_QR_MS, swaps the matrix without
// flicker, counts the token down, and shows the two-step password form when
// Telegram asks for it. The phone form is a fallback hidden behind one button.
//
// The QR payload is a short-lived secret: it stays in this component's state,
// never in localStorage, the URL or a log line. All strings go through `t`.

const PHONE_PATTERN = /^\+?[0-9]{6,15}$/

// The QR matrix arrives as a row-major `0`/`1` string. One SVG path with a
// sub-path per dark module is compact and stays crisp (DESIGN-v0.2 9.3).
function qrPathData(matrix) {
  if (isRecord(matrix) === false) return ''
  const size = Number(matrix.size)
  const modules = typeof matrix.modules === 'string' ? matrix.modules : ''
  if (!Number.isInteger(size) || size < 21 || modules.length < size * size) return ''
  const parts = []
  for (let y = 0; y < size; y += 1) {
    let x = 0
    while (x < size) {
      if (modules.charAt(y * size + x) !== '1') {
        x += 1
        continue
      }
      let run = 1
      while (x + run < size && modules.charAt(y * size + x + run) === '1') run += 1
      parts.push('M' + String(x) + ' ' + String(y) + 'h' + String(run) + 'v1h-' + String(run) + 'z')
      x += run
    }
  }
  return parts.join('')
}

function QrPanel(props) {
  const t = props.t
  const qr = isRecord(props.qr) ? props.qr : null
  const matrix = qr !== null && isRecord(qr.matrix) ? qr.matrix : null
  const path = qrPathData(matrix)
  const remaining = qr === null ? 0 : secondsUntil(qr.expiresAt, props.now)
  return h(
    'div',
    { className: 'tg-login-qr', 'data-dsh-telegram': 'qr' },
    path === ''
      ? h('div', { className: 'tg-login-qr-placeholder', role: 'status' }, t('login.qrWaiting'))
      : h(
          'svg',
          {
            className: 'tg-login-qr-code',
            viewBox: '0 0 ' + String(matrix.size) + ' ' + String(matrix.size),
            role: 'img',
            'aria-label': t('login.qrAlt'),
            shapeRendering: 'crispEdges',
          },
          h('rect', { width: String(matrix.size), height: String(matrix.size), fill: 'var(--dsw-alias-bg-base)' }),
          h('path', { d: path, fill: 'var(--dsw-alias-label-primary)' }),
        ),
    h('p', { className: 'tg-login-hint' }, t('login.qrHint')),
    qr !== null
      ? h(
          'p',
          { className: 'tg-login-qr-expiry', role: 'status' },
          remaining > 0 ? t('login.qrExpires', { seconds: remaining }) : t('login.qrExpired'),
        )
      : null,
    h(
      'div',
      { className: 'tg-login-actions' },
      h(
        'button',
        { type: 'button', className: 'tg-btn', onClick: props.onRefresh, disabled: props.refreshing === true },
        props.refreshing === true ? t('login.refreshing') : t('login.qrRefresh'),
      ),
      h('button', { type: 'button', className: 'tg-btn tg-login-secondary', onClick: props.onPhone }, t('login.phoneToggle')),
    ),
  )
}

function LoginScreen(props) {
  const ctx = props.ctx
  const t = props.t
  const lang = props.lang
  const active = props.active
  const statusState = isRecord(props.state) ? props.state : {}
  const hostStage = typeof statusState.loginStage === 'string' ? statusState.loginStage : 'idle'
  // R2: /status carries no phone digits. `phoneConfigured` only tells the form
  // that the Host can fill an empty submission from its own config.
  const phoneConfigured = isRecord(statusState.config) && statusState.config.phoneConfigured === true

  const mode = useState(hostStage === 'code_sent' || hostStage === 'awaiting_2fa' ? 'phone' : 'qr')
  const stage = useState(hostStage)
  const qr = useState(null)
  const seqRef = useRef(0)
  const busy = useState('')
  const error = useState(null)
  const hint = useState(null)
  const phone = useState('')
  const code = useState('')
  const password = useState('')
  const now = useState(Date.now())
  const startedRef = useRef(false)
  const mounted = useRef(true)
  const doneRef = useRef(false)

  useEffect(function () {
    mounted.current = true
    return function () {
      mounted.current = false
    }
  }, [])

  const finish = useCallback(function () {
    if (doneRef.current === true) return
    doneRef.current = true
    stage[1]('connected')
    if (typeof props.onDone === 'function') props.onDone()
  }, [props.onDone])

  const applyQrState = useCallback(function (payload) {
    if (isRecord(payload) === false) return
    if (typeof payload.stage === 'string') stage[1](payload.stage)
    if (typeof payload.hint === 'string') hint[1](payload.hint)
    if (isRecord(payload.error)) error[1]({ code: payload.error.code, message: payload.error.message, retryAfterMs: null })
    else error[1](null)
    if (isRecord(payload.qr) && typeof payload.qr.uri === 'string') {
      seqRef.current = typeof payload.qr.seq === 'number' ? payload.qr.seq : seqRef.current
      qr[1](payload.qr)
    }
    if (payload.stage === 'connected') finish()
  }, [finish])

  const startQr = useCallback(function () {
    if (busy[0] !== '') return Promise.resolve(null)
    busy[1]('start')
    error[1](null)
    return apiRequest('POST', apiUrl(ROUTES.loginQrStart), {}).then(function (reply) {
      busy[1]('')
      if (reply.ok === true) {
        seqRef.current = 0
        applyQrState(reply.data)
      } else if (reply.code !== 'aborted') {
        error[1]({ code: reply.code, message: reply.message, retryAfterMs: reply.retryAfterMs })
      }
      return reply
    })
  }, [busy[0], applyQrState])

  // Auto-start QR once per mount when nothing is in flight; a reopened panel
  // that already has a qr_waiting attempt just resumes polling.
  useEffect(function () {
    if (active !== true || startedRef.current === true) return
    if (statusState.status === 'connection_failed') return
    if (hostStage === 'qr_waiting' || hostStage === 'awaiting_2fa' || hostStage === 'code_sent') {
      startedRef.current = true
      stage[1](hostStage)
      return
    }
    if (hostStage === 'idle' || hostStage === 'failed') {
      startedRef.current = true
      startQr()
    }
  }, [active, hostStage, startQr])

  // Poll the QR state while a QR attempt is alive. One timer only.
  useInterval(function () {
    if (mode[0] !== 'qr') return
    if (stage[0] !== 'qr_waiting' && stage[0] !== 'awaiting_2fa') return
    apiRequest('GET', apiUrl(ROUTES.loginQrState, { since: seqRef.current })).then(function (reply) {
      if (mounted.current !== true) return
      if (reply.ok === true) applyQrState(reply.data)
      else if (reply.code !== 'aborted') error[1]({ code: reply.code, message: reply.message, retryAfterMs: reply.retryAfterMs })
    })
  }, POLL_QR_MS, active === true && mode[0] === 'qr' && (stage[0] === 'qr_waiting' || stage[0] === 'awaiting_2fa'))

  // Countdown tick for the token expiry.
  useInterval(function () {
    now[1](Date.now())
  }, 1000, active === true && mode[0] === 'qr' && qr[0] !== null)

  const switchToPhone = useCallback(function () {
    mode[1]('phone')
    error[1](null)
    if (stage[0] === 'idle' || stage[0] === 'failed') stage[1]('awaiting_phone')
  }, [stage[0]])

  const switchToQr = useCallback(function () {
    mode[1]('qr')
    error[1](null)
    if (stage[0] === 'idle' || stage[0] === 'failed' || stage[0] === 'awaiting_phone') startQr()
  }, [stage[0], startQr])

  const startPhone = useCallback(function () {
    const value = phone[0].trim()
    // An empty field is allowed only when the Host has a configured number; the
    // Host substitutes it server-side, so no digits ever reach the response.
    if (value === '' ? phoneConfigured !== true : PHONE_PATTERN.test(value) !== true) {
      error[1]({ code: 'auth_phone_invalid', message: '', retryAfterMs: null })
      return
    }
    if (busy[0] !== '') return
    busy[1]('phone')
    error[1](null)
    apiRequest('POST', apiUrl(ROUTES.loginPhoneStart), { phone: value }).then(function (reply) {
      busy[1]('')
      if (reply.ok === true && isRecord(reply.data)) {
        if (typeof reply.data.stage === 'string') stage[1](reply.data.stage)
        if (isRecord(reply.data.state) && typeof reply.data.state.loginHint === 'string') hint[1](reply.data.state.loginHint)
      } else if (reply.code !== 'aborted') {
        error[1]({ code: reply.code, message: reply.message, retryAfterMs: reply.retryAfterMs })
      }
    })
  }, [phone[0], busy[0], phoneConfigured])

  const verify = useCallback(function (kind) {
    if (busy[0] !== '') return
    const payload = kind === 'code' ? { code: code[0].trim() } : { password: password[0] }
    if (kind === 'code' && payload.code === '') return
    if (kind === 'password' && payload.password === '') return
    busy[1](kind)
    error[1](null)
    apiRequest('POST', apiUrl(ROUTES.loginVerify), payload).then(function (reply) {
      busy[1]('')
      if (reply.ok === true && isRecord(reply.data)) {
        if (typeof reply.data.hint === 'string') hint[1](reply.data.hint)
        if (reply.data.stage === 'connected') {
          finish()
          return
        }
        if (typeof reply.data.stage === 'string') stage[1](reply.data.stage)
        if (kind === 'code') code[1]('')
        if (kind === 'password') password[1]('')
      } else if (reply.code !== 'aborted') {
        error[1]({ code: reply.code, message: reply.message, retryAfterMs: reply.retryAfterMs })
      }
    })
  }, [busy[0], code[0], password[0], finish])

  if (stage[0] === 'connected' || doneRef.current === true) {
    return h(
      'div',
      { className: 'tg-login', 'data-dsh-telegram': 'login-done' },
      h('h3', { className: 'tg-login-title' }, t('login.doneTitle')),
      h('p', { className: 'tg-login-state' }, t('login.doneBody')),
      h('button', { type: 'button', className: 'tg-btn is-primary', onClick: finish }, t('login.continue')),
    )
  }

  const errorValue = error[0] !== null ? errorText(error[0], t) : ''
  // R18: the field stays empty when the user let the Host substitute its own
  // configured number, so the notice must not interpolate an empty string.
  const knownPhone = phone[0].trim()

  return h(
    'div',
    { className: 'tg-login', 'data-dsh-telegram': 'login', 'aria-label': t('login.aria') },
    h('h3', { className: 'tg-login-title' }, mode[0] === 'qr' ? t('login.qrTitle') : t('login.phoneTitle')),
    mode[0] === 'qr'
      ? h(
          'div',
          null,
          stage[0] === 'awaiting_2fa'
            ? h(
                'form',
                {
                  className: 'tg-login-form',
                  onSubmit: function (event) {
                    event.preventDefault()
                    verify('password')
                  },
                },
                h('p', { className: 'tg-login-notice' }, t('login.passwordCloudHint')),
                typeof hint[0] === 'string' && hint[0] !== ''
                  ? h('p', { className: 'tg-login-hint' }, t('login.passwordHintWith', { hint: hint[0] }))
                  : h('p', { className: 'tg-login-hint' }, t('login.passwordHint')),
                h(
                  'label',
                  { className: 'tg-login-field' },
                  h('span', { className: 'tg-login-label' }, t('login.passwordLabel')),
                  h('input', {
                    type: 'password',
                    className: 'tg-input',
                    value: password[0],
                    autoComplete: 'current-password',
                    onChange: function (event) { password[1](event.target.value) },
                    'aria-label': t('login.passwordLabel'),
                  }),
                ),
                h(
                  'div',
                  { className: 'tg-login-actions' },
                  h('button', { type: 'submit', className: 'tg-btn is-primary', disabled: busy[0] !== '' }, busy[0] === 'password' ? t('login.checking') : t('login.verify')),
                  h('button', { type: 'button', className: 'tg-btn tg-login-secondary', onClick: switchToPhone }, t('login.phoneToggle')),
                ),
              )
            : h(
                'div',
                null,
                h(QrPanel, {
                  t: t,
                  lang: lang,
                  qr: qr[0],
                  now: now[0],
                  refreshing: busy[0] === 'start',
                  onRefresh: startQr,
                  onPhone: switchToPhone,
                }),
                stage[0] === 'qr_waiting' ? h('p', { className: 'tg-login-state', role: 'status' }, t('login.qrScan')) : null,
              ),
        )
      : h(
          'form',
          {
            className: 'tg-login-form',
            onSubmit: function (event) {
              event.preventDefault()
              if (stage[0] === 'code_sent') verify('code')
              else if (stage[0] === 'awaiting_2fa') verify('password')
              else startPhone()
            },
          },
          stage[0] === 'code_sent'
            ? h(
                'div',
                null,
                h(
                  'p',
                  { className: 'tg-login-notice', 'data-dsh-telegram': 'login-code-sent' },
                  knownPhone === ''
                    ? t('login.codeSentConfigured')
                    : t('login.codeSent', { phone: knownPhone }),
                ),
                error[0] !== null
                  ? h('p', { className: 'tg-login-hint', role: 'status' }, t('login.codeRetryHint'))
                  : null,
                h(
                  'label',
                  { className: 'tg-login-field' },
                  h('span', { className: 'tg-login-label' }, t('login.codeLabel')),
                  h('input', {
                    type: 'text',
                    inputMode: 'numeric',
                    className: 'tg-input',
                    value: code[0],
                    autoComplete: 'one-time-code',
                    placeholder: t('login.codePlaceholder'),
                    onChange: function (event) { code[1](event.target.value) },
                    'aria-label': t('login.codeLabel'),
                  }),
                ),
                h('p', { className: 'tg-login-hint' }, t('login.codeHint')),
                h(
                  'div',
                  { className: 'tg-login-actions' },
                  h('button', { type: 'submit', className: 'tg-btn is-primary', disabled: busy[0] !== '' }, busy[0] === 'code' ? t('login.checking') : t('login.verify')),
                  h('button', { type: 'button', className: 'tg-btn tg-login-secondary', onClick: function () { stage[1]('awaiting_phone') }, disabled: busy[0] !== '' }, t('login.changeNumber')),
                ),
              )
            : stage[0] === 'awaiting_2fa'
              ? h(
                  'div',
                  null,
                  h('p', { className: 'tg-login-notice' }, t('login.passwordCloudHint')),
                  typeof hint[0] === 'string' && hint[0] !== ''
                    ? h('p', { className: 'tg-login-hint' }, t('login.passwordHintWith', { hint: hint[0] }))
                    : h('p', { className: 'tg-login-hint' }, t('login.passwordHint')),
                  h(
                    'label',
                    { className: 'tg-login-field' },
                    h('span', { className: 'tg-login-label' }, t('login.passwordLabel')),
                    h('input', {
                      type: 'password',
                      className: 'tg-input',
                      value: password[0],
                      autoComplete: 'current-password',
                      onChange: function (event) { password[1](event.target.value) },
                      'aria-label': t('login.passwordLabel'),
                    }),
                  ),
                  h(
                    'div',
                    { className: 'tg-login-actions' },
                    h('button', { type: 'submit', className: 'tg-btn is-primary', disabled: busy[0] !== '' }, busy[0] === 'password' ? t('login.checking') : t('login.verify')),
                  ),
                )
              : h(
                  'div',
                  null,
                  h('p', { className: 'tg-login-hint' }, t('login.phoneHint')),
                  h(
                    'label',
                    { className: 'tg-login-field' },
                    h('span', { className: 'tg-login-label' }, t('login.phoneLabel')),
                    h('input', {
                      type: 'tel',
                      inputMode: 'tel',
                      className: 'tg-input',
                      value: phone[0],
                      autoComplete: 'tel',
                      placeholder: t('login.phonePlaceholder'),
                      onChange: function (event) { phone[1](event.target.value) },
                      'aria-label': t('login.phoneLabel'),
                    }),
                  ),
                  h(
                    'div',
                    { className: 'tg-login-actions' },
                    h('button', { type: 'submit', className: 'tg-btn is-primary', disabled: busy[0] !== '' }, busy[0] === 'phone' ? t('login.sending') : t('login.start')),
                    h('button', { type: 'button', className: 'tg-btn tg-login-secondary', onClick: switchToQr }, t('login.qrToggle')),
                  ),
                ),
        ),
    errorValue !== ''
      ? h('div', { className: 'tg-login-error', role: 'alert' }, errorValue)
      : null,
  )
}
