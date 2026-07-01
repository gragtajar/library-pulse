# Figma plugin best practices

A catalogue of plugin-specific hardening that **isn't** covered by the website-oriented production-readiness spec we inherited. Each practice has a one-line statement, the rationale (what breaks if you skip it), and a pointer to where it's enforced in this repo.

If you add a new pattern that other Figma plugins would benefit from, append it here.

---

## 1. Validate `manifest.json` against a JSON schema in CI

**What:** A typo'd `editorType`, malformed `networkAccess`, or missing `id` field will be silently accepted by `npm run dev` and only blow up when Figma rejects the manifest at publish time. CI should catch it.

**Why:** Reviewer feedback at publish time is days-long; CI feedback is seconds.

**Where:** [`scripts/validate-manifest.mjs`](../scripts/validate-manifest.mjs) — Ajv against the documented Figma manifest constraints. Wired into [`ci.yml`](../.github/workflows/ci.yml).

---

## 2. Typed message contract between sandbox and UI

**What:** Both runtimes agree on a closed set of `{ type, …payload }` messages. The sandbox enforces an allow-list (`ALLOWED_UI_MESSAGE_TYPES`); JSDoc typedefs in `backend/lib/types.js` make the union machine-checkable via `tsc --checkJs`.

**Why:** Plugins are shipped to users — a typo'd `msg.type` in production silently does nothing and the user sees a frozen UI. The allow-list converts that to a loud `figma.notify` error.

**Where:**

- [`figma-plugin/code.js`](../figma-plugin/code.js) (`ALLOWED_UI_MESSAGE_TYPES` set + `safe()` wrapper)
- [`backend/lib/types.js`](../backend/lib/types.js) (`UiToPluginMessage` / `PluginToUiMessage` typedefs)
- [ADR-004](./adrs/004-plugin-ui-message-contract.md)

---

## 3. XSS hardening in the plugin UI (no `innerHTML` for handlers)

**What:** Never interpolate user-controlled data into an `innerHTML` string — especially not inside attribute strings like `onclick="…"`. Use `document.createElement` + `addEventListener`.

**Why:** The Figma UI runs inside an `iframe` with `srcdoc`, which has `Origin: null`. XSS still gives an attacker access to the user's plugin storage, Figma user id, and any token the UI happened to be holding. Cheap to do right.

**Where:**

- [`figma-plugin/ui.html`](../figma-plugin/ui.html) — `renderChannels()` builds pills with the DOM API; channel IDs are written via `textContent`, not interpolation.
- [`backend/lib/oauth-result-page.js`](../backend/lib/oauth-result-page.js) — every reflected query value goes through `escapeHtml`.

---

## 4. Namespace and quota-guard `clientStorage`

**What:** Prefix every key the plugin writes (`lp/v1/…`). Cap per-value size at a few hundred KB. Figma's total per-plugin quota is 5 MB; a runaway UI can easily fill it and lock out future writes.

**Why:** Namespacing lets you wipe everything on uninstall or version bump. Per-value caps stop one bug from breaking the whole plugin.

**Where:** [`figma-plugin/code.js`](../figma-plugin/code.js) — `STORAGE_PREFIX = "lp/v1/"`, `MAX_STORAGE_VALUE_BYTES = 200 * 1024`.

---

## 5. Drift-check `networkAccess.allowedDomains` against runtime URLs

**What:** If the UI tries to `fetch` a host that's not in the manifest's `allowedDomains`, Figma silently blocks the request. The CI script greps all `https://` URLs in `ui.html` and fails if any aren't declared.

**Why:** This bug manifests as "buttons do nothing in production" because the UI's `fetch` never even fires. Painful to diagnose; trivial to catch in CI.

**Where:** [`scripts/check-api-base.mjs`](../scripts/check-api-base.mjs). Run in [`ci.yml`](../.github/workflows/ci.yml).

---

## 6. Use Figma color-theme tokens, not hard-coded colours

**What:** The plugin UI styles everything via `var(--figma-color-bg)`, `var(--figma-color-text)`, etc., with sensible hex fallbacks. Figma re-paints these when the user switches Figma's UI theme; hard-coded colours give a jarring dark-mode experience.

**Why:** Users on dark Figma + a light plugin = pain. Two-character cost to fix.

**Where:** Throughout [`figma-plugin/ui.html`](../figma-plugin/ui.html) — every colour reference is `var(--figma-color-*, <fallback>)`.

---

## 7. Strict CSP on every HTML page the backend serves

**What:** The OAuth callback pages are reachable from a real browser, not just Figma. CSP `default-src 'none'`; allow `style-src 'unsafe-inline'` only because we ship one small stylesheet block; no `script-src` at all.

**Why:** If a reflected value ever escapes our HTML escaping, CSP becomes the second line of defence — nothing executes.

**Where:** [`backend/lib/oauth-result-page.js`](../backend/lib/oauth-result-page.js). Per-route headers also include `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`.

---

## 8. Webhook idempotency (Figma retries on 5xx)

**What:** Figma's webhook delivery retries on timeout or 5xx. Without dedup, the same `LIBRARY_PUBLISH` posts to Slack multiple times. We derive a stable `event_key` from the payload and INSERT into a `webhook_events` table with `event_key UNIQUE`. Duplicate insert → already-processed → 200 OK no-op.

**Why:** "Why did Slack get notified twice?" is one of the most common Figma-plugin webhook complaints. One small table + one INSERT removes it.

**Where:**

- [`backend/lib/idempotency.js`](../backend/lib/idempotency.js) — `deriveEventKey` + `reserveEvent`
- [`backend/api/webhook.js`](../backend/api/webhook.js) — checked after passcode validation
- [`database/schema.sql`](../database/schema.sql) — `webhook_events` table + 14-day GC cron stub

---

## 9. Bind OAuth `state` to the plugin user + enforce expiry

**What:** The `state` parameter is a UUID v4 the plugin generates. Backend stores it with `figma_user_id`, `expires_at`, and `used_at`. Callbacks atomically claim the session: must be `pending`, must be unexpired, must be unused. A successful callback sets `used_at`, so replaying the URL fails.

**Why:** Stateless OAuth handlers are a classic source of CSRF and replay vulnerabilities. The patterns here are cheap and obviate the most common failure modes.

**Where:**

- [`backend/lib/auth-session.js`](../backend/lib/auth-session.js) — `claimAuthSession` + `finalizeAuthSession`
- [`backend/lib/validators.js`](../backend/lib/validators.js) — `assertUuid`
- [`database/schema.sql`](../database/schema.sql) — `auth_sessions.expires_at` + `used_at` columns + the 5-min `expire-auth-sessions` cron stub

---

## 10. Sandbox-level error boundary with `figma.notify` fallback

**What:** Every handler in `code.js` is wrapped in `safe(type, fn)`. A thrown error surfaces as a red `figma.notify(...)` toast (visible to the user) AND posts `{ type: "error" }` back to the UI so it can clean up loading states. Without this, an exception in an async sandbox handler leaves the UI's promise hanging forever — the user sees a spinner that never stops.

**Why:** Plugin UIs have no devtools by default; debugging "the spinner is stuck" is awful. Surfacing the actual error in a toast is the single highest-leverage debugging improvement.

**Where:** [`figma-plugin/code.js`](../figma-plugin/code.js) — `safe()` helper.

---

## Honourable mentions (followups, not yet implemented)

- **Figma OAuth refresh-token flow.** Access tokens expire; users today must reconnect. Tracked in `CHANGELOG.md` known gaps.
- **Auto-backoff on Slack rate limits.** Slack's `Retry-After` header isn't honoured today.
- **Plugin-side rate limiting per `figmaUserId`.** Easy DoS surface if a malicious plugin host enumerates `figma_user_id` values.
- **Versioned UI bundle.** `manifest.json` doesn't track UI version; if you ever ship a v2 UI with a v1 sandbox in the wild, weird things happen. Use a `?v=2` query string on the UI's API calls so the backend can warn on mismatch.
