/**
 * dsh-telegram — the `telegram` agent tool (DESIGN.md 4, DESIGN-v0.2 8.4).
 *
 * Registered as a raw `ToolDefinition` through `ctx.tools.register`: the
 * plugin's linked checkout cannot resolve `@deepseek-ai/dsh-tools`
 * (RESEARCH-FINDINGS 2.9), and the raw shape is exactly what the registry takes
 * (`dsh-tools/src/index.ts:128-151`, type `src/contracts.ts:27-40`).
 *
 * The tool is read/send only. It has no action that grants or confirms
 * authority: no login, verification, logout, delete, edit, forward or pin
 * (DESIGN 4.5). Signing in is a user-only path through the panel.
 *
 * Every failure is a value, never an exception: `{ ok:false, action, error }`
 * with a code from `ERROR_CODES`. Secrets never enter arguments, values or error
 * messages.
 *
 * @module dsh-telegram/host/tool
 */

import { ERROR_CODES, AGENT_ERROR_CODES, fail, isFail, ok } from './telegram/errors.js'
import { getChat, listChats } from './telegram/chats.js'
import { getMessages, markRead, sendText } from './telegram/messages.js'
import { searchMessages } from './telegram/search.js'
import { getProfile } from './telegram/profile.js'

/** The complete action vocabulary of the tool (DESIGN 4.2). */
export const TELEGRAM_ACTIONS = Object.freeze([
  'status',
  'whoami',
  'list_chats',
  'get_chat',
  'get_messages',
  'send_message',
  'mark_read',
  'search',
])

/** Actions that only read; they may run concurrently with sibling calls. */
const READ_ACTIONS = new Set(['status', 'whoami', 'list_chats', 'get_chat', 'get_messages', 'search'])

/**
 * Raw JSON Schema of the arguments (standard JSON Schema understood by the model
 * runtime; `defineTool` is not used here on purpose, DESIGN-v0.2 8.4).
 */
const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: {
      type: 'string',
      enum: TELEGRAM_ACTIONS,
      description: 'Telegram operation to perform.',
    },
    chat_id: {
      type: 'string',
      description: 'Chat id from list_chats. Required for get_chat, get_messages, send_message, mark_read and chat-scoped search.',
    },
    text: {
      type: 'string',
      description: 'Message text. Required for send_message. Max 4096 characters.',
    },
    limit: {
      type: 'integer',
      description: 'Result size. list_chats 1-30 (default 30), get_messages 1-100 (default 25), search 1-50 (default 10).',
    },
    before: {
      type: 'integer',
      description: 'get_messages only: return messages older than this message id (exclusive).',
    },
    query: {
      type: 'string',
      description: 'Search text. Required for search.',
    },
    up_to: {
      type: 'integer',
      description: 'mark_read only: acknowledge through this message id.',
    },
  },
}

/** Canonical output shape: a success value or a contract failure (DESIGN 4.4). */
const OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['ok', 'action', 'result'],
      properties: {
        ok: { type: 'boolean', const: true },
        action: { type: 'string', enum: TELEGRAM_ACTIONS },
        result: {},
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['ok', 'action', 'error'],
      properties: {
        ok: { type: 'boolean', const: false },
        action: { type: 'string', enum: TELEGRAM_ACTIONS },
        error: {
          type: 'object',
          additionalProperties: false,
          required: ['code', 'message'],
          properties: {
            code: { type: 'string', enum: AGENT_ERROR_CODES },
            message: { type: 'string' },
          },
        },
      },
    },
  ],
}

/** Codes the tool itself can emit without an operation; kept for the contract. */
export const TOOL_ERROR_CODES = Object.freeze(ERROR_CODES.filter((code) => code !== 'unauthorized_origin' && code !== 'body_too_large'))

/**
 * Read a string argument.
 * @param {any} value - raw argument
 * @returns {string} trimmed string, `''` for anything else
 */
function stringArg(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Read an optional non-negative integer argument.
 * @param {any} value - raw argument
 * @returns {number | null} integer or null when absent/invalid
 */
function integerArg(value) {
  if (value === undefined || value === null) return null
  return Number.isInteger(value) && value >= 0 ? value : null
}

/**
 * The tool value for a failure.
 * @param {string} action - requested action
 * @param {{ ok: false, error: { code: string, message: string } }} failure - contract failure
 * @returns {object} tool value
 */
function toolFailure(action, failure) {
  return { ok: false, action, error: { code: failure.error.code, message: failure.error.message } }
}

/**
 * Build the `telegram` tool definition.
 * @param {{ host: any }} options
 * @returns {object} raw `ToolDefinition`
 */
export function createTelegramTool({ host }) {
  return {
    name: 'telegram',
    description: 'Read Telegram dialogs and messages, search them, send a text message, or report connection state.',
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value) }]
      },
    },
    timeoutMs: 30_000,
    isConcurrencySafe(args) {
      return args !== null && typeof args === 'object' && READ_ACTIONS.has(/** @type {any} */ (args).action) === true
    },
    presentCall(args) {
      const action = args !== null && typeof args === 'object' && typeof args.action === 'string' ? args.action : 'status'
      const kind = action === 'send_message' || action === 'mark_read' ? 'edit' : action === 'search' ? 'search' : 'read'
      return { card: 'generic', title: `Telegram: ${action}`, kind, rawInput: args }
    },
    async execute(args, exec) {
      const input = args !== null && typeof args === 'object' ? args : {}
      const action = typeof input.action === 'string' ? input.action : ''
      if (TELEGRAM_ACTIONS.includes(action) === false) {
        return { ok: false, action: action === '' ? 'status' : action, error: { code: 'invalid_arguments', message: `action must be one of: ${TELEGRAM_ACTIONS.join(', ')}` } }
      }
      if (exec !== null && exec !== undefined && exec.signal !== undefined && exec.signal.aborted === true) {
        return toolFailure(action, fail('internal_error', 'The Telegram operation was cancelled'))
      }

      const state = host.state()
      if (action === 'status') return { ok: true, action, result: state }
      if (state.configured !== true) {
        return toolFailure(action, fail('not_configured', 'Telegram is not configured. Set apiId and apiHash (or apiHashRef) in the telegram plugin row.'))
      }
      if (state.engineAvailable !== true) {
        return toolFailure(action, fail('engine_unavailable', 'The Telegram engine package is not available in this installation.'))
      }
      if (state.loggedIn !== true) {
        return toolFailure(action, fail('not_authenticated', 'Telegram is not signed in. Ask the user to sign in from the Telegram overlay (paper-plane button).'))
      }

      const chatId = stringArg(input.chat_id ?? input.chatId)
      const limit = integerArg(input.limit)
      const before = integerArg(input.before)
      const upTo = integerArg(input.up_to ?? input.upTo)

      /** @type {any} */
      let result
      switch (action) {
        case 'whoami': {
          const profile = await getProfile(host, {})
          if (isFail(profile)) return toolFailure(action, profile)
          const user = profile.value.user
          result = ok({
            userId: user.userId,
            phone: user.phoneMasked,
            title: user.title,
            username: user.username,
            dcId: user.dcId,
          })
          break
        }
        case 'list_chats':
          result = await listChats(host, { limit: limit ?? undefined })
          break
        case 'get_chat':
          if (chatId === '') return toolFailure(action, fail('invalid_arguments', 'chat_id is required for get_chat'))
          result = await getChat(host, { chatId })
          break
        case 'get_messages':
          if (chatId === '') return toolFailure(action, fail('invalid_arguments', 'chat_id is required for get_messages'))
          result = await getMessages(host, { chatId, limit: limit ?? undefined, before: before ?? 0 })
          break
        case 'send_message': {
          if (chatId === '') return toolFailure(action, fail('invalid_arguments', 'chat_id is required for send_message'))
          const text = typeof input.text === 'string' ? input.text : ''
          result = await sendText(host, { chatId, text })
          break
        }
        case 'mark_read':
          if (chatId === '') return toolFailure(action, fail('invalid_arguments', 'chat_id is required for mark_read'))
          result = await markRead(host, { chatId, upTo: upTo ?? 0 })
          break
        case 'search': {
          const query = stringArg(input.query)
          if (query === '') return toolFailure(action, fail('invalid_arguments', 'query is required for search'))
          result = await searchMessages(host, { query, limit: limit ?? undefined, chatId: chatId === '' ? null : chatId })
          break
        }
        default:
          return toolFailure(action, fail('invalid_arguments', 'Unknown Telegram action'))
      }
      if (isFail(result)) return toolFailure(action, result)
      return { ok: true, action, result: result.value }
    },
  }
}

/**
 * Register the tool on a context that owns `tools`. The caller keeps the
 * returned disposer inside a `ctx.effect`.
 * @param {any} ctx - context with `tools` (DESIGN-v0.2 8.4)
 * @param {{ host: any }} options
 * @returns {() => void} unregister
 */
export function registerTelegramTool(ctx, { host }) {
  return ctx.tools.register(createTelegramTool({ host }))
}
