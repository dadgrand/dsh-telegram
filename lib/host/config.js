/**
 * dsh-telegram plugin configuration: defaults and validation (DESIGN.md 3.1,
 * DESIGN-v0.2 8.2).
 *
 * `Config` is declared as a Standard Schema — the interface Cordis validates
 * with `Config['~standard'].validate` — instead of importing
 * `@deepseek-ai/schemastery`: a local plugin is mounted from its own directory,
 * where the Host's dependency tree is not resolvable, and this plugin keeps
 * zero extra runtime dependencies. A plain object is not an acceptable `Config`
 * (DSH docs user/develop/basic/config.md).
 *
 * Every field has a default, so the bundle row of `cordis.patch.yml` mounts even
 * with no `config` block at all: `apiId: 0` and `apiHash: ''` mean "not
 * configured", and every surface reports the `not_configured` state instead of
 * failing the composition.
 *
 * A malformed block refuses the mount with one issue per offending field.
 * Issue text names the field only — never a value — because `apiHash`,
 * `apiHashRef`, the proxy credentials and the phone number are secrets
 * (DESIGN 3.2).
 *
 * Proxy precedence (DESIGN-v0.2 10.2): a non-`direct` Config wins; otherwise
 * `DSH_TELEGRAM_PROXY` is parsed; otherwise `direct`. The env value is read by
 * `lib/host/proxy.js`, never echoed into a DTO or a log line.
 *
 * @module dsh-telegram/host/config
 */

/** Plugin defaults; also the documented surface of the bundle row (DESIGN 8.2). */
export const CONFIG_DEFAULTS = Object.freeze({
  /** apiId from https://my.telegram.org/apps. 0 means "not configured". */
  apiId: 0,
  /** apiHash literal. Empty means "not configured"; prefer apiHashRef. Secret. */
  apiHash: '',
  /** Name of a credential record holding the apiHash; wins over `apiHash`. */
  apiHashRef: '',
  /** Prefill of the phone field in the sign-in form, E.164. Not used alone. */
  defaultPhone: '',
  /** Upper bound of one connection attempt in `ensureConnected`. */
  connectionTimeoutMs: 20_000,
  /** Ceiling of `list_chats` and `/dialogs`. */
  dialogLimit: 30,
  /** Ceiling of `get_messages` and `/messages`. */
  messageLimit: 25,
  /** Ceiling of `search` and `/search`. */
  searchLimit: 10,
  /** Ceiling of one outgoing message text (GramJS limit is 4096 characters). */
  textMaxLength: 4096,
  /** Ceiling of a POST request body in bytes. */
  bodyMaxBytes: 65_536,
  /** Sign-in attempt TTL; every fresh QR token refreshes it (DESIGN-v0.2 9.2). */
  authTimeoutMs: 180_000,
  /** Proxy mode: `direct`, `socks5` or `mtproxy` (DESIGN-v0.2 10.2). */
  proxyMode: 'direct',
  /** Proxy host. */
  proxyHost: '127.0.0.1',
  /** Proxy port. */
  proxyPort: 1080,
  /** SOCKS5 user name. Never logged. */
  proxyUser: '',
  /** Credential reference holding the SOCKS5 password. Never logged. */
  proxyPasswordRef: '',
  /** Credential reference holding the MTProxy secret. Never logged. */
  proxySecretRef: '',
  /** SOCKS/MTProxy handshake timeout in seconds. */
  proxyTimeoutSec: 8,
  /** TCP preflight budget of the proxy endpoint in milliseconds. */
  proxyPreflightMs: 1_500,
  /** Host-side clamp of selected objects in a prompt (DESIGN-v0.2 5.4). */
  selectionMaxObjects: 12,
  /** Host-side clamp of characters per selected object. */
  selectionTextPerObject: 500,
  /** Host-side clamp of the whole prompt. */
  promptMaxChars: 6_000,
  /** Host-side clamp of the user's comment. */
  noteMaxChars: 2_000,
  /** Default prompt delivery mode: append a turn or interrupt the running one. */
  sendMode: 'queue',
})

/** Largest apiId Telegram issues (a signed 32-bit id). */
const API_ID_MAX = 2_147_483_647

/** The only accepted proxy modes. */
const PROXY_MODES = Object.freeze(['direct', 'socks5', 'mtproxy'])

/** The only accepted prompt delivery modes. */
const SEND_MODES = Object.freeze(['queue', 'steer'])

/**
 * Read an integer field; an out-of-range or non-integer value falls back to the
 * default and is reported as an issue.
 * @param {unknown} raw - the raw value
 * @param {string} key - field name, used in the issue text only
 * @param {number} fallback - default
 * @param {number} min - lower bound
 * @param {number} max - upper bound
 * @param {Array<{ message: string, path: string[] }>} issues - issue sink
 * @returns {number} accepted value
 */
function readInteger(raw, key, fallback, min, max, issues) {
  if (raw === undefined || raw === null || raw === '') return fallback
  const value = typeof raw === 'number' ? raw : Number(String(raw).trim())
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max) {
    issues.push({ message: `${key} must be an integer between ${min} and ${max}`, path: [key] })
    return fallback
  }
  return value
}

/**
 * Read a string field. The value is never echoed into an issue: apiHash,
 * apiHashRef and the phone number are secrets.
 * @param {unknown} raw - the raw value
 * @param {string} key - field name
 * @param {string} fallback - default
 * @param {Array<{ message: string, path: string[] }>} issues - issue sink
 * @returns {string} accepted value
 */
function readString(raw, key, fallback, issues) {
  if (raw === undefined || raw === null) return fallback
  if (typeof raw !== 'string') {
    issues.push({ message: `${key} must be a string`, path: [key] })
    return fallback
  }
  return raw
}

/**
 * Read one enum field.
 * @param {unknown} raw - raw value
 * @param {string} key - field name
 * @param {readonly string[]} allowed - accepted values
 * @param {string} fallback - default
 * @param {Array<{ message: string, path: string[] }>} issues - issue sink
 * @returns {string} accepted value
 */
function readEnum(raw, key, allowed, fallback, issues) {
  if (raw === undefined || raw === null || raw === '') return fallback
  if (typeof raw !== 'string' || allowed.includes(raw) === false) {
    issues.push({ message: `${key} must be one of: ${allowed.join(', ')}`, path: [key] })
    return fallback
  }
  return raw
}

/**
 * Validate and normalize the `config` block of the bundle row.
 * @param {unknown} raw - the row's `config` value
 * @returns {{ value: object, issues: Array<{ message: string, path: string[] }> }} normalized config and issues
 */
export function resolveConfig(raw) {
  const issues = []
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    issues.push({ message: 'config must be an object of telegram settings', path: [] })
  }
  const value = {
    apiId: readInteger(source.apiId, 'apiId', CONFIG_DEFAULTS.apiId, 0, API_ID_MAX, issues),
    apiHash: readString(source.apiHash, 'apiHash', CONFIG_DEFAULTS.apiHash, issues),
    apiHashRef: readString(source.apiHashRef, 'apiHashRef', CONFIG_DEFAULTS.apiHashRef, issues),
    defaultPhone: readString(source.defaultPhone, 'defaultPhone', CONFIG_DEFAULTS.defaultPhone, issues),
    connectionTimeoutMs: readInteger(source.connectionTimeoutMs, 'connectionTimeoutMs', CONFIG_DEFAULTS.connectionTimeoutMs, 1_000, 120_000, issues),
    dialogLimit: readInteger(source.dialogLimit, 'dialogLimit', CONFIG_DEFAULTS.dialogLimit, 1, 100, issues),
    messageLimit: readInteger(source.messageLimit, 'messageLimit', CONFIG_DEFAULTS.messageLimit, 1, 100, issues),
    searchLimit: readInteger(source.searchLimit, 'searchLimit', CONFIG_DEFAULTS.searchLimit, 1, 50, issues),
    textMaxLength: readInteger(source.textMaxLength, 'textMaxLength', CONFIG_DEFAULTS.textMaxLength, 1, 4096, issues),
    bodyMaxBytes: readInteger(source.bodyMaxBytes, 'bodyMaxBytes', CONFIG_DEFAULTS.bodyMaxBytes, 1_024, 262_144, issues),
    authTimeoutMs: readInteger(source.authTimeoutMs, 'authTimeoutMs', CONFIG_DEFAULTS.authTimeoutMs, 30_000, 600_000, issues),
    proxyMode: readEnum(source.proxyMode, 'proxyMode', PROXY_MODES, CONFIG_DEFAULTS.proxyMode, issues),
    proxyHost: readString(source.proxyHost, 'proxyHost', CONFIG_DEFAULTS.proxyHost, issues),
    proxyPort: readInteger(source.proxyPort, 'proxyPort', CONFIG_DEFAULTS.proxyPort, 1, 65_535, issues),
    proxyUser: readString(source.proxyUser, 'proxyUser', CONFIG_DEFAULTS.proxyUser, issues),
    proxyPasswordRef: readString(source.proxyPasswordRef, 'proxyPasswordRef', CONFIG_DEFAULTS.proxyPasswordRef, issues),
    proxySecretRef: readString(source.proxySecretRef, 'proxySecretRef', CONFIG_DEFAULTS.proxySecretRef, issues),
    proxyTimeoutSec: readInteger(source.proxyTimeoutSec, 'proxyTimeoutSec', CONFIG_DEFAULTS.proxyTimeoutSec, 1, 60, issues),
    proxyPreflightMs: readInteger(source.proxyPreflightMs, 'proxyPreflightMs', CONFIG_DEFAULTS.proxyPreflightMs, 200, 10_000, issues),
    selectionMaxObjects: readInteger(source.selectionMaxObjects, 'selectionMaxObjects', CONFIG_DEFAULTS.selectionMaxObjects, 1, 50, issues),
    selectionTextPerObject: readInteger(source.selectionTextPerObject, 'selectionTextPerObject', CONFIG_DEFAULTS.selectionTextPerObject, 50, 4_000, issues),
    promptMaxChars: readInteger(source.promptMaxChars, 'promptMaxChars', CONFIG_DEFAULTS.promptMaxChars, 200, 20_000, issues),
    noteMaxChars: readInteger(source.noteMaxChars, 'noteMaxChars', CONFIG_DEFAULTS.noteMaxChars, 100, 2_000, issues),
    sendMode: readEnum(source.sendMode, 'sendMode', SEND_MODES, CONFIG_DEFAULTS.sendMode, issues),
  }
  // A phone prefill must at least look like a number; the sign-in form re-checks
  // the exact E.164 shape and reports `auth_phone_invalid` on the request itself.
  if (value.defaultPhone !== '' && !/^\+?[0-9]{6,15}$/.test(value.defaultPhone)) {
    issues.push({ message: 'defaultPhone must be an E.164 phone number, for example +79001234567', path: ['defaultPhone'] })
    value.defaultPhone = CONFIG_DEFAULTS.defaultPhone
  }
  return { value, issues }
}

/**
 * Plugin config schema in the Standard Schema shape Cordis validates with
 * (DESIGN 3.1.1). Deliberately plain — no `toJSON()`, so the Host's settings-form
 * projection skips this row instead of failing on a foreign schema shape.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-telegram',
    validate(raw) {
      const { value, issues } = resolveConfig(raw)
      if (issues.length > 0) return { issues }
      return { value }
    },
  },
}
