/**
 * dsh-telegram — dialogs and chats (DESIGN.md 3.6; owner `tg-ops`, task t4).
 *
 * Contract exports: `listChats`, `getChat`, `mapDialog`.
 *
 * The MTProto client is always supplied by the tg-core host: every operation
 * starts with `await host.ensureConnected()` and, for a single chat, with
 * `host.resolveChat(chatId)`. This module never builds a client, never knows
 * about HTTP and never knows about the agent tool, so one implementation serves
 * both the panel routes (DESIGN 5.3) and the agent tool (DESIGN 4.3).
 * Nothing here throws: every failure is a `Result` failure from `errors.js`.
 *
 * Engine calls used here, all verified against the pinned engine
 * `telegram@2.26.22` (package unpacked in `/tmp/tgpkg/package`):
 *
 * | our step                | GramJS source                                              |
 * |-------------------------|------------------------------------------------------------|
 * | `client.getDialogs(p)`  | `client/TelegramClient.d.ts:695`, `client/dialogs.js:171` |
 * | page iterator           | `client/dialogs.js:51-59` → `Api.messages.GetDialogs`      |
 * | `archived` semantics    | `client/dialogs.js:155-157` — `archived != undefined → folder = archived ? 1 : 0` |
 * | `IterDialogsParams`     | `client/dialogs.d.ts:19-45` (`limit`, `folder`, `archived`, `ignorePinned`) |
 * | `Dialog` fields         | `tl/custom/dialog.js:16-52` (`pinned`, `folderId`, `archived`, `message`, `date`, `entity`, `inputEntity`, `id`, `name`, `title`, `unreadCount`, `isUser`, `isGroup`, `isChannel`) |
 * | raw `Api.Dialog`        | `tl/api.d.ts:2447-2464` (`peer`, `topMessage`, `unreadCount`, `folderId`) |
 * | marked peer id rule     | `Utils.js:1036-1076` `getPeerId(peer, addMark = true)` → `userId` / `-chatId` / `-100channelId` |
 *
 * Engine import is lazy on purpose: DESIGN 3.3 keeps the eager engine entry
 * point (`import { TelegramClient } from 'telegram'`) inside `client.js` as the
 * single engine mount point, and DESIGN 8.2 level 1 requires this plugin to
 * mount even when the engine package is absent. The `Api` classes are therefore
 * resolved on first use here, never at module load.
 * @module dsh-telegram/host/telegram/chats
 */

import { createRequire } from 'node:module'

import { CONFIG_DEFAULTS } from '../config.js'
import { fail, isFail, ok, toTelegramError } from './errors.js'
import { mapMessage } from './messages.js'

/** Engine package specifier (DESIGN 8.2 keeps the swap point a constant). */
const ENGINE_SPEC = 'telegram'

/** Absolute ceiling of one dialog page: `dialogLimit` is 1..100 (DESIGN 3.1). */
const DIALOG_LIMIT_CEILING = 100

/** Page size used when the caller asks for nothing (Config default 30). */
const DIALOG_LIMIT_DEFAULT = CONFIG_DEFAULTS.dialogLimit

/** `MessageBrief.text` cut length (DESIGN 3.6). */
const BRIEF_TEXT_CHARS = 160

/** Marker appended to a cut `MessageBrief.text`. */
const BRIEF_ELLIPSIS = '…'

/** Dialogs fetched by `getChat` while looking for the matching dialog row. */
const GET_CHAT_DIALOG_SCAN = DIALOG_LIMIT_CEILING

/** @typedef {'user' | 'chat' | 'channel'} ChatKind */

/**
 * @typedef {object} MessageBrief
 * @property {number} id
 * @property {number} date unix seconds
 * @property {string} text cut to {@link BRIEF_TEXT_CHARS} characters
 * @property {boolean} fromMe
 */

/**
 * @typedef {object} ChatSummary
 * @property {string} chatId marked peer id: `userId`, `-chatId`, `-100channelId`
 * @property {ChatKind} kind
 * @property {string} title
 * @property {boolean} pinned
 * @property {boolean} archived
 * @property {number} unreadCount
 * @property {MessageBrief | null} lastMessage
 * @property {number} updatedAt unix seconds
 */

/** @typedef {{ ok: true, value: any }} Success */
/** @typedef {{ ok: false, error: { code: string, message: string } }} Failure */
/** @typedef {Success | Failure} Result */

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
  // Same fallback as profile.js: a resolver may expose the ESM namespace
  // without the CJS named exports, while `require` still returns the package.
  if (apiNamespace === null) {
    try {
      const require = createRequire(import.meta.url)
      const module = require(ENGINE_SPEC)
      apiNamespace = module?.Api ?? module?.default?.Api ?? null
    } catch {
      apiNamespace = null
    }
  }
  return apiNamespace
}

/**
 * Read a decimal id from anything the engine hands over (`BigInteger`, number,
 * string). BigIntegers are kept as text so an id above 2^53 never rounds.
 * @param {unknown} value - raw id
 * @returns {string} decimal id, `''` when there is nothing readable
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
 * Read a finite number from anything the engine hands over.
 * @param {unknown} value - raw number or `BigInteger`
 * @returns {number | null} finite number or null
 */
function numberOrNull(value) {
  if (value === undefined || value === null) return null
  const num = typeof value === 'object' && typeof value.toJSNumber === 'function' ? value.toJSNumber() : Number(value)
  return Number.isFinite(num) ? num : null
}

/**
 * Marked peer id of a raw peer or entity object, mirroring
 * `getPeerId(peer, addMark = true)` from the engine (`Utils.js:1036`):
 * user ids stay unmarked, chat ids are negated, channel ids get `-100`.
 * The TL class name is read from the object itself (`tl/api.js:238` assigns
 * `className` on every instance), so no engine import is needed here.
 * @param {any} peer - `PeerUser` / `PeerChat` / `PeerChannel` / `User` / `Chat` / `Channel`
 * @returns {string} marked decimal id, `''` when it cannot be derived
 */
function markedPeerId(peer) {
  if (peer === undefined || peer === null) return ''
  const direct = idText(peer)
  if (direct !== '') return direct
  const kind = typeof peer.className === 'string' ? peer.className : ''
  if (kind === 'PeerUser' || kind === 'InputPeerUser' || kind === 'User') return idText(peer.userId ?? peer.id)
  if (kind === 'PeerChat' || kind === 'InputPeerChat' || kind === 'Chat') {
    const chatId = idText(peer.chatId ?? peer.id)
    return chatId === '' ? '' : `-${chatId}`
  }
  if (kind === 'PeerChannel' || kind === 'InputPeerChannel' || kind === 'Channel') {
    const channelId = idText(peer.channelId ?? peer.id)
    return channelId === '' ? '' : `-100${channelId}`
  }
  // `Api.Dialog` and wrappers carry their peer under `peer`.
  if (peer.peer !== undefined) return markedPeerId(peer.peer)
  return ''
}

/**
 * `ChatKind` of a dialog, preferring the explicit engine flags. A megagroup is
 * both `isChannel` and `isGroup` in GramJS, so the group flag wins.
 * @param {any} dialog - engine `Dialog`
 * @param {string} chatId - marked id, used as the last fallback
 * @returns {ChatKind} chat kind
 */
function chatKindOf(dialog, chatId) {
  if (dialog?.isGroup === true) return 'chat'
  if (dialog?.isChannel === true) return 'channel'
  if (dialog?.isUser === true) return 'user'
  if (chatId.startsWith('-100')) return 'channel'
  if (chatId.startsWith('-')) return 'chat'
  return 'user'
}

/**
 * Cut a message text to the `MessageBrief` size (DESIGN 3.6).
 * @param {string} text - full text
 * @returns {string} brief text
 */
function briefText(text) {
  const chars = Array.from(typeof text === 'string' ? text : '')
  if (chars.length <= BRIEF_TEXT_CHARS) return chars.join('')
  return `${chars.slice(0, BRIEF_TEXT_CHARS).join('')}${BRIEF_ELLIPSIS}`
}

/**
 * Normalize one engine `Dialog` into the contract `ChatSummary` (DESIGN 3.6).
 * A value that is not a dialog maps to `null`; `listChats` filters those out
 * instead of throwing.
 * @param {any} dialog - engine `Dialog` (`tl/custom/dialog.js`)
 * @returns {ChatSummary | null} contract DTO
 */
export function mapDialog(dialog) {
  if (dialog === null || typeof dialog !== 'object') return null
  const chatId = idText(dialog.id) || markedPeerId(dialog.dialog?.peer) || markedPeerId(dialog.entity)
  const lastDto = mapMessage(dialog.message)
  const lastMessage = lastDto === null
    ? null
    : { id: lastDto.id, date: lastDto.date, text: briefText(lastDto.text), fromMe: lastDto.fromMe }
  const title = typeof dialog.title === 'string' && dialog.title !== ''
    ? dialog.title
    : typeof dialog.name === 'string' && dialog.name !== ''
      ? dialog.name
      : chatId
  return {
    chatId,
    kind: chatKindOf(dialog, chatId),
    title,
    pinned: dialog.pinned === true,
    archived: dialog.archived === true,
    unreadCount: numberOrNull(dialog.unreadCount) ?? 0,
    lastMessage,
    updatedAt: numberOrNull(dialog.date) ?? 0,
  }
}

/**
 * Stable order of the chat list (DESIGN 7.2): pinned first, then the newest
 * last message, then the id so the order never depends on the server's page order.
 * @param {ChatSummary} a
 * @param {ChatSummary} b
 * @returns {number} comparator result
 */
function compareChats(a, b) {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt
  if (a.chatId !== b.chatId) return a.chatId < b.chatId ? -1 : 1
  return 0
}

/**
 * Validate the host and open its single-flight connection.
 * @param {any} host - tg-core `TelegramHost`
 * @returns {{ client: any } | Failure} the engine client or a contract failure
 */
async function acquireClient(host) {
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
  if (client === null || typeof client !== 'object' || typeof client.getDialogs !== 'function') {
    return fail('engine_unavailable', 'The Telegram client is not available')
  }
  return { client }
}

/**
 * Resolve a page size from the request and the plugin config (DESIGN 3.6:
 * limits are bounded by `dialogLimit`/`messageLimit`/`searchLimit`).
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
 * How many items the engine reported in total (a `TotalList` carries `total`).
 * @param {any} list - engine `TotalList`
 * @returns {number | null} server total, null when it is not readable
 */
function serverTotal(list) {
  return numberOrNull(list?.total)
}

/**
 * `GET /dialogs` and the tool action `list_chats`: the dialog list of the
 * signed-in account (DESIGN 3.6, 4.3, 5.3).
 * @param {any} host - tg-core `TelegramHost` (supplies the client)
 * @param {{ limit?: number, includeArchived?: boolean }} [options]
 * @returns {Promise<Result<{ chats: ChatSummary[], count: number, truncated: boolean }>>}
 */
export async function listChats(host, { limit, includeArchived = false, offsetDate = null, offsetId = null, offsetPeer = null } = {}) {
  const acquired = await acquireClient(host)
  if (isFail(acquired)) return acquired
  const size = resolveLimit(limit, host?.config?.dialogLimit, DIALOG_LIMIT_DEFAULT, DIALOG_LIMIT_CEILING)
  // `archived: false` means folder 0 (no archived dialogs), `undefined` means
  // every folder, including archived (verified in client/dialogs.js:155-157).
  const archived = includeArchived === true ? undefined : false
  const boundary = typeof offsetPeer === 'string' ? offsetPeer.trim() : ''
  const paging = {}
  if (Number.isInteger(offsetDate) && offsetDate > 0) paging.offsetDate = offsetDate
  if (Number.isInteger(offsetId) && offsetId > 0) paging.offsetId = offsetId
  if (boundary !== '' && typeof host.resolveChat === 'function') {
    try {
      const resolved = await host.resolveChat(boundary)
      if (!isFail(resolved) && resolved.value?.inputEntity !== undefined) paging.offsetPeer = resolved.value.inputEntity
    } catch {
      // A pagination cursor without the peer still continues from date/id.
    }
  }
  let dialogs
  try {
    dialogs = await acquired.client.getDialogs({ limit: size, archived, ...paging })
  } catch (error) {
    // The engine's custom `Dialog` constructor reads `message.date`
    // (`tl/custom/dialog.js:26`) and throws for one dialog whose top message is
    // missing, which would fail the whole page. Fall back to the raw TL page:
    // GramJS builds no per-dialog wrapper there, so one odd row cannot take
    // down the list. Keep the engine error when even the raw page is empty.
    const fallback = await listChatsRaw(acquired.client, size, includeArchived, paging, boundary)
    if (isFail(fallback) || fallback.value.chats.length === 0) return toTelegramError(error)
    return fallback
  }
  if (!Array.isArray(dialogs)) return fail('upstream_error', 'Telegram returned no dialog list')
  const mapped = []
  for (const dialog of dialogs) {
    const summary = mapDialog(dialog)
    if (summary === null || summary.chatId === '' || summary.chatId === boundary) continue
    mapped.push(summary)
  }
  const next = nextDialogCursor(mapped)
  const chats = mapped.slice().sort(compareChats)
  const total = serverTotal(dialogs)
  const truncated = total === null ? chats.length >= size : total > chats.length
  return ok({ chats, count: chats.length, truncated, next })
}

/**
 * Cursor for the next `list_chats` page, taken from the last dialog in server
 * order (before the pinned-first sort). Telegram's offset is inclusive, so the
 * caller's `offset_peer` row is filtered out by `listChats`.
 * @param {ChatSummary[]} chats - mapped page in server order
 * @returns {{ offsetDate: number, offsetId: number, offsetPeer: string } | null}
 */
function nextDialogCursor(chats) {
  const last = chats.length > 0 ? chats[chats.length - 1] : null
  if (last === null) return null
  return {
    offsetDate: last.updatedAt,
    offsetId: last.lastMessage === null ? 0 : last.lastMessage.id,
    offsetPeer: last.chatId,
  }
}

/**
 * Raw dialog page for the fallback path of {@link listChats}. Uses
 * `messages.getDialogs` through `client.invoke`, whose response carries plain
 * TL `Dialog`/`Message`/`User`/`Chat`/`Channel` objects: no engine wrapper
 * constructor runs, so a dialog with a missing top message cannot throw.
 *
 * `archived: false` means folder 0; `includeArchived` merges folder 1. The
 * engine's `getDialogs` page iterator is not reused because it also builds the
 * wrappers that fail.
 *
 * @param {any} client - engine client
 * @param {number} size - page size per folder
 * @param {boolean} includeArchived - also read the archive folder
 * @returns {Promise<Result<{ chats: ChatSummary[], count: number, truncated: boolean }>>}
 */
async function listChatsRaw(client, size, includeArchived, paging = {}, boundary = '') {
  const api = await engineApi()
  if (api === null) return fail('engine_unavailable', 'The Telegram engine is not available')
  const folders = includeArchived === true ? [0, 1] : [0]
  const chats = []
  let total = null
  for (const folderId of folders) {
    let page
    try {
      page = await client.invoke(new api.messages.GetDialogs({
        offsetPeer: paging.offsetPeer ?? new api.InputPeerEmpty(),
        offsetDate: Number.isInteger(paging.offsetDate) ? paging.offsetDate : 0,
        offsetId: Number.isInteger(paging.offsetId) ? paging.offsetId : 0,
        limit: size,
        hash: 0,
        excludePinned: false,
        folderId,
      }))
    } catch (error) {
      if (folderId === 0) return toTelegramError(error)
      continue
    }
    chats.push(...mapRawDialogPage(page).filter((row) => row.chatId !== boundary))
    const count = numberOrNull(page?.count)
    if (count !== null) total = (total ?? 0) + count
  }
  if (chats.length === 0) return fail('upstream_error', 'Telegram returned no dialog list')
  chats.sort(compareChats)
  const truncated = total === null ? chats.length >= size : total > chats.length
  return ok({ chats, count: chats.length, truncated, next: null })
}

/**
 * Map one raw `messages.getDialogs` response to contract `ChatSummary` values.
 * Every field is read defensively: a `ChannelForbidden`, a peer without a chat
 * entity or a missing top message degrades that one row instead of throwing.
 * Exported for the unit tests (`test/chats-raw.test.mjs`).
 *
 * @param {any} page - raw `messages.Dialogs`/`messages.DialogsSlice` value
 * @returns {ChatSummary[]} mapped chats in server order
 */
export function mapRawDialogPage(page) {
  const dialogs = Array.isArray(page?.dialogs) ? page.dialogs : []
  const rawMessages = Array.isArray(page?.messages) ? page.messages : []
  const rawChats = Array.isArray(page?.chats) ? page.chats : []
  const rawUsers = Array.isArray(page?.users) ? page.users : []

  const messagesById = new Map()
  for (const message of rawMessages) {
    const id = numberOrNull(message?.id)
    if (id !== null) messagesById.set(id, message)
  }
  const chatEntities = new Map()
  for (const entity of rawChats) {
    const id = idText(entity?.id)
    if (id === '') continue
    const isChannel = typeof entity?.className === 'string' && entity.className.includes('Channel')
    chatEntities.set(`${isChannel ? 'channel' : 'chat'}:${id}`, entity)
  }
  const userEntities = new Map()
  for (const entity of rawUsers) {
    const id = idText(entity?.id)
    if (id !== '') userEntities.set(id, entity)
  }

  const chats = []
  for (const dialog of dialogs) {
    const peer = dialog?.peer
    if (peer === null || typeof peer !== 'object') continue
    let chatId = ''
    let kind = 'user'
    let entity = null
    if (peer.className === 'PeerUser') {
      chatId = idText(peer.userId)
      entity = userEntities.get(chatId) ?? null
    } else if (peer.className === 'PeerChat') {
      const id = idText(peer.chatId)
      chatId = id === '' ? '' : `-${id}`
      entity = chatEntities.get(`chat:${id}`) ?? null
      kind = 'chat'
    } else if (peer.className === 'PeerChannel') {
      const id = idText(peer.channelId)
      chatId = id === '' ? '' : `-100${id}`
      entity = chatEntities.get(`channel:${id}`) ?? null
      kind = entity?.megagroup === true ? 'chat' : 'channel'
    } else {
      continue
    }
    if (chatId === '') continue
    const topId = numberOrNull(dialog.topMessage)
    const top = topId === null || topId <= 0 ? null : messagesById.get(topId) ?? null
    const lastMessage = top === null
      ? null
      : {
          id: idText(top.id) === '' ? topId : numberOrNull(top.id) ?? topId,
          date: numberOrNull(top.date) ?? 0,
          text: briefText(typeof top.message === 'string' ? top.message : ''),
          fromMe: top.out === true,
        }
    chats.push({
      chatId,
      kind,
      title: rawDialogTitle(chatId, kind, entity),
      pinned: dialog.pinned === true,
      archived: numberOrNull(dialog.folderId) === 1,
      unreadCount: numberOrNull(dialog.unreadCount) ?? 0,
      lastMessage,
      updatedAt: lastMessage === null ? 0 : lastMessage.date,
    })
  }
  return chats
}

/**
 * Title of a raw dialog: the entity's display name, its username, or the
 * marked id, in that order.
 * @param {string} chatId - marked peer id
 * @param {ChatKind} kind - chat kind
 * @param {any} entity - raw TL entity or null
 * @returns {string} display title
 */
function rawDialogTitle(chatId, kind, entity) {
  if (entity === null || typeof entity !== 'object') return chatId
  if (kind === 'user') {
    const parts = [entity.firstName, entity.lastName]
      .filter((part) => typeof part === 'string' && part.trim() !== '')
    const name = parts.join(' ').trim()
    if (name !== '') return name
    if (typeof entity.username === 'string' && entity.username.trim() !== '') return entity.username.trim()
    return chatId
  }
  if (typeof entity.title === 'string' && entity.title.trim() !== '') return entity.title.trim()
  return chatId
}

/**
 * `GET /chat` material: one chat by id or `@username`. The dialog row is looked
 * up first, because it is the only source of `pinned`, `archived` and
 * `unreadCount`; when the chat has no dialog row (a chat that was never opened,
 * or a newer dialog than the scan window) the summary is built from the
 * resolved entity plus its newest message.
 * @param {any} host - tg-core `TelegramHost`
 * @param {{ chatId: string }} options - chat id or username
 * @returns {Promise<Result<{ chat: ChatSummary }>>} contract result
 */
export async function getChat(host, { chatId } = {}) {
  const wanted = typeof chatId === 'string' ? chatId.trim() : ''
  if (wanted === '') return fail('invalid_arguments', 'chat_id is required to read one chat')
  const acquired = await acquireClient(host)
  if (isFail(acquired)) return acquired
  let resolved
  try {
    resolved = await host.resolveChat(wanted)
  } catch (error) {
    return toTelegramError(error)
  }
  if (isFail(resolved)) return resolved
  const value = resolved?.value
  const canonicalId = typeof value?.chatId === 'string' ? value.chatId : wanted
  const api = await engineApi()
  if (!isUsableInputPeer(value?.inputEntity, api)) {
    return fail('chat_not_found', `Telegram chat "${canonicalId}" could not be resolved`)
  }
  const size = resolveLimit(undefined, host?.config?.dialogLimit, DIALOG_LIMIT_DEFAULT, DIALOG_LIMIT_CEILING)
  const dialogs = await readDialogs(acquired.client, Math.max(size, GET_CHAT_DIALOG_SCAN))
  const dialog = dialogs.find((row) => mapDialog(row)?.chatId === canonicalId)
  const fromDialog = mapDialog(dialog)
  if (fromDialog !== null && fromDialog.chatId !== '') return ok({ chat: fromDialog })
  const last = await newestMessage(acquired.client, value.inputEntity)
  /** @type {ChatSummary} */
  const chat = {
    chatId: canonicalId,
    kind: kindFromResolved(value.kind, canonicalId),
    title: typeof value.title === 'string' && value.title !== '' ? value.title : canonicalId,
    pinned: false,
    archived: false,
    unreadCount: 0,
    lastMessage: last === null ? null : { id: last.id, date: last.date, text: briefText(last.text), fromMe: last.fromMe },
    updatedAt: last === null ? 0 : last.date,
  }
  return ok({ chat })
}

/**
 * Read a bounded dialog page without failing the caller: `getChat` degrades to
 * the resolved entity when the dialog scan fails, and the engine may throw
 * inside its own `Dialog` constructor for a dialog whose top message is missing
 * (`tl/custom/dialog.js:26` reads `message.date`).
 * @param {any} client - engine client
 * @param {number} size - page size
 * @returns {Promise<any[]>} dialogs, empty when the scan failed
 */
async function readDialogs(client, size) {
  try {
    const dialogs = await client.getDialogs({ limit: size, archived: undefined })
    return Array.isArray(dialogs) ? dialogs : []
  } catch {
    return []
  }
}

/**
 * Newest message of a chat as a `MessageBrief`, or null when the chat is empty.
 * @param {any} client - engine client
 * @param {any} inputEntity - resolved input peer
 * @returns {Promise<MessageBrief | null>} brief of the newest message
 */
async function newestMessage(client, inputEntity) {
  try {
    const list = await client.getMessages(inputEntity, { limit: 1, offsetId: 0 })
    for (const raw of Array.isArray(list) ? list : []) {
      const dto = mapMessage(raw)
      if (dto !== null) return { id: dto.id, date: dto.date, text: briefText(dto.text), fromMe: dto.fromMe }
    }
    return null
  } catch {
    return null
  }
}

/**
 * `ResolvedChat.kind` (DESIGN 3.3) is already one of the contract kinds; the
 * marked id is the fallback when the host omits it.
 * @param {unknown} kind - host kind
 * @param {string} chatId - marked id
 * @returns {ChatKind} chat kind
 */
function kindFromResolved(kind, chatId) {
  if (kind === 'user' || kind === 'chat' || kind === 'channel') return kind
  if (chatId.startsWith('-100')) return 'channel'
  if (chatId.startsWith('-')) return 'chat'
  return 'user'
}

/**
 * Reject an input peer that cannot address a real chat, so the caller gets
 * `chat_not_found` instead of an opaque upstream error.
 * @param {any} peer - `Api.TypeInputPeer` from `host.resolveChat`
 * @param {any} api - lazily resolved `Api` namespace or null
 * @returns {boolean} usable
 */
function isUsableInputPeer(peer, api) {
  if (peer === null || typeof peer !== 'object') return false
  if (api !== null && peer instanceof api.InputPeerEmpty) return false
  return typeof peer.className === 'string' ? peer.className !== 'InputPeerEmpty' : true
}
