// 55-profile.js — the profile screen data and rendering (DESIGN-v0.2 7.4).
//
// `useProfile(ctx, active, target)` reads `/profile` for the signed-in account
// by default, or for `target.userId` / `target.chatId` when the overlay asks for
// a user or a channel. The phone number arrives masked; the full value is fetched
// only after the explicit "Reveal" action (`reveal=phone`) and stays in this
// component's memory.

function profileUrl(target, reveal) {
  const params = {}
  if (isRecord(target)) {
    if (typeof target.userId === 'string' && target.userId !== '') params.userId = target.userId
    if (typeof target.chatId === 'string' && target.chatId !== '') params.chatId = target.chatId
  }
  if (reveal === true) params.reveal = 'phone'
  return apiUrl(ROUTES.profile, params)
}

function useProfile(ctx, active, target) {
  const user = useState(null)
  const loading = useState(true)
  const error = useState(null)
  const revealed = useState(false)
  const targetKey = isRecord(target) ? String(target.userId ?? '') + '|' + String(target.chatId ?? '') : ''
  const mounted = useRef(true)
  useEffect(function () {
    mounted.current = true
    return function () {
      mounted.current = false
    }
  }, [])
  const load = useCallback(function (reveal) {
    loading[1](true)
    return apiRequest('GET', profileUrl(target, reveal === true)).then(function (reply) {
      if (mounted.current !== true) return reply
      if (reply.ok === true && isRecord(reply.data) && isRecord(reply.data.user)) {
        user[1](reply.data.user)
        error[1](null)
      } else if (reply.ok === false && reply.code !== 'aborted') {
        error[1]({ code: reply.code, message: reply.message, retryAfterMs: reply.retryAfterMs })
      }
      loading[1](false)
      return reply
    })
  }, [targetKey])
  useEffect(function () {
    user[1](null)
    revealed[1](false)
    load(false)
    return function () {
      abortRequests(ROUTES.profile)
    }
  }, [targetKey, active, load])
  const reveal = useCallback(function () {
    revealed[1](true)
    return load(true)
  }, [load])
  return { user: user[0], loading: loading[0], error: error[0], revealed: revealed[0], refresh: function () { return load(revealed[0]) }, reveal: reveal }
}

function ProfileField(props) {
  const value = props.value
  if (value === null || value === undefined || value === '') return null
  return h(
    'div',
    { className: 'tg-profile-field' },
    h('dt', { className: 'tg-profile-label' }, props.label),
    h('dd', { className: 'tg-profile-value' }, value),
    props.action !== undefined ? props.action : null,
  )
}

function ProfileScreen(props) {
  const ctx = props.ctx
  const t = props.t
  const active = props.active
  const target = isRecord(props.target) ? props.target : null
  const data = useProfile(ctx, active, target)
  const user = data.user
  const kindLabel = user === null
    ? ''
    : user.kind === 'channel'
      ? t('profile.kindChannel')
      : user.kind === 'chat'
        ? t('profile.kindChat')
        : user.kind === 'self'
          ? t('profile.kindSelf')
          : t('profile.kindUser')
  // «Write» opens the conversation with this account (Saved Messages for the
  // own profile), a group or a channel. It is hidden only when the DTO names no
  // peer at all.
  const writeId = user === null
    ? null
    : typeof user.chatId === 'string' && user.chatId !== ''
      ? user.chatId
      : typeof user.userId === 'string' && user.userId !== ''
        ? user.userId
        : null
  const canWrite = writeId !== null && typeof props.onWrite === 'function'
  const canSelect = user !== null && typeof props.onSelect === 'function'
  const descriptor = user === null ? null : selectionDescriptorOfProfile(user)
  const descriptorRef = descriptor === null ? '' : descriptor.ref
  const selectionMode = props.selectionMode === true
  const marked = Array.isArray(props.selectedRefs) && descriptorRef !== '' && props.selectedRefs.indexOf(descriptorRef) >= 0
  if (descriptor !== null && typeof props.onRegisterSelection === 'function') props.onRegisterSelection(descriptor)
  return h(
    'div',
    { className: 'tg-profile', 'data-dsh-telegram': 'profile' },
    h(
      'div',
      { className: 'tg-profile-head' },
      h('h3', { className: 'tg-profile-title' }, t('profile.title')),
      marked === true ? h('span', { className: 'tg-profile-mark', 'aria-hidden': 'true' }, '\u2713') : null,
      typeof props.onClose === 'function'
        ? h('button', { type: 'button', className: 'tg-btn', onClick: props.onClose }, t('profile.close'))
        : null,
    ),
    data.loading === true && user === null
      ? h('p', { className: 'tg-profile-state', role: 'status' }, t('profile.loading'))
      : data.error !== null
        ? h(
            'div',
            { className: 'tg-profile-state', role: 'alert' },
            errorText(data.error, t),
            h('button', { type: 'button', className: 'tg-btn', onClick: data.refresh }, t('state.retry')),
          )
        : user === null
          ? h('p', { className: 'tg-profile-state' }, t('profile.empty'))
          : h(
              'div',
              {
                className: classNameOf('tg-profile-body', { 'is-marked': marked }),
                'data-tg-sel': descriptorRef === '' ? undefined : descriptorRef,
                'data-tg-kind': 'profile',
                'data-tg-selected': marked ? 'true' : undefined,
                'aria-pressed': selectionMode === true ? (marked ? 'true' : 'false') : undefined,
                onClick: function (event) {
                  if (selectionMode !== true || descriptor === null) return
                  if (typeof props.onToggleSelection !== 'function') return
                  if (selectionStartsDrag(event === null || event === undefined ? null : event.target) !== true) return
                  props.onToggleSelection(descriptor)
                },
              },
              h(
                'div',
                { className: 'tg-profile-hero' },
                h(
                  'span',
                  { className: 'tg-profile-avatar', style: { background: avatarTokenOf(user.chatId ?? user.userId ?? 'profile') }, 'aria-hidden': true },
                  h('span', { className: 'tg-profile-glyph' }, initialOf(user.title)),
                ),
                h(
                  'div',
                  null,
                  h('h4', { className: 'tg-profile-name' }, user.title),
                  h('span', { className: 'tg-profile-badge' }, kindLabel),
                  typeof user.username === 'string' && user.username !== ''
                    ? h('span', { className: 'tg-profile-username' }, '@' + user.username)
                    : null,
                ),
              ),
              h(
                'dl',
                { className: 'tg-profile-list' },
                h(ProfileField, { label: t('profile.fieldId'), value: user.userId ?? user.chatId }),
                h(ProfileField, { label: t('profile.fieldUsername'), value: user.username === null ? null : '@' + user.username }),
                h(ProfileField, { label: t('profile.fieldKind'), value: kindLabel }),
                h(ProfileField, {
                  label: t('profile.fieldPhone'),
                  value: data.revealed === true && typeof user.phone === 'string' ? user.phone : user.phoneMasked,
                  action: typeof user.phoneMasked === 'string' && user.phoneMasked !== '' && data.revealed !== true
                    ? h('button', { type: 'button', className: 'tg-btn', onClick: data.reveal }, t('profile.revealPhone'))
                    : null,
                }),
                h(ProfileField, { label: t('profile.fieldBio'), value: user.bio }),
                user.participantsCount !== null && user.participantsCount !== undefined
                  ? h(ProfileField, {
                      label: user.kind === 'channel' ? t('profile.fieldSubscribers') : t('profile.fieldMembers'),
                      value: String(user.participantsCount),
                    })
                  : null,
                user.commonChatsCount !== null && user.commonChatsCount !== undefined
                  ? h(ProfileField, { label: t('profile.fieldCommonChats'), value: String(user.commonChatsCount) })
                  : null,
                user.dcId !== null && user.dcId !== undefined
                  ? h(ProfileField, { label: t('profile.fieldDc'), value: String(user.dcId) })
                  : null,
              ),
              canWrite === true || canSelect === true
                ? h(
                    'div',
                    { className: 'tg-profile-actions' },
                    canWrite === true
                      ? h(
                          'button',
                          {
                            type: 'button',
                            className: 'tg-btn is-primary tg-profile-action',
                            'data-dsh-telegram': 'profile-write',
                            onClick: function () {
                              props.onWrite(user)
                            },
                          },
                          t('profile.write'),
                        )
                      : null,
                    canSelect === true
                      ? h(
                          'button',
                          {
                            type: 'button',
                            className: 'tg-btn tg-profile-action',
                            'data-dsh-telegram': 'profile-select',
                            onClick: function () {
                              props.onSelect(user)
                            },
                          },
                          t('profile.select'),
                        )
                      : null,
                  )
                : null,
            ),
  )
}
