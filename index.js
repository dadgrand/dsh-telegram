/**
 * dsh-telegram — Host entry point (DESIGN.md 3.1, DESIGN-v0.2 8).
 *
 * One Cordis row (`telegram`) mounts four resources, each inside its own
 * `ctx.effect` so unmounting the row releases it:
 *
 *   1. the Telegram session engine (`lib/host/telegram/client.js`): GramJS over
 *      MTProto, a credential-record session, the QR/phone sign-in machine and a
 *      bounded, proxy-aware connection;
 *   2. thirteen loopback JSON routes under `/api/dsh-telegram` for the browser
 *      panel (`lib/host/routes.js`);
 *   3. the `telegram` agent tool (`lib/host/tool.js`), registered on a
 *      `ctx.inject(['tools'], …)` child so a profile without the tool registry
 *      still mounts the plugin (DESIGN-v0.2 8.4);
 *   4. the config schema (`Config`), validated by Cordis against the row's
 *      `config` block; every field has a default, so a row without `config`
 *      mounts and reports `not_configured`.
 *
 * No core edits, no second server, no files outside the plugin directory. The
 * browser half is a separate bundle declared through `dsh.client` and built by
 * `scripts/build-client.mjs`.
 *
 * @module dsh-telegram
 */

import { Config, resolveConfig } from './lib/host/config.js'
import { createHostApi } from './lib/host/routes.js'
import { createTelegramHost } from './lib/host/telegram/client.js'
import { registerTelegramTool } from './lib/host/tool.js'

/** Package version reported by `/status`; must equal `package.json.version`. */
export const VERSION = '0.2.1'

/** Canonical plugin id: the module name, the bundle row's `name` and the client module id. */
export const name = 'dsh-telegram'

/** The browser HTTP carrier and the credential seam are required. */
export const inject = ['webServer', 'credentials']

export { Config }

/**
 * Register the Telegram engine, routes and agent tool.
 * @param {any} ctx - host root context (needs `webServer` and `credentials`)
 * @param {object} [config] - bundle-row config; every field has a default
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config)
  if (resolved.issues.length > 0) {
    // Cordis refuses the mount before `apply` for an invalid Standard Schema;
    // this branch only keeps a directly-called `apply` honest.
    throw new Error(`dsh-telegram: invalid config: ${resolved.issues.map((issue) => issue.message).join('; ')}`)
  }
  const host = createTelegramHost({ ctx, config: resolved.value })

  ctx.effect(() => () => {
    try {
      host.dispose()
    } catch {
      // The engine is being dropped anyway.
    }
  }, 'dsh-telegram: connection')

  const api = createHostApi({ version: VERSION, config: resolved.value, host })
  for (const route of api.routes) {
    ctx.effect(() => {
      const dispose = ctx.webServer.register({ kind: route.kind === 'prefix' ? 'prefix' : 'exact', path: route.path, handler: route.handler })
      return () => {
        try {
          dispose()
        } catch {
          // The route fiber is already gone during shutdown.
        }
      }
    }, `dsh-telegram: ${route.method} ${route.path}`)
  }

  // Optional on purpose (DESIGN-v0.2 8.4): a profile without the tool registry
  // still mounts the panel half.
  ctx.effect(() => {
    const fiber = ctx.inject(['tools'], (toolCtx) => {
      toolCtx.effect(() => registerTelegramTool(toolCtx, { host }), 'dsh-telegram: agent tool')
    })
    return () => {
      try {
        fiber.dispose()
      } catch {
        // Already gone.
      }
    }
  }, 'dsh-telegram: agent tool scope')
}
