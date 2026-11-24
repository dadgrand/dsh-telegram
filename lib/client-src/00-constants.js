// 00-constants.js — constants shared by every fragment of the dsh-telegram
// browser bundle (DESIGN-v0.2 3.2, DESIGN.md 6.2).
//
// Fragment rule: the top level holds declarations only (const / let / function /
// class) plus comments. No import, no export, no top-level return/throw/await,
// no statement expressions, no 'use strict' (the generator header carries it).
//
// The generator inserts `const DICT = { en: <locale/en.json>, ru: … }` right
// after this fragment, so the offline dictionary and the shipped locale files are
// the same bytes by construction. Referencing `DICT` from 10-utils is guarded by
// `typeof DICT`, which keeps every fragment readable standalone.
//
// The React hooks derived here come from the generator header `const React =
// require('react')`; a fragment must never redeclare React or h.

const NS = 'dsh-telegram'
// The single root entry id used by the overlay launcher registration (t3).
const OVERLAY_ID = 'dsh-telegram.launcher'
const OVERLAY_ORDER = 900
const PANEL_ID = 'telegram'
const API_BASE = '/api/dsh-telegram'

// Client-side ceilings; the Host clamps every request to its own Config too.
const LIMITS = Object.freeze({
  dialogs: 30,
  messages: 25,
  search: 10,
  textMax: 4096,
  phoneMax: 15,
  queryMax: 256,
  // Client ceiling of the selection. The t4 contract names a limit "for
  // example 50"; DESIGN-v0.2 5.4's 12 stays the Host Config default that
  // /status advertises (`selectionMaxObjects` in lib/host/config.js) — the
  // client no longer truncates a marquee at 12. Overflow is always marked,
  // never silent (selection.limitWarning / selection.limitFull).
  selectionMaxObjects: 50,
  selectionTextPerObject: 500,
  // A region selects an object when the overlap covers this share of the
  // smaller rectangle (DESIGN-v0.2 5.3).
  selectionMinHitRatio: 0.3,
  promptMaxChars: 6000,
  noteMaxChars: 2000,
})

// localStorage keys for panel-local UI style only (DESIGN.md 3.5: never a
// session, a token or a phone number).
const STORAGE_PREFIX = 'dsh-telegram.'
const STORAGE_CHAT = 'chat'
const STORAGE_DRAFT = 'draft.'
const STORAGE_FILTER = 'filter.'

// Polling and interaction timing (DESIGN-v0.2 7.7).
const POLL_STATUS_MS = 12000
const POLL_DIALOGS_MS = 15000
const POLL_THREAD_MS = 4000
const POLL_QR_MS = 2000
const DEBOUNCE_MS = 150
const TOAST_MS = 4000
const SKELETON_DELAY_MS = 250
const AUTH_TTL_HINT_MS = 180000

// Route table mirrors DESIGN-v0.2 8.3; apiUrl prefixes API_BASE.
const ROUTES = Object.freeze({
  status: '/status',
  dialogs: '/dialogs',
  messages: '/messages',
  send: '/send',
  read: '/read',
  search: '/search',
  profile: '/profile',
  loginQrStart: '/login/qr/start',
  loginQrState: '/login/qr/state',
  loginVerify: '/login/verify',
  loginPhoneStart: '/login/phone/start',
  loginState: '/login/state',
  logout: '/logout',
})

// HostState.loginStage values (DESIGN-v0.2 9.2).
const LOGIN_STAGES = Object.freeze([
  'idle',
  'awaiting_phone',
  'code_sent',
  'qr_waiting',
  'awaiting_2fa',
  'connected',
  'failed',
])

// MediaMeta.kind values (DESIGN.md 3.6); keys 'thread.media.<kind>'.
const MEDIA_KINDS = Object.freeze([
  'photo',
  'video',
  'document',
  'audio',
  'voice',
  'videoNote',
  'sticker',
  'gif',
  'geo',
  'contact',
  'poll',
  'other',
])

// error.code values the Host may return; used only to pick 'error.<code>'.
const ERROR_CODES = Object.freeze([
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

// Store keys of the panel store (10-utils.createPanelStore).
const STORE_KEYS = Object.freeze([
  'engineStatus',
  'host',
  'configured',
  'engineAvailable',
  'connected',
  'loggedIn',
  'loginStage',
  'loginPhone',
  'selectedChat',
  'error',
  'notice',
  'busy',
  'updatedAt',
])

// React hooks derived from the generator header `React`.
const useState = React.useState
const useEffect = React.useEffect
const useRef = React.useRef
const useMemo = React.useMemo
const useCallback = React.useCallback
const useLayoutEffect = React.useLayoutEffect
const useSyncExternalStore = typeof React.useSyncExternalStore === 'function' ? React.useSyncExternalStore : null

// Monogram palette for chat avatars: every entry is a theme token, so light and
// dark follow the DSH theme without a literal colour (DESIGN.md 7.2).
const AVATAR_TOKENS = Object.freeze([
  '--dsw-alias-state-business-primary',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-warn-primary',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-border-selected',
  '--dsw-alias-label-secondary',
])
