/**
 * dsh-telegram — loopback JSON routes of the browser panel (DESIGN.md 5,
 * DESIGN-v0.2 8.3).
 *
 * Fourteen exact paths under `/api/dsh-telegram` are registered on the
 * composition's `webServer`; every handler owns its response and answers JSON
 * only. The trust fence is a copy of the shipped, working sample
 * (`dsh-agent-teams-dashboard/lib/host/routes.js:45-101`): the socket peer must
 * be 127/8 or ::1, `Host` must be a loopback authority, `sec-fetch-site:
 * cross-site` is refused, and an `Origin`, when present, must equal `Host`.
 * `X-Forwarded-For` is never trusted. Refusals answer 403 without detail.
 *
 * Success bodies are `{ ok: true, data: <DTO> }`; failures are
 * `{ ok: false, error: { code, message } }` (DESIGN 3.2, 5.3). The QR matrix is
 * computed Host-side and returned only when it changed since the client's `seq`
 * (DESIGN-v0.2 9.2). No response, log line or error text carries a session, an
 * api hash, a QR token, a phone number or a proxy credential.
 *
 * @module dsh-telegram/host/routes
 */

import { buildQrMatrix } from './qr.js'
import { getProfile } from './telegram/profile.js'
import { listChats } from './telegram/chats.js'
import { getMessages, sendText, markRead } from './telegram/messages.js'
import { searchMessages } from './telegram/search.js'
import { isFail } from './telegram/errors.js'

/** Base path of the route family (DESIGN 5.2). */
export const ROUTE_BASE = '/api/dsh-telegram'

/** Absolute path of one route. */
export function routePath(name) {
  return `${ROUTE_BASE}/${name}`
}

/**
 * HTTP status of one contract error code (DESIGN 5.3 + DESIGN-v0.2 8.3).
 * @param {string} code - `error.code`
 * @returns {number} status
 */
export function statusForCode(code) {
  switch (code) {
    case 'not_authenticated': return 401
    case 'unauthorized_origin':
    case 'chat_forbidden': return 403
    case 'chat_not_found': return 404
    case 'auth_expired':
    case 'auth_timeout':
    case 'auth_in_progress': return 409
    case 'body_too_large': return 413
    case 'flood_wait': return 429
    case 'connection_failed': return 502
    case 'not_configured':
    case 'engine_unavailable': return 503
    case 'internal_error':
    case 'upstream_error': return 500
    default: return 400
  }
}

/** IPv4 127/8 predicate. */
function isIPv4Loopback(value) {
  if (typeof value !== 'string') return false
  const parts = value.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Whether a socket remote address names the loopback range. */
export function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address === '') return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice('::ffff:'.length))
  return isIPv4Loopback(normalized)
}

/** Parse one `Host`/`Origin` authority as loopback. */
function loopbackAuthority(authority) {
  if (typeof authority !== 'string' || authority === '') return null
  let parsed
  try {
    parsed = new URL('http://' + authority)
  } catch {
    return null
  }
  const hostname = parsed.hostname
  const loopback = hostname === 'localhost' || hostname === '[::1]' || isIPv4Loopback(hostname)
  return loopback ? { host: parsed.host, hostname } : null
}

/**
 * Request-level trust fence shared by every route.
 * @param {import('node:http').IncomingMessage} request - incoming request
 * @returns {boolean} true when the request may read a Telegram route
 */
export function isLoopbackRequest(request) {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false
  const hostHeader = request.headers.host
  if (typeof hostHeader !== 'string') return false
  const host = loopbackAuthority(hostHeader)
  if (host === null) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined || origin === '') return true
  let originUrl
  try {
    originUrl = new URL(origin)
  } catch {
    return false
  }
  return originUrl.host === host.host
}

/**
 * Write one JSON response with the route family's headers.
 * @param {import('node:http').ServerResponse} res - response
 * @param {number} status - HTTP status
 * @param {unknown} body - JSON body
 * @param {boolean} [head] - answer a HEAD request without a body
 */
export function sendJson(res, status, body, head = false) {
  let payload
  try {
    payload = JSON.stringify(body)
  } catch {
    payload = JSON.stringify({ ok: false, error: { code: 'internal_error', message: 'The response could not be serialized' } })
  }
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  }
  res.writeHead(status, headers)
  if (head) {
    res.end()
    return
  }
  res.end(payload)
}

/**
 * Send a contract `Result` as the route response (DESIGN 5.3).
 * @param {import('node:http').ServerResponse} res - response
 * @param {{ ok: boolean, value?: any, error?: any }} result - operation result
 * @param {boolean} [head] - HEAD request
 * @returns {void}
 */
export function sendResult(res, result, head = false) {
  if (result !== null && typeof result === 'object' && result.ok === true) {
    sendJson(res, 200, { ok: true, data: result.value }, head)
    return
  }
  const error = result !== null && typeof result === 'object' && result.error !== null && typeof result.error === 'object'
    ? result.error
    : { code: 'internal_error', message: 'The Telegram operation failed' }
  sendJson(res, statusForCode(error.code), { ok: false, error: { code: error.code, message: error.message } }, head)
}

/**
 * Parse the request URL defensively.
 * @param {import('node:http').IncomingMessage} request - request
 * @returns {URL} parsed URL
 */
function requestUrl(request) {
  try {
    return new URL(request.url ?? '/', 'http://127.0.0.1')
  } catch {
    return new URL('http://127.0.0.1/')
  }
}

/**
 * Read an integer query parameter, bounded.
 * @param {URLSearchParams} search - query
 * @param {string} name - parameter name
 * @param {number} min - lower bound
 * @param {number} max - upper bound
 * @returns {number | null} accepted integer or null
 */
function integerParam(search, name, min, max) {
  const raw = search.get(name)
  if (raw === null || raw === '') return null
  if (!/^\d+$/.test(raw)) return null
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < min || value > max) return null
  return value
}

/**
 * Read a JSON body with a byte cap (DESIGN 5.1, 5.3).
 * @param {import('node:http').IncomingMessage} request - request
 * @param {number} maxBytes - cap
 * @returns {Promise<{ ok: true, value: any } | { ok: false, status: number, code: string, message: string }>}
 */
export function readJsonBody(request, maxBytes) {
  const limit = Number.isFinite(Number(maxBytes)) ? Math.max(1_024, Math.trunc(Number(maxBytes))) : 65_536
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    request.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        finish({ ok: false, status: 413, code: 'body_too_large', message: `The request body exceeds ${limit} bytes` })
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (settled) return
      if (chunks.length === 0) {
        finish({ ok: true, value: {} })
        return
      }
      let parsed
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        finish({ ok: false, status: 400, code: 'invalid_arguments', message: 'The request body is not valid JSON' })
        return
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        finish({ ok: false, status: 400, code: 'invalid_arguments', message: 'The request body must be a JSON object' })
        return
      }
      finish({ ok: true, value: parsed })
    })
    request.on('error', () => {
      finish({ ok: false, status: 400, code: 'invalid_arguments', message: 'The request body could not be read' })
    })
  })
}

/**
 * Obtain the first QR token after a start, bounded (DESIGN-v0.2 9.3: the panel
 * shows a QR immediately). The token callback fires after the first
 * `ExportLoginToken`, usually within a second through a live proxy.
 * @param {any} host - Telegram host
 * @param {number} budgetMs - upper bound
 * @returns {Promise<{ state: any, qr: any }>}
 */
async function firstQrState(host, budgetMs) {
  const deadline = Date.now() + Math.max(0, budgetMs)
  let state = host.qrState(0)
  while (state.qr === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    state = host.qrState(0)
    if (state.stage === 'failed' || state.stage === 'awaiting_2fa' || state.stage === 'connected') break
  }
  return state
}

/**
 * Build the route table. Each route is registered by `index.js` inside its own
 * `ctx.effect`, so unloading the row removes every handler.
 * @param {{ version: string, config: any, host: any }} options
 * @returns {{ routes: Array<{ method: string, path: string, handler: (req: any, res: any) => Promise<void> }> }}
 */
export function createHostApi({ version, config, host }) {
  const settings = config !== null && typeof config === 'object' ? config : {}
  /** @type {Map<string, { size: number, modules: string }>} */
  const matrixCache = new Map()

  /**
   * Attach the QR matrix to a state object when the token changed.
   * @param {any} state - `host.qrState()` value
   * @returns {Promise<any>} response payload
   */
  async function withMatrix(state) {
    if (state.qr === null || state.qr === undefined) {
      return { stage: state.stage, seq: state.seq, qr: null, hint: state.hint ?? null, error: state.error ?? null }
    }
    const uri = state.qr.uri
    let matrix = matrixCache.get(uri)
    if (matrix === undefined) {
      const built = await buildQrMatrix(uri)
      if (built.ok === false) {
        return { stage: state.stage, seq: state.seq, qr: null, hint: state.hint ?? null, error: built.error }
      }
      matrix = { size: built.value.size, modules: built.value.matrix }
      matrixCache.set(uri, matrix)
      while (matrixCache.size > 8) {
        const oldest = matrixCache.keys().next().value
        if (oldest === undefined) break
        matrixCache.delete(oldest)
      }
    }
    return {
      stage: state.stage,
      seq: state.seq,
      qr: { seq: state.qr.seq, uri, expiresAt: state.qr.expiresAt, matrix: { size: matrix.size, modules: matrix.modules } },
      hint: state.hint ?? null,
      error: state.error ?? null,
    }
  }

  /**
   * Status payload (DESIGN-v0.2 8.3): top-level fields plus the full HostState
   * for the panel, and a secret-free config summary.
   * @returns {object} response data
   */
  function statusData() {
    const state = host.state()
    return {
      version,
      status: state.status,
      loggedIn: state.loggedIn === true,
      account: state.loggedIn === true
        ? { id: state.userId, title: state.title, phone: state.phone, userId: state.userId, dcId: state.dcId }
        : null,
      loginStage: state.loginStage,
      diagnostics: state.diagnostics,
      state,
      config: {
        apiId: state.configured === true,
        apiHashConfigured: state.configured === true,
        proxy: state.proxy,
        limits: {
          dialogs: settings.dialogLimit,
          messages: settings.messageLimit,
          search: settings.searchLimit,
          text: settings.textMaxLength,
          selectionObjects: settings.selectionMaxObjects,
          selectionText: settings.selectionTextPerObject,
          promptChars: settings.promptMaxChars,
          noteChars: settings.noteMaxChars,
        },
        sendMode: settings.sendMode,
        // R2 (t6 review): never return the configured phone number. The panel
        // only needs to know whether the fallback form has a configured number;
        // the number itself stays on the Host and is used only when the user
        // submits the fallback form (auth.start fills an empty phone from it).
        phoneConfigured: typeof settings.defaultPhone === 'string' && settings.defaultPhone.trim() !== '',
      },
    }
  }

  /**
   * One route handler: fence, method, body, dispatch, JSON response.
   * @param {string} method - expected HTTP method
   * @param {(request: any, url: URL, body: any) => Promise<any>} run - operation
   * @returns {(request: any, res: any) => Promise<void>}
   */
  function handlerFor(method, run) {
    return async function handler(request, res) {
      try {
        if (isLoopbackRequest(request) !== true) {
          sendJson(res, 403, { ok: false, error: { code: 'unauthorized_origin', message: 'The Telegram API is available to loopback clients only' } })
          return
        }
        const actualMethod = request.method === 'HEAD' ? 'GET' : request.method
        if (actualMethod !== method) {
          res.setHeader('allow', method)
          sendJson(res, 405, { ok: false, error: { code: 'invalid_arguments', message: `Use ${method} for this route` } })
          return
        }
        const url = requestUrl(request)
        let body = {}
        if (method === 'POST') {
          const contentType = typeof request.headers['content-type'] === 'string' ? request.headers['content-type'] : ''
          if (contentType !== '' && contentType.toLowerCase().startsWith('application/json') === false) {
            sendJson(res, 400, { ok: false, error: { code: 'invalid_arguments', message: 'The request body must be JSON' } })
            return
          }
          const read = await readJsonBody(request, settings.bodyMaxBytes)
          if (read.ok === false) {
            sendJson(res, read.status, { ok: false, error: { code: read.code, message: read.message } })
            return
          }
          body = read.value
        }
        const result = await run(request, url, body)
        sendResult(res, result, request.method === 'HEAD')
      } catch {
        sendJson(res, 500, { ok: false, error: { code: 'internal_error', message: 'The Telegram request failed' } })
      }
    }
  }

  const routes = [
    {
      kind: 'exact',
      method: 'GET',
      path: routePath('status'),
      handler: handlerFor('GET', async () => {
        // A cheap, bounded proxy probe makes `connection_failed` observable on
        // /status itself (DESIGN-v0.2 10.4) without opening an MTProto client.
        if (typeof host.probeConnection === 'function') {
          try {
            await host.probeConnection()
          } catch {
            // The state snapshot carries the failure.
          }
        }
        return { ok: true, value: statusData() }
      }),
    },
    {
      kind: 'exact',
      method: 'GET',
      path: routePath('dialogs'),
      handler: handlerFor('GET', async (request, url) => {
        const requested = integerParam(url.searchParams, 'limit', 1, 100)
        const query = (url.searchParams.get('query') ?? '').trim().toLowerCase()
        const result = await listChats(host, { limit: requested ?? undefined, includeArchived: url.searchParams.get('archived') === '1' })
        if (isFail(result)) return result
        const filtered = query === ''
          ? result.value.chats
          : result.value.chats.filter((chat) => String(chat.title).toLowerCase().includes(query))
        return {
          ok: true,
          value: {
            dialogs: filtered,
            chats: filtered,
            count: filtered.length,
            truncated: result.value.truncated,
            updatedAt: Math.floor(Date.now() / 1000),
          },
        }
      }),
    },
    {
      kind: 'exact',
      method: 'GET',
      path: routePath('messages'),
      handler: handlerFor('GET', async (request, url) => {
        const chatId = (url.searchParams.get('chatId') ?? url.searchParams.get('chat_id') ?? '').trim()
        const limit = integerParam(url.searchParams, 'limit', 1, 100)
        const before = integerParam(url.searchParams, 'before', 0, Number.MAX_SAFE_INTEGER)
        if (chatId === '') {
          return { ok: false, error: { code: 'invalid_arguments', message: 'chatId is required to read a chat history' } }
        }
        return getMessages(host, { chatId, limit: limit ?? undefined, before: before ?? 0 })
      }),
    },
    {
      kind: 'exact',
      method: 'POST',
      path: routePath('send'),
      handler: handlerFor('POST', async (request, url, body) => {
        const chatId = typeof body.chatId === 'string' ? body.chatId : typeof body.chat_id === 'string' ? body.chat_id : ''
        const text = typeof body.text === 'string' ? body.text : ''
        const replyTo = Number.isInteger(body.replyTo) ? body.replyTo : Number.isInteger(body.reply_to) ? body.reply_to : undefined
        return sendText(host, { chatId, text, replyTo })
      }),
    },
    {
      kind: 'exact',
      method: 'POST',
      path: routePath('read'),
      handler: handlerFor('POST', async (request, url, body) => {
        const chatId = typeof body.chatId === 'string' ? body.chatId : typeof body.chat_id === 'string' ? body.chat_id : ''
        const maxId = Number.isInteger(body.maxId) ? body.maxId : Number.isInteger(body.up_to) ? body.up_to : 0
        return markRead(host, { chatId, upTo: maxId })
      }),
    },
    {
      kind: 'exact',
      method: 'GET',
      path: routePath('search'),
      handler: handlerFor('GET', async (request, url) => {
        const query = (url.searchParams.get('q') ?? url.searchParams.get('query') ?? '').trim()
        const chatId = (url.searchParams.get('chatId') ?? url.searchParams.get('chat_id') ?? '').trim()
        const limit = integerParam(url.searchParams, 'limit', 1, 50)
        return searchMessages(host, { query, chatId: chatId === '' ? null : chatId, limit: limit ?? undefined })
      }),
    },
    {
      kind: 'exact',
      method: 'GET',
      path: routePath('profile'),
      handler: handlerFor('GET', async (request, url) => {
        const userId = (url.searchParams.get('userId') ?? url.searchParams.get('user_id') ?? '').trim()
        const chatId = (url.searchParams.get('chatId') ?? url.searchParams.get('chat_id') ?? '').trim()
        const reveal = url.searchParams.get('reveal') === 'phone' || url.searchParams.get('reveal') === '1'
        return getProfile(host, { userId: userId === '' ? null : userId, chatId: chatId === '' ? null : chatId, revealPhone: reveal })
      }),
    },
    {
      kind: 'exact',
      method: 'POST',
      path: routePath('login/qr/start'),
      handler: handlerFor('POST', async () => {
        const started = await host.loginQrStart()
        if (isFail(started)) return started
        const state = await firstQrState(host, 2_500)
        return { ok: true, value: await withMatrix(state) }
      }),
    },
    {
      kind: 'exact',
      method: 'GET',
      path: routePath('login/qr/state'),
      handler: handlerFor('GET', async (request, url) => {
        const since = integerParam(url.searchParams, 'since', 0, Number.MAX_SAFE_INTEGER) ?? 0
        const state = host.qrState(since)
        return { ok: true, value: await withMatrix(state) }
      }),
    },
    {
      kind: 'exact',
      method: 'POST',
      path: routePath('login/verify'),
      handler: handlerFor('POST', async (request, url, body) => {
        const params = {}
        if (typeof body.code === 'string') params.code = body.code
        if (typeof body.password === 'string') params.password = body.password
        const verified = await host.loginVerify(params)
        if (isFail(verified)) return verified
        return { ok: true, value: { stage: verified.value.stage, hint: host.loginState() === 'awaiting_2fa' ? host.state().loginHint : null, state: host.state() } }
      }),
    },
    {
      kind: 'exact',
      method: 'POST',
      path: routePath('login/phone/start'),
      handler: handlerFor('POST', async (request, url, body) => {
        const phone = typeof body.phone === 'string' ? body.phone : ''
        const started = await host.loginStart({ phone })
        if (isFail(started)) return started
        return { ok: true, value: { stage: started.value.stage, state: host.state() } }
      }),
    },
    {
      kind: 'exact',
      method: 'GET',
      path: routePath('login/state'),
      handler: handlerFor('GET', async () => ({ ok: true, value: { stage: host.loginState(), hint: host.state().loginHint, error: host.state().lastError, state: host.state() } })),
    },
    {
      kind: 'exact',
      method: 'POST',
      path: routePath('logout'),
      handler: handlerFor('POST', async (request, url, body) => {
        if (body.confirm !== 'logout') {
          return { ok: false, error: { code: 'invalid_arguments', message: "Pass {confirm:'logout'} to sign out" } }
        }
        const loggedOut = await host.logout()
        if (isFail(loggedOut)) return loggedOut
        return { ok: true, value: { loggedOut: true, state: host.state() } }
      }),
    },
  ]

  // Any other path under the family answers JSON 404 (never the SPA HTML).
  routes.push({
    kind: 'prefix',
    method: '*',
    path: ROUTE_BASE,
    handler: async function fallback(request, res) {
      if (isLoopbackRequest(request) !== true) {
        sendJson(res, 403, { ok: false, error: { code: 'unauthorized_origin', message: 'The Telegram API is available to loopback clients only' } })
        return
      }
      sendJson(res, 404, { ok: false, error: { code: 'invalid_arguments', message: 'Unknown Telegram API route' } })
    },
  })

  return { routes }
}
