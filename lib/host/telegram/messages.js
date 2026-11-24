/**
 * dsh-telegram — message history, sending and read markers (DESIGN.md 3.6;
 * owner `tg-ops`, task t4).
 *
 * Contract exports: `getMessages`, `sendText`, `markRead`, `mapMessage`.
 *
 * The client comes from the tg-core host (`host.ensureConnected()`,
 * `host.resolveChat()`); this module neither builds a client nor knows about
 * HTTP or the agent tool. Every engine exception is converted into a contract
 * code by `errors.js`, and nothing here logs anything: message bodies, phone
 * numbers, sessions and api hashes never reach a log or an error message
 * (DESIGN 3.2).
 *
 * Engine calls used here, all verified against the pinned engine
 * `telegram@2.26.22` (package unpacked in `/tmp/tgpkg/package`):
 *
 * | our step                        | GramJS source |
 * |---------------------------------|---------------|
 * | `client.getMessages(e, p)`      | `client/TelegramClient.d.ts:465` |
 * | history request                 | `client/messages.js:151` → `Api.messages.GetHistory` |
 * | paged search inside a chat      | `client/messages.js:112` → `Api.messages.Search` |
 * | `offsetId` is exclusive         | `client/messages.d.ts:53-54` ("only messages previous to the given ID … Exclusive") |
 * | chunk size 100 per page         | `client/messages.js:33` `_MAX_CHUNK_SIZE = 100` |
 * | `client.sendMessage(e, p)`      | `client/TelegramClient.d.ts:507`, `client/messages.js:448-565` → `Api.messages.SendMessage` |
 * | `replyTo`                       | `client/messages.d.ts:107-108` and `client/messages.js:487-492` → `Api.InputReplyToMessage` |
 * | 4096-character limit            | `client/messages.d.ts:103-105` (`SendMessageParams.message`) |
 * | `client.markAsRead(e, m, p)`    | `client/TelegramClient.d.ts:658`, `client/messages.js:760-787` → `Api.messages.ReadHistory` / `Api.channels.ReadHistory`, `MarkAsReadParams.maxId` wins over `message` |
 * | message DTO fields              | `tl/custom/message.js:48-110` (`id`, `date`, `message`, `out`, `fromId`, `peerId`, `replyTo`, `editDate`, `pinned`, `media`, `entities`, `views`, `action`), `replyToMsgId` getter `tl/custom/message.js:401-403` over `messageReplyHeader.reply_to_msg_id` (`tl/apiTl.js`) |
 * | media classes                   | `tl/custom/message.js:303-390` (`photo`, `document`, `audio`, `voice`, `video`, `videoNote`, `gif`, `sticker`, `contact`, `geo`, `poll`) |
 * | media metadata                  | `tl/custom/file.js:20-77` (`name`, `mimeType`, `width`, `height`, `duration`, `size`) |
 * | gaps in a history page          | `tl/apiTl.js` `messageEmpty#90a6ca84 … id:int … = Message` |
 *
 * `Api.Message` extends the engine's `CustomMessage` (`tl/api.d.ts:1456`), which
 * is why the media getters above are available on every message we receive.
 *
 * The engine is imported lazily (DESIGN 3.3 keeps the eager engine entry point
 * `import { TelegramClient } from 'telegram'` in `client.js`, and DESIGN 8.2
 * level 1 requires the plugin to mount without the engine package): only the
 * `Api` classes used for defensive validation are resolved on first use.
 * @module dsh-telegram/host/telegram/messages
 */

import { CONFIG_DEFAULTS } from '../config.js'
import { fail, isFail, ok, toTelegramError } from './errors.js'

/** Engine package specifier (DESIGN 8.2 keeps the swap point a constant). */
const ENGINE_SPEC = 'telegram'

/** Absolute ceiling of one history page: `messageLimit` is 1..100 (DESIGN 3.1). */
const MESSAGE_LIMIT_CEILING = 100

/** Page size used when the caller asks for nothing (Config default 25). */
const MESSAGE_LIMIT_DEFAULT = CONFIG_DEFAULTS.messageLimit

/** Hard engine limit of one outgoing message (DESIGN 3.1 `textMaxLength`). */
const TEXT_LIMIT_CHARS = CONFIG_DEFAULTS.textMaxLength

/** Lazily resolved `Api` namespace; `null` when the engine package is absent. */
let apiNamespace = null
let apiResolved = false

/** @typedef {{ ok: true, value: any }} Success */
/** @typedef {{ ok: false, error: { code: string, message: string } }} Failure */
/** @typedef {Success | Failure} Result */

/**
 * @typedef {object} MediaMeta
 * @property {'photo' | 'video' | 'document' | 'audio' | 'voice' | 'videoNote' | 'sticker' | 'gif' | 'geo' | 'contact' | 'poll' | 'other'} kind
 * @property {string | null} name
 * @property {string | null} mimeType
 * @property {number | null} sizeBytes
 * @property {number | null} width
 * @property {number | null} height
 * @property {number | null} durationSec
 */

/**
 * @typedef {object} Message
 * @property {number} id
 * @property {string} chatId marked peer id: `userId`, `-chatId`, `-100channelId`
 * @property {number} date unix seconds
 * @property {string} text plain text
 * @property {boolean} fromMe
 * @property {string | null} authorId
 * @property {string | null} authorTitle
 * @property {MediaMeta | null} media
 * @property {number | null} replyToId
 * @property {number | null} editedAt
 * @property {boolean} pinned
 */

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
 * @returns {string} decimal id, `''` when unreadable
 */
function idText(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  if (typeof value?.toString === 'function') {
    const text = String(value.toString()).trim()
    return /^-?\d+$/.test(text) ? text : ''
  }
  return ''
}

/**
 * Finite number from a plain number or a `BigInteger` (`toJSNumber`).
 * @param {unknown} value - raw value
 * @returns {number | null} finite number or null
 */
function numberOrNull(value) {
  if (value === undefined || value === null) return null
  const num = typeof value === 'object' && typeof value.toJSNumber === 'function' ? value.toJSNumber() : Number(value)
  return Number.isFinite(num) ? num : null
}

/**
 * Whole number used as a message id filter (`before`, `up_to`, `reply_to`).
 * @param {unknown} value - raw value
 * @param {number} fallback - value used when nothing was given
 * @returns {number | null} accepted value, null when the value is invalid
 */
function idNumberOrNull(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const num = numberOrNull(value)
  if (num === null || !Number.isInteger(num) || num < 0) return null
  return num
}

/**
 * Marked peer id of a raw peer object, mirroring `getPeerId(peer, true)`
 * (`Utils.js:1036-1076`): user ids unmarked, chat ids negated, channel ids
 * prefixed with `-100`. Class names are read from the object itself
 * (`tl/api.js:238`), so this works without an engine import.
 * @param {any} peer - `Api.TypePeer` or entity
 * @returns {string} marked decimal id, `''` when it cannot be derived
 */
function markedPeerId(peer) {
  if (peer === undefined || peer === null) return ''
  const direct = idText(peer)
  if (direct !== '') return direct
  const kind = typeof peer.className === 'string' ? peer.className : ''
  if (kind === 'PeerUser' || kind === 'User') return idText(peer.userId ?? peer.id)
  if (kind === 'PeerChat' || kind === 'Chat') {
    const chatId = idText(peer.chatId ?? peer.id)
    return chatId === '' ? '' : `-${chatId}`
  }
  if (kind === 'PeerChannel' || kind === 'Channel') {
    const channelId = idText(peer.channelId ?? peer.id)
    return channelId === '' ? '' : `-100${channelId}`
  }
  return ''
}

/**
 * Display name of an entity, mirroring `getDisplayName` (`Utils.js:1207-1226`).
 * @param {any} entity - `Api.User`, `Api.Chat` or `Api.Channel`
 * @returns {string} name or title, `''` when the entity has none
 */
function entityTitle(entity) {
  if (entity === null || typeof entity !== 'object') return ''
  if (typeof entity.title === 'string') return entity.title
  const first = typeof entity.firstName === 'string' ? entity.firstName : ''
  const last = typeof entity.lastName === 'string' ? entity.lastName : ''
  if (first !== '' && last !== '') return `${first} ${last}`
  return first !== '' ? first : last
}

/**
 * Plain text of a message. `message.message` is the plain text Telegram stored
 * (formatting lives in `entities`), and `rawText` is the engine getter for it
 * (`tl/custom/message.js:182-184`); the engine's `text` getter is deliberately
 * not used because it re-inserts markdown when a parse mode is configured.
 * @param {any} message - engine message
 * @returns {string} plain text, `''` when the message has none
 */
function plainText(message) {
  if (typeof message.rawText === 'string') return message.rawText
  return typeof message.message === 'string' ? message.message : ''
}

/**
 * Compact attachment description without downloading a single byte (DESIGN 7.4:
 * media is metadata-only in v1). The media class comes from the engine's own
 * getters, the metadata from `message.file` (`tl/custom/file.js`).
 * @param {any} message - engine message
 * @returns {MediaMeta | null} media metadata, null for a text-only message
 */
/**
 * Read a value through a possibly-throwing engine getter.
 * @param {() => any} read - getter thunk
 * @returns {any} the value, or `undefined` when the getter threw
 */
function safeRead(read) {
  try {
    return read()
  } catch {
    return undefined
  }
}

/**
 * Width/height/duration of a media message, read without the engine's
 * `file.width`/`file.height`/`file.duration` getters: GramJS 2.26.22 passes an
 * array of attribute classes to `File._fromAttr`, which then evaluates
 * `attr instanceof <array>` and throws `TypeError: Right-hand side of
 * 'instanceof' is not callable` for every Document-based media. The raw
 * `photo.sizes`/`document.attributes` values carry the same numbers.
 * @param {any} message - engine message
 * @returns {{ width: number | null, height: number | null, durationSec: number | null }}
 */
function mediaDimensions(message) {
  const out = { width: null, height: null, durationSec: null }
  try {
    const photo = message.photo
    if (photo !== undefined && photo !== null && Array.isArray(photo.sizes) && photo.sizes.length > 0) {
      const size = photo.sizes[photo.sizes.length - 1]
      out.width = numberOrNull(size?.w)
      out.height = numberOrNull(size?.h)
      return out
    }
    const document = message.document
    if (document !== undefined && document !== null && Array.isArray(document.attributes)) {
      for (const attribute of document.attributes) {
        const className = typeof attribute?.className === 'string' ? attribute.className : ''
        if (className === 'DocumentAttributeImageSize' || className === 'DocumentAttributeVideo') {
          out.width = numberOrNull(attribute.w)
          out.height = numberOrNull(attribute.h)
        }
        if (className === 'DocumentAttributeVideo' || className === 'DocumentAttributeAudio') {
          out.durationSec = numberOrNull(attribute.duration)
        }
      }
    }
  } catch {
    // A malformed engine media keeps the null dimensions; the message survives.
  }
  return out
}

/**
 * File name carried by a document's own attributes, used when the engine's
 * `file.name` getter is unavailable.
 * @param {any} message - engine message
 * @returns {string | null} file name or null
 */
function filenameAttribute(message) {
  try {
    const attributes = message?.document?.attributes
    if (!Array.isArray(attributes)) return null
    for (const attribute of attributes) {
      if (attribute?.className === 'DocumentAttributeFilename' && typeof attribute.fileName === 'string' && attribute.fileName !== '') {
        return attribute.fileName
      }
    }
  } catch {
    // Best effort only.
  }
  return null
}

function mediaMeta(message) {
  const file = safeRead(() => message.file)
  let kind = null
  if (message.photo !== undefined && message.photo !== null) kind = 'photo'
  else if (message.sticker !== undefined && message.sticker !== null) kind = 'sticker'
  else if (message.gif !== undefined && message.gif !== null) kind = 'gif'
  else if (message.voice !== undefined && message.voice !== null) kind = 'voice'
  // `video` also matches a round video note, so the note is checked first.
  else if (message.videoNote !== undefined && message.videoNote !== null) kind = 'videoNote'
  else if (message.video !== undefined && message.video !== null) kind = 'video'
  else if (message.audio !== undefined && message.audio !== null) kind = 'audio'
  else if (message.document !== undefined && message.document !== null) kind = 'document'
  else if (message.geo !== undefined && message.geo !== null) kind = 'geo'
  else if (message.contact !== undefined && message.contact !== null) kind = 'contact'
  else if (message.poll !== undefined && message.poll !== null) kind = 'poll'
  else if (message.media !== undefined && message.media !== null) kind = 'other'
  if (kind === null) return null
  const size = numberOrNull(safeRead(() => file?.size)) ?? numberOrNull(message?.document?.size)
  const name = safeRead(() => file?.name) ?? filenameAttribute(message)
  const fromFile = safeRead(() => file?.mimeType)
  const mimeType = typeof fromFile === 'string' && fromFile !== ''
    ? fromFile
    : (message?.document !== undefined && message?.document !== null
        ? message.document.mimeType
        : message?.photo !== undefined && message?.photo !== null ? 'image/jpeg' : null)
  const dimensions = mediaDimensions(message)
  return {
    kind,
    name: typeof name === 'string' && name !== '' ? name : null,
    mimeType: typeof mimeType === 'string' && mimeType !== '' ? mimeType : null,
    sizeBytes: size === null ? null : Math.max(0, Math.round(size)),
    width: dimensions.width,
    height: dimensions.height,
    durationSec: dimensions.durationSec,
  }
}

/**
 * Normalize one engine message into the contract `Message` (DESIGN 3.6).
 * A gap in a history page (`messageEmpty`, id 0) and a value that is not a
 * message both map to `null`; the callers filter them out instead of throwing.
 * @param {any} message - `Api.Message` (`Api.Message extends CustomMessage`, `tl/api.d.ts:1456`)
 * @returns {Message | null} contract DTO
 */
export function mapMessage(message) {
  if (message === null || typeof message !== 'object') return null
  const id = numberOrNull(message.id)
  if (id === null || id <= 0) return null
  const chatId = markedPeerId(message.peerId) || markedPeerId(message._chatPeer)
  const fromId = idText(message.fromId) === '' && message.fromId !== undefined && message.fromId !== null
    ? markedPeerId(message.fromId)
    : idText(message.fromId)
  const authorId = fromId === '' ? null : fromId
  // A broadcast channel post has no `fromId`: the author is the channel itself.
  const authorTitle = authorId !== null
    ? (entityTitle(message._sender) || null)
    : (entityTitle(message._chat) || null)
  const replyToId = numberOrNull(message.replyToMsgId ?? message.replyTo?.replyToMsgId)
  return {
    id,
    chatId,
    date: numberOrNull(message.date) ?? 0,
    text: plainText(message),
    fromMe: message.out === true,
    authorId,
    authorTitle,
    media: safeRead(() => mediaMeta(message)) ?? null,
    replyToId: replyToId === null || replyToId <= 0 ? null : replyToId,
    editedAt: numberOrNull(message.editDate),
    pinned: message.pinned === true,
  }
}

/**
 * Validate the host and open its single-flight connection.
 * @param {any} host - tg-core `TelegramHost`
 * @param {string[]} methods - client methods the operation needs
 * @returns {{ client: any } | Failure} the engine client or a contract failure
 */
async function acquireClient(host, methods) {
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
  // A transport connection is not an authorization: signing in is a user-only
  // flow, and data operations must not spend an RPC on an unauthenticated
  // client (DESIGN 4.5, DESIGN-v0.2 8.3).
  if (typeof host.state === 'function' && host.state().loggedIn !== true) {
    return fail('not_authenticated', 'Telegram is not signed in. Sign in from the Telegram overlay (the paper-plane button).')
  }
  const client = connected?.value?.client
  if (client === null || typeof client !== 'object' || methods.some((name) => typeof client[name] !== 'function')) {
    return fail('engine_unavailable', 'The Telegram client is not available')
  }
  return { client }
}

/**
 * Resolve the requested chat through the host and check that the returned input
 * peer can address a real chat.
 * @param {any} host - tg-core `TelegramHost`
 * @param {string} chatId - chat id or `@username`
 * @returns {Promise<{ resolved: { chatId: string, kind?: string, title?: string, inputEntity: any } } | Failure>}
 */
async function acquireChat(host, chatId) {
  if (typeof host.resolveChat !== 'function') {
    return fail('internal_error', 'The Telegram host cannot resolve chats')
  }
  let resolved
  try {
    resolved = await host.resolveChat(chatId)
  } catch (error) {
    return toTelegramError(error)
  }
  if (isFail(resolved)) return resolved
  const value = resolved?.value
  if (value === null || typeof value !== 'object') {
    return fail('chat_not_found', `Telegram chat "${chatId}" could not be resolved`)
  }
  const api = await engineApi()
  const peer = value.inputEntity
  const empty = peer === null || peer === undefined || (api !== null && peer instanceof api.InputPeerEmpty)
    || (typeof peer?.className === 'string' && peer.className === 'InputPeerEmpty')
  if (empty) {
    const canonical = typeof value.chatId === 'string' ? value.chatId : chatId
    return fail('chat_not_found', `Telegram chat "${canonical}" could not be resolved`)
  }
  return { resolved: value }
}

/**
 * Page size bounded by Config (DESIGN 3.6).
 * @param {unknown} requested - caller `limit`
 * @param {unknown} configured - `Config` ceiling for this operation
 * @param {number} fallbackDefault - Config default
 * @param {number} ceiling - absolute ceiling
 * @returns {number} accepted page size in `1..ceiling`
 */
function resolveLimit(requested, configured, fallbackDefault, ceiling) {
  const configuredValue = numberOrNull(configured) ?? fallbackDefault
  const boundedConfigured = Math.min(Math.max(Math.trunc(configuredValue), 1), ceiling)
  const requestedValue = numberOrNull(requested)
  if (requestedValue === null) return boundedConfigured
  return Math.min(Math.max(Math.trunc(requestedValue), 1), boundedConfigured)
}

/**
 * `GET /messages` and the tool action `get_messages`: one page of a chat
 * history, newest first, exactly the order `Api.messages.GetHistory` returns
 * (the panel renders days top-down and asks for older pages with `before`,
 * DESIGN 7.2).
 * @param {any} host - tg-core `TelegramHost`
 * @param {{ chatId: string, limit?: number, before?: number }} options
 *   `before` is an exclusive message id: only older messages are returned
 * @returns {Promise<Result<{ chatId: string, messages: Message[], hasMore: boolean }>>}
 */
export async function getMessages(host, { chatId, limit, before = 0 } = {}) {
  const wanted = typeof chatId === 'string' ? chatId.trim() : ''
  if (wanted === '') return fail('invalid_arguments', 'chat_id is required to read a chat history')
  const offsetId = idNumberOrNull(before, 0)
  if (offsetId === null) return fail('invalid_arguments', 'before must be a whole message id of 0 or more')
  const acquired = await acquireClient(host, ['getMessages'])
  if (isFail(acquired)) return acquired
  const chat = await acquireChat(host, wanted)
  if (isFail(chat)) return chat
  const size = resolveLimit(limit, host?.config?.messageLimit, MESSAGE_LIMIT_DEFAULT, MESSAGE_LIMIT_CEILING)
  let page
  try {
    page = await acquired.client.getMessages(chat.resolved.inputEntity, { limit: size, offsetId })
  } catch (error) {
    return toTelegramError(error)
  }
  if (!Array.isArray(page)) return fail('upstream_error', 'Telegram returned no message list')
  const messages = []
  for (const raw of page) {
    const dto = mapMessage(raw)
    if (dto !== null) messages.push(dto.chatId === '' ? { ...dto, chatId: chat.resolved.chatId ?? wanted } : dto)
  }
  const total = numberOrNull(page.total)
  const hasMore = total === null ? messages.length >= size : total > messages.length
  return ok({ chatId: chat.resolved.chatId ?? wanted, messages, hasMore })
}

/**
 * `POST /send` and the tool action `send_message`: send plain text to one chat,
 * optionally as a reply to a message id. One chat only — a batch send over a
 * list of chats is out of the contract (DESIGN 4.5), and the tool has no
 * delete/edit/forward action at all.
 * @param {any} host - tg-core `TelegramHost`
 * @param {{ chatId: string, text: string, replyTo?: number }} options
 * @returns {Promise<Result<{ message: Message }>>} the sent message
 */
export async function sendText(host, { chatId, text, replyTo } = {}) {
  const wanted = typeof chatId === 'string' ? chatId.trim() : ''
  if (wanted === '') return fail('invalid_arguments', 'chat_id is required to send a message')
  if (typeof text !== 'string') return fail('invalid_arguments', 'text must be a string')
  const body = text.trim()
  if (body === '') return fail('invalid_arguments', 'text must not be empty')
  const configured = numberOrNull(host?.config?.textMaxLength) ?? TEXT_LIMIT_CHARS
  const ceiling = Math.min(Math.max(Math.trunc(configured), 1), TEXT_LIMIT_CHARS)
  if (Array.from(body).length > ceiling) {
    return fail('message_too_long', `Message text is longer than the ${ceiling} character limit`)
  }
  const replyToId = idNumberOrNull(replyTo, 0)
  if (replyToId === null) return fail('invalid_arguments', 'reply_to must be a whole message id of 1 or more')
  const acquired = await acquireClient(host, ['sendMessage'])
  if (isFail(acquired)) return acquired
  const chat = await acquireChat(host, wanted)
  if (isFail(chat)) return chat
  /** @type {any} */
  const params = { message: body }
  if (replyToId !== null && replyToId > 0) params.replyTo = replyToId
  let sent
  try {
    sent = await acquired.client.sendMessage(chat.resolved.inputEntity, params)
  } catch (error) {
    return toTelegramError(error)
  }
  const dto = mapMessage(sent)
  if (dto === null) return fail('upstream_error', 'Telegram did not return the sent message')
  return ok({ message: dto.chatId === '' ? { ...dto, chatId: chat.resolved.chatId ?? wanted } : dto })
}

/**
 * `POST /read` and the tool action `mark_read`: acknowledge the chat through a
 * message id. `upTo = 0` acknowledges everything up to the newest message,
 * which is what `Api.messages.ReadHistory`/`Api.channels.ReadHistory` do with
 * `max_id = 0` (verified in `client/messages.js:760-787`).
 * @param {any} host - tg-core `TelegramHost`
 * @param {{ chatId: string, upTo?: number }} options
 * @returns {Promise<Result<{ chatId: string, marked: true, maxId: number }>>}
 */
export async function markRead(host, { chatId, upTo = 0 } = {}) {
  const wanted = typeof chatId === 'string' ? chatId.trim() : ''
  if (wanted === '') return fail('invalid_arguments', 'chat_id is required to mark a chat as read')
  const maxId = idNumberOrNull(upTo, 0)
  if (maxId === null) return fail('invalid_arguments', 'up_to must be a whole message id of 0 or more')
  const acquired = await acquireClient(host, ['markAsRead'])
  if (isFail(acquired)) return acquired
  const chat = await acquireChat(host, wanted)
  if (isFail(chat)) return chat
  let acknowledged
  try {
    acknowledged = await acquired.client.markAsRead(chat.resolved.inputEntity, undefined, { maxId, clearMentions: true })
  } catch (error) {
    return toTelegramError(error)
  }
  if (acknowledged === false) return fail('upstream_error', 'Telegram did not acknowledge the read marker')
  return ok({ chatId: chat.resolved.chatId ?? wanted, marked: true, maxId })
}
