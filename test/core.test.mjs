/**
 * Core contract tests of dsh-telegram (node --test test/).
 *
 * They cover the parts that do not need a Telegram account: config
 * normalization, proxy URL parsing and precedence, the Host-side QR matrix, the
 * route trust fence/status mapping, the credential record shape, the tool
 * definition and the QR sign-in state machine against a fake engine. The live
 * account flows (real QR approval, real dialogs) stay user-dependent and are
 * listed in docs/DETAIL.md.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { CONFIG_DEFAULTS, resolveConfig } from '../lib/host/config.js'
import { engineProxy, parseProxyUrl, proxySummary, resolveProxy, tcpPreflight } from '../lib/host/proxy.js'
import { buildQrMatrix } from '../lib/host/qr.js'
import { createHostApi, isLoopbackRequest, statusForCode } from '../lib/host/routes.js'
import { createTelegramTool, TELEGRAM_ACTIONS } from '../lib/host/tool.js'
import { createAuthFlow } from '../lib/host/telegram/auth.js'
import { clearSession, readSession, sessionKey, writeSession } from '../lib/host/telegram/store.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('config: every field has a default and a row without config mounts', () => {
  const resolved = resolveConfig(undefined)
  assert.deepEqual(resolved.issues, [])
  assert.equal(resolved.value.apiId, 0)
  assert.equal(resolved.value.apiHash, '')
  assert.equal(resolved.value.proxyMode, 'direct')
  assert.equal(resolved.value.sendMode, 'queue')
  assert.ok(Object.keys(CONFIG_DEFAULTS).length >= 20)
})

test('config: out-of-range values fall back and are reported without values', () => {
  const resolved = resolveConfig({ apiId: -1, authTimeoutMs: 10, proxyPort: 99999, proxyMode: 'http', apiHash: 'secret-value' })
  assert.equal(resolved.value.apiId, 0)
  assert.equal(resolved.value.authTimeoutMs, CONFIG_DEFAULTS.authTimeoutMs)
  assert.equal(resolved.value.proxyPort, CONFIG_DEFAULTS.proxyPort)
  assert.equal(resolved.value.proxyMode, 'direct')
  assert.ok(resolved.issues.length >= 4)
  for (const issue of resolved.issues) assert.equal(issue.message.includes('secret-value'), false)
})

test('proxy URL parsing accepts SOCKS5 and MTProxy and keeps secrets out of the summary', () => {
  const socks = parseProxyUrl('socks5://user:p%40ss@127.0.0.1:1081')
  assert.deepEqual(socks, { mode: 'socks5', host: '127.0.0.1', port: 1081, username: 'user', password: 'p@ss', secret: '' })
  const mt = parseProxyUrl('mtproxy://host.example:443?secret=dd0123')
  assert.equal(mt.mode, 'mtproxy')
  assert.equal(mt.secret, 'dd0123')
  const summary = proxySummary({ ...socks, source: 'env' })
  assert.deepEqual(summary, { mode: 'socks5', host: '127.0.0.1', port: 1081, source: 'env' })
  assert.equal(JSON.stringify(summary).includes('p@ss'), false)
  const proxyObject = engineProxy({ ...socks, timeoutSec: 8 })
  assert.equal(proxyObject.socksType, 5)
  assert.equal(proxyObject.password, 'p@ss')
})

test('proxy precedence: non-direct Config wins over the environment', async () => {
  const config = { ...CONFIG_DEFAULTS, proxyMode: 'socks5', proxyHost: '127.0.0.1', proxyPort: 1081 }
  const fromConfig = await resolveProxy({ config, env: { DSH_TELEGRAM_PROXY: 'socks5://10.0.0.1:1080' }, credentials: {} })
  assert.equal(fromConfig.ok, true)
  assert.equal(fromConfig.value.port, 1081)
  assert.equal(fromConfig.value.source, 'config')

  const fromEnv = await resolveProxy({ config: CONFIG_DEFAULTS, env: { DSH_TELEGRAM_PROXY: 'socks5://127.0.0.1:1081' }, credentials: {} })
  assert.equal(fromEnv.ok, true)
  assert.equal(fromEnv.value.port, 1081)
  assert.equal(fromEnv.value.source, 'env')

  const invalid = await resolveProxy({ config: CONFIG_DEFAULTS, env: { DSH_TELEGRAM_PROXY: 'http://127.0.0.1:8080' }, credentials: {} })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.error.code, 'connection_failed')
})

test('TCP preflight is bounded and reports an unreachable endpoint', async () => {
  const started = Date.now()
  const result = await tcpPreflight('127.0.0.1', 1, 500)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'proxy_unreachable')
  assert.ok(Date.now() - started < 2_000)
})

test('QR matrix is square, row-major and large enough to scan', async () => {
  const built = await buildQrMatrix('tg://login?token=abc')
  assert.equal(built.ok, true)
  assert.ok(built.value.size >= 21)
  assert.equal(built.value.matrix.length, built.value.size * built.value.size)
  assert.match(built.value.matrix, /^[01]+$/)
  const empty = await buildQrMatrix('')
  assert.equal(empty.ok, false)
})

test('route fences reject cross-site and non-loopback requests', () => {
  const base = {
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080' },
  }
  assert.equal(isLoopbackRequest(base), true)
  assert.equal(isLoopbackRequest({ ...base, headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' } }), true)
  assert.equal(isLoopbackRequest({ ...base, headers: { host: '127.0.0.1:3080', origin: 'http://evil.test' } }), false)
  assert.equal(isLoopbackRequest({ ...base, headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' } }), false)
  assert.equal(isLoopbackRequest({ ...base, socket: { remoteAddress: '10.0.0.2' } }), false)
  assert.equal(isLoopbackRequest({ ...base, socket: { remoteAddress: '::1' } }), true)
})

test('route status mapping covers the contract codes', () => {
  assert.equal(statusForCode('not_configured'), 503)
  assert.equal(statusForCode('connection_failed'), 502)
  assert.equal(statusForCode('not_authenticated'), 401)
  assert.equal(statusForCode('unauthorized_origin'), 403)
  assert.equal(statusForCode('chat_not_found'), 404)
  assert.equal(statusForCode('auth_timeout'), 409)
  assert.equal(statusForCode('flood_wait'), 429)
  assert.equal(statusForCode('invalid_arguments'), 400)
})

test('credential session round trip keeps the secret out of keys and accepts method', async () => {
  const records = new Map()
  const credentials = {
    async readRecord(key) { return records.get(key) },
    async modifyRecord(key, update) { const next = update(records.get(key)); records.set(key, next); return next },
    async deleteRecord(key) { records.delete(key) },
  }
  const ctx = { credentials }
  assert.equal(sessionKey(), 'dsh-telegram/session')
  const written = await writeSession(ctx, { session: 'SESSION_STRING', phone: '+70000000000', userId: '42', dcId: 2, method: 'qr' })
  assert.equal(written.ok, true)
  assert.equal(written.value.payload.method, 'qr')
  const read = await readSession(ctx)
  assert.equal(read.ok, true)
  assert.equal(read.value.payload.session, 'SESSION_STRING')
  const cleared = await clearSession(ctx)
  assert.equal(cleared.ok, true)
  assert.equal(records.size, 0)
})

test('tool declares the eight actions, validates, and reports status without a login', async () => {
  const definition = createTelegramTool({ host: { state: () => ({ configured: false, engineAvailable: true, loggedIn: false, status: 'not_configured' }) } })
  assert.equal(definition.name, 'telegram')
  assert.deepEqual(definition.parameters.properties.action.enum, [...TELEGRAM_ACTIONS])
  const status = await definition.execute({ action: 'status' }, {})
  assert.equal(status.ok, true)
  assert.equal(status.result.status, 'not_configured')
  const blocked = await definition.execute({ action: 'list_chats' }, {})
  assert.equal(blocked.ok, false)
  assert.equal(blocked.error.code, 'not_configured')
  const bad = await definition.execute({ action: 'login' }, {})
  assert.equal(bad.error.code, 'invalid_arguments')
  const rendered = definition.output.render({ action: 'status' }, status)
  assert.equal(rendered[0].type, 'text')
})

test('QR sign-in publishes tokens, requests the 2FA password and stores method=qr', async () => {
  let stored = null
  let completed = false
  const fakeClient = {
    session: { save: () => 'SESSION_STRING', dcId: 2 },
    async getMe() { return { id: 42, firstName: 'Test' } },
    async signInUserWithQrCode(_credentials, params) {
      await params.qrCode({ token: Buffer.from('qr-token'), expires: Math.floor(Date.now() / 1000) + 30 })
      await sleep(120)
      await params.password('pet')
      return { id: 42, firstName: 'Test' }
    },
  }
  const host = {
    async ensureConnected() { return { ok: true, value: { client: fakeClient } } },
    async openLoginClient() { return { ok: true, value: { client: fakeClient, apiId: 1, apiHash: 'hash' } } },
    async closeLoginClient() {},
    async completeExternalLogin() { completed = true },
  }
  const flow = createAuthFlow({
    host,
    config: { authTimeoutMs: 2_000 },
    store: { writeSession: async (record) => { stored = record; return { ok: true, value: { kind: 'grant', payload: record } } } },
  })
  try {
    const started = await flow.startQr()
    assert.equal(started.value.stage, 'qr_waiting')
    await sleep(30)
    const state = flow.qrState(0)
    assert.equal(state.stage, 'qr_waiting')
    assert.match(state.qr.uri, /^tg:\/\/login\?token=/)
    await sleep(150)
    assert.equal(flow.qrState(0).stage, 'awaiting_2fa')
    const verified = await flow.verify({ password: 'secret' })
    assert.equal(verified.value.stage, 'connected')
    await sleep(10)
    assert.equal(flow.stage(), 'connected')
    assert.equal(stored.method, 'qr')
    assert.equal(completed, true)
  } finally {
    flow.dispose()
  }
})


test('R2: /status reports phoneConfigured but never returns the configured phone number', async () => {
  const configuredPhone = '+79001234567'
  const config = resolveConfig({ apiId: 1, apiHash: '0123456789abcdef0123456789abcdef', defaultPhone: configuredPhone }).value
  const host = {
    state() {
      return {
        configured: true,
        engineAvailable: true,
        engineVersion: '2.26.21',
        loggedIn: false,
        connected: false,
        loginStage: 'idle',
        phone: null,
        userId: null,
        title: null,
        dcId: null,
        savedAt: null,
        lastError: null,
        status: 'needs_auth',
        loginHint: null,
        proxy: { mode: 'direct', host: '', port: 0, source: 'default' },
        diagnostics: null,
      }
    },
    async probeConnection() {
      return { ok: true, value: { probed: false } }
    },
  }
  const api = createHostApi({ version: '0.2.0', config, host })
  const route = api.routes.find((entry) => entry.path === '/api/dsh-telegram/status')
  assert.ok(route !== undefined, 'the status route must be registered')
  const request = {
    method: 'GET',
    url: '/api/dsh-telegram/status',
    headers: { host: '127.0.0.1:3099' },
    socket: { remoteAddress: '127.0.0.1' },
  }
  let status = 0
  let body = ''
  const response = {
    writeHead(code) { status = code },
    end(chunk) { body = typeof chunk === 'string' ? chunk : '' },
    setHeader() {},
  }
  await route.handler(request, response)
  assert.equal(status, 200)
  assert.equal(body.includes(configuredPhone), false, 'the configured phone string must not be serialized')
  assert.equal(body.includes('79001234567'), false, 'the configured phone digits must not be serialized')
  assert.equal(body.includes('9001234567'), false, 'the configured phone digits must not be serialized')
  const parsed = JSON.parse(body)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.data.config.phoneConfigured, true)
  assert.equal(Object.hasOwn(parsed.data.config, 'defaultPhone'), false)
  assert.equal(Object.hasOwn(parsed.data.state, 'defaultPhone'), false)
  // The rest of the contract stays stable for existing consumers.
  assert.equal(parsed.data.version, '0.2.0')
  assert.equal(parsed.data.status, 'needs_auth')
  assert.equal(typeof parsed.data.config.apiId, 'boolean')
  assert.equal(typeof parsed.data.config.sendMode, 'string')
  assert.equal(typeof parsed.data.config.limits, 'object')
  assert.equal(typeof parsed.data.config.proxy, 'object')
  assert.equal(typeof parsed.data.state, 'object')
})

test('R2: /status reports phoneConfigured=false when no default phone is configured', async () => {
  const config = resolveConfig({}).value
  const host = {
    state() {
      return { configured: false, engineAvailable: true, engineVersion: null, loggedIn: false, connected: false, loginStage: 'idle', phone: null, userId: null, title: null, dcId: null, savedAt: null, lastError: null, status: 'not_configured', loginHint: null, proxy: null, diagnostics: null }
    },
  }
  const api = createHostApi({ version: '0.2.0', config, host })
  const route = api.routes.find((entry) => entry.path === '/api/dsh-telegram/status')
  let body = ''
  await route.handler(
    { method: 'GET', url: '/api/dsh-telegram/status', headers: { host: '127.0.0.1:3099' }, socket: { remoteAddress: '127.0.0.1' } },
    { writeHead() {}, end(chunk) { body = String(chunk) }, setHeader() {} },
  )
  assert.equal(JSON.parse(body).data.config.phoneConfigured, false)
})


test('R2: an empty fallback phone submission uses the configured number on the Host only', async () => {
  let capturedPhone = null
  const fakeClient = {
    async start(params) {
      capturedPhone = await params.phoneNumber()
      // Stop the flow after the phone callback; the stage itself is irrelevant.
      throw new Error('TEST_STOP')
    },
  }
  const flow = createAuthFlow({
    host: { async ensureConnected() { return { ok: true, value: { client: fakeClient } } } },
    config: { authTimeoutMs: 2_000, defaultPhone: '+79001234567' },
    store: { writeSession: async () => ({ ok: true, value: { kind: 'grant', payload: {} } }) },
  })
  try {
    const started = await flow.start({ phone: '' })
    assert.equal(started.ok, true)
    assert.equal(started.value.stage, 'code_sent')
    await sleep(20)
    assert.equal(capturedPhone, '+79001234567')
  } finally {
    flow.dispose()
  }
})
