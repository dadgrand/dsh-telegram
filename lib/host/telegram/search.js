/**
 * dsh-telegram — text search (DESIGN.md 3.6; owner `tg-ops`, task t4).
 *
 * Contract export: `searchMessages`. One implementation serves both
 * `GET /api/dsh-telegram/search` (DESIGN 5.3) and the tool action `search`
 * (DESIGN 4.3).
 *
 * Two modes, both real MTProto calls of the pinned engine `telegram@2.26.22`
 * (package unpacked in `/tmp/tgpkg/package`):
 *
 * | mode                    | GramJS call                                     | Request the engine builds |
 * |-------------------------|-------------------------------------------------|---------------------------|
 * | `chatId` given          | `client.getMessages(inputEntity, { search, limit })` | `Api.messages.Search` — `client/messages.js:109-125` |
 * | `chatId` omitted        | `client.getMessages(undefined, { search, limit })`    | `Api.messages.SearchGlobal` — `client/messages.js:83-94` |
 *
 * Supporting typings:
 * - `client/TelegramClient.d.ts:465` — `getMessages(entity: EntityLike | undefined, params)`;
 * - `client/TelegramClient.d.ts:398-405` — "If either `search`, `filter` or `fromUser` are
 *   provided this will use `Api.messages.Search` instead of `Api.messages.GetHistory`", and
 *   "It may be undefined to perform a global search … you must set a non-empty search string";
 * - `client/messages.d.ts:66-68` — `IterMessagesParams.search`;
 * - `tl/apiTl.js` — `messages.searchGlobal#4bc6589a … q:string … = messages.Messages`,
 *   `messages.search` and `messageSearchResult*` (the engine resolves the chats and users of
 *   every hit into `message._chat`, see `client/messages.js:216-222`).
 *
 * A search over dialog *titles* is not a separate MTProto call in v1: the panel filters
 * titles locally over `listChats` (DESIGN 7.2), and the contract result of `search`
 * carries messages (DESIGN 3.6, 4.3).
 *
 * The engine is imported lazily (DESIGN 3.3 keeps the eager engine entry point
 * `import { TelegramClient } from 'telegram'` in `client.js`; DESIGN 8.2 level 1 requires the
 * plugin to mount without the engine package). Only the `Api` classes used for defensive
 * validation are resolved on first use. Nothing is logged: a search query is user content and
 * stays out of logs and out of error text except as the requested `query` echo (DESIGN 3.2).
 * @module dsh-telegram/host/telegram/search
 */

import { CONFIG_DEFAULTS } from '../config.js'
import { fail, isFail, ok, toTelegramError } from './errors.js'
import { mapMessage } from './messages.js'

/** Engine package specifier (DESIGN 8.2 keeps the swap point a constant). */
const ENGINE_SPEC = 'telegram'

/** Absolute ceiling of one search page: `searchLimit` is 1..50 (DESIGN 3.1). */
const SEARCH_LIMIT_CEILING = 50

/** Page size used when the caller asks for nothing (Config default 10). */
const SEARCH_LIMIT_DEFAULT = CONFIG_DEFAULTS.searchLimit

/** Longest search text accepted (DESIGN 5.3: `q` is 1..256). */
const QUERY_MAX_CHARS = 256

/** Lazily resolved `Api` namespace; `null` when the engine package is absent. */
let apiNamespace = null
let apiResolved = false

/** @typedef {{ ok: true, value: any }} Success */
/** @typedef {{ ok: false, error: { code: string, message: string } }} Failure */
/** @typedef {Success | Failure} Result */

/**
 * @typedef {object} Message
 * @property {number} id
 * @property {string} chatId
 * @property {number} date
 * @property {string} text
 * @property {boolean} fromMe
 * @property {string | null} authorId
 * @property {string | null} authorTitle
 * @property {import('./messages.js').MediaMeta | null} media
 * @property {number | null} replyToId
 * @property {number | null} editedAt
 * @property {boolean} pinned
 */

/**
 * @typedef {object} SearchGroup
 * @property {string} chatId marked peer id of the chat the hits belong to
 * @property {string} chatTitle title of that chat
 * @property {Message[]} messages hits, newest first
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
 * Finite number from a plain number or a `BigInteger`.
 * @param {unknown} value - raw value
 * @returns {number | null} finite number or null
 */
function numberOrNull(value) {
  if (value === undefined || value === null) return null
  const num = typeof value === 'object' && typeof value.toJSNumber === 'function' ? value.toJSNumber() : Number(value)
  return Number.isFinite(num) ? num : null
}

/**
 * Page size bounded by Config (DESIGN 3.6).
 * @param {unknown} requested - caller `limit`
 * @param {unknown} configured - `Config.searchLimit`
 * @returns {number} accepted page size in `1..SEARCH_LIMIT_CEILING`
 */
function resolveLimit(requested, configured) {
  const configuredValue = numberOrNull(configured) ?? SEARCH_LIMIT_DEFAULT
  const boundedConfigured = Math.min(Math.max(Math.trunc(configuredValue), 1), SEARCH_LIMIT_CEILING)
  const requestedValue = numberOrNull(requested)
  if (requestedValue === null) return boundedConfigured
  return Math.min(Math.max(Math.trunc(requestedValue), 1), boundedConfigured)
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
  if (client === null || typeof client !== 'object' || typeof client.getMessages !== 'function') {
    return fail('engine_unavailable', 'The Telegram client is not available')
  }
  return { client }
}

/**
 * Display name of an entity resolved by the engine for a search hit
 * (`message._chat`, built in `client/messages.js:216-222`), mirroring
 * `getDisplayName` (`Utils.js:1207-1226`).
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
 * `GET /search` and the tool action `search`: full-text search inside one chat
 * (`chatId` given) or across the account (`chatId` omitted), grouped per chat.
 * @param {any} host - tg-core `TelegramHost`
 * @param {{ query: string, limit?: number, chatId?: string | null }} options
 * @returns {Promise<Result<{ query: string, results: SearchGroup[], truncated: boolean }>>}
 */
export async function searchMessages(host, { query, limit, chatId = null } = {}) {
  const text = typeof query === 'string' ? query.trim() : ''
  if (text === '') return fail('invalid_arguments', 'query is required for a Telegram search')
  if (Array.from(text).length > QUERY_MAX_CHARS) {
    return fail('invalid_arguments', `query must be ${QUERY_MAX_CHARS} characters or shorter`)
  }
  const scoped = typeof chatId === 'string' ? chatId.trim() : ''
  const size = resolveLimit(limit, host?.config?.searchLimit)
  const acquired = await acquireClient(host)
  if (isFail(acquired)) return acquired

  /** @type {any} */
  let target = undefined
  let chatTitle = ''
  if (scoped !== '') {
    if (typeof host.resolveChat !== 'function') return fail('internal_error', 'The Telegram host cannot resolve chats')
    let resolved
    try {
      resolved = await host.resolveChat(scoped)
    } catch (error) {
      return toTelegramError(error)
    }
    if (isFail(resolved)) return resolved
    const value = resolved?.value
    const peer = value?.inputEntity
    const api = await engineApi()
    const empty = peer === null || peer === undefined || (api !== null && peer instanceof api.InputPeerEmpty)
      || (typeof peer?.className === 'string' && peer.className === 'InputPeerEmpty')
    if (value === null || typeof value !== 'object' || empty) {
      return fail('chat_not_found', `Telegram chat "${scoped}" could not be resolved`)
    }
    target = peer
    chatTitle = typeof value.title === 'string' ? value.title : ''
    if (chatTitle === '') chatTitle = typeof value.chatId === 'string' ? value.chatId : scoped
  }

  let hits
  try {
    // A search inside a chat uses `Api.messages.Search`; without a target the
    // engine builds `Api.messages.SearchGlobal` (client/messages.js:83-125).
    hits = await acquired.client.getMessages(target, { search: text, limit: size })
  } catch (error) {
    return toTelegramError(error)
  }
  if (!Array.isArray(hits)) return fail('upstream_error', 'Telegram returned no search results')

  /** @type {Map<string, SearchGroup>} */
  const groups = new Map()
  let mapped = 0
  for (const raw of hits) {
    const dto = mapMessage(raw)
    if (dto === null) continue
    const id = dto.chatId === '' ? (scoped || '') : dto.chatId
    let group = groups.get(id)
    if (group === undefined) {
      group = { chatId: id, chatTitle: chatTitle || entityTitle(raw?._chat) || id, messages: [] }
      groups.set(id, group)
    }
    if (group.chatTitle === '') group.chatTitle = id
    group.messages.push(dto)
    mapped += 1
  }

  const results = [...groups.values()]
  for (const group of results) {
    group.messages.sort((a, b) => (a.date !== b.date ? b.date - a.date : b.id - a.id))
  }
  results.sort((a, b) => {
    const left = a.messages[0]?.date ?? 0
    const right = b.messages[0]?.date ?? 0
    if (left !== right) return right - left
    if (a.chatId !== b.chatId) return a.chatId < b.chatId ? -1 : 1
    return 0
  })

  const total = numberOrNull(hits.total)
  const truncated = total === null ? mapped >= size : total > mapped
  return ok({ query: text, results, truncated })
}
