// 10-utils.js — shared helpers of the dsh-telegram browser bundle (DESIGN.md
// 6.2, DESIGN-v0.2 3.2).
//
// Contract names: boundTranslate, dictionaryTranslate, apiUrl, apiRequest,
// readLocal, writeLocal, formatTime, truncate, classNameOf, documentVisible,
// useSnapshot, useSessionsStore, useActivePanelId, useInterval.
//
// `DICT` is inserted by the generator right after 00-constants.js. Every use is
// guarded with `typeof DICT` so a fragment still reads standalone.
//
// `apiRequest(method, path, body, signal)` resolves either
//   { ok:true, data, status }
// or { ok:false, code, message, status, retryAfterMs }.
// Route responses are `{ok:true,data}` / `{ok:false,error}` (DESIGN-v0.2 8.3).
// A repeated request to the same method+URL aborts the stale one.

function isRecord(value) {
  return value !== null && typeof value === 'object' && Array.isArray(value) === false
}

function hasOwn(object, key) {
  return object !== null && object !== undefined && Object.prototype.hasOwnProperty.call(object, key)
}

function interpolate(text, params) {
  if (params === undefined || params === null) return String(text)
  return String(text).replace(/\{(\w+)\}/g, function (match, name) {
    const value = params[name]
    return value === undefined || value === null ? match : String(value)
  })
}

function clampInt(value, min, max, fallback) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!isFinite(parsed)) return fallback
  const rounded = Math.trunc(parsed)
  if (rounded < min) return min
  if (rounded > max) return max
  return rounded
}

//#region Locale

function dictionaryTranslate(lang) {
  const code = String(lang === undefined || lang === null ? 'en' : lang).toLowerCase().slice(0, 2)
  const dictionaries = typeof DICT !== 'undefined' && isRecord(DICT) ? DICT : {}
  const fallback = isRecord(dictionaries.en) ? dictionaries.en : {}
  const dictionary = isRecord(dictionaries[code]) ? dictionaries[code] : fallback
  return function t(key, params) {
    const source = hasOwn(dictionary, key) ? dictionary[key] : hasOwn(fallback, key) ? fallback[key] : key
    return interpolate(source, params)
  }
}

function activeLanguage(ctx) {
  try {
    if (ctx !== null && typeof ctx.locale === 'object' && typeof ctx.locale.getSnapshot === 'function') {
      const snapshot = ctx.locale.getSnapshot()
      if (isRecord(snapshot)) {
        if (typeof snapshot.active === 'string' && snapshot.active !== '') return snapshot.active
        if (typeof snapshot.language === 'string' && snapshot.language !== '') return snapshot.language
      }
    }
  } catch (error) {
    // The offline dictionary is the fallback; a locale service that is not
    // installed yet must not blank the panel.
  }
  return 'en'
}

// ctx.locale.bind(NS) is the live translator (DESIGN.md 6.4); the generated DICT
// is its fallback, following REF/lib/client.js:154-169.
function boundTranslate(ctx) {
  let bound = null
  try {
    if (ctx !== null && typeof ctx.locale === 'object' && typeof ctx.locale.bind === 'function') {
      bound = ctx.locale.bind(NS)
    }
  } catch (error) {
    bound = null
  }
  if (typeof bound !== 'function') return dictionaryTranslate('en')
  return function t(key, params) {
    try {
      return bound(key, params)
    } catch (error) {
      return interpolate(dictionaryTranslate('en')(key, undefined), params)
    }
  }
}

// DESIGN.md 7.3: t('error.' + code), degrading to the server message and then to
// the code itself when no key exists.
function errorText(result, t) {
  const translate = typeof t === 'function' ? t : dictionaryTranslate('en')
  if (result === null || result === undefined) return ''
  const code = typeof result.code === 'string' ? result.code : ''
  const message = typeof result.message === 'string' ? result.message : ''
  if (code === '') return message
  const localized = translate('error.' + code)
  if (typeof localized === 'string' && localized !== 'error.' + code) return localized
  return message !== '' ? message : code
}

//#endregion

//#region HTTP client to /api/dsh-telegram (DESIGN.md 5, DESIGN-v0.2 8.3)

const inflightRequests = new Map()

function requestKeyOf(method, url) {
  return method + ' ' + url
}

function abortEntry(entry) {
  if (entry === null || entry === undefined) return
  if (entry.controller === null || entry.controller === undefined) return
  try {
    entry.controller.abort()
  } catch (error) {
    // An abort that fails is already settled.
  }
}

function abortRequest(method, url) {
  const key = requestKeyOf(method, url)
  const entry = inflightRequests.get(key)
  if (entry === undefined) return
  inflightRequests.delete(key)
  abortEntry(entry)
}

// Cancel every in-flight request whose URL starts with `routePrefix`
// (for example ROUTES.messages) — used when a chat is closed or the panel unmounts.
function abortRequests(routePrefix) {
  const prefix = String(routePrefix === undefined ? '' : routePrefix)
  const keys = []
  inflightRequests.forEach(function (entry, key) {
    if (prefix === '' || key.indexOf(' ' + API_BASE + prefix) !== -1) keys.push(key)
  })
  for (let index = 0; index < keys.length; index += 1) {
    const entry = inflightRequests.get(keys[index])
    inflightRequests.delete(keys[index])
    abortEntry(entry)
  }
}

function apiUrl(path, params) {
  const route = isRecord(path) ? path.path : path
  const query = isRecord(path) ? path.params : params
  const clean = String(route === undefined || route === null ? '' : route).replace(/^\/+/, '')
  let url = API_BASE + '/' + clean
  if (isRecord(query)) {
    const parts = []
    const names = Object.keys(query)
    for (let index = 0; index < names.length; index += 1) {
      const name = names[index]
      const value = query[name]
      if (value === undefined || value === null || value === '') continue
      parts.push(encodeURIComponent(name) + '=' + encodeURIComponent(String(value)))
    }
    if (parts.length > 0) url += '?' + parts.join('&')
  }
  return url
}

function resolveRequestUrl(path, params) {
  const text = String(path === undefined || path === null ? '' : path)
  if (text.indexOf(API_BASE) === 0) return text
  return apiUrl(path, params)
}

function jsonShape(body, status) {
  if (isRecord(body) && body.ok === true) {
    const data = hasOwn(body, 'data') ? body.data : body
    return { ok: true, data: data, status: status }
  }
  if (isRecord(body) && body.ok === false && isRecord(body.error)) {
    const code = typeof body.error.code === 'string' ? body.error.code : 'internal_error'
    const message = typeof body.error.message === 'string' ? body.error.message : ''
    const retryAfterMs = typeof body.error.retryAfterMs === 'number' ? body.error.retryAfterMs : null
    return { ok: false, code: code, message: message, status: status, retryAfterMs: retryAfterMs }
  }
  // A bare HostState body (older route shape) is accepted as data.
  if (isRecord(body) && !hasOwn(body, 'ok')) return { ok: true, data: body, status: status }
  const code = status === 403 ? 'unauthorized_origin' : status === 401 ? 'not_authenticated' : status === 404 ? 'invalid_arguments' : 'http_' + status
  return { ok: false, code: code, message: '', status: status, retryAfterMs: null }
}

function apiRequest(method, path, body, signal) {
  const verb = String(method === undefined || method === null ? 'GET' : method).toUpperCase()
  const params = isRecord(path) ? path.params : undefined
  const url = resolveRequestUrl(path, params)
  const key = requestKeyOf(verb, url)
  abortEntry(inflightRequests.get(key))
  inflightRequests.delete(key)
  if (typeof fetch !== 'function') {
    return Promise.resolve({ ok: false, code: 'fetch_unavailable', message: '', status: 0, retryAfterMs: null })
  }
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const entry = { controller: controller }
  inflightRequests.set(key, entry)
  const headers = { accept: 'application/json' }
  if (verb === 'POST') headers['content-type'] = 'application/json'
  let started = null
  try {
    started = fetch(url, {
      method: verb,
      cache: 'no-store',
      credentials: 'same-origin',
      headers: headers,
      body: verb === 'POST' && body !== undefined && body !== null ? JSON.stringify(body) : undefined,
      signal: signal !== undefined && signal !== null ? signal : controller === null ? undefined : controller.signal,
    })
  } catch (error) {
    inflightRequests.delete(key)
    return Promise.resolve({ ok: false, code: 'fetch_failed', message: '', status: 0, retryAfterMs: null })
  }
  return Promise.resolve(started)
    .then(function (reply) {
      if (reply === null || typeof reply !== 'object') return { ok: false, code: 'fetch_failed', message: '', status: 0, retryAfterMs: null }
      const status = typeof reply.status === 'number' ? reply.status : 0
      if (typeof reply.json !== 'function') return jsonShape(null, status)
      return reply.json().then(
        function (parsed) {
          return jsonShape(parsed, status)
        },
        function () {
          return jsonShape(null, status)
        },
      )
    })
    .then(function (result) {
      if (inflightRequests.get(key) === entry) inflightRequests.delete(key)
      return result
    })
    .catch(function (error) {
      if (inflightRequests.get(key) === entry) inflightRequests.delete(key)
      const aborted = error !== null && typeof error === 'object' && error.name === 'AbortError'
      return { ok: false, code: aborted ? 'aborted' : 'fetch_failed', message: '', status: 0, retryAfterMs: null }
    })
}

//#endregion

//#region Panel-local storage (DESIGN.md 3.5: UI style only, never a session)

function storageAvailable() {
  try {
    return typeof window !== 'undefined' && window.localStorage !== undefined && window.localStorage !== null
  } catch (error) {
    return false
  }
}

function readLocal(key, fallback) {
  if (storageAvailable() !== true) return fallback
  try {
    const stored = window.localStorage.getItem(STORAGE_PREFIX + String(key))
    if (typeof stored !== 'string') return fallback
    try {
      return JSON.parse(stored)
    } catch (error) {
      return stored
    }
  } catch (error) {
    return fallback
  }
}

function writeLocal(key, value) {
  if (storageAvailable() !== true) return
  try {
    if (value === undefined || value === null) {
      window.localStorage.removeItem(STORAGE_PREFIX + String(key))
      return
    }
    let text = String(value)
    try {
      text = JSON.stringify(value)
    } catch (error) {
      text = String(value)
    }
    window.localStorage.setItem(STORAGE_PREFIX + String(key), text)
  } catch (error) {
    // Storage quota or a sandboxed document: panel state stays in memory.
  }
}

function removeLocal(key) {
  if (storageAvailable() !== true) return
  try {
    window.localStorage.removeItem(STORAGE_PREFIX + String(key))
  } catch (error) {
    // Nothing to clean.
  }
}

//#endregion

//#region Panel store

function defaultPanelState() {
  return {
    engineStatus: 'idle',
    host: null,
    configured: null,
    engineAvailable: null,
    connected: false,
    loggedIn: false,
    loginStage: 'idle',
    loginPhone: '',
    selectedChat: null,
    status: 'idle',
    proxy: null,
    diagnostics: null,
    config: null,
    error: null,
    notice: '',
    busy: '',
    updatedAt: 0,
  }
}

function createPanelStore(initial) {
  let state = Object.assign(defaultPanelState(), isRecord(initial) ? initial : {})
  const listeners = new Set()
  function notify() {
    listeners.forEach(function (listener) {
      try {
        listener()
      } catch (error) {
        // One failing subscriber must not stop the others.
      }
    })
  }
  return {
    get: function get() {
      return state
    },
    set: function set(patch) {
      if (isRecord(patch) === false) return state
      state = Object.assign({}, state, patch)
      notify()
      return state
    },
    update: function update(reducer) {
      if (typeof reducer !== 'function') return state
      return this.set(reducer(state))
    },
    subscribe: function subscribe(listener) {
      if (typeof listener !== 'function') return function () {}
      listeners.add(listener)
      return function unsubscribe() {
        listeners.delete(listener)
      }
    },
  }
}

// Subscribe to any `{ getSnapshot, subscribe }` source through one hook whose
// call sequence never changes. The choice between React's
// `useSyncExternalStore` and the local fallback is made once at module load
// (never inside a render), and `useSnapshot` always calls the result exactly
// once — a conditional `useSyncExternalStore` is a Rules-of-Hooks violation
// that React 19 crashes on the first time the branch flips (D1 of the t5
// verification: opening the overlay crashed the `shell.overlay` entry).
function useSnapshotFallback(subscribe, getSnapshot) {
  const version = useState(0)
  useEffect(function () {
    return subscribe(function () {
      version[1](function (current) {
        return current + 1
      })
    })
  }, [subscribe])
  return getSnapshot()
}

const useSnapshotSubscription = typeof useSyncExternalStore === 'function' ? useSyncExternalStore : useSnapshotFallback

function useStore(store) {
  const subscribe = useCallback(function (notify) {
    return store.subscribe(notify)
  }, [store])
  const getSnapshot = useCallback(function () {
    return store.get()
  }, [store])
  return useSnapshotSubscription(subscribe, getSnapshot, getSnapshot)
}

// `enabled === false` keeps the identical hook sequence and only drops the
// subscription: subscribers and readers are inert and the snapshot is null.
// Every hook in this function is called on every render path.
function useSnapshot(source, enabled) {
  const active = enabled !== false
    && source !== null && source !== undefined
    && typeof source.getSnapshot === 'function'
    && typeof source.subscribe === 'function'
  const subscribe = useCallback(function (notify) {
    if (active !== true) return function () {}
    return source.subscribe(notify)
  }, [active, source])
  const getSnapshot = useCallback(function () {
    if (active !== true) return null
    return source.getSnapshot()
  }, [active, source])
  return useSnapshotSubscription(subscribe, getSnapshot, getSnapshot)
}

// `ctx.sessions.list` is an ObservableSnapshot<SessionListState>. The `enabled`
// flag is forwarded so the always-mounted overlay root subscribes only while
// the overlay is open, without changing the hook sequence.
function useSessionsStore(ctx, enabled) {
  const active = enabled !== false
  const sessions = active === true && ctx !== null && ctx !== undefined && typeof ctx.get === 'function' ? ctx.get('sessions') : null
  const list = sessions !== null && typeof sessions === 'object' ? sessions.list : null
  return useSnapshot(list, active)
}

// `ctx.layout.panelInfo` is the public HostObservable<PanelInfo>.
function useActivePanelId(ctx) {
  const layout = ctx !== null && ctx !== undefined && typeof ctx.get === 'function' ? ctx.get('layout') : null
  const info = layout !== null && typeof layout === 'object' ? layout.panelInfo : null
  const snapshot = useSnapshot(info)
  return isRecord(snapshot) && typeof snapshot.activePanelId === 'string' ? snapshot.activePanelId : null
}

//#endregion

//#region Visibility, polling, debouncing (DESIGN-v0.2 7.7)

function documentVisible() {
  try {
    if (typeof document === 'undefined' || document === null) return true
    return document.visibilityState !== 'hidden'
  } catch (error) {
    return true
  }
}

function onVisibilityChange(listener) {
  if (typeof document === 'undefined' || document === null || typeof document.addEventListener !== 'function') {
    return function () {}
  }
  function handler() {
    try {
      listener(documentVisible() === true)
    } catch (error) {
      // A listener failure must not remove the subscription.
    }
  }
  document.addEventListener('visibilitychange', handler)
  return function () {
    try {
      document.removeEventListener('visibilitychange', handler)
    } catch (error) {
      // Document already gone.
    }
  }
}

// Poll while `active` AND the document is visible; stale overlaps are skipped,
// not queued. Returns refresh() for a manual "Retry"/"Refresh".
function usePolling(options) {
  const settings = isRecord(options) ? options : {}
  const active = settings.active !== false
  const intervalMs = clampInt(settings.intervalMs, 1000, 600000, POLL_DIALOGS_MS)
  const runRef = useRef(settings.run)
  runRef.current = settings.run
  const runningRef = useRef(false)
  const refresh = useCallback(function () {
    if (active !== true) return Promise.resolve(null)
    if (documentVisible() !== true) return Promise.resolve(null)
    if (runningRef.current === true) return Promise.resolve(null)
    if (typeof runRef.current !== 'function') return Promise.resolve(null)
    runningRef.current = true
    return Promise.resolve()
      .then(function () {
        return runRef.current()
      })
      .catch(function () {
        return null
      })
      .then(function (value) {
        runningRef.current = false
        return value
      })
  }, [active])
  useEffect(function () {
    if (active !== true) return function () {}
    let timer = null
    function tick() {
      if (documentVisible() !== true) return
      refresh()
    }
    tick()
    if (typeof setInterval === 'function') timer = setInterval(tick, intervalMs)
    const releaseVisibility = onVisibilityChange(function (visible) {
      if (visible === true) refresh()
    })
    return function () {
      if (timer !== null && typeof clearInterval === 'function') clearInterval(timer)
      releaseVisibility()
    }
  }, [active, intervalMs, refresh])
  return refresh
}

// A plain interval hook for flows that are not list fetch loops (QR polling).
function useInterval(callback, intervalMs, active) {
  const callbackRef = useRef(callback)
  callbackRef.current = callback
  useEffect(function () {
    if (active === false) return function () {}
    if (typeof setInterval !== 'function') return function () {}
    const timer = setInterval(function () {
      if (documentVisible() !== true) return
      try {
        callbackRef.current()
      } catch (error) {
        // A tick failure must not stop the interval.
      }
    }, clampInt(intervalMs, 250, 600000, POLL_QR_MS))
    return function () {
      clearInterval(timer)
    }
  }, [intervalMs, active])
}

// [value, setValue, settledValue]: settles `value` after delayMs so a filter or
// a composer draft does not fire a request per keystroke.
function useDebounced(initialValue, delayMs) {
  const wait = clampInt(delayMs, 0, 5000, DEBOUNCE_MS)
  const pair = useState(initialValue)
  const settled = useState(initialValue)
  const timerRef = useRef(null)
  const setValue = useCallback(function (next) {
    pair[1](next)
    if (timerRef.current !== null && typeof clearTimeout === 'function') clearTimeout(timerRef.current)
    if (typeof setTimeout !== 'function') {
      settled[1](next)
      return
    }
    timerRef.current = setTimeout(function () {
      settled[1](next)
    }, wait)
  }, [wait])
  useEffect(function () {
    return function () {
      if (timerRef.current !== null && typeof clearTimeout === 'function') clearTimeout(timerRef.current)
    }
  }, [])
  return [pair[0], setValue, settled[0]]
}

//#endregion

//#region Nested-layer Escape arbitration

// The overlay and every dialog it can open listen for Escape on `document`.
// Registration order would decide who closes first, so each nested layer owns a
// blocker token: while one is held the overlay leaves Escape to that layer.
// The comment window of the selection wave uses the same pair.
const escapeBlockers = new Set()

function pushEscapeBlocker() {
  const token = { active: true }
  escapeBlockers.add(token)
  return function releaseEscapeBlocker() {
    escapeBlockers.delete(token)
  }
}

function hasEscapeBlocker() {
  return escapeBlockers.size > 0
}

//#endregion

//#region Deterministic formatting (DESIGN.md 7.4: no Intl)

function pad2(value) {
  return value < 10 ? '0' + String(value) : String(value)
}

function dateOf(seconds) {
  const parsed = typeof seconds === 'number' ? seconds : Number(seconds)
  if (!isFinite(parsed) || parsed <= 0) return null
  return new Date(parsed * 1000)
}

function startOfLocalDay(date) {
  const copy = new Date(date.getTime())
  copy.setHours(0, 0, 0, 0)
  return copy.getTime()
}

// 'HH:MM' for today, 'DD.MM' for this year, 'DD.MM.YY' for older messages.
function formatTime(seconds, lang) {
  const date = dateOf(seconds)
  if (date === null) return ''
  const clock = pad2(date.getHours()) + ':' + pad2(date.getMinutes())
  const now = new Date()
  if (startOfLocalDay(date) === startOfLocalDay(now)) return clock
  const day = pad2(date.getDate())
  const month = pad2(date.getMonth() + 1)
  if (date.getFullYear() === now.getFullYear()) return day + '.' + month
  return day + '.' + month + '.' + String(date.getFullYear()).slice(-2)
}

function formatDateTime(seconds) {
  const date = dateOf(seconds)
  if (date === null) return ''
  return pad2(date.getDate()) + '.' + pad2(date.getMonth() + 1) + '.' + date.getFullYear() + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes())
}

function dayKeyOf(seconds) {
  const date = dateOf(seconds)
  if (date === null) return 'date'
  const now = new Date()
  const today = startOfLocalDay(now)
  const day = startOfLocalDay(date)
  if (day === today) return 'today'
  if (today - day === 24 * 60 * 60 * 1000) return 'yesterday'
  return 'date'
}

function formatDay(seconds, t) {
  const key = dayKeyOf(seconds)
  const translate = typeof t === 'function' ? t : dictionaryTranslate('en')
  if (key === 'today') return translate('thread.dayToday')
  if (key === 'yesterday') return translate('thread.dayYesterday')
  return formatDateTime(seconds).slice(0, 10)
}

// Bytes with the language's unit names; MediaMeta.sizeBytes may be null.
function formatBytes(value, lang) {
  const bytes = typeof value === 'number' ? value : Number(value)
  if (!isFinite(bytes) || bytes < 0) return ''
  const russian = String(lang === undefined ? 'en' : lang).toLowerCase().slice(0, 2) === 'ru'
  const units = russian ? ['Б', 'КБ', 'МБ', 'ГБ'] : ['B', 'KB', 'MB', 'GB']
  let size = bytes
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size = size / 1024
    unit += 1
  }
  const text = unit === 0 ? String(Math.round(size)) : String(Math.round(size * 10) / 10)
  return text + ' ' + units[unit]
}

// 'm:ss' / 'h:mm:ss' for MediaMeta.durationSec.
function formatDuration(value) {
  const total = typeof value === 'number' ? Math.round(value) : Number(value)
  if (!isFinite(total) || total < 0) return ''
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return String(hours) + ':' + pad2(minutes) + ':' + pad2(seconds)
  return String(minutes) + ':' + pad2(seconds)
}

// Seconds until a unix-ms instant; 0 when it already passed.
function secondsUntil(expiresAt, now) {
  const target = Number(expiresAt)
  const current = typeof now === 'number' ? now : Date.now()
  if (!isFinite(target) || target <= 0) return 0
  return Math.max(0, Math.ceil((target - current) / 1000))
}

function truncate(text, max) {
  const limit = clampInt(max, 1, 100000, LIMITS.textMax)
  const value = typeof text === 'string' ? text : String(text === undefined || text === null ? '' : text)
  if (value.length <= limit) return value
  return value.slice(0, limit) + '\u2026'
}

function initialOf(title) {
  const value = String(title === undefined || title === null ? '' : title).trim()
  if (value === '') return '\u2022'
  const parts = value.split(/\s+/)
  const first = Array.from(parts[0])[0] || ''
  if (parts.length < 2) return first.toUpperCase()
  const second = Array.from(parts[1])[0] || ''
  return (first + second).toUpperCase()
}

function avatarTokenOf(chatId) {
  const value = String(chatId === undefined || chatId === null ? '' : chatId)
  let sum = 0
  for (let index = 0; index < value.length; index += 1) sum += value.charCodeAt(index)
  return 'var(' + AVATAR_TOKENS[sum % AVATAR_TOKENS.length] + ')'
}

//#endregion

//#region Class names

function classNameOf() {
  const parts = []
  for (let index = 0; index < arguments.length; index += 1) {
    const part = arguments[index]
    if (typeof part === 'string') {
      if (part !== '') parts.push(part)
      continue
    }
    if (Array.isArray(part)) {
      for (let inner = 0; inner < part.length; inner += 1) {
        if (typeof part[inner] === 'string' && part[inner] !== '') parts.push(part[inner])
      }
      continue
    }
    if (isRecord(part)) {
      const names = Object.keys(part)
      for (let inner = 0; inner < names.length; inner += 1) {
        if (part[names[inner]] === true) parts.push(names[inner])
      }
    }
  }
  return parts.join(' ')
}

//#endregion
