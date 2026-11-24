/**
 * dsh-telegram — proxy resolution, TCP preflight and the GramJS proxy object
 * (DESIGN-v0.2 10).
 *
 * Direct TCP to every Telegram DC is blocked on this machine, while the local
 * SOCKS5 «watchman» reaches all of them (RESEARCH-FINDINGS 3). DSH itself does
 * not support SOCKS in its `HTTP(S)_PROXY` handling, so the proxy must be
 * passed to GramJS explicitly (DESIGN-v0.2 10.1).
 *
 * Precedence (DESIGN-v0.2 10.2): a non-`direct` Config wins, then
 * `DSH_TELEGRAM_PROXY`, then `direct`. Accepted env forms:
 *
 *   socks5://127.0.0.1:1081
 *   socks5://user:pass@127.0.0.1:1081
 *   mtproxy://host:443?secret=dd0123…
 *   mtproxy://dd0123…@host:443
 *   host:port                      (plain host:port is read as SOCKS5)
 *
 * Secrets (a SOCKS5 password, an MTProxy secret, a credential reference value)
 * never reach a log line, a DTO, `/status` or an error message: `summary()`
 * exposes only mode/host/port, and the password/secret stay in this object.
 *
 * `tcpPreflight` is mandatory before `connect()`: with a dead proxy GramJS
 * resolves `connect()` to `false` in ~1 s and then hangs every later
 * `invoke()` forever (RESEARCH-FINDINGS 3.4; DESIGN-v0.2 10.3).
 *
 * @module dsh-telegram/host/proxy
 */

import net from 'node:net'

import { fail, ok } from './telegram/errors.js'

/** Environment variable that carries a proxy URL (DESIGN-v0.2 10.2). */
export const PROXY_ENV = 'DSH_TELEGRAM_PROXY'

/** Proxy modes GramJS can speak (DESIGN-v0.2 10.2). */
export const PROXY_MODES = Object.freeze(['direct', 'socks5', 'mtproxy'])

/**
 * @typedef {object} ProxySettings
 * @property {'direct' | 'socks5' | 'mtproxy'} mode
 * @property {string} host
 * @property {number} port
 * @property {string} username SOCKS5 user; never logged
 * @property {string} password SOCKS5 password; never logged
 * @property {string} secret MTProxy secret; never logged
 * @property {number} timeoutSec handshake timeout
 * @property {number} preflightMs TCP preflight budget
 * @property {'config' | 'env' | 'default'} source
 */

/**
 * Decode one URL component, tolerating a malformed percent escape.
 * @param {string} value - raw component
 * @returns {string} decoded text
 */
function decode(value) {
  if (typeof value !== 'string' || value === '') return ''
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * Parse a proxy URL into its parts. Exposed for tests; never logs its input.
 * @param {string} value - proxy URL or `host:port`
 * @returns {{ mode: 'socks5' | 'mtproxy', host: string, port: number, username: string, password: string, secret: string } | null}
 */
export function parseProxyUrl(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return null
  let url
  try {
    url = new URL(text.includes('://') ? text : `socks5://${text}`)
  } catch {
    return null
  }
  const scheme = url.protocol.replace(/:$/, '').toLowerCase()
  const mode = scheme === 'mtproxy' || scheme === 'mtproxy-tls' ? 'mtproxy' : scheme === 'socks5' || scheme === 'socks5h' ? 'socks5' : null
  if (mode === null) return null
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const port = Number(url.port)
  if (host === '' || Number.isInteger(port) === false || port <= 0 || port > 65_535) return null
  const username = decode(url.username)
  const password = decode(url.password)
  let secret = decode(url.searchParams.get('secret') ?? '')
  if (mode === 'mtproxy' && secret === '') {
    // Some tools publish `mtproxy://<secret>@host:port`; accept both spellings.
    secret = username !== '' ? username : password
  }
  return { mode, host, port, username: mode === 'socks5' ? username : '', password: mode === 'socks5' ? password : '', secret }
}

/**
 * Resolve the credential reference of a proxy password/secret.
 * @param {any} credentials - `ctx.credentials`
 * @param {string} ref - credential reference name
 * @returns {Promise<{ ok: true, value: string } | { ok: false, error: { code: string, message: string } }>}
 */
async function resolveSecret(credentials, ref) {
  if (credentials === null || typeof credentials !== 'object' || typeof credentials.resolve !== 'function') {
    return fail('internal_error', 'The credentials service is not available to the Telegram plugin')
  }
  let resolved
  try {
    resolved = await credentials.resolve(ref)
  } catch {
    // The reference name itself may be sensitive; nothing of the failure is echoed.
    return fail('internal_error', 'The referenced Telegram proxy credential could not be read')
  }
  const value = resolved !== null && typeof resolved === 'object' ? resolved.value : undefined
  if (typeof value !== 'string' || value.trim() === '') {
    return fail('not_configured', 'The referenced Telegram proxy credential is not set')
  }
  return ok(value.trim())
}

/**
 * Resolve the effective proxy settings for one engine instantiation.
 * @param {{ config: any, env?: Record<string, string | undefined>, credentials?: any }} options
 * @returns {Promise<{ ok: true, value: ProxySettings } | { ok: false, error: { code: string, message: string } }>}
 */
export async function resolveProxy({ config, env, credentials }) {
  const settings = config !== null && typeof config === 'object' ? config : {}
  const environment = env !== null && typeof env === 'object' ? env : {}
  /** @type {ProxySettings} */
  const direct = {
    mode: 'direct',
    host: '',
    port: 0,
    username: '',
    password: '',
    secret: '',
    timeoutSec: Number(settings.proxyTimeoutSec) || 8,
    preflightMs: Number(settings.proxyPreflightMs) || 1_500,
    source: 'default',
  }
  const configured = typeof settings.proxyMode === 'string' && settings.proxyMode !== 'direct'
  if (configured) {
    const mode = settings.proxyMode === 'mtproxy' ? 'mtproxy' : 'socks5'
    const host = typeof settings.proxyHost === 'string' && settings.proxyHost.trim() !== '' ? settings.proxyHost.trim() : '127.0.0.1'
    const port = Number.isInteger(settings.proxyPort) && settings.proxyPort > 0 && settings.proxyPort <= 65_535 ? settings.proxyPort : 1080
    let password = ''
    if (mode === 'socks5' && typeof settings.proxyPasswordRef === 'string' && settings.proxyPasswordRef.trim() !== '') {
      const resolved = await resolveSecret(credentials, settings.proxyPasswordRef.trim())
      if (resolved.ok === false) return resolved
      password = resolved.value
    }
    let secret = ''
    if (mode === 'mtproxy') {
      const ref = typeof settings.proxySecretRef === 'string' ? settings.proxySecretRef.trim() : ''
      if (ref === '') return fail('connection_failed', 'MTProxy requires proxySecretRef with the proxy secret')
      const resolved = await resolveSecret(credentials, ref)
      if (resolved.ok === false) return resolved
      secret = resolved.value
    }
    return ok({
      mode,
      host,
      port,
      username: mode === 'socks5' && typeof settings.proxyUser === 'string' ? settings.proxyUser : '',
      password,
      secret,
      timeoutSec: direct.timeoutSec,
      preflightMs: direct.preflightMs,
      source: 'config',
    })
  }

  const raw = typeof environment[PROXY_ENV] === 'string' ? environment[PROXY_ENV].trim() : ''
  if (raw !== '') {
    const parsed = parseProxyUrl(raw)
    if (parsed === null) {
      return fail('connection_failed', `${PROXY_ENV} is not a valid socks5:// or mtproxy:// URL`)
    }
    if (parsed.mode === 'mtproxy' && parsed.secret === '') {
      return fail('connection_failed', `${PROXY_ENV} names an MTProxy without a secret`)
    }
    return ok({
      mode: parsed.mode,
      host: parsed.host,
      port: parsed.port,
      username: parsed.username,
      password: parsed.password,
      secret: parsed.secret,
      timeoutSec: direct.timeoutSec,
      preflightMs: direct.preflightMs,
      source: 'env',
    })
  }

  return ok(direct)
}

/**
 * A secret-free summary for `/status` and diagnostics (DESIGN-v0.2 10.4).
 * @param {ProxySettings} settings
 * @returns {{ mode: string, host: string, port: number, source: string }}
 */
export function proxySummary(settings) {
  const value = settings !== null && typeof settings === 'object' ? settings : null
  if (value === null || value.mode === 'direct') {
    return { mode: 'direct', host: '', port: 0, source: value === null ? 'default' : value.source }
  }
  return { mode: value.mode, host: value.host, port: value.port, source: value.source }
}

/**
 * The object GramJS accepts in `TelegramClientParams.proxy`
 * (`network/connection/TCPMTProxy.d.ts:4-18`). `undefined` for direct mode.
 * @param {ProxySettings} settings
 * @returns {Record<string, any> | undefined}
 */
export function engineProxy(settings) {
  if (settings === null || typeof settings !== 'object' || settings.mode === 'direct') return undefined
  if (settings.mode === 'mtproxy') {
    return {
      ip: settings.host,
      port: settings.port,
      secret: settings.secret,
      MTProxy: true,
      timeout: settings.timeoutSec,
    }
  }
  /** @type {Record<string, any>} */
  const proxy = {
    ip: settings.host,
    port: settings.port,
    socksType: 5,
    timeout: settings.timeoutSec,
  }
  if (settings.username !== '') proxy.username = settings.username
  if (settings.password !== '') proxy.password = settings.password
  return proxy
}

/**
 * TCP preflight of the proxy endpoint (DESIGN-v0.2 10.3). Bounded, never throws.
 * @param {string} host - proxy host
 * @param {number} port - proxy port
 * @param {number} timeoutMs - budget
 * @returns {Promise<{ ok: true } | { ok: false, code: string, ec: string | null }>}
 */
export function tcpPreflight(host, port, timeoutMs) {
  const target = typeof host === 'string' ? host.trim() : ''
  const numericPort = Number(port)
  const budget = Number.isFinite(Number(timeoutMs)) ? Math.max(200, Math.floor(Number(timeoutMs))) : 1_500
  if (target === '' || Number.isInteger(numericPort) === false || numericPort <= 0 || numericPort > 65_535) {
    return Promise.resolve({ ok: false, code: 'proxy_unreachable', ec: 'EINVAL' })
  }
  return new Promise((resolve) => {
    let settled = false
    const socket = net.connect({ host: target, port: numericPort })
    const finish = (result) => {
      if (settled) return
      settled = true
      try {
        socket.destroy()
      } catch {
        // Already closed.
      }
      resolve(result)
    }
    const timer = setTimeout(() => finish({ ok: false, code: 'proxy_unreachable', ec: 'ETIMEDOUT' }), budget)
    if (typeof timer.unref === 'function') timer.unref()
    socket.once('connect', () => {
      clearTimeout(timer)
      finish({ ok: true })
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      const ec = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : null
      finish({ ok: false, code: 'proxy_unreachable', ec })
    })
  })
}
