#!/usr/bin/env node
/**
 * Static package checks for dsh-telegram (DESIGN-v0.2 11.2).
 *
 * No bundler and no test framework: this script only reads files and asserts the
 * manifest contract that DSH's plugin loader and the plugin manager rely on.
 * Exit code 0 means the package is shippable.
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const failures = []

function check(condition, message) {
  if (!condition) failures.push(message)
}

function readJson(relative) {
  const file = path.join(ROOT, relative)
  check(existsSync(file), `${relative} is missing`)
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    failures.push(`${relative} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    return {}
  }
}

const pkg = readJson('package.json')

check(pkg.name === 'dsh-telegram', 'package.json name must be dsh-telegram')
check(typeof pkg.version === 'string' && /^\d+\.\d+\.\d+/.test(pkg.version), 'package.json version must be semver')
check(pkg.type === 'module', 'package.json type must be module')
check(existsSync(path.join(ROOT, 'index.js')), 'index.js is missing')
check(existsSync(path.join(ROOT, 'lib', 'client.js')), 'lib/client.js is missing (run scripts/build-client.mjs)')
check(existsSync(path.join(ROOT, 'lib', 'client-src')), 'lib/client-src/ is missing')
check(existsSync(path.join(ROOT, 'cordis.patch.yml')), 'cordis.patch.yml is missing')
check(existsSync(path.join(ROOT, 'icon.svg')), 'icon.svg is missing')

check(pkg.dsh !== undefined && pkg.dsh.bundle !== undefined && pkg.dsh.bundle.patch === './cordis.patch.yml', 'dsh.bundle.patch must be ./cordis.patch.yml')
check(pkg.dsh !== undefined && pkg.dsh.client !== undefined && pkg.dsh.client.platform === 'web', 'dsh.client.platform must be web')
check(pkg.exports !== undefined && pkg.exports['./client'] === './lib/client.js', 'exports["./client"] must be ./lib/client.js')
check(pkg.exports !== undefined && pkg.exports['.'] === './index.js', 'exports["."] must be ./index.js')
check(pkg.exports !== undefined && pkg.exports['./package.json'] === './package.json', 'exports["./package.json"] is missing')
check(pkg.exports !== undefined && pkg.exports['./cordis.patch.yml'] === './cordis.patch.yml', 'exports["./cordis.patch.yml"] is missing')
check(Array.isArray(pkg.files), 'package.json files must be an array')
for (const entry of ['index.js', 'lib/client.js', 'scripts/build-client.mjs', 'cordis.patch.yml', 'locale/en.json', 'locale/ru.json']) {
  check(Array.isArray(pkg.files) && pkg.files.includes(entry), `files must include ${entry}`)
}
check(pkg.engines !== undefined && typeof pkg.engines.dsh === 'string' && pkg.engines.dsh.trim() !== '', 'engines.dsh must be a non-empty range')
check(pkg.dependencies !== undefined && pkg.dependencies.telegram === '2.26.22', 'dependencies.telegram must be pinned to 2.26.22')
check(pkg.dependencies !== undefined && typeof pkg.dependencies['qrcode-generator'] === 'string', 'dependencies.qrcode-generator is missing')
check(pkg.private !== true, 'package.json must not be private (it is published to GitHub/npm)')

const en = readJson('locale/en.json')
const ru = readJson('locale/ru.json')
const enKeys = Object.keys(en).sort()
const ruKeys = Object.keys(ru).sort()
check(enKeys.length === ruKeys.length && enKeys.every((key, index) => key === ruKeys[index]), 'locale/en.json and locale/ru.json must have identical key sets')
check(typeof en.meta?.title === 'string' && typeof en.meta?.description === 'string', 'locale/en.json must declare meta.title/description')
check(typeof ru.meta?.title === 'string' && typeof ru.meta?.description === 'string', 'locale/ru.json must declare meta.title/description')

const indexSource = readFileSync(path.join(ROOT, 'index.js'), 'utf8')
check(/export const name = 'dsh-telegram'/.test(indexSource), "index.js must export name = 'dsh-telegram'")
check(/export function apply\(/.test(indexSource), 'index.js must export apply()')
check(/export \{ Config \}/.test(indexSource), 'index.js must re-export Config')
check(indexSource.includes("inject = ['webServer', 'credentials']"), 'index.js must inject webServer and credentials')

const patch = existsSync(path.join(ROOT, 'cordis.patch.yml')) ? readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8') : ''
check(/^- insert:/m.test(patch), 'cordis.patch.yml must contain one insert list')
check(/name: 'dsh-telegram'/.test(patch), "cordis.patch.yml row must name 'dsh-telegram'")
check(/apiHash: ''/.test(patch), 'cordis.patch.yml must not ship a real apiHash')

if (failures.length > 0) {
  process.stderr.write('check-package: FAILED\n')
  for (const failure of failures) process.stderr.write(`  - ${failure}\n`)
  process.exit(1)
}
process.stdout.write(`check-package: OK (${pkg.name}@${pkg.version}, ${enKeys.length} locale keys)\n`)
