/**
 * dsh-telegram — the user-driven sign-in machine (DESIGN.md 3.4,
 * DESIGN-v0.2 9).
 *
 * Two user-only paths share one state machine:
 *
 *   QR (primary, DESIGN-v0.2 9): POST /login/qr/start creates a dedicated,
 *   freshly connected client (`host.openLoginClient()`), runs GramJS
 *   `signInUserWithQrCode` in the background, publishes the latest
 *   `tg://login?token=…` payload for the Host to render as a matrix, rotates it
 *   when GramJS does (≈ every 30 s), falls back to `awaiting_2fa` via the
 *   library's `SESSION_PASSWORD_NEEDED` path, and on success writes the
 *   StringSession to the credential record and asks the host to reconnect.
 *
 *   Phone → code → 2FA (fallback, DESIGN.md 3.4): `client.start` is called once
 *   per attempt with callbacks that block on a deferred fed by `verify()`. Every
 *   value that authenticates comes from the user through the panel routes; this
 *   module never invents, caches from disk, replays or auto-fills a code or a
 *   two-step password.
 *
 * Why a dedicated client for QR (DESIGN-v0.2 9.1): GramJS
 * `client/auth.js:211-217` adds an internal `UpdateLoginToken` event handler and
 * never removes it on the error path. One attempt per client instance, destroyed
 * on failure, is the safe mitigation; the shared engine instance therefore never
 * runs a QR attempt.
 *
 * Engine error names are never imported: `telegram/errors` exposes only RPCError
 * and a short subclass list, and every other RPC error arrives as the base
 * `RPCError` whose message begins with the canonical token
 * (`PHONE_NUMBER_INVALID`, `SESSION_PASSWORD_NEEDED`, `PASSWORD_HASH_INVALID`,
 * …). All mapping goes through `toTelegramError` in `./errors.js`.
 *
 * No engine import here: `./client.js` is the only module that imports the
 * engine (DESIGN 3.3), and the agent tool must not reach this module at all
 * (DESIGN 4.5 — signing in is a user-only action).
 *
 * @module dsh-telegram/host/telegram/auth
 */

import { fail, isFail, ok, toTelegramError } from './errors.js'

/** Default lifetime of one sign-in attempt (DESIGN-v0.2 8.2 `authTimeoutMs`). */
export const AUTH_TTL_MS = 180_000

/** Same phone shape the panel route accepts (DESIGN 5.3 `/login/start`). */
const PHONE_PATTERN = /^\+?[0-9]{6,15}$/

/** Thrown by our `firstAndLastNames` callback to refuse an engine sign-up. */
const SIGNUP_SENTINEL = 'DSH_TELEGRAM_SIGN_UP_UNSUPPORTED'

/** `HostState.loginStage` values (DESIGN 3.3, DESIGN-v0.2 9.2). */
const STAGE_SET = new Set(['idle', 'awaiting_phone', 'code_sent', 'qr_waiting', 'awaiting_2fa', 'connected', 'failed'])

/** Upper bound of a single QR payload string; anything longer is not shown. */
const QR_URI_MAX_CHARS = 2_048

/**
 * Read the engine credentials of the plugin row (DESIGN 3.4).
 * `apiHashRef` wins over `apiHash`: a credential reference keeps the secret out
 * of YAML (`SKILL/configuration.md:12`). `resolve` returns
 * `{ value, source } | undefined` (`dsh-credentials/src/index.ts:184`); the ref
 * is passed as a plain string because the branded `CredentialRef` is a
 * compile-time brand only.
 * @param {any} ctx - host context; only `ctx.credentials` is used
 * @param {any} config - resolved plugin config (DESIGN 3.1)
 * @returns {Promise<{ ok: true, value: { apiId: number, apiHash: string } } | { ok: false, error: { code: string, message: string } }>}
 *   `Result<{ apiId, apiHash }>` — never logs or echoes either value
 */
export async function readApiCredentials(ctx, config) {
  const source = config !== null && typeof config === 'object' ? /** @type {Record<string, unknown>} */ (config) : {}
  const apiId = Number.isInteger(source.apiId) && /** @type {number} */ (source.apiId) >= 0 ? /** @type {number} */ (source.apiId) : 0
  const direct = typeof source.apiHash === 'string' ? source.apiHash.trim() : ''
  const ref = typeof source.apiHashRef === 'string' ? source.apiHashRef.trim() : ''
  const notConfigured = fail('not_configured', 'Set apiId and apiHash (or apiHashRef) in the telegram plugin row')

  let apiHash = direct
  if (ref !== '') {
    const service = ctx !== null && typeof ctx === 'object' ? ctx.credentials : undefined
    if (service === null || typeof service !== 'object' || typeof service.resolve !== 'function') {
      return fail('internal_error', 'The credentials service is not available to the Telegram plugin')
    }
    /** @type {unknown} */
    let resolved
    try {
      resolved = await service.resolve(/** @type {any} */ (ref))
    } catch {
      // The reference name itself may be sensitive, so nothing of the failure is echoed.
      return fail('internal_error', 'The referenced Telegram credential could not be read')
    }
    const value = resolved !== null && typeof resolved === 'object'
      ? /** @type {Record<string, unknown>} */ (resolved).value
      : undefined
    if (typeof value !== 'string' || value.trim() === '') return notConfigured
    apiHash = value.trim()
  }

  if (apiId === 0 || apiHash === '') return notConfigured
  return ok({ apiId, apiHash })
}

/**
 * One pending user answer inside a sign-in attempt.
 * @typedef {object} Deferred
 * @property {'code' | 'password'} name which callback it feeds
 * @property {boolean} settled an answer was already taken, or it was rejected
 * @property {(value: string) => void} resolve
 * @property {(error: unknown) => void} reject
 * @property {Promise<string>} promise the promise the engine callback awaits
 */

/**
 * The sign-in state machine. Stages are exactly the `loginStage` values of
 * DESIGN 3.3 plus `qr_waiting`; every public method returns a `Result`.
 * @typedef {object} AuthFlow
 * @property {(params: { phone: string }) => Promise<any>} start phone fallback
 * @property {() => Promise<any>} startQr open a fresh client and begin QR sign-in
 * @property {(since: number) => { stage: string, seq: number, qr: { seq: number, uri: string, expiresAt: number } | null, hint: string | null, error: { code: string, message: string } | null }} qrState latest QR token
 * @property {(params: { code?: string, password?: string }) => Promise<any>} verify deliver the user's answer
 * @property {() => string} stage current `loginStage`
 * @property {() => string | null} hint two-step verification hint given by Telegram
 * @property {() => { code: string, message: string } | null} lastError last failure of this flow
 * @property {() => void} reset silent reset to `idle` (used after a log-out)
 * @property {() => void} dispose abandon the flow and every timer it armed
 */

/**
 * Build the sign-in machine for one host.
 *
 * `store` is the session store **already bound to the host context**: the
 * functions exported by `./store.js` take `ctx` first (DESIGN 3.5), while
 * `createAuthFlow` (DESIGN 3.4) does not receive a context, so `./client.js`
 * passes `{ readSession, writeSession, clearSession }` closed over `ctx`.
 * `host` supplies the dedicated QR client and the post-login reconnect.
 * @param {{ host: any, config?: any, store: { writeSession: (record: object) => Promise<any> } }} options
 * @returns {AuthFlow}
 */
export function createAuthFlow({ host, config, store }) {
  const settings = config !== null && typeof config === 'object' ? config : {}
  const authTtlMs = Number.isInteger(settings.authTimeoutMs) ? Math.max(30_000, settings.authTimeoutMs) : AUTH_TTL_MS
  const sessionStore = store !== null && typeof store === 'object' ? store : /** @type {any} */ ({})

  /** @type {string} */ let stage = 'idle'
  /** @type {string | null} */ let phone = null
  /** @type {string | null} */ let hint = null
  /** @type {{ code: string, message: string } | null} */ let lastError = null
  /** @type {{ code: string, message: string } | null} */ let pendingFailure = null
  /** @type {Record<'code' | 'password', Deferred | null>} */
  const deferreds = { code: null, password: null }
  /** @type {Array<(result: any) => void>} */ let waiters = []
  /** @type {ReturnType<typeof setTimeout> | null} */ let deadline = null
  /** @type {Promise<void> | null} */ let running = null
  /** @type {boolean} */ let abandoned = false
  /** @type {boolean} */ let disposed = false

  // QR-specific state (DESIGN-v0.2 9.2). The token lives in memory only.
  /** @type {number} */ let qrSeq = 0
  /** @type {{ seq: number, uri: string, expiresAt: number } | null} */ let qrInfo = null
  /** @type {{ code: string, message: string } | null} */ let qrError = null
  /** @type {number} */ let qrGeneration = 0
  /** @type {boolean} */ let qrActive = false

  /**
   * @param {'code' | 'password'} name
   * @returns {Deferred} the deferred the engine callback must await next
   */
  function ensureDeferred(name) {
    const current = deferreds[name]
    if (current !== null && current.settled === false) return current
    /** @type {Deferred} */
    const box = /** @type {any} */ ({ name, settled: false })
    box.promise = new Promise((/** @type {(value: string) => void} */ resolve, /** @type {(error: unknown) => void} */ reject) => {
      box.resolve = resolve
      box.reject = reject
    })
    // A rejection that nobody awaits yet must not surface as an unhandled
    // rejection; the engine callback installs its own handler when it awaits.
    box.promise.catch(() => {})
    deferreds[name] = box
    return box
  }

  /**
   * @param {'code' | 'password' | null} name
   * @param {unknown} error - reason the wait is over
   */
  function abandonDeferreds(name, error) {
    for (const key of /** @type {Array<'code' | 'password'>} */ (['code', 'password'])) {
      if (name !== null && key !== name) continue
      const box = deferreds[key]
      if (box === null || box.settled) continue
      box.settled = true
      box.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }

  function clearDeadline() {
    if (deadline !== null) {
      clearTimeout(deadline)
      deadline = null
    }
  }

  /** Close and destroy the dedicated QR client (one attempt per instance). */
  async function releaseQrClient() {
    qrActive = false
    qrInfo = null
    if (typeof host.closeLoginClient !== 'function') return
    try {
      await host.closeLoginClient()
    } catch {
      // A half-closed socket is already unreachable; disposal is best effort.
    }
  }

  /**
   * Arm the single TTL of this attempt; every fresh QR token refreshes it
   * (DESIGN-v0.2 9.2). Expiry is `auth_timeout`, and a QR attempt closes its
   * dedicated client so the next start gets a clean instance.
   */
  function armDeadline() {
    clearDeadline()
    deadline = setTimeout(() => {
      deadline = null
      if (disposed || stage === 'connected') return
      abandoned = true
      abandonDeferreds(null, new Error('AUTH_USER_CANCEL'))
      const failure = fail('auth_timeout', 'The sign-in request expired. Start again to get a fresh QR code.')
      lastError = failure.error
      pendingFailure = failure.error
      if (qrActive === true) {
        qrError = failure.error
        qrGeneration += 1
        void releaseQrClient()
      }
      stage = 'failed'
      running = null
      settle(failure)
    }, authTtlMs)
  }

  /**
   * Wake every `verify()` call that is waiting for the next step.
   * @param {any} result - `Result` delivered to the callers
   */
  function settle(result) {
    const next = result !== null && typeof result === 'object' && result.ok === false && result.error !== null ? result.error : null
    if (next !== null) lastError = next
    pendingFailure = next
    const pending = waiters
    waiters = []
    for (const resolve of pending) resolve(result)
  }

  /** @returns {Promise<any>} resolves with the next flow outcome */
  function awaitNextStep() {
    return new Promise((resolve) => {
      waiters.push(resolve)
    })
  }

  /**
   * Read the fresh StringSession out of the live client. `client.session` is the
   * public `Session` field of `TelegramBaseClient` and is always a
   * `StringSession` instance in this plugin, whose `save(): string` returns the
   * current state, or `''` when nothing is usable.
   * @param {any} client - engine client instance
   * @returns {string} the session string, or `''`
   */
  function savedSessionOf(client) {
    const session = client !== null && typeof client === 'object' ? client.session : undefined
    if (session === null || typeof session !== 'object' || typeof session.save !== 'function') return ''
    let value
    try {
      value = session.save()
    } catch {
      return ''
    }
    return typeof value === 'string' ? value.trim() : ''
  }

  /**
   * @param {any} client - engine client instance
   * @returns {Promise<{ userId: string | null, title: string | null }>}
   */
  async function identityOf(client) {
    try {
      const me = await client.getMe()
      const id = me !== null && typeof me === 'object' && me.id !== undefined ? String(me.id) : null
      const names = me !== null && typeof me === 'object'
        ? [me.firstName, me.lastName].filter((/** @type {any} */ part) => typeof part === 'string' && part.trim() !== '').join(' ').trim()
        : ''
      const username = me !== null && typeof me === 'object' && typeof me.username === 'string' && me.username.trim() !== '' ? me.username.trim() : null
      const title = names !== '' ? names : username
      return { userId: id, title: title !== '' ? title : null }
    } catch {
      return { userId: null, title: null }
    }
  }

  /**
   * Turn an engine error into a contract error and decide whether the engine
   * loop may ask the same question again.
   * @param {unknown} error - thrown by the engine
   * @returns {Promise<boolean>} `true` stops `client.start` / QR auth
   */
  async function onError(error) {
    if (disposed || abandoned) return true
    const isSentinel = error instanceof Error && error.message === SIGNUP_SENTINEL
    if (isSentinel) {
      // The engine would otherwise register an account named "first name"
      // (client/auth.js `signInUser` sign-up branch), which this plugin never does.
      const refusal = fail('not_allowed', 'Creating a new Telegram account is not supported here. Finish the registration in an official Telegram app.')
      lastError = refusal.error
      pendingFailure = refusal.error
      abandoned = true
      settle(refusal)
      return true
    }
    const mapped = toTelegramError(error)
    // Wrong answers keep the engine's own loop alive: the user can retype the
    // code or the 2FA password without a new phone round-trip.
    const retryable = mapped.error.code === 'auth_code_invalid' && stage === 'code_sent'
    if (retryable) {
      lastError = mapped.error
      settle(mapped)
      return false
    }
    const keepWaitingForPassword = mapped.error.code === 'auth_password_invalid' && stage === 'awaiting_2fa'
    if (keepWaitingForPassword) {
      lastError = mapped.error
      qrError = mapped.error
      settle(mapped)
      return false
    }
    lastError = mapped.error
    pendingFailure = mapped.error
    abandoned = true
    return true
  }

  /**
   * Phone fallback: runs in the background once a sign-in attempt was accepted.
   * @param {any} client - engine client instance
   * @returns {Promise<void>}
   */
  async function runSignIn(client) {
    try {
      await client.start({
        phoneNumber: async () => /** @type {string} */ (phone),
        phoneCode: async () => await ensureDeferred('code').promise,
        password: async (/** @type {string | undefined} */ passwordHint) => {
          hint = typeof passwordHint === 'string' && passwordHint.trim() !== '' ? passwordHint.trim() : null
          if (stage === 'code_sent') {
            stage = 'awaiting_2fa'
            settle(ok({ stage: 'awaiting_2fa', hint }))
          }
          return await ensureDeferred('password').promise
        },
        // DESIGN 3.4 covers sign-in only. Refusing here is deliberate: without
        // this callback the engine would silently register an account named
        // "first name".
        firstAndLastNames: async () => {
          throw new Error(SIGNUP_SENTINEL)
        },
        onError,
      })
    } catch (error) {
      const failure = pendingFailure !== null
        ? fail(pendingFailure.code, pendingFailure.message)
        : toTelegramError(error)
      stage = 'failed'
      abandoned = true
      clearDeadline()
      settle(failure)
      return
    }

    if (abandoned || disposed) return

    const session = savedSessionOf(client)
    if (session === '') {
      stage = 'failed'
      clearDeadline()
      settle(fail('internal_error', 'Telegram did not return a usable log-in state'))
      return
    }
    const identity = await identityOf(client)
    const dcId = client !== null && typeof client === 'object' && client.session !== null && typeof client.session === 'object'
      && Number.isInteger(client.session.dcId) && client.session.dcId > 0
      ? client.session.dcId
      : null
    if (typeof sessionStore.writeSession !== 'function') {
      stage = 'failed'
      clearDeadline()
      settle(fail('internal_error', 'The Telegram plugin could not store its log-in state'))
      return
    }
    const stored = await sessionStore.writeSession({ session, phone, userId: identity.userId, dcId, method: 'phone' })
    if (isFail(stored)) {
      stage = 'failed'
      clearDeadline()
      settle(stored)
      return
    }
    // Success: exactly one store write (DESIGN 3.4), then the host reconnects
    // the client from that stored state (DESIGN 3.3, see client.js).
    stage = 'connected'
    lastError = null
    pendingFailure = null
    abandoned = true
    clearDeadline()
    for (const key of /** @type {Array<'code' | 'password'>} */ (['code', 'password'])) deferreds[key] = null
    settle(ok({ stage: 'connected' }))
  }

  /**
   * Convert a QR token into the documented `tg://login?token=…` payload. A token
   * that is not byte-like or is implausibly long is ignored (never echoed).
   * @param {unknown} token - `Buffer` from GramJS
   * @returns {string} the URI, or `''`
   */
  function qrUriOf(token) {
    if (token === null || token === undefined) return ''
    let bytes
    try {
      bytes = typeof token === 'string' ? Buffer.from(token, 'utf8') : Buffer.from(/** @type {any} */ (token))
    } catch {
      return ''
    }
    if (bytes.length === 0) return ''
    const uri = 'tg://login?token=' + bytes.toString('base64url')
    return uri.length <= QR_URI_MAX_CHARS ? uri : ''
  }

  /**
   * Finish a successful QR sign-in: store the StringSession, publish
   * `connected`, and ask the host to reconnect the shared client.
   * @param {any} client - the dedicated QR client
   * @param {any} user - user returned by GramJS
   * @param {number} generation - attempt generation
   */
  async function finishQr(client, user, generation) {
    if (generation !== qrGeneration || disposed) return
    const session = savedSessionOf(client)
    if (session === '') {
      const failure = fail('internal_error', 'Telegram did not return a usable log-in state')
      stage = 'failed'
      lastError = failure.error
      qrError = failure.error
      abandoned = true
      clearDeadline()
      await releaseQrClient()
      settle(failure)
      return
    }
    const userId = user !== null && typeof user === 'object' && user.id !== undefined ? String(user.id) : null
    const dcId = client !== null && typeof client === 'object' && client.session !== null && typeof client.session === 'object'
      && Number.isInteger(client.session.dcId) && client.session.dcId > 0
      ? client.session.dcId
      : null
    if (typeof sessionStore.writeSession !== 'function') {
      const failure = fail('internal_error', 'The Telegram plugin could not store its log-in state')
      stage = 'failed'
      lastError = failure.error
      qrError = failure.error
      abandoned = true
      clearDeadline()
      await releaseQrClient()
      settle(failure)
      return
    }
    const stored = await sessionStore.writeSession({ session, phone: null, userId, dcId, method: 'qr' })
    if (isFail(stored)) {
      stage = 'failed'
      lastError = stored.error
      qrError = stored.error
      abandoned = true
      clearDeadline()
      await releaseQrClient()
      settle(stored)
      return
    }
    stage = 'connected'
    lastError = null
    pendingFailure = null
    qrError = null
    qrInfo = null
    abandoned = true
    clearDeadline()
    running = null
    for (const key of /** @type {Array<'code' | 'password'>} */ (['code', 'password'])) deferreds[key] = null
    settle(ok({ stage: 'connected' }))
    // Invalidate late QR callbacks of this generation before the client dies.
    qrGeneration += 1
    qrActive = false
    if (typeof host.completeExternalLogin === 'function') {
      try {
        await host.completeExternalLogin()
      } catch {
        // The session is stored; a failed reconnect is reported through /status.
      }
    }
  }

  /**
   * Background QR sign-in (DESIGN-v0.2 9.1-9.2).
   * @param {{ client: any, apiId: number, apiHash: string, generation: number }} context
   * @returns {Promise<void>}
   */
  async function runQr(context) {
    const generation = context.generation
    try {
      const user = await context.client.signInUserWithQrCode(
        { apiId: context.apiId, apiHash: context.apiHash },
        {
          qrCode: async (/** @type {{ token: Buffer, expires: number }} */ code) => {
            if (generation !== qrGeneration || disposed || abandoned) return
            const uri = qrUriOf(code !== null && typeof code === 'object' ? code.token : undefined)
            if (uri === '') return
            const expires = Number(code.expires)
            qrSeq += 1
            qrInfo = { seq: qrSeq, uri, expiresAt: Number.isFinite(expires) && expires > 0 ? Math.round(expires * 1000) : Date.now() + 30_000 }
            armDeadline()
          },
          password: async (/** @type {string | undefined} */ passwordHint) => {
            if (generation !== qrGeneration || disposed) throw new Error('AUTH_USER_CANCEL')
            hint = typeof passwordHint === 'string' && passwordHint.trim() !== '' ? passwordHint.trim() : null
            qrInfo = null
            stage = 'awaiting_2fa'
            settle(ok({ stage: 'awaiting_2fa', hint }))
            return await ensureDeferred('password').promise
          },
          onError: async (error) => {
            if (generation !== qrGeneration || disposed) return true
            return await onError(error)
          },
        },
      )
      if (generation !== qrGeneration || disposed) return
      await finishQr(context.client, user, generation)
    } catch (error) {
      if (generation !== qrGeneration || disposed) return
      const failure = pendingFailure !== null
        ? fail(pendingFailure.code, pendingFailure.message)
        : toTelegramError(error)
      stage = 'failed'
      lastError = failure.error
      qrError = failure.error
      abandoned = true
      clearDeadline()
      running = null
      await releaseQrClient()
      settle(failure)
    }
  }

  /** @type {AuthFlow['start']} */
  async function start({ phone: rawPhone } = /** @type {any} */ ({})) {
    if (disposed) return fail('internal_error', 'The Telegram plugin was unloaded')
    // R2: the configured `defaultPhone` never leaves the Host through `/status`.
    // The fallback form may submit an empty phone; the Host then uses the
    // configured number, so the prefill feature survives without exposing it.
    const configuredPhone = settings !== null && typeof settings === 'object' && typeof settings.defaultPhone === 'string'
      ? settings.defaultPhone.trim()
      : ''
    const typedPhone = typeof rawPhone === 'string' ? rawPhone.trim() : ''
    const value = typedPhone !== '' ? typedPhone : configuredPhone
    if (PHONE_PATTERN.test(value) === false) {
      return fail('auth_phone_invalid', 'Enter the phone number in international format: the country code followed by the digits')
    }
    if (stage === 'qr_waiting') {
      // The phone form is the documented fallback (DESIGN-v0.2 9.3 item 5): a
      // half-open QR attempt is abandoned and its dedicated client destroyed
      // instead of blocking the fallback for the whole authTimeoutMs.
      qrGeneration += 1
      qrInfo = null
      running = null
      await releaseQrClient()
      stage = 'idle'
      abandoned = false
    }
    if (stage === 'code_sent' || stage === 'awaiting_2fa') {
      return fail('auth_in_progress', 'Telegram is already waiting for an answer to this sign-in. Enter it, or start a new attempt after it expires.')
    }
    if (stage === 'connected') {
      return fail('not_allowed', 'Telegram is already signed in. Log out before signing in as another account.')
    }
    const connected = await host.ensureConnected()
    if (isFail(connected)) {
      lastError = connected.error
      stage = 'failed'
      return connected
    }

    clearDeadline()
    for (const key of /** @type {Array<'code' | 'password'>} */ (['code', 'password'])) deferreds[key] = null
    waiters = []
    pendingFailure = null
    hint = null
    lastError = null
    qrError = null
    abandoned = false
    phone = value
    // DESIGN 3.4: the engine call runs in the background and the stage is set
    // to `code_sent` for the panel.
    stage = 'code_sent'
    armDeadline()
    running = runSignIn(connected.value.client)
    running.catch(() => {})
    return ok({ stage: 'code_sent' })
  }

  /**
   * Start (or restart) QR sign-in on a dedicated client. A restart destroys the
   * previous instance first: GramJS has no QR cancellation and leaks its event
   * handler on the error path, so one attempt per instance is the contract.
   * @returns {Promise<Result<{ stage: string }>>} `stage: 'qr_waiting'`
   */
  async function startQr() {
    if (disposed) return fail('internal_error', 'The Telegram plugin was unloaded')
    if (stage === 'connected') {
      return fail('not_allowed', 'Telegram is already signed in. Log out before signing in as another account.')
    }
    if (stage === 'code_sent') {
      return fail('auth_in_progress', 'A phone sign-in code is already on its way. Finish it or wait until it expires.')
    }
    if (stage === 'awaiting_2fa' && qrActive === true) {
      return fail('auth_in_progress', 'Telegram is waiting for the two-step verification password.')
    }
    if (typeof host.openLoginClient !== 'function') {
      return fail('internal_error', 'The Telegram host cannot open a sign-in connection')
    }

    // Cancel a previous QR attempt (refresh, Retry, a previous failure).
    qrGeneration += 1
    running = null
    clearDeadline()
    abandonDeferreds(null, new Error('AUTH_USER_CANCEL'))
    for (const key of /** @type {Array<'code' | 'password'>} */ (['code', 'password'])) deferreds[key] = null
    waiters = []
    pendingFailure = null
    lastError = null
    qrError = null
    hint = null
    phone = null
    qrSeq = 0
    qrInfo = null
    abandoned = false
    if (qrActive === true) await releaseQrClient()
    stage = 'idle'

    const opened = await host.openLoginClient()
    if (isFail(opened)) {
      stage = 'failed'
      lastError = opened.error
      qrError = opened.error
      return opened
    }
    const generation = qrGeneration
    qrActive = true
    stage = 'qr_waiting'
    armDeadline()
    running = runQr({ client: opened.value.client, apiId: opened.value.apiId, apiHash: opened.value.apiHash, generation })
    running.catch(() => {})
    return ok({ stage: 'qr_waiting' })
  }

  /** @type {AuthFlow['qrState']} */
  function qrState(since) {
    const from = Number.isFinite(Number(since)) ? Math.max(0, Math.trunc(Number(since))) : 0
    const qr = qrInfo !== null && qrInfo.seq > from ? { seq: qrInfo.seq, uri: qrInfo.uri, expiresAt: qrInfo.expiresAt } : null
    return {
      stage: currentStage(),
      seq: qrSeq,
      qr,
      hint,
      error: qrError !== null ? { code: qrError.code, message: qrError.message } : null,
    }
  }

  /** @type {AuthFlow['verify']} */
  async function verify(params = /** @type {any} */ ({})) {
    if (disposed) return fail('internal_error', 'The Telegram plugin was unloaded')
    const input = params !== null && typeof params === 'object' ? params : {}
    const hasCode = typeof input.code === 'string' && input.code.trim() !== ''
    const hasPassword = typeof input.password === 'string' && input.password !== ''
    if (hasCode === hasPassword) {
      return fail('invalid_arguments', 'Provide exactly one of a code or a two-step verification password')
    }
    if (stage === 'connected') {
      return fail('auth_in_progress', 'Telegram is already signed in')
    }
    if (hasCode === true && stage !== 'code_sent') {
      return fail('auth_in_progress', 'There is no pending code request for this sign-in.')
    }
    if (hasPassword === true && stage !== 'awaiting_2fa') {
      return fail('auth_in_progress', 'Telegram has not asked for a two-step verification password yet.')
    }
    if (running === null || abandoned) {
      // The attempt already ended on its own (a rejected phone number, an
      // expired wait): report the real reason instead of a bare "no attempt".
      if (pendingFailure !== null) return fail(pendingFailure.code, pendingFailure.message)
      return fail('auth_expired', 'There is no active sign-in request. Start again.')
    }
    const kind = hasCode ? 'code' : 'password'
    const box = ensureDeferred(kind)
    if (box.settled) {
      return fail('auth_in_progress', 'Telegram already received an answer for this step. Wait for the next one.')
    }
    box.settled = true
    box.resolve(hasCode ? /** @type {string} */ (input.code).trim() : /** @type {string} */ (input.password))
    return await awaitNextStep()
  }

  /** @returns {string} one of the DESIGN 3.3 `loginStage` values plus `qr_waiting` */
  function currentStage() {
    return STAGE_SET.has(stage) ? stage : 'idle'
  }

  /** @returns {string | null} Telegram's own two-step verification hint */
  function currentHint() {
    return hint
  }

  /** @returns {{ code: string, message: string } | null} last failure of this flow */
  function currentError() {
    return lastError
  }

  /** Silent reset, used after a log-out or on disposal. */
  function reset() {
    qrGeneration += 1
    if (qrActive === true) void releaseQrClient()
    clearDeadline()
    abandonDeferreds(null, new Error('AUTH_USER_CANCEL'))
    for (const key of /** @type {Array<'code' | 'password'>} */ (['code', 'password'])) deferreds[key] = null
    waiters = []
    running = null
    phone = null
    hint = null
    lastError = null
    pendingFailure = null
    qrError = null
    qrInfo = null
    qrActive = false
    abandoned = true
    if (stage !== 'connected') stage = 'idle'
  }

  /** Drop every timer and waiter this flow created. */
  function dispose() {
    disposed = true
    reset()
  }

  return { start, startQr, qrState, verify, stage: currentStage, hint: currentHint, lastError: currentError, reset, dispose }
}
