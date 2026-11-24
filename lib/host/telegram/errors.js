/**
 * dsh-telegram — shared error contract for every host module (DESIGN.md 3.2).
 *
 * One result shape is used by the engine layer, the JSON routes (DESIGN 5.3)
 * and the agent tool (DESIGN 4.3-4.4):
 *
 *   Result<T> = { ok: true, value: T } | { ok: false, error: { code, message } }
 *
 * `code` is always an element of ERROR_CODES. This module owns that vocabulary
 * so no other module invents its own codes.
 *
 * No engine import here: this file must load even when the GramJS package is
 * missing (DESIGN 8.2 level 1 — the plugin still mounts and degrades).
 *
 * Engine note (verified against the pinned engine `telegram@2.26.22`): the
 * engine's error surface is `telegram/errors` (index re-exports Common,
 * RPCBaseErrors and RPCErrorList); there is no top-level `errors.d.ts`. Only
 * these RPC classes actually exist there — RPCError, InvalidDCError,
 * BadRequestError, UnauthorizedError, ForbiddenError, NotFoundError,
 * AuthKeyError, FloodError, ServerError, TimedOutError, UserMigrateError,
 * PhoneMigrateError, SlowModeWaitError, FloodWaitError,
 * FloodTestPhoneWaitError, FileMigrateError, NetworkMigrateError,
 * EmailUnconfirmedError, MsgWaitError — while every other Telegram RPC error
 * collapses into the base `RPCError` whose message starts with the canonical
 * Telegram token (`PHONE_NUMBER_INVALID`, `SESSION_EXPIRED`, …). Therefore
 * mapping below is token-first, then class-name (including the DESIGN 3.2
 * names, which the actively maintained GramJS fork exposes), then generic
 * transport failure.
 *
 * Secret rule (DESIGN 3.2): a message never carries `apiHash`, a StringSession,
 * `phoneCode`, `phoneCodeHash`, a password, an auth key or a phone number, and
 * never a stack trace. Outgoing text is taken from the error's own message,
 * scrubbed, and capped.
 * @module dsh-telegram/host/telegram/errors
 */

/** Every code this plugin may emit (DESIGN 3.2). Exact set, exact order. */
export const ERROR_CODES = Object.freeze([
  'not_configured',
  'not_authenticated',
  'engine_unavailable',
  'connection_failed',
  'auth_phone_invalid',
  'auth_code_invalid',
  'auth_password_invalid',
  'auth_expired',
  'auth_timeout',
  'auth_in_progress',
  'chat_not_found',
  'chat_forbidden',
  'message_too_long',
  'invalid_arguments',
  'body_too_large',
  'unauthorized_origin',
  'not_allowed',
  'flood_wait',
  'upstream_error',
  'internal_error',
])

/**
 * Codes the agent tool may report (DESIGN 4.4): everything except the two
 * codes that only the HTTP layer can produce.
 */
export const AGENT_ERROR_CODES = Object.freeze(
  ERROR_CODES.filter((code) => code !== 'unauthorized_origin' && code !== 'body_too_large'),
)

const CODE_SET = new Set(ERROR_CODES)

/** Longest error text handed to a client; longer messages are cut with a marker. */
const MAX_MESSAGE_CHARS = 300

/** Fallback wording when the thrown value carries no usable message. */
const FALLBACK_MESSAGE = 'Telegram request failed'

/**
 * Rate-limit tokens with the delay in a capture group. `FloodWaitError.seconds`
 * (verified in telegram/errors/RPCErrorList.d.ts) is preferred when present.
 */
const FLOOD_PATTERNS = [
  /FLOOD_WAIT_(\d+)/,
  /FLOOD_PREMIUM_WAIT_(\d+)/,
  /FLOOD_TEST_PHONE_WAIT_(\d+)/,
  /SLOWMODE_WAIT_(\d+)/,
  /MSG_WAIT_[^-\s]/,
]

/**
 * Canonical Telegram RPC error token -> contract code. Applied to the
 * upper-cased tokens of an error message, so it works both for the base
 * `RPCError` (unknown to the engine's class list) and for named subclasses.
 */
const TOKEN_CODES = new Map([
  // configuration of the plugin row
  ['API_ID_INVALID', 'not_configured'],
  ['API_ID_PUBLISHED_FLOOD', 'not_configured'],
  // session / authorization state
  ['AUTH_KEY_UNREGISTERED', 'not_authenticated'],
  ['AUTH_KEY_INVALID', 'not_authenticated'],
  ['AUTH_KEY_BANNED', 'not_authenticated'],
  ['USER_DEACTIVATED', 'not_authenticated'],
  ['USER_DEACTIVATED_BAN', 'not_authenticated'],
  ['SESSION_EXPIRED', 'not_authenticated'],
  ['SESSION_REVOKED', 'not_authenticated'],
  ['SESSION_REVISION_NEEDED', 'not_authenticated'],
  ['SESSION_START_INVALID', 'not_authenticated'],
  ['AUTH_UNKNOWN', 'not_authenticated'],
  ['UNAUTHORIZED_ACCESS', 'not_authenticated'],
  ['SESSION_PASSWORD_INVALID', 'not_authenticated'],
  // sign-in flow
  ['PHONE_NUMBER_INVALID', 'auth_phone_invalid'],
  ['PHONE_NUMBER_BANNED', 'auth_phone_invalid'],
  ['PHONE_NUMBER_UNOCCUPIED', 'auth_phone_invalid'],
  ['PHONE_NUMBER_TOO_LONG', 'auth_phone_invalid'],
  ['SMS_VERIFY_CODE_INVALID', 'auth_code_invalid'],
  ['PHONE_CODE_INVALID', 'auth_code_invalid'],
  ['PHONE_CODE_HASH_INVALID', 'auth_code_invalid'],
  ['PHONE_CODE_EXPIRED', 'auth_expired'],
  ['SMS_CODE_CREATE_FAILED', 'auth_expired'],
  ['CODE_REDENY', 'auth_expired'],
  ['PASSWORD_HASH_INVALID', 'auth_password_invalid'],
  ['PASSWORD_EMPTY', 'auth_password_invalid'],
  ['PASSWORD_INVALID', 'auth_password_invalid'],
  ['TWO_FA_PENDING', 'auth_password_invalid'],
  // chat resolution and permissions
  ['PEER_ID_INVALID', 'chat_not_found'],
  ['CHAT_ID_INVALID', 'chat_not_found'],
  ['CHAT_INVALID', 'chat_not_found'],
  ['USERNAME_NOT_FOUND', 'chat_not_found'],
  ['USERNAME_NOT_OCCUPIED', 'chat_not_found'],
  ['CHANNEL_PRIVATE', 'chat_forbidden'],
  ['CHANNEL_PRIVATE_INVALID', 'chat_forbidden'],
  ['USER_BANNED_IN_CHANNEL', 'chat_forbidden'],
  ['CHAT_WRITE_FORBIDDEN', 'chat_forbidden'],
  ['USER_PRIVACY_VIOLATED', 'chat_forbidden'],
  // request validation
  ['MESSAGE_TOO_LONG', 'message_too_long'],
  ['MESSAGE_EMPTY', 'invalid_arguments'],
  ['SEARCH_QUERY_EMPTY', 'invalid_arguments'],
  ['USER_METHOD_INVALID', 'not_allowed'],
  ['BOT_METHOD_INVALID', 'not_allowed'],
  ['METHOD_INVALID', 'not_allowed'],
  // transport
  ['INVITE_HASH_EXPIRED', 'connection_failed'],
  ['NETWORK_MIGRATE_FAILED', 'connection_failed'],
])

/**
 * Engine class names -> contract code, checked along the class chain. The first
 * block lists the names verified in `telegram@2.26.22`; the second block lists
 * the DESIGN 3.2 names, which the maintained GramJS fork exposes, so the same
 * mapping keeps working after the DESIGN 8.2 engine swap.
 */
const CLASS_CODES = new Map([
  // verified in telegram/errors (RPCErrorList, RPCBaseErrors, Common)
  ['UserMigrateError', 'connection_failed'],
  ['PhoneMigrateError', 'connection_failed'],
  ['FileMigrateError', 'connection_failed'],
  ['NetworkMigrateError', 'connection_failed'],
  ['InvalidDCError', 'connection_failed'],
  ['SlowModeWaitError', 'flood_wait'],
  ['FloodTestPhoneWaitError', 'flood_wait'],
  ['MsgWaitError', 'flood_wait'],
  ['EmailUnconfirmedError', 'auth_code_invalid'],
  ['BadRequestError', 'invalid_arguments'],
  ['UnauthorizedError', 'not_authenticated'],
  ['ForbiddenError', 'chat_forbidden'],
  ['NotFoundError', 'chat_not_found'],
  ['AuthKeyError', 'connection_failed'],
  ['FloodError', 'flood_wait'],
  ['ServerError', 'upstream_error'],
  ['TimedOutError', 'connection_failed'],
  ['RPCError', 'upstream_error'],
  ['ReadCancelledError', 'connection_failed'],
  ['TypeNotFoundError', 'upstream_error'],
  ['InvalidChecksumError', 'connection_failed'],
  ['InvalidBufferError', 'connection_failed'],
  ['SecurityError', 'connection_failed'],
  ['CdnFileTamperedError', 'upstream_error'],
  ['BadMessageError', 'connection_failed'],
  // DESIGN 3.2 names (GramJS fork / older GramJS builds)
  ['ApiIdInvalidError', 'not_configured'],
  ['AuthKeyUnregisteredError', 'not_authenticated'],
  ['SessionExpiredError', 'not_authenticated'],
  ['SessionRevisionNeededError', 'not_authenticated'],
  ['PhoneNumberInvalidError', 'auth_phone_invalid'],
  ['SmsVerifyCodeInvalidError', 'auth_code_invalid'],
  ['PhoneCodeExpiredError', 'auth_expired'],
  ['PasswordHashInvalidError', 'auth_password_invalid'],
  ['TwoFaPending', 'auth_password_invalid'],
  ['PeerIdInvalidError', 'chat_not_found'],
  ['ChannelPrivateError', 'chat_forbidden'],
  ['UserDeactivatedBanError', 'not_authenticated'],
  ['FloodWaitError', 'flood_wait'],
  ['ConnectionError', 'connection_failed'],
  ['InviteHashExpiredError', 'connection_failed'],
])

/**
 * Plain-`Error` wording produced by the engine's own auth helpers (verified in
 * telegram@2.26.22 `client/auth.js`) and by its DC lookup, which the class and
 * token tables cannot see.
 */
const PHRASE_CODES = [
  [/code is empty/i, 'auth_code_invalid'],
  [/password is empty/i, 'auth_password_invalid'],
  [/account has 2fa enabled/i, 'auth_password_invalid'],
  [/AUTH_USER_CANCEL/, 'auth_expired'],
  [/failed to retrieve phone code hash/i, 'auth_phone_invalid'],
  [/cannot find the dc with the id of/i, 'connection_failed'],
]

/** Transport-level wording used when nothing above matched. */
const TRANSPORT_PATTERNS = [
  /ECONNREFUSED/,
  /ECONNRESET/,
  /ETIMEDOUT/,
  /ENOTFOUND/,
  /EHOSTUNREACH/,
  /ENETUNREACH/,
  /EPIPE/,
  /EAI_AGAIN/,
  /socket hang up/i,
  /\btimed out\b/i,
  /\btimeout\b/i,
  /no matching access hash/i,
  /connection (was )?(closed|lost|failed|reset)/i,
  /\bnot connected\b/i,
]

/**
 * Collapse whitespace and cap the length; stack traces are never part of the
 * contract, so callers must pass an error, not its `stack`.
 * @param {unknown} value - raw message text
 * @returns {string} message safe for an HTTP body, a tool value or a log line
 */
function messageText(value) {
  const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed === '') return FALLBACK_MESSAGE
  return collapsed.length > MAX_MESSAGE_CHARS ? `${collapsed.slice(0, MAX_MESSAGE_CHARS - 1)}…` : collapsed
}

/**
 * Remove values that must never leave the plugin: phone numbers, long opaque
 * strings (StringSession, phoneCodeHash, auth key material). Words such as
 * "password" in an upstream message are fine — only their values are secret.
 * @param {string} text - already collapsed message text
 * @returns {string} scrubbed text
 */
function redactSecrets(text) {
  return text
    .replace(/\+\d[\d\s\-()]{5,}\d/g, '[redacted phone]')
    .replace(/[A-Za-z0-9+/_=-]{24,}/g, '[redacted]')
}

/**
 * Walk the class chain of a value and return its known engine name.
 * @param {any} error - thrown value
 * @returns {{ kind: string, code: string | undefined }} class name and mapped code
 */
function classCode(error) {
  const names = []
  let ctor = error !== null && typeof error === 'object' && typeof error.constructor === 'function' ? error.constructor : undefined
  for (let depth = 0; depth < 8 && typeof ctor === 'function'; depth += 1) {
    const name = typeof ctor.name === 'string' && ctor.name !== '' ? ctor.name : ''
    if (name !== '' && !names.includes(name)) {
      names.push(name)
      const mapped = CLASS_CODES.get(name)
      if (mapped !== undefined) return { kind: name, code: mapped }
    }
    const proto = Object.getPrototypeOf(ctor)
    ctor = typeof proto === 'function' ? proto : undefined
  }
  const ownName = error !== null && typeof error === 'object' && typeof error.name === 'string' ? error.name : ''
  return { kind: names[0] ?? (ownName !== '' ? ownName : 'Error'), code: undefined }
}

/**
 * Read a rate-limit delay from an engine error. `FloodWaitError.seconds` is the
 * documented field; the token capture is the fallback.
 * @param {any} error - thrown value
 * @param {string} text - raw message text
 * @returns {number | undefined} delay in milliseconds
 */
function retryAfterMs(error, text) {
  const seconds = Number(error?.seconds ?? error?.retryAfter ?? error?.secondsLeft)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  for (const pattern of FLOOD_PATTERNS) {
    const match = text.match(pattern)
    if (match === null) continue
    const captured = match[1] === undefined ? undefined : Number(match[1])
    return Number.isFinite(captured) && captured >= 0 ? Math.round(captured * 1000) : undefined
  }
  return undefined
}

/**
 * Build a contract failure. An unknown code is demoted to `internal_error` so
 * no layer can leak a private code into a response.
 * @param {string} code - element of ERROR_CODES
 * @param {string} message - human-readable text, secret-free
 * @param {{ retryAfterMs?: number }} [details] - optional delay hint, kept
 *   non-enumerable so the JSON body stays exactly `{ code, message }`
 * @returns {{ ok: false, error: { code: string, message: string } }}
 */
export function fail(code, message, details = {}) {
  const safeCode = CODE_SET.has(code) ? code : 'internal_error'
  const result = { ok: false, error: { code: safeCode, message: redactSecrets(messageText(message)) } }
  if (typeof details.retryAfterMs === 'number' && Number.isFinite(details.retryAfterMs)) {
    Object.defineProperty(result.error, 'retryAfterMs', { value: Math.max(0, Math.round(details.retryAfterMs)), enumerable: false })
  }
  return result
}

/**
 * Build a contract success.
 * @template T
 * @param {T} value
 * @returns {{ ok: true, value: T }}
 */
export function ok(value) {
  return { ok: true, value }
}

/**
 * @param {unknown} result - a Result from any layer
 * @returns {boolean} true when it is a failure
 */
export function isFail(result) {
  return result !== null && typeof result === 'object' && result.ok === false
}

/**
 * Normalize anything thrown by the engine, the transport or our own code into a
 * contract failure (DESIGN 3.2). Never rethrows, never keeps a stack, never
 * keeps a secret.
 * @param {unknown} error - thrown value
 * @returns {{ ok: false, error: { code: string, message: string } }}
 */
export function toTelegramError(error) {
  const rawMessage = messageText(error instanceof Error ? error.message : error)
  const retry = retryAfterMs(error, rawMessage)

  const floodPattern = FLOOD_PATTERNS.find((pattern) => pattern.test(rawMessage))
  if (floodPattern !== undefined) {
    const token = rawMessage.match(floodPattern)?.[0] ?? 'FLOOD_WAIT'
    const seconds = retry === undefined ? 'unknown' : Math.round(retry / 1000)
    const suffix = retry === undefined ? '' : ` (retryAfterMs=${retry})`
    return fail('flood_wait', `Telegram rate limit (${token}): retry after ${seconds} s${suffix}`, { retryAfterMs: retry })
  }

  for (const token of rawMessage.toUpperCase().match(/[A-Z][A-Z0-9_]{2,}/g) ?? []) {
    const code = TOKEN_CODES.get(token)
    // The token was read out of the message, so the message already names it.
    if (code !== undefined) return fail(code, rawMessage, { retryAfterMs: retry })
  }

  const phrase = PHRASE_CODES.find(([pattern]) => pattern.test(rawMessage))
  if (phrase !== undefined) return fail(phrase[1], rawMessage, { retryAfterMs: retry })

  const mapped = classCode(error)
  if (mapped.code !== undefined) {
    if (mapped.code === 'flood_wait') {
      return fail('flood_wait', `${mapped.kind}: ${rawMessage} (retryAfterMs=${String(retry ?? 'unknown')})`, { retryAfterMs: retry })
    }
    return fail(mapped.code, rawMessage, { retryAfterMs: retry })
  }

  if (TRANSPORT_PATTERNS.some((pattern) => pattern.test(rawMessage))) {
    return fail('connection_failed', rawMessage, { retryAfterMs: retry })
  }

  return fail('upstream_error', rawMessage, { retryAfterMs: retry })
}
