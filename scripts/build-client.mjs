#!/usr/bin/env node
/**
 * Build `lib/client.js` from `lib/client-src/*.js` (DESIGN.md 6.3,
 * DESIGN-v0.2 3.2).
 *
 * The bundle format is the shipped DSH one: a `window.__ModuleLoader__.load({
 * id, factory(require) })` call whose factory receives the baseline `react`
 * module and returns `{ inject, apply }`. No bundler, no JSX, no imports of
 * Harness client packages.
 *
 * Steps:
 *   1. enumerate `lib/client-src/^\d\d-[a-z-]+\.js$`, sorted lexicographically;
 *      a missing expected fragment fails the build (this script never creates one);
 *   2. apply the fragment gate to every line at column 0: declarations
 *      (`const`/`let`/`function`/`class`), comments, closing punctuation and the
 *      closing backtick of a template literal are allowed; `import`, `export`,
 *      top-level `return`/`throw`/`await`, statement expressions and calls are not;
 *   3. `node --check` every fragment;
 *   4. read `locale/en.json` and `locale/ru.json`, require identical key sets and
 *      inject `const DICT = { en, ru }` right after 00-constants.js;
 *   5. concatenate header + fragments + footer, write `lib/client.js`;
 *   6. require every exported component/helper name to be declared, then
 *      `node --check lib/client.js`.
 *
 * Exit code 0 means the bundle exists and is syntactically valid.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SRC_DIR = path.join(ROOT, 'lib', 'client-src')
const OUT_FILE = path.join(ROOT, 'lib', 'client.js')

const FRAGMENT_PATTERN = /^\d\d-[a-z-]+\.js$/
const EXPECTED_FRAGMENTS = [
  '00-constants.js',
  '10-utils.js',
  '15-overlay.js',
  '20-panel.js',
  '30-chatlist.js',
  '40-thread.js',
  '50-composer.js',
  '55-profile.js',
  '60-login.js',
  '65-selection.js',
  '68-comment.js',
  '70-styles.js',
  '90-register.js',
]

// Names later fragments call. The build fails when one disappears, so a renamed
// component cannot silently degrade to a placeholder at runtime.
const REQUIRED_NAMES = [
  'NS',
  'OVERLAY_ID',
  'OVERLAY_ORDER',
  'API_BASE',
  'ROUTES',
  'LIMITS',
  'STORAGE_PREFIX',
  'POLL_STATUS_MS',
  'POLL_DIALOGS_MS',
  'POLL_THREAD_MS',
  'POLL_QR_MS',
  'dictionaryTranslate',
  'boundTranslate',
  'apiUrl',
  'apiRequest',
  'abortRequests',
  'readLocal',
  'writeLocal',
  'formatTime',
  'truncate',
  'classNameOf',
  'documentVisible',
  'useSnapshot',
  'useSessionsStore',
  'useActivePanelId',
  'useInterval',
  'createPanelStore',
  'pushEscapeBlocker',
  'hasEscapeBlocker',
  'OverlayRoot',
  'Launcher',
  'useOverlayState',
  'useLauncherHealth',
  'OverlaySelectionBar',
  'OverlayToolbar',
  'SelectionChip',
  'useSelection',
  'selectionRefOfDescriptor',
  'selectionChipLabel',
  'serializeSelection',
  'buildPrompt',
  'hitTest',
  'collectSelectionHits',
  'selectionBandRect',
  'activeSessionOf',
  'useActiveSession',
  'sendPromptToSession',
  'CommentDialog',
  'TelegramPanel',
  'PanelErrorBoundary',
  'ChatList',
  'Thread',
  'Composer',
  'ProfileScreen',
  'LoginScreen',
  'applyClientModule',
]

const HEADER = `window.__ModuleLoader__.load({
  id: 'dsh-telegram',
  factory(require) {
    'use strict'
    const React = require('react')
    const h = React.createElement
`

const FOOTER = `    return { inject: ['slots', 'locale', 'sessions'], apply: applyClientModule }
  },
})
`

function fail(message) {
  process.stderr.write(`build-client: ${message}\n`)
  process.exit(1)
}

function checkSyntax(file) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' })
  if (result.status !== 0) fail(`node --check failed for ${path.relative(ROOT, file)}`)
}

/** The column-0 gate of DESIGN.md 6.2(б), widened to closing punctuation. */
function gateFragment(name, source) {
  const lines = source.split('\n')
  const allowed = /^(const |let |function |class |\/\/|\/\*|\*|\s*$|[})\]])/
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === '') continue
    if (/^\s/.test(line)) continue
    if (line === '`') continue
    if (allowed.test(line)) continue
    fail(`${name}:${index + 1} is a top-level statement outside the fragment rule: ${line.slice(0, 120)}`)
  }
  const first = lines.find((line) => line.trim() !== '')
  if (first !== undefined && /^(import|export)\b/.test(first.trim())) {
    fail(`${name}: a fragment must not import or export`)
  }
}

function readLocale(name) {
  const file = path.join(ROOT, 'locale', name)
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    fail(`cannot read ${path.relative(ROOT, file)}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) fail(`${name} must be a JSON object`)
  const meta = parsed.meta
  if (meta === null || typeof meta !== 'object' || typeof meta.title !== 'string' || typeof meta.description !== 'string') {
    fail(`${name} must declare meta.title and meta.description (Plugin Manager card)`)
  }
  return parsed
}

function main() {
  let entries
  try {
    entries = readdirSync(SRC_DIR)
  } catch {
    fail(`missing directory ${path.relative(ROOT, SRC_DIR)}`)
  }
  const fragments = entries.filter((name) => FRAGMENT_PATTERN.test(name)).sort()
  for (const expected of EXPECTED_FRAGMENTS) {
    if (fragments.includes(expected) === false) fail(`missing fragment ${expected}`)
  }
  if (fragments.length === 0) fail('no fragments found')

  const sources = []
  for (const fragment of fragments) {
    const file = path.join(SRC_DIR, fragment)
    const source = readFileSync(file, 'utf8')
    gateFragment(fragment, source)
    checkSyntax(file)
    sources.push({ name: fragment, source: source.endsWith('\n') ? source : source + '\n' })
  }

  const en = readLocale('en.json')
  const ru = readLocale('ru.json')
  const enKeys = Object.keys(en).sort()
  const ruKeys = Object.keys(ru).sort()
  if (enKeys.length !== ruKeys.length || enKeys.some((key, index) => key !== ruKeys[index])) {
    fail('locale/en.json and locale/ru.json must have identical key sets')
  }

  const chunks = [HEADER]
  for (const fragment of sources) {
    chunks.push(`// ---- ${fragment.name} ----\n`)
    chunks.push(fragment.source)
    if (fragment.name === '00-constants.js') {
      chunks.push('\n// Generated from locale/en.json and locale/ru.json by scripts/build-client.mjs.\n')
      chunks.push(`const DICT = ${JSON.stringify({ en: en, ru: ru }, null, 2)}\n\n`)
    }
  }
  chunks.push(FOOTER)
  const bundle = chunks.join('')

  for (const name of REQUIRED_NAMES) {
    const declaration = new RegExp(`(?:const|let|function|class)\\s+${name}\\b`)
    if (declaration.test(bundle) === false) fail(`required name "${name}" is not declared by any fragment`)
  }

  writeFileSync(OUT_FILE, bundle)
  checkSyntax(OUT_FILE)
  process.stdout.write(`build-client: wrote ${path.relative(ROOT, OUT_FILE)} (${bundle.length} bytes, ${sources.length} fragments)\n`)
}

main()
