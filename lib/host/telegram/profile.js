/**
 * dsh-telegram — the profile screen's data source (DESIGN-v0.2 7.4).
 *
 * One operation serves `/api/dsh-telegram/profile` and the panel's profile
 * screen: the signed-in user (`userId` omitted), another user (`userId`) or a
 * chat/channel (`chatId`). The DTO is an explicit allow-list — a phone number is
 * masked by default, the full value is returned only when the request asks for
 * a reveal, and no session, api hash, auth key or raw TL object ever leaves this
 * module (DESIGN-v0.2 5.5, 9.4).
 *
 * Verified TL names for `telegram@2.26.22`: `Api.users.GetFullUser({id})` →
 * `{ fullUser: Api.UserFull }`; `Api.channels.GetFullChannel({channel})` and
 * `Api.messages.GetFullChat({chatId})` → `{ fullChat }`
 * (`tl/api.d.ts:22788`, `:27108`, `:23499`). `Api.UserFull.about` and
 * `commonChatsCount` are optional (`:2913-2933`).
 *
 * @module dsh-telegram/host/telegram/profile
 */

import { fail, isFail, ok, toTelegramError } from './errors.js'

/** Engine package specifier (DESIGN 8.2 keeps the swap point a constant). */
const ENGINE_SPEC = 'telegram'

/** Lazily resolved `Api` namespace; `null` when the engine package is absent. */
let apiNamespace = null
let apiResolved = false

/**
 * Resolve the engine's `Api` classes on first use (never at module load).
 * @returns {Promise<any | null>} `Api` or null when the engine is unavailable
 */
async function engineApi() {
  if (apiResolved) return apiNamespace
  apiResolved = true
  try {
    const namespace = await import(ENGINE_SPEC)
    const module = namespace?.default ?? namespace
    apiNamespace = module?.Api ?? null
  } catch {
    apiNamespace = null
  }
  return apiNamespace
}

/**
 * Decimal id text from `BigInteger`, number or string; never rounds a large id.
 * @param {unknown} value - raw id
 * @returns {string | null} decimal id text or null
 */
function idText(value) {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return value.trim() === '' ? null : value.trim()
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null
  if (typeof value?.toString === 'function') {
    const text = String(value.toString()).trim()
    return /^-?\d+$/.test(text) ? text : null
  }
  return null
}

/**
 * Mask a phone number for a DTO (DESIGN 3.3 `'+7 9** ** **12'`).
 * @param {unknown} value - raw number
 * @returns {string | null} mask, or null
 */
function maskPhone(value) {
  if (typeof value !== 'string') return null
  const digits = value.replace(/\D/g, '')
  if (digits.length < 6) return null
  return `+${digits.slice(0, 1)} ${digits.slice(1, 2)}** ** **${digits.slice(-2)}`
}

/**
 * Display name of a user, mirroring `getDisplayName`.
 * @param {any} entity - `Api.User`
 * @returns {string} name or `''`
 */
function userName(entity) {
  if (entity === null || typeof entity !== 'object') return ''
  const first = typeof entity.firstName === 'string' ? entity.firstName.trim() : ''
  const last = typeof entity.lastName === 'string' ? entity.lastName.trim() : ''
  const names = [first, last].filter((part) => part !== '').join(' ')
  if (names !== '') return names
  return typeof entity.username === 'string' && entity.username.trim() !== '' ? `@${entity.username.trim()}` : ''
}

/**
 * @typedef {object} ProfileDto
 * @property {string | null} userId account id of the profile
 * @property {string | null} chatId canonical chat id of the profile
 * @property {'self' | 'user' | 'chat' | 'channel'} kind
 * @property {string} title display name or chat title
 * @property {string | null} username public username without `@`
 * @property {string | null} phoneMasked masked phone, always safe to render
 * @property {string | null} phone full phone, only when explicitly revealed
 * @property {string | null} bio profile bio / channel description
 * @property {number | null} dcId data center of the stored authorization
 * @property {number | null} participantsCount members/subscribers when provided
 * @property {number | null} commonChatsCount common chats when provided
 * @property {boolean} isSelf true for the signed-in account
 */

/**
 * Read one profile. Identity is the caller's own by default, or the requested
 * user / chat.
 * @param {any} host - tg-core `TelegramHost`
 * @param {{ userId?: string | null, chatId?: string | null, revealPhone?: boolean }} [options]
 * @returns {Promise<Result<{ user: ProfileDto }>>}
 */
export async function getProfile(host, { userId = null, chatId = null, revealPhone = false } = {}) {
  if (host === null || typeof host !== 'object' || typeof host.ensureConnected !== 'function') {
    return fail('internal_error', 'The Telegram host is not available')
  }
  let connected
  try {
    connected = await host.ensureConnected()
  } catch (error) {
    return toTelegramError(error)
  }
  if (isFail(connected)) return connected
  if (typeof host.state === 'function' && host.state().loggedIn !== true) {
    return fail('not_authenticated', 'Telegram is not signed in. Sign in from the Telegram overlay (the paper-plane button).')
  }
  const client = connected?.value?.client
  if (client === null || typeof client !== 'object' || typeof client.getEntity !== 'function') {
    return fail('engine_unavailable', 'The Telegram client is not available')
  }
  const api = await engineApi()
  if (api === null) return fail('engine_unavailable', 'The Telegram engine is not available')

  const wantedUser = typeof userId === 'string' ? userId.trim() : ''
  const wantedChat = typeof chatId === 'string' ? chatId.trim() : ''

  try {
    if (wantedChat !== '') {
      if (typeof host.resolveChat !== 'function') return fail('internal_error', 'The Telegram host cannot resolve chats')
      const resolved = await host.resolveChat(wantedChat)
      if (isFail(resolved)) return resolved
      const value = resolved.value
      const entity = await client.getEntity(value.inputEntity)
      const kind = value.kind === 'channel' ? 'channel' : 'chat'
      /** @type {ProfileDto} */
      const dto = {
        userId: null,
        chatId: typeof value.chatId === 'string' ? value.chatId : wantedChat,
        kind,
        title: typeof value.title === 'string' && value.title !== '' ? value.title : wantedChat,
        username: typeof entity?.username === 'string' && entity.username.trim() !== '' ? entity.username.trim() : null,
        phoneMasked: null,
        phone: null,
        bio: null,
        dcId: Number.isInteger(client?.session?.dcId) ? client.session.dcId : null,
        participantsCount: Number.isFinite(Number(entity?.participantsCount)) ? Math.max(0, Math.trunc(Number(entity.participantsCount))) : null,
        commonChatsCount: null,
        isSelf: false,
      }
      // About / member counts live in the "full" object, not the entity.
      try {
        const full = entity?.className === 'Channel'
          ? await client.invoke(new api.channels.GetFullChannel({ channel: value.inputEntity }))
          : await client.invoke(new api.messages.GetFullChat({ chatId: entity?.id }))
        const fullChat = full?.fullChat
        if (typeof fullChat?.about === 'string' && fullChat.about.trim() !== '') dto.bio = fullChat.about.trim()
        if (Number.isFinite(Number(fullChat?.participantsCount))) {
          dto.participantsCount = Math.max(0, Math.trunc(Number(fullChat.participantsCount)))
        }
      } catch {
        // The basic entity already answers the screen; the full object is optional.
      }
      return ok({ user: dto })
    }

    // Self or another user. `getEntity('me')` returns the signed-in user.
    const target = wantedUser !== '' ? wantedUser : 'me'
    const entity = await client.getEntity(target)
    const isSelf = wantedUser === '' || idText(entity?.id) === idText(client?.session?.userId)
    /** @type {ProfileDto} */
    const dto = {
      userId: idText(entity?.id),
      chatId: null,
      kind: isSelf ? 'self' : 'user',
      title: userName(entity) || (idText(entity?.id) ?? ''),
      username: typeof entity?.username === 'string' && entity.username.trim() !== '' ? entity.username.trim() : null,
      phoneMasked: maskPhone(entity?.phone),
      phone: revealPhone === true && typeof entity?.phone === 'string' && entity.phone.trim() !== '' ? entity.phone.trim() : null,
      bio: null,
      dcId: Number.isInteger(client?.session?.dcId) ? client.session.dcId : null,
      participantsCount: null,
      commonChatsCount: null,
      isSelf,
    }
    try {
      const inputPeer = await client.getInputEntity(entity)
      const full = await client.invoke(new api.users.GetFullUser({ id: inputPeer }))
      const fullUser = full?.fullUser
      if (typeof fullUser?.about === 'string' && fullUser.about.trim() !== '') dto.bio = fullUser.about.trim()
      if (Number.isFinite(Number(fullUser?.commonChatsCount))) {
        dto.commonChatsCount = Math.max(0, Math.trunc(Number(fullUser.commonChatsCount)))
      }
    } catch {
      // The basic user already answers the screen.
    }
    return ok({ user: dto })
  } catch (error) {
    return toTelegramError(error)
  }
}
