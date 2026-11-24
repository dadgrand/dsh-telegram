# Telegram inside DeepSeek Harness

`dsh-telegram` brings a Telegram account into the DSH Web GUI and, in the same package, gives the agent one tool for reading and writing Telegram messages. The client speaks official MTProto through the GramJS engine (`telegram@2.26.22`); no bot token, no HTTP bridge, no Telegram Desktop process.

## Where it appears

A paper-plane button sits in the top-right corner of the window, above every panel, so it is available from the Conversation, from Plugins, and from settings-like pages.

- Click it, or press `Alt+Shift+T`, to open the Telegram overlay.
- The button carries a small state dot: red for `connection_failed`, amber for `needs_auth`, none while connected.
- Close the overlay with `×`, `Escape`, or a click on the dimmed backdrop. Focus returns to the button.
- The overlay is a real dialog (`role="dialog"`, `aria-modal`, focus trap) and stays open when you switch to another section.

## First run

1. Set `apiId` and `apiHash` (or `apiHashRef`) in your profile patch layer, row `telegram`. Without them the overlay reports “Telegram is not set up”.
2. If your network blocks direct MTProto, configure the proxy (see below). With a dead proxy the overlay shows `connection_failed` and the diagnostics behind it.
3. Open the overlay and scan the QR code with Telegram on your phone: Settings → Devices → Link Desktop Device. The code rotates about every 30 seconds and the screen counts down to expiry.
4. If scanning is inconvenient, `Sign in with a phone number` switches to phone → code → two-step password.

Signing in is a person's action. The agent tool has no action that can sign in, confirm a code, or sign out.

## What the overlay does

- **Dialog list** — monogram, title, last-message preview, time, unread badge, pinned and archived marks, plus a local title filter. Pinned dialogs first, then by recency.
- **Thread** — messages grouped by day, author for groups and channels, own-message marking, edited and reply marks, media chips with metadata (type, name, size, dimensions, duration), and `Load earlier`. A thread header opens the chat's profile; a message author opens the person's profile.
- **Composer** — `Ctrl`/`Cmd`+`Enter` sends, a `N / 4096` counter, per-chat drafts kept in `localStorage` (text only).
- **Profile** — self, user, group or channel: id, username, kind, masked phone with reveal, bio, member/subscriber counts, common chats, data-centre id, and two actions: `Write` opens the conversation (Saved Messages for yourself), `Select` adds the profile to the selection.
- **Sign-in** — QR first, phone fallback, and a short “done” state before the dialog list appears.
- **Status strip and diagnostics** — engine state, connection state, and the proxy diagnostics for a failed connection.

Polling: the dialog list refreshes about every 15 seconds and the open thread about every 4 seconds, only while the overlay is open and the tab is visible.

## Selecting objects and sending them to the agent

Selection is a mode, so ordinary browsing is never intercepted.

1. Press **Select** in the overlay toolbar.
2. Click a dialog row, a message, a media chip or a profile card to add it as a chip; click again to remove it. `Shift`-free, explicit, and reversible.
3. Or drag a region across the panel: every selectable object overlapping the dragged band by at least 30 % of the smaller rectangle joins the selection, in reading order.
4. Press **Comment** to open the comment window: chips with `×`, the comment field, the prompt preview, and `Queue` / `Interrupt and insert` while the target session is running.
5. **Send** delivers the prompt to the active DSH session. The window names the target; with no active session it offers `Open in a new session` (new session in the current workspace, prompt placed in the composer) and `Copy`.

The prompt starts with a short digest, then your comment, then a fenced JSON block with the selected objects (`"schema": "dsh-telegram/selection@1"`). Telegram content is untrusted data: the fence uses four backticks and the text says so explicitly. Only allow-listed fields are serialized — phone numbers, API credentials, the session string and QR tokens cannot appear in a prompt. Limits: 12 objects and 500 characters per object on the Host (the overlay allows up to 50 chips and marks what it drops), 6000 characters for the prompt, 2000 for the comment; truncation is always marked.

## The `telegram` agent tool

One tool with an `action` parameter:

| Action | Purpose |
|---|---|
| `status` | configuration, engine, sign-in stage, masked phone, user id, data centre, session save time, last error |
| `whoami` | the signed-in account |
| `list_chats` | dialogs with ids, kinds, titles, unread counts, last message and time |
| `get_chat` | one dialog |
| `get_messages` | a page of messages, optionally older than a given id |
| `send_message` | send plain text (up to 4096 characters) |
| `mark_read` | acknowledge messages through an id |
| `search` | search all dialogs or one chat |

`status`, `whoami`, `list_chats`, `get_chat`, `get_messages` and `search` are safe to call in parallel; `send_message` and `mark_read` are not. Every call is bounded to 30 seconds.

## Security and privacy

- The sign-in session is a DSH **credential record** (`dsh-telegram/session`) in `$DSH_HOME/.credentials.yaml`; it is not in the plugin config, not in `localStorage`, and not in any log line or response body.
- `apiHash` can stay out of configuration by naming a stored credential (`apiHashRef`); the proxy password and MTProxy secret work the same way.
- `/status` returns whether the fallback form has a phone configured, never the number itself; the signed-in account's phone is masked (`+7 9** ** **12`).
- The overlay's JSON routes live under `/api/dsh-telegram/`, accept loopback peers only, refuse cross-site requests, and require `Origin` to match `Host`. They are the panel's internal channel, not a public API.
- Selection serialization is allow-list based, so a new DTO field cannot leak into a prompt by accident.

## Configuration surface

`apiId`, `apiHash`, `apiHashRef`, `defaultPhone`, `connectionTimeoutMs`, `dialogLimit`, `messageLimit`, `searchLimit`, `textMaxLength`, `bodyMaxBytes`, `authTimeoutMs`, `proxyMode` (`direct`/`socks5`/`mtproxy`), `proxyHost`, `proxyPort`, `proxyUser`, `proxyPasswordRef`, `proxySecretRef`, `proxyTimeoutSec`, `proxyPreflightMs`, `selectionMaxObjects`, `selectionTextPerObject`, `promptMaxChars`, `noteMaxChars`, `sendMode` (`queue`/`steer`). Every field has a default, so a row without config mounts and reports `not_configured`. Configuration is read from your patch layer; the plugin never rewrites it, and it has no Settings form.

Proxy precedence: a non-`direct` `proxyMode`, otherwise the `DSH_TELEGRAM_PROXY` environment variable (`socks5://127.0.0.1:1081`), otherwise a direct connection. DSH's own `HTTP_PROXY`/`HTTPS_PROXY` do not accept `socks5://`, so they are not used here.

## Limitations

- Host modals (first-run notice, Preview Notice, Settings) render above the frame and therefore above the launcher; dismiss them before using the button.
- Clicking the backdrop does not close the overlay while the comment window is open; use `Cancel`, `×` or `Escape`.
- Message rows and profile cards are selectable with the pointer only; dialog rows also expose `aria-pressed` and keyboard activation.
- The overlay allows 50 chips, the Host clamps prompts to 12 objects by default.
- No live push: dialogs and threads are polled.
- Text only: no media upload or download, no stickers, polls, location, calls or secret chats; attachments appear as metadata. No edit, forward, pin or delete.
- The engine (`telegram@2.26.22`) is pinned; npm marks that release as archived and development continues in the `teleproto` fork.
- Below 768 px the navigation drawer covers the overlay.
- A real QR sign-in, real dialogs and a live MTProto round trip require your own API credentials and phone; they are not covered by CI.
- Installing the bundle from GitHub with pnpm 11 needs one explicit `allowBuilds` decision for three transitive packages that carry install scripts (`bufferutil`, `utf-8-validate`, `es5-ext`); none of their builds is needed, and README spells out the exact block. Installing from a local directory avoids the question entirely.

## Verification status

The repository ships a unit suite (43 tests, no network, no account) plus static gates: `node --check` on every source and on the built bundle, a deterministic client build, a manifest/locale/exports check, and a CI workflow that rebuilds the bundle and fails when the committed artifact differs. Live behaviour (overlay geometry, selection, prompt delivery into a session, host routes) was verified against an isolated DSH instance with fixture Telegram responses; signing in to a real account is the user's step.
