# Changelog

All notable changes to Library Pulse will be documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **A Google Chat space the app couldn't be added to was never tried again.**
  When Google refused to add Library Pulse to a chosen space (for example
  because the signed-in account wasn't yet allowed to install the app), the
  space was still saved, and later saves only added the app to _new_ spaces,
  so fixing the cause on Google's side changed nothing until the space was
  removed and chosen again. Every save of a Google Chat config now also
  retries the chosen spaces that have no recorded membership (the add was
  refused, or the app was removed from the space), and reports the result the
  same way.
- **Google Chat failures now say why.** The log line for a refused add or a
  failed post carries Google's HTTP status, its `ErrorInfo.reason` (such as
  `ACCESS_TOKEN_SCOPE_INSUFFICIENT`) and the start of its message; the line
  for a failed app sign-in names the Workload Identity Federation pool
  address and the service account it was built from, so an `invalid_target`
  points at the setting to fix. Nothing logged is a token or an address.
  The four `GCP_*` federation settings are also trimmed, so whitespace pasted
  around a value can't corrupt the pool address.
- **No way to sign in to Google again after the sign-in expired.** The plugin
  restored "Connected as …" from its saved sign-in, which hides the Sign in with
  Google button. When Google had expired or revoked that sign-in (Testing-mode
  grants last 7 days), the space picker said to sign in again, but there was no
  button to do it. Now, when the space list fails with `google_reauth_required`
  for the sign-in saved in the plugin (in first-time setup, or the file's own
  account when it's the same one), the plugin forgets that sign-in. The button
  comes back with "Your Google sign-in has expired. Sign in with Google again."
  under it. A file set up with someone else's account keeps your sign-in; it
  recovers from the dashboard's "Google Chat disconnected" banner.
- **"Upstream service error" when saving email or Google Chat.** Production had
  run an early copy of migration 007 that lacked `configurations.gchat_timezone`
  and `gchat_spaces.muted`, and every save from the current plugin named the
  Google Chat columns, even for email and Slack, so each failed with PGRST204.
  `database/migrations/008-google-chat-columns.sql` adds the two columns
  (idempotent) and reloads PostgREST's schema cache; a save now names only the
  columns of the destinations it involves, so email and Slack saves no longer
  depend on Google Chat's. `database/schema.sql` now includes migrations 007
  and 008.

### Changed

- **The Slack row in step 2 shows Slack's official mark**, replacing a
  hand-drawn approximation. It's `SLA-Slack-icon-RGB.svg` from Slack's media
  kit ("Logos"), byte for byte, embedded as an image so it can't be restyled.
  It carries Slack's current colours (#E3066A, #00B3FF, #41B658, #FCC003),
  which Slack's own developer site also uses. Slack's "Add to Slack" button
  image, below it, still has the previous palette; that is Slack's published
  asset and isn't modified.
- **Slack's official "Add to Slack" button.** Connecting Slack installs the
  Library Pulse app through Slack's OAuth install flow, and Slack's button for
  that flow is "Add to Slack". ("Sign in with Slack" is Slack's separate OpenID
  sign-in, and Slack doesn't allow its scopes in the same flow.)
  - The button is Slack's own image, byte for byte (`add_to_slack.png` and
    `@2x`), shown as Slack's SDKs show it: 139 × 40 with a 1x/2x srcset. It
    is embedded because a plugin can't load images from other domains.
  - It replaces "Connect to Slack" in setup, "Reconnect Slack" in the
    @mention hint, and "Reconnect Slack" on the dashboard's "Slack
    disconnected" banner.
  - Slack's brand terms forbid changing the logo's colors, proportions or
    transparency, so the image is never relabelled or faded. While
    connecting, the button only disables; once connected, a separate status
    button shows "Connected to …".
- **Step 2 lists the destinations as a stacked list: Slack, Google Chat, Email.**
  Each row shows its limit (up to 3 channels, 3 spaces, 5 addresses). The
  Microsoft Teams "Coming soon" card is gone until Teams is fully built. The
  Google Chat row uses Google's official Chat logo, embedded as a data URI
  (Figma's plugin CSP allows `data:`). Step 4's title before a choice is now
  "Add channels, spaces or addresses".
- **Google sign-in uses Google's own "Sign in with Google" button**, built to
  Google's sign-in branding guidelines, which app verification requires. It is
  the HTML and CSS Google's button configurator generates (standard,
  rectangular; light theme, dark theme in Figma's dark mode) with the type the
  guidelines specify, Google Sans Medium 14/20, embedded as a 2 KB subset
  (SIL Open Font License; the license travels in `ui.html`). It replaces
  "Connect Google Chat" in setup and "Reconnect Google Chat" on the dashboard.
  The button never carries other text: while signing in it only disables, and
  once signed in a separate status button shows "Connected as …".
- **The Google sign-in says which permissions to select.** Google's consent
  screen gives each Chat permission its own checkbox and has no way to
  pre-select them (granular consent), so before sign-in the plugin says to
  select both and what each is for. If one is left unselected, the plugin and
  the browser page both say how to retry.
- **Backend grouped into 7 Vercel Functions (was 12).** The Hobby plan caps
  Functions per deployment, and the backend had reached the cap. The OAuth
  endpoints, the two Slack picker endpoints and the file resolver now share one
  file each (`api/auth.js`, `api/slack.js`, `api/figma.js`), with `vercel.json`
  rewriting every public path to its file. No URL changed; the handlers moved to
  `lib/handlers/` unchanged.

### Added

- **Resend a confirmation email from the dashboard.** Every address that
  hasn't confirmed yet has a **Resend** action next to its state
  (`PUT /api/config { resendConfirmation }`, any editor of the file, the same
  limit of three confirmation emails per address per day). Removing and
  re-adding the address is no longer the only way.
- **The dashboard says when something never happened, and keeps saying so.**
  Each address now records the outcome of its last confirmation attempt
  (`confirmation_sent_at` / `confirmation_error` on the entry), so an address
  whose email never went out shows **Email not sent** (with the reason on
  hover) instead of Pending, and a file where no confirmation could be sent
  shows "The confirmation emails couldn't be sent" with the cause, not
  "No one has confirmed yet". A Google Chat config's responses carry
  `gchat_memberships` (whether the app is in each chosen space), and a space
  the app isn't in shows "Library Pulse isn't in a space" with a **Retry**
  that re-saves the same spaces, which adds the app again with the connected
  Google account. Both replace a toast that was easy to miss, and both stay
  until the state changes.
- **The "Deliveries failing" banner says what kind of failure it was.** The
  email service rejecting the server's credentials or sender address, or the
  app failing to sign in to Google Chat (a server setting), is named as such,
  so editors aren't told to check the addresses or the space when the fix is
  on the server.
- **Google Chat as a destination.** Step 2 gains a live Google Chat card. The user
  signs in with Google from the plugin (scopes `chat.spaces.readonly`,
  `chat.memberships.app`, `openid email`), picks up to three spaces they belong to,
  and Library Pulse adds itself to those spaces; every publish is then posted in
  them by the Library Pulse app itself, with the same facts as the Slack message
  and the email. `@Library Pulse help`, `stop` and `start` work in a space, and
  the dashboard shows "Google Chat disconnected" with a reconnect when Google
  revokes the sign-in. Requires `database/migrations/007-google-chat.sql`, the
  `GOOGLE_*` variables and either Workload Identity Federation (`GCP_*`) or a
  service-account key.
- **Email as a destination.** A file can now notify up to five email addresses
  instead of Slack. Setup step 2 becomes "Choose where to get updates", and step 4
  asks for channels or addresses accordingly. Addresses are validated as they
  are typed, with a live `N/5` counter. Each address confirms by email before it
  receives anything (double opt-in), every email has an unsubscribe link and
  one-click unsubscribe headers, and the publish time is shown in the time zone
  of the editor who saved the list. Any editor of the file can change the list.
  Sent through Amazon SES. Requires `database/migrations/006-email-destination.sql`
  and the `SES_*` / `EMAIL_*` environment variables. Existing Slack
  configurations are unchanged.

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
