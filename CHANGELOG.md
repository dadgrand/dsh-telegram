# Changelog

All notable changes to this plugin are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
