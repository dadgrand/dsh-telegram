/**
 * Regression tests for two field defects found on a live account (v0.2.2):
 *
 * 1. `GET /dialogs?limit>=16` returned 500 because GramJS's custom `Dialog`
 *    constructor throws for a dialog whose top message is missing. `listChats`
 *    now falls back to the raw `messages.getDialogs` page; `mapRawDialogPage`
 *    is the mapper it uses, so it is exercised here against raw TL-shaped
 *    fixtures.
 * 2. The `telegram` tool's `whoami` action returned a plain object where the
 *    dispatcher expects a `Result`, so `result.value` was `undefined` and the
 *    harness rejected the value as non-lossless JSON. The executor test below
 *    pins the success shape.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { mapRawDialogPage } from '../lib/host/telegram/chats.js'
import { ok } from '../lib/host/telegram/errors.js'
import { createTelegramTool } from '../lib/host/tool.js'

const channelDialog = {
  className: 'Dialog',
  peer: { className: 'PeerChannel', channelId: 123 },
  topMessage: 10,
  unreadCount: 3,
  pinned: true,
  folderId: 0,
}
const userDialog = {
  className: 'Dialog',
  peer: { className: 'PeerUser', userId: 7 },
  topMessage: 20,
  unreadCount: 0,
  pinned: false,
  folderId: 0,
}
const chatDialog = {
  className: 'Dialog',
  peer: { className: 'PeerChat', chatId: 55 },
  topMessage: 0,
  unreadCount: 0,
  pinned: false,
  folderId: 1,
}

function page() {
  return {
    dialogs: [channelDialog, userDialog, chatDialog, { className: 'DialogFolder', peer: { className: 'Folder' } }],
    messages: [
      { id: 10, date: 1_700_000_100, message: 'hello from the channel', out: false },
      { id: 20, date: 1_700_000_200, message: 'direct message', out: true },
    ],
    chats: [
      { className: 'Channel', id: 123, title: 'Team Channel', megagroup: false },
      { className: 'Chat', id: 55, title: 'Small Group' },
    ],
    users: [{ className: 'User', id: 7, firstName: 'Anna', lastName: 'Test', username: 'anna' }],
  }
}

test('raw dialogs: channel row comes from the entity and its top message', () => {
  const chats = mapRawDialogPage(page())
  const channel = chats.find((row) => row.chatId === '-100123')
  assert.equal(channel.kind, 'channel')
  assert.equal(channel.title, 'Team Channel')
  assert.equal(channel.pinned, true)
  assert.equal(channel.unreadCount, 3)
  assert.equal(channel.archived, false)
  assert.deepEqual(channel.lastMessage, {
    id: 10,
    date: 1_700_000_100,
    text: 'hello from the channel',
    fromMe: false,
  })
  assert.equal(channel.updatedAt, 1_700_000_100)
})

test('raw dialogs: user row title is first+last name, last message keeps fromMe', () => {
  const chats = mapRawDialogPage(page())
  const user = chats.find((row) => row.chatId === '7')
  assert.equal(user.kind, 'user')
  assert.equal(user.title, 'Anna Test')
  assert.equal(user.lastMessage.fromMe, true)
})

test('raw dialogs: chat row without a top message maps to a null last message', () => {
  const chats = mapRawDialogPage(page())
  const chat = chats.find((row) => row.chatId === '-55')
  assert.equal(chat.kind, 'chat')
  assert.equal(chat.title, 'Small Group')
  assert.equal(chat.lastMessage, null)
  assert.equal(chat.updatedAt, 0)
  assert.equal(chat.archived, true)
})

test('raw dialogs: a peer without an entity still yields a row, titled by its id', () => {
  const chats = mapRawDialogPage({
    dialogs: [{ className: 'Dialog', peer: { className: 'PeerChannel', channelId: 999 }, topMessage: 1 }],
    messages: [],
    chats: [],
    users: [],
  })
  assert.equal(chats.length, 1)
  assert.equal(chats[0].chatId, '-100999')
  assert.equal(chats[0].title, '-100999')
  assert.equal(chats[0].kind, 'channel')
  assert.equal(chats[0].lastMessage, null)
})

test('raw dialogs: megagroup channels map to the chat kind', () => {
  const chats = mapRawDialogPage({
    dialogs: [{ className: 'Dialog', peer: { className: 'PeerChannel', channelId: 321 }, topMessage: 0 }],
    messages: [],
    chats: [{ className: 'Channel', id: 321, title: 'Mega', megagroup: true }],
    users: [],
  })
  assert.equal(chats[0].kind, 'chat')
  assert.equal(chats[0].title, 'Mega')
})

test('whoami tool value is a Result so the dispatcher exposes result, not undefined', async () => {
  const fakeClient = {
    session: { dcId: 2, userId: '1' },
    getEntity: async () => ({
      id: 1,
      firstName: 'Test',
      lastName: 'User',
      username: 'tester',
      phone: '+79001234567',
    }),
  }
  const host = {
    ensureConnected: async () => ok({ client: fakeClient }),
    state: () => ({ configured: true, engineAvailable: true, loggedIn: true }),
  }
  const tool = createTelegramTool({ host })
  const value = await tool.execute({ action: 'whoami' }, null)
  assert.equal(value.ok, true)
  assert.equal(value.action, 'whoami')
  assert.ok(value.result !== undefined, 'whoami must return a result payload')
  assert.equal(value.result.userId, '1')
  assert.equal(value.result.username, 'tester')
  // The harness requires a lossless JSON value; JSON round-trip must not drop
  // anything and must not contain undefined.
  const round = JSON.parse(JSON.stringify(value))
  assert.deepEqual(round, value)
})
