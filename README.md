# dsh-telegram

English | [Русский](README.ru.md)

Telegram inside [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): a paper-plane button in the top-right corner of the Web GUI opens a full Telegram overlay — official MTProto through [GramJS](https://github.com/gram-js/gramjs), QR sign-in first, dialog list, message thread, composer and profiles. Selecting any object or dragging a region inside the overlay opens a comment window that sends your prompt to the **active DSH session**, together with the selected objects.

The same plugin gives the agent one tool, `telegram`, for reading dialogs and history, searching, sending text and marking read.

- Overlay works from every section of the GUI (Conversation, Plugins, Settings pages) because it lives in the frame's `shell.overlay` slot.
- No core changes: the plugin is one bundle row plus its own files.
- The session token never leaves the Host: it is a DSH credential record, not configuration and not `localStorage`.

## Requirements

| Requirement | Detail |
|---|---|
| DeepSeek Harness | `>=0.2.2-rc.3` (checked through `engines.dsh`); developed and verified against `0.2.2-rc.5` |
| Node | `>=24` |
| Telegram API credentials | `api_id` and `api_hash` from <https://my.telegram.org/apps>, issued for the account you want to link |
| Network | MTProto reachability to Telegram data centres, directly or through a SOCKS5/MTProxy proxy (see [Proxy](#proxy)) |

## Install

The plugin is a DSH **bundle**: its `package.json` declares `dsh.bundle.patch`, and the patch inserts the single row `telegram`.

### From GitHub

pnpm 11 refuses to run a dependency's install scripts without an explicit decision, and GramJS brings three transitive packages that have them (`bufferutil`, `utf-8-validate`, `es5-ext`). None of their builds is needed. Declare that once, in the profile's `pnpm-workspace.yaml` (`~/.dsh/profiles/web/pnpm-workspace.yaml`):

```yaml
allowBuilds:
  bufferutil: false
  utf-8-validate: false
  es5-ext: false
```

Then install:

```sh
dsh plugin --profile web add github:dadgrand/dsh-telegram
```

pnpm installs the package and its two runtime dependencies (`telegram@2.26.22`, `qrcode-generator@2.0.4`) into the profile, and `dsh` appends `dsh-telegram` to `dsh.profile.bundles`.

Without that block the first `add` stops with `ERR_PNPM_IGNORED_BUILDS`: the package is already in the profile's `package.json`, but the bundle row is not registered yet. Add the block and run the same `add` command again — it completes and appends the row. Alternatively install from a local checkout (below), which never asks pnpm for a build decision.

### From a local checkout

```sh
dsh plugin --profile web add /absolute/path/to/dsh-telegram
```

A linked checkout keeps its own `node_modules`, and pnpm does not install the dependencies of a link target, so install them inside the directory first:

```sh
cd /absolute/path/to/dsh-telegram
npm install --omit=dev --ignore-scripts --no-audit --no-fund --no-package-lock
```

`--ignore-scripts` is intentional: GramJS lists optional native dependencies (`bufferutil`, `utf-8-validate`) whose build scripts are not needed and should only run with your explicit consent.

### From the GUI

Settings → Plugins → Add plugin → **Local directory**, and pick the plugin directory. This is the same link installation.

### Restart and verify

```sh
dsh --profile web --dump-config | grep -A3 "== dsh-telegram"
dsh --profile web
```

After the restart the paper-plane button appears in the top-right corner of the window, above every panel. Removing the bundle (`dsh plugin --profile web remove dsh-telegram`) and restarting unmounts the row, its routes and the tool.

## Configuration

Edit **your own** patch layer — `~/.dsh/profiles/<profile>/cordis.patch.yml`. The plugin never rewrites its config, and the user layer outranks the bundle patch, so your values survive plugin upgrades.

```yaml
- id: telegram
  config:
    apiId: 1234567
    apiHashRef: TELEGRAM_API_HASH
    proxyMode: socks5
    proxyHost: 127.0.0.1
    proxyPort: 1081
```

Every field has a default, so a row without `config` still mounts and reports `not_configured`.

| Field | Type | Default | Meaning |
|---|---|---:|---|
| `apiId` | integer `0…2147483647` | `0` | API id from my.telegram.org; `0` = not configured |
| `apiHash` | string | `''` | API hash (secret); empty = not configured |
| `apiHashRef` | string | `''` | Name of a stored credential holding the hash; **wins over `apiHash`** |
| `defaultPhone` | string | `''` | Number the Host substitutes when the fallback form is submitted empty; never returned by `/status` and never placed in the page |
| `connectionTimeoutMs` | integer | `20000` | Upper bound of one connection attempt |
| `dialogLimit` / `messageLimit` / `searchLimit` | integer | `30` / `25` / `10` | Per-request ceilings |
| `textMaxLength` | integer | `4096` | Outgoing text ceiling |
| `bodyMaxBytes` | integer | `65536` | POST body ceiling |
| `authTimeoutMs` | integer | `180000` | Sign-in attempt TTL, refreshed by every new QR token |
| `proxyMode` | `direct` \| `socks5` \| `mtproxy` | `direct` | Proxy mode; a non-direct mode wins over `DSH_TELEGRAM_PROXY` |
| `proxyHost` / `proxyPort` | string / integer | `127.0.0.1` / `1080` | Proxy endpoint |
| `proxyUser` | string | `''` | SOCKS5 user name (never logged) |
| `proxyPasswordRef` / `proxySecretRef` | string | `''` | Credential names for the SOCKS5 password / MTProxy secret |
| `proxyTimeoutSec` / `proxyPreflightMs` | integer | `8` / `1500` | Handshake timeout, TCP preflight budget |
| `selectionMaxObjects` | integer | `12` | Advertised prompt limit (read from `/status`; see the prompt section — the prompt is bounded in the browser, not on the Host) |
| `selectionTextPerObject` | integer | `500` | Advertised per-object text limit (not enforced on the Host) |
| `promptMaxChars` | integer | `6000` | Advertised prompt budget (not enforced on the Host) |
| `noteMaxChars` | integer | `2000` | Advertised comment budget (not enforced on the Host) |
| `sendMode` | `queue` \| `steer` | `queue` | Default delivery mode for the prompt |

`apiHash` is a secret. Prefer `apiHashRef`: DSH resolves the name through its credential store (a saved key or the profile environment variable `TELEGRAM_API_HASH`) and the value never appears in configuration. Note that this plugin's schema is validated but has no Settings form — configuration is edited in the patch layer only (or through the proxy environment variable below).

## Sign in

Open the overlay: the sign-in screen shows a QR code.

1. **QR (primary).** Telegram on your phone → Settings → Devices → Link Desktop Device, then scan. The code refreshes about every 30 seconds; `Refresh code now` requests a new one immediately. The window counts down to expiry.
2. **Phone fallback.** `Sign in with a phone number` reveals phone → code → two-step password (2FA, with the hint Telegram provides). `defaultPhone`, when configured, is used **by the Host** if you submit the form empty: the field itself stays empty and the number never reaches the browser. The overlay only shows whether such a number exists (`/status` reports `phoneConfigured`).
3. An attempt lives 3 minutes (`authTimeoutMs`); each fresh QR token extends it. Letting it expire returns you to `idle`.

The sign-in session (a GramJS `StringSession`) is stored as the DSH credential record `dsh-telegram/session` in `$DSH_HOME/.credentials.yaml` — never in the plugin config, never in `localStorage`, never in a log line. The overlay and `/status` only ever show a masked number (`+7 9** ** **12`). `Sign out` deletes the local record and destroys the client; revoking the session on Telegram's side is done from your phone.

Sign-in, sign-out and QR confirmation are user-only: the agent tool has no action that can perform them.

## Proxy

Many networks block direct MTProto. Start a local SOCKS5 proxy (the plugin was developed against a local «watchman» on `127.0.0.1:1081`) and point the plugin at it, either in config:

```yaml
- id: telegram
  config:
    proxyMode: socks5
    proxyHost: 127.0.0.1
    proxyPort: 1081
```

or through the environment, read when the plugin activates:

```sh
DSH_TELEGRAM_PROXY=socks5://127.0.0.1:1081
DSH_TELEGRAM_PROXY=socks5://user:pass@127.0.0.1:1081
DSH_TELEGRAM_PROXY=mtproxy://host:443?secret=<secret>
```

Precedence: a non-`direct` `proxyMode` wins; otherwise `DSH_TELEGRAM_PROXY`; otherwise direct. The credentials in the URL are not logged, and `/status` reports only mode, host and port.

DSH's own `HTTP_PROXY` / `HTTPS_PROXY` support does not accept `socks5://` URLs, so those variables do not help this plugin — the proxy must be given here.

Before connecting, the Host probes the proxy TCP endpoint (1.5 s). A dead or unreachable proxy is reported as `connection_failed` with secret-free diagnostics (`proxy_unreachable`, `connect_timeout`, `connect_refused`, `dc_unreachable`, `auth_key_unregistered`) instead of a hanging request. Note that GramJS accepts the proxy only in the client constructor: changing it takes effect when the client is recreated (plugin restart, or `Retry` in the overlay after a failure).

## Select an object or a region, then send it to the agent

Selection is an explicit mode so ordinary browsing is never intercepted.

1. Open the overlay and press **Select** in the overlay toolbar. The hint line explains the mode.
2. **Click** a dialog row, a message, a media chip or a profile card → it becomes a chip in the selection bar. Click again to remove it. Pressing `Select` again leaves the mode.
3. **Drag a region** across the panel. Every selectable object whose area overlaps the dragged band by at least 30 % of the smaller rectangle joins the selection, in reading order.
4. Press **Comment** (or `Comment` in the toolbar) to open the comment window.
5. Write what the agent should do, review the prompt preview, choose `Queue` or `Interrupt and insert` while the target session is running, and press **Send**.

Where the prompt goes: the **active DSH session** — the session the Conversation last opened, identified by its main-view retention. The window always names the target; with no active session it offers `Open in a new session` (creates a session in the current workspace and puts the prompt in the composer) and `Copy`.

The prompt is built deterministically: a short human digest first (`Telegram: N objects selected …`), then your comment, then a fenced JSON block (`"schema": "dsh-telegram/selection@1"`) with the selected objects. Telegram content is treated as untrusted data: the block is fenced with four backticks and the prompt carries an explicit note that it is data, not instructions. Only allow-listed fields are serialized — phone numbers, API credentials, the session string and QR tokens can never reach a prompt.

Your comment is inserted **escaped, not verbatim**: control characters and bidi marks are dropped, tabs become spaces, and HTML and Markdown are neutralized so a pasted fragment cannot restructure the prompt. The budget is enforced in the browser, not on the Host: up to 50 selected objects (the chip bar marks what it drops), 500 characters of text per object, 6000 characters for the finished prompt, 2000 for your comment, with every truncation marked. The `selection*` / `promptMaxChars` / `noteMaxChars` values in Config are the defaults the overlay reads from `/status`; the Host receives finished text and does not clamp it again.

## The `telegram` agent tool

One tool, one `action` parameter. Read-only actions are safe for parallel calls; `send_message` and `mark_read` are not.

| Action | Parameters | Result |
|---|---|---|
| `status` | — | configured/engine/sign-in state, masked phone, user id, DC, session save time, last error |
| `whoami` | — | user id, masked phone, name, username, DC |
| `list_chats` | `limit` (1–30) | dialogs: id, type (`user`/`chat`/`channel`), title, pinned/archived, unread, last message, time |
| `get_chat` | `chat_id` | one dialog |
| `get_messages` | `chat_id`, `limit` (1–100), `before` | messages with text, author, `fromMe`, reply, edit flag, media metadata; plus "older available" |
| `send_message` | `chat_id`, `text` | the sent message |
| `mark_read` | `chat_id`, `up_to` | acknowledgement |
| `search` | `query`, `chat_id` (optional), `limit` (1–50) | matching messages |

```json
{ "action": "get_messages", "chat_id": "-1001234567890", "limit": 25, "before": 4200 }
```

Responses are `{ "ok": true, "action": … , "result": … }` or `{ "ok": false, "action": …, "error": { "code": …, "message": … } }`. `chat_id` comes from `list_chats` (channels carry the `-100` prefix). The tool cannot sign in or out, delete, edit, forward, pin, broadcast or call raw `Api.*` methods, and its call budget is 30 seconds.

## Diagnostics

| What you see | What to do |
|---|---|
| `not_configured` / "Telegram is not set up" | set `apiId` and `apiHash` (or `apiHashRef`) in the `telegram` patch row |
| `engine_unavailable` | the `telegram` package is missing inside the plugin directory; reinstall the dependencies |
| `connection_failed` + `proxy_unreachable` | the proxy is not listening on the configured host/port; start it or fix the config |
| `connection_failed` + `connect_timeout` / `dc_unreachable` | the proxy is reachable but Telegram is not; check the proxy's upstream |
| `auth_key_unregistered` | `apiId`/`apiHash` are wrong or revoked |
| `not_authenticated` | sign in from the overlay |
| `auth_expired` | the attempt expired; request a new code or refresh the QR |
| `flood_wait` | wait the interval Telegram asks for |

`GET /api/dsh-telegram/status` carries the same facts in JSON, including `diagnostics`. All routes are loopback-only, same-origin fenced and unauthenticated-by-design for local use; they are the overlay's internal channel, not a public API.

## What is in the package

`index.js` (Host entry), `lib/host/**` (engine, operations, routes, agent tool, proxy, QR matrix), `lib/client-src/*.js` + `scripts/build-client.mjs` (the browser bundle and its generator), `lib/client.js` (generated artifact — do not edit by hand), `cordis.patch.yml` (one insert row), `locale/en.json`, `locale/ru.json`, `icon.svg`, `docs/DETAIL.md`, `test/**`, `README.md`, `README.ru.md`, `CHANGELOG.md`, `LICENSE`.

## Known limitations

- **Host modals cover the launcher.** The overlay lives in the frame (`shell.overlay`, z-index 20); DSH modals render in `document.body` at z-index 1000/1100. While the first-run notice, the Preview Notice or Settings is open, it intercepts clicks on the paper-plane — dismiss it (`Continue`, `Got it`, `×`), then press the button or `Alt+Shift+T`. Raising the plugin above modals would require a portal out of the frame, which breaks the embedding contract.
- **The backdrop is inert while the comment window is open.** Clicking outside does not close the overlay in that state by design (the comment window is modal to the overlay until it is sent, discarded or cancelled), so use `Cancel`, `×` or `Escape`.
- **Message and profile selection are pointer-only.** Dialog rows expose `aria-pressed` and are operable from the keyboard, but message rows and profile cards have no keyboard toggle yet; use a dialog-row selection or the region marquee instead.
- **The prompt budget is client-side.** The overlay keeps up to 50 chips and marks what it drops; the 12-object default in Config is only advertised through `/status` today and is not enforced host-side, so a prompt is bounded by the browser limits (50 objects, 500 characters per object, 6000 total) rather than by the Config value.
- **No live updates.** The dialog list and the open thread are polled (≈15 s and ≈4 s while the overlay is open and the document is visible). Push updates would need an upgrade route and are not implemented.
- **Text only.** No media download, upload, stickers, polls, location, calls or secret chats; attachments are metadata only. No editing, forwarding, pinning or deleting messages.
- **Not official Telegram Desktop.** The engine is `telegram@2.26.22`, which npm marks as archived (development continues in the `teleproto` fork); the version is pinned deliberately and the engine is isolated behind `lib/host/telegram/client.js`.
- **Mobile drawer** (below 768 px) sits above the overlay; opening the drawer closes the overlay.
- **Real sign-in is not covered by CI.** The unit suite and the live smoke tests run without an account: an actual QR login, real dialogs and a live MTProto round trip require your `api_id`/`api_hash` and your phone.

## Development

```sh
npm install --omit=dev --ignore-scripts
node --check index.js
node scripts/build-client.mjs      # lib/client-src -> lib/client.js, deterministic
node scripts/check-package.mjs     # manifest, exports, files, locales, icon
node --test test/                  # 48 tests, no network, no account
```

`lib/client.js` is generated; the CI workflow rebuilds it and fails when the committed bundle differs from its sources.

## License

MIT — see [LICENSE](LICENSE).
