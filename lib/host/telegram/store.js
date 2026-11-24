/**
 * dsh-telegram — durable storage of the Telegram sign-in state (DESIGN.md 3.5).
 *
 * A StringSession is a secret: it carries the MTProto authorization key plus the
 * DC address, so anyone holding it acts as the account. It is therefore stored
 * as a credential record owned by this plugin — `dsh-telegram/session` — and not
 * by us: the Host keeps records in the user's own storage
 * (`$DSH_HOME/.credentials.yaml`, declared in `dsh-base/cordis.patch.yml:113` and
 * mounted by the `credentials` row `@deepseek-ai/dsh-credentials-local`,
 * `dsh-base/cordis.patch.yml:125-126`), and that store writes the file with
 * `mode: 0o600` and its directory with `0o700`
 * (`dsh-credentials-local/src/index.ts:717,738,781` — "права 0600 где возможно"
 * is the seam's job, and this plugin never writes the file itself).
 *
 * Nothing about the sign-in state is ever written into the plugin directory,
 * `/tmp`, the plugin Config, `localStorage`, a log line or a DTO (DESIGN 3.2,
 * 3.5; `SKILL/configuration.md:12` — "Store secrets … as
 * `ctx.credentials.modifyRecord()` records, not configuration").
 *
 * Atomicity: `modifyRecord` is the only write path of the seam and is a
 * serialized read-modify-write, exclusive across processes
 * (`dsh-credentials/README.md` "Storing, updating, and removing records",
 * `dsh-credentials/src/index.ts:247`). Reading "nothing stored" yields `null`,
 * never a throw (`dsh-credentials/src/index.ts:217`).
 *
 * Plugin settings are deliberately NOT written here: the user owns them in the
 * `telegram` row of their own patch layer (DESIGN 3.1), and this plugin never
 * rewrites its own config nor the profile patch (`SKILL/configuration.md:1-3`).
 *
 * @module dsh-telegram/host/telegram/store
 */

import { fail, ok } from './errors.js'

/**
 * Owning scope of the record: the plugin's registered package name. The seam
 * requires `<scope>/<id>` where the scope is the owner, and validates the
 * segment grammar `/^[a-z][a-z0-9-]*$/` itself
 * (`dsh-credentials/src/types.ts:24-36`, `src/index.ts:22,69-77,85-92`).
 */
export const CREDENTIAL_SCOPE = 'dsh-telegram'

/** Id chosen by this plugin inside its own scope. */
export const SESSION_RECORD_ID = 'session'

/**
 * Address of the one record this plugin owns. Passed as a plain string: the
 * branded `CredentialKey` is a compile-time brand only, and the local store
 * calls `parseCredentialKey` on the value it receives
 * (`dsh-credentials-local/src/index.ts:296,687,921`). No `@deepseek-ai/cordis`
 * or `@deepseek-ai/dsh-credentials` import is created here (DESIGN 1.4).
 * @returns {string} the credential key `dsh-telegram/session`
 */
export function sessionKey() {
  return `${CREDENTIAL_SCOPE}/${SESSION_RECORD_ID}`
}

/**
 * The payload this plugin keeps in its `GrantRecord`. JSON round-trip safe by
 * construction; `session` is a secret and never leaves this module.
 * @typedef {object} SessionPayload
 * @property {string} session StringSession string. Secret.
 * @property {string | null} phone the number the user signed in with, E.164. Secret.
 * @property {string | null} userId account id, decimal string
 * @property {number | null} dcId data center id of the stored authorization key
 * @property {number} savedAt unix milliseconds of the write
 * @property {'qr' | 'phone'} method the sign-in path that produced this record
 */

/**
 * A readable sign-in state: the seam's `GrantRecord` wrapper plus the payload
 * this plugin wrote (`dsh-credentials/src/types.ts:47-56`).
 * @typedef {object} SessionRecord
 * @property {'grant'} kind record discriminant
 * @property {SessionPayload} payload owner-defined JSON value
 */

/**
 * @param {any} ctx - host context; only `ctx.credentials` is used
 * @returns {{ readRecord?: Function, modifyRecord?: Function, deleteRecord?: Function } | null}
 *   the credential seam, or null when this plugin was mounted without it
 */
function seamOf(ctx) {
  const service = ctx === null || typeof ctx !== 'object' ? undefined : ctx.credentials
  if (service === null || typeof service !== 'object') return null
  if (typeof service.readRecord !== 'function' || typeof service.modifyRecord !== 'function') return null
  return service
}

/**
 * One secret-free sentence per seam failure. The thrown value is normalized by
 * `toTelegramError`-style scrubbing inside `fail`, so no seam internals (a file
 * path or a record body) reach a caller.
 * @param {unknown} error - thrown value
 * @returns {{ ok: false, error: { code: string, message: string } }}
 */
function seamFailure(error) {
  const reason = error instanceof Error && typeof error.message === 'string' ? error.message : 'storage call failed'
  return fail('internal_error', `Telegram storage could not be reached: ${reason}`)
}

/**
 * Accept only the shape this plugin wrote. Anything else is reported, never
 * guessed: a payload of another shape would silently produce a broken client.
 * @param {unknown} record - value returned by the seam
 * @returns {SessionPayload | null} normalized payload, or null when unusable
 */
function normalizePayload(record) {
  if (record === null || typeof record !== 'object') return null
  if (/** @type {{ kind?: unknown }} */ (record).kind !== 'grant') return null
  const payload = /** @type {{ payload?: unknown }} */ (record).payload
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null
  const source = /** @type {Record<string, unknown>} */ (payload)
  const session = typeof source.session === 'string' ? source.session.trim() : ''
  if (session === '' || session.length > 4096) return null
  const phone = typeof source.phone === 'string' && source.phone.trim() !== '' ? source.phone.trim() : null
  const userId = typeof source.userId === 'string' && source.userId.trim() !== ''
    ? source.userId.trim()
    : typeof source.userId === 'number' && Number.isFinite(source.userId) ? String(source.userId) : null
  const dcId = Number.isInteger(source.dcId) && /** @type {number} */ (source.dcId) > 0 ? /** @type {number} */ (source.dcId) : null
  const savedAt = Number.isFinite(source.savedAt) ? Math.max(0, Math.round(/** @type {number} */ (source.savedAt))) : 0
  const method = source.method === 'qr' || source.method === 'phone' ? source.method : null
  return { session, phone, userId, dcId, savedAt, method }
}

/**
 * Read the stored sign-in state at start-up (DESIGN 3.5).
 * `null` means "nothing stored" — the normal pre-login state, not an error.
 * @param {any} ctx - host context with `credentials`
 * @returns {Promise<{ ok: true, value: SessionRecord | null } | { ok: false, error: { code: string, message: string } }>}
 *   `Result<SessionRecord | null>`
 */
export async function readSession(ctx) {
  const seam = seamOf(ctx)
  if (seam === null) return fail('internal_error', 'The credentials service is not available to the Telegram plugin')
  /** @type {unknown} */
  let record
  try {
    record = await seam.readRecord(/** @type {any} */ (sessionKey()))
  } catch (error) {
    return seamFailure(error)
  }
  if (record === undefined || record === null) return ok(null)
  const payload = normalizePayload(record)
  if (payload === null) {
    return fail('internal_error', 'The stored Telegram log-in state is unreadable; sign in again')
  }
  return ok({ kind: 'grant', payload })
}

/**
 * Store the sign-in state produced by one successful user sign-in.
 * `savedAt` is stamped here so every write is traceable, and a previous payload
 * is carried over only when it was itself a readable payload of this plugin.
 * @param {any} ctx - host context with `credentials`
 * @param {{ session?: string, phone?: string | null, userId?: string | null, dcId?: number | null, method?: 'qr' | 'phone' | null }} record - new values
 * @returns {Promise<{ ok: true, value: SessionRecord } | { ok: false, error: { code: string, message: string } }>}
 *   `Result<SessionRecord>` — the stored record
 */
export async function writeSession(ctx, record) {
  const seam = seamOf(ctx)
  if (seam === null) return fail('internal_error', 'The credentials service is not available to the Telegram plugin')
  const input = record !== null && typeof record === 'object' ? /** @type {Record<string, unknown>} */ (record) : {}
  const session = typeof input.session === 'string' ? input.session.trim() : ''
  if (session === '') return fail('internal_error', 'Telegram returned no usable log-in state to store')
  if (session.length > 4096) return fail('internal_error', 'Telegram returned an oversized log-in state')

  const next = {
    session,
    phone: typeof input.phone === 'string' && input.phone.trim() !== '' ? input.phone.trim() : null,
    userId: typeof input.userId === 'string' && input.userId.trim() !== ''
      ? input.userId.trim()
      : typeof input.userId === 'number' && Number.isFinite(input.userId) ? String(input.userId) : null,
    dcId: Number.isInteger(input.dcId) && /** @type {number} */ (input.dcId) > 0 ? /** @type {number} */ (input.dcId) : null,
    method: input.method === 'qr' || input.method === 'phone' ? input.method : null,
    savedAt: Date.now(),
  }

  /** @type {unknown} */
  let written
  try {
    written = await seam.modifyRecord(
      /** @type {any} */ (sessionKey()),
      (/** @type {unknown} */ current) => ({
        kind: 'grant',
        // `current?.payload` is merged exactly as DESIGN 3.5 prescribes, but only
        // when the previous record was a readable payload of this plugin.
        payload: { ...(normalizePayload(current) ?? {}), ...next },
      }),
    )
  } catch (error) {
    return seamFailure(error)
  }

  const payload = normalizePayload(written) ?? next
  return ok({ kind: 'grant', payload })
}

/**
 * Explicit user log-out: remove the record. Removing an absent record is a
 * no-op in the seam (`dsh-credentials/README.md`), so this is idempotent.
 * @param {any} ctx - host context with `credentials`
 * @returns {Promise<{ ok: true, value: { cleared: true } } | { ok: false, error: { code: string, message: string } }>}
 *   `Result<{ cleared: true }>`
 */
export async function clearSession(ctx) {
  const seam = seamOf(ctx)
  if (seam === null) return fail('internal_error', 'The credentials service is not available to the Telegram plugin')
  if (typeof seam.deleteRecord !== 'function') {
    return fail('internal_error', 'The credentials service cannot remove records')
  }
  try {
    await seam.deleteRecord(/** @type {any} */ (sessionKey()))
  } catch (error) {
    return seamFailure(error)
  }
  return ok({ cleared: true })
}
