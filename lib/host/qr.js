/**
 * dsh-telegram — server-side QR matrix rendering (DESIGN-v0.2 9.1, 9.3).
 *
 * GramJS produces the QR payload (`tg://login?token=<base64url>`); the matrix
 * is computed here, on the Host, with `qrcode-generator@2.0.4` (MIT, zero
 * dependencies), so the browser bundle stays free of third-party code and only
 * draws the rows. The matrix is not a secret in itself — it *is* the login
 * token, so it lives in page memory only: never in a log, `/status`, the
 * credential record or `localStorage` (DESIGN-v0.2 9.2).
 *
 * `matrix` is a compact row-major string of `0`/`1` characters, `size * size`
 * long. A 29-module code is 841 characters, which is what DESIGN-v0.2 9.2
 * budgets for.
 *
 * @module dsh-telegram/host/qr
 */

/**
 * @typedef {object} QrMatrix
 * @property {number} size module count per side
 * @property {string} matrix row-major `0`/`1` string, `size * size` characters
 * @property {number} version QR version (1..40)
 * @property {'L' | 'M' | 'Q' | 'H'} errorCorrection
 */

/**
 * Build the QR matrix of a payload. The engine package is loaded lazily: the
 * plugin mounts even when the optional dependency is absent, and `/status`
 * then reports a readable error instead of failing the composition.
 * @param {string} text - payload, normally `tg://login?token=…`
 * @param {{ errorCorrection?: 'L' | 'M' | 'Q' | 'H' }} [options]
 * @returns {Promise<{ ok: true, value: QrMatrix } | { ok: false, error: { code: string, message: string } }>}
 */
export async function buildQrMatrix(text, options = {}) {
  const payload = typeof text === 'string' ? text : ''
  if (payload === '') {
    return { ok: false, error: { code: 'invalid_arguments', message: 'A QR payload is required' } }
  }
  const errorCorrection = ['L', 'M', 'Q', 'H'].includes(options.errorCorrection) ? options.errorCorrection : 'M'
  let qrcode
  try {
    const imported = await import('qrcode-generator')
    qrcode = imported.default ?? imported
  } catch {
    return { ok: false, error: { code: 'engine_unavailable', message: 'The QR renderer package (qrcode-generator) is not installed' } }
  }
  if (typeof qrcode !== 'function') {
    return { ok: false, error: { code: 'engine_unavailable', message: 'The QR renderer package does not expose qrcode()' } }
  }
  try {
    const code = qrcode(0, errorCorrection)
    code.addData(payload)
    code.make()
    const size = code.getModuleCount()
    const rows = new Array(size)
    for (let y = 0; y < size; y += 1) {
      const row = new Array(size)
      for (let x = 0; x < size; x += 1) row[x] = code.isDark(y, x) === true ? '1' : '0'
      rows[y] = row.join('')
    }
    return { ok: true, value: { size, matrix: rows.join(''), version: 0, errorCorrection } }
  } catch (error) {
    const message = error instanceof Error && typeof error.message === 'string' ? error.message : 'The QR payload could not be rendered'
    return { ok: false, error: { code: 'internal_error', message } }
  }
}
