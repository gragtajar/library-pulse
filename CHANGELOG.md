# Changelog

All notable changes to Library Pulse will be documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **"error (open-url) missing or invalid url field" on Connect Slack.** In the
  Figma desktop app the plugin iframe isn't a secure context, so
  `crypto.randomUUID()` is unavailable and the CSRF-state fallback produced a
  non-UUID string. The backend rejected it with `400` (no `url`), and the UI
  then asked the sandbox to `openExternal(undefined)`. `makeStateNonce()` now
  always returns a valid RFC-4122 v4 UUID, and the UI surfaces the backend's
  actual error instead of blindly opening `data.url`. (`figma-plugin/ui.html`)

### Changed

- **Figma connects automatically — no manual "Connect Figma" step.** The plugin
  reads the logged-in user from `figma.currentUser` and, on open, starts the
  one-time Figma authorization automatically (a banner replaces the old
  button). Returning users with a stored session token skip it entirely; an
  expired session auto-reconnects. Note: a browser authorization is still
  required once because a Figma plugin sandbox cannot obtain a `webhooks:write`
  token itself — identity stays cryptographically proven (session minted from
  real OAuth), so there is no security regression. Removing a config no longer
  disconnects the user's Slack/Figma accounts. (`figma-plugin/ui.html`)

### Security

- **OAuth callback XSS fixed.** Previously the `?error=` query string was
  reflected unescaped into the success/failure HTML page. Now goes through
  `escapeHtml` and a hard `default-src 'none'` CSP. (`backend/lib/oauth-result-page.js`)
- **Plugin-UI XSS fixed.** Channel-pill rendering used `innerHTML` to inject
  the channel ID into an `onclick` attribute. Switched to DOM construction
  with `addEventListener`. (`figma-plugin/ui.html`)
- **Webhook passcode is now hard-required.** v1 fell open when `webhook_id`
  was missing. New flow rejects any payload that doesn't carry a known
  webhook id and a `timingSafeEqual`-matching passcode header.
- **Cross-user config access blocked.** Backend now requires
  `X-Figma-User` on every CRUD call and matches it against the row's
  `figma_user_id`. Mismatched → 403.
- **OAuth session replay blocked.** `auth_sessions` now tracks `expires_at`
  (enforced) and `used_at` (set on consumption).
- **Slack mrkdwn escaping.** Component names and descriptions are now
  escaped through `escapeSlack` before being embedded in blocks; a malicious
  component named `<!channel>` no longer pings everyone.
- **Tightened CORS.** Backend no longer responds with `Access-Control-Allow-Origin: *`.
  The Figma srcdoc origin (`null`) plus an opt-in `ALLOWED_ORIGINS` env list
  are the only allowed callers.

### Added

- **Webhook idempotency** via the new `webhook_events` table. Figma retries
  the same `LIBRARY_PUBLISH` are de-duplicated by `event_id` (preferred) or
  payload hash. (`backend/lib/idempotency.js`)
- **Custom error hierarchy** so handlers raise typed exceptions
  (`ValidationError`, `ForbiddenError`, `NotFoundError`, `UpstreamError`)
  that `withErrorHandling` translates to HTTP responses. (`backend/lib/errors.js`)
- **Structured JSON logger** with key-based secret redaction. Replaces all
  `console.log` calls. (`backend/lib/logger.js`)
- **`fetchWithTimeout`** wrapper around `fetch` using `AbortSignal.timeout`.
  Slack + Figma calls now time out at 8–10 s instead of hanging until
  Vercel kills the function. (`backend/lib/http.js`)
- **Input validators** for Slack channel IDs, Figma file keys, team/user IDs,
  and UUID v4 states. (`backend/lib/validators.js`)
- **Bounded concurrency on Slack fan-out** — at most 4 parallel `chat.postMessage`
  calls per config, to stay under Slack's per-channel rate limit.
- **Plugin sandbox hardening:** scoped `clientStorage` keys (`lp/v1/…`),
  per-value byte cap, `https://`-only `openExternal`, message-type allow-list,
  top-level error boundary that surfaces via `figma.notify`.
- **Code-quality toolchain:** ESLint v9 flat config (security, import, n,
  promise plugins), Prettier, EditorConfig, husky (pre-commit, commit-msg,
  pre-push), lint-staged, commitlint Conventional Commits, jsconfig
  (`checkJs: true`, strict mode).
- **Vitest** test suite with v8 coverage. Initial suites cover encryption
  round-trip + tampering, validators, escape helpers, slack-blocks
  formatting, idempotency-key derivation.
- **GitHub Actions:** `ci.yml` (verify), `codeql.yml` (security scan),
  `dependency-review.yml` (PR dep audit).
- **Manifest validator** + **`allowedDomains` drift check** scripts.
- **Documentation:** ARCHITECTURE.md, CONTRIBUTING.md, SECURITY.md,
  CHANGELOG.md, four ADRs, three runbooks, GitHub PR + issue templates.
- **DB schema additions:** `webhook_events` table, `auth_sessions.used_at`
  column, GC cron stubs.

### Changed

- `vercel.json` no longer ships `Access-Control-Allow-Origin: *` and now
  sets `Strict-Transport-Security`, `X-Content-Type-Options`,
  `Referrer-Policy`, `X-Frame-Options`, and `Permissions-Policy` on every
  `/api/*` route.
- `backend/lib/supabase.js` fails at module-load if env vars are missing.
- `backend/lib/encryption.js` validates hex format of `ENCRYPTION_KEY` and
  rejects malformed ciphertext lengths before attempting to decrypt.

## [1.0.0] - 2026-04-19

Initial public release: Figma plugin + Vercel backend that posts Slack
notifications on Figma `LIBRARY_PUBLISH` webhooks.
