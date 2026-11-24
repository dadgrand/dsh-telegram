# Changelog

All notable changes to this plugin are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.4] — 2026-11-25

Engine `Api` resolution hardening.

### Fixed

- `whoami` and self/chat profiles no longer return `engine_unavailable` when
  the ESM loader exposes the `telegram` package without its CommonJS named
  exports: `engineApi()` falls back to `createRequire`, and a missing `Api`
  now degrades the optional full-user/full-chat fields instead of failing the
  whole profile screen.

## [0.2.3] — 2026-11-25

Dialog list crash fix on accounts with media messages.

### Fixed

- A dialog whose last message carries Document media (video, document, voice,
  sticker, GIF, audio) no longer fails the whole dialog page with
  `TypeError: Right-hand side of 'instanceof' is not callable`. GramJS 2.26.22
  passes an array of attribute classes to `File._fromAttr`, so its
  `file.width`/`height`/`duration` getters throw; the mapper now reads
  width/height/duration from `photo.sizes`/`document.attributes` directly and
  treats every engine getter as fallible. This was the live cause of
  `GET /dialogs?limit>=16` returning 500 and the panel showing a failure.

## [0.2.2] — 2026-11-25

Field fixes found on a real signed-in account.

### Fixed

- Dialog list no longer fails with `internal_error` when the account has a
  dialog whose top message is missing, which made GramJS's custom `Dialog`
  constructor throw for the whole page: `GET /dialogs` (and the agent tool
  `list_chats`) now falls back to the raw `messages.getDialogs` page and maps
  plain TL objects (`mapRawDialogPage`), so the page size is no longer capped at
  the first odd row.
- The `telegram` tool's `whoami` action now returns a proper `Result`; before,
  the dispatcher read `result.value` from a plain object and the harness
  rejected the value as non-lossless JSON.

## [0.2.1] — 2026-11-24

Documentation and sign-in UX patch. No protocol, route or storage change.

### Fixed

- The fallback sign-in screen no longer prints a blank "Code sent to " notice
  after a submission whose number the Host substituted from its own config:
  the notice now uses neutral copy when the client has no number to show, and a
  retry hint appears together with a failed attempt (`lib/client-src/60-login.js`,
  new `login.codeSentConfigured` and `login.codeRetryHint` keys in `en`/`ru`).
- Public documentation no longer over-claims three behaviours: that the Host
  clamps the prompt limits, that `defaultPhone` prefills the sign-in field, and
  that the comment is quoted verbatim. The prompt budget is applied in the
  browser (50 objects, 500 characters per object, 6000 total, 2000 for the
  comment), the Config values are only advertised through `/status`, the Host
  substitutes its configured number on an empty submission without exposing it,
  and the comment is escaped before it enters the prompt (`README.md`,
  `docs/DETAIL.md`).

### Added

- `README.ru.md` — a Russian translation of the README, linked from the English
  one.
- This changelog.

## [0.2.0] — 2026-11-24

First public release.

- Paper-plane launcher in the top-right corner of the DSH Web GUI and a
  frame-level Telegram overlay (`shell.overlay`) that works from every section.
- Official MTProto through GramJS (`telegram@2.26.22`) with QR-first sign-in and
  a phone → code → 2FA fallback; the session is a DSH credential record
  (`dsh-telegram/session`), never configuration or `localStorage`.
- Dialog list, message thread, composer with per-chat drafts, and profiles of
  yourself, users, groups and channels.
- Selection mode: click an object or drag a region (30 % overlap of the smaller
  rectangle) to build a selection; the comment window sends one deterministic
  prompt — digest, your comment, a fenced JSON block — to the active DSH session,
  with `queue`/`steer` delivery and an explicit Send.
- SOCKS5 / MTProxy support with config/environment precedence, a TCP preflight
  and secret-free `connection_failed` diagnostics.
- The `telegram` agent tool: `status`, `whoami`, `list_chats`, `get_chat`,
  `get_messages`, `send_message`, `mark_read`, `search`.
- Thirteen loopback JSON routes behind a loopback/same-origin fence, a 48-test
  unit suite, a package gate, a deterministic client build and a CI workflow.
- `GET /api/dsh-telegram/status` reports `config.phoneConfigured` and a masked
  account number only; the configured fallback number is substituted on the Host
  when the form is submitted empty.
