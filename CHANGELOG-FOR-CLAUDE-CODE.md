# Code Changes Log — Hand this to Claude Code

All changes made to the Library Pulse codebase across Cowork sessions.
Claude Code should commit these to the GitHub repo.

---

## Change 1: Fix ES2020 syntax in code.js (Figma sandbox compatibility)

**File:** `figma-plugin/code.js`

**Problem:** Figma's plugin sandbox does not support `??` (nullish coalescing) or `?.` (optional chaining). These were introduced by a linter/refactor pass.

**Fix:** Replaced all 5 instances with ES5-compatible ternaries:

- `figma.fileKey ?? null` → `figma.fileKey != null ? figma.fileKey : null`
- `figma.root?.name ?? ""` → `figma.root && figma.root.name ? figma.root.name : ""`
- `value ?? null` → `value != null ? value : null`
- `msg.value ?? null` (2 occurrences) → `msg.value != null ? msg.value : null`

**Note:** `ui.html` runs in a normal browser iframe and CAN use modern JS — only `code.js` has this restriction.

---

## Change 2: Add `currentuser` permission to manifest.json

**File:** `figma-plugin/manifest.json`

**Problem:** Figma console error: `"currentuser" permission not specified in manifest.json`

**Fix:** Added `"permissions": ["currentuser"]` to the manifest.

---

## Change 3: Remove Figma OAuth step from plugin UI

**File:** `figma-plugin/ui.html`

**Problem:** Users are already logged into Figma. Asking them to "Connect Figma Account" via OAuth was redundant and confusing UX. The Team ID field was equally bad — most users don't know what a Figma Team ID is.

**Changes:**

1. **Removed Step 2 HTML** (Connect Figma) — the entire `<div class="step" id="step-figma">` block
2. **Removed Team ID input** — the `<div class="section">` containing `input-team-id`
3. **Renumbered** Step 3 (Configure) → Step 2
4. **Removed `figmaConnected`** from the `app` state object
5. **Removed `connectFigma()` function** entirely (~55 lines of Figma OAuth polling code)
6. **Simplified `initialize()`** — no longer reads `figma_auth` from storage
7. **Simplified `updateSetupState()`** — after Slack connected, enables config step directly (no Figma step in between)
8. **Simplified `updateSaveButton()`** — only checks `slackConnected + hasFile + hasChannels` (removed `figmaConnected` and `hasTeamId` checks)
9. **Simplified `saveConfig()`** — no longer reads Team ID or sends `figmaTeamId` in POST body
10. **Simplified `deleteConfig()`** — no longer resets Figma step UI or clears `figma_auth` storage
11. **Removed Team ID event listener** from `DOMContentLoaded`

---

## Change 4: Backend config.js — use server-side Figma credentials

**File:** `backend/api/config.js`

**Problem:** `ensureWebhook()` was looking up per-user Figma OAuth tokens from the database to register webhooks. This required every user to go through Figma OAuth in the plugin.

**Changes:**

1. **Removed imports:** `decrypt` from encryption.js, `assertFigmaTeamId` from validators.js
2. **`handlePost()`:** No longer reads `figmaTeamId` from request body. Instead reads from `process.env.FIGMA_TEAM_ID`. Throws `ValidationError` if not configured.
3. **`ensureWebhook()`:** Changed signature from `(figmaUserId, figmaTeamId)` to `(figmaTeamId)`. Uses `process.env.FIGMA_ADMIN_TOKEN` instead of decrypting per-user tokens from `figma_tokens` table. Sets `registered_by: "admin"` instead of the user's ID.

---

## Change 5: Update manifest.json reasoning

**File:** `figma-plugin/manifest.json`

**Change:** Updated `networkAccess.reasoning` from "Connects to the Library Pulse backend for Slack OAuth, Figma webhook registration, and notification configuration." to "Connects to the Library Pulse backend for Slack OAuth and notification configuration."

---

## Change 6: Update .env.example

**File:** `.env.example`

**Change:** Replaced `FIGMA_CLIENT_ID` and `FIGMA_CLIENT_SECRET` (required) with:

- `FIGMA_ADMIN_TOKEN` (required) — Personal Access Token from team admin
- `FIGMA_TEAM_ID` (required) — numeric team ID
- `FIGMA_CLIENT_ID` and `FIGMA_CLIENT_SECRET` moved to commented-out optional section

---

## Change 7: Update README.md

**File:** `README.md`

**Changes:**

- Prerequisites table: "Figma OAuth App" → "Figma Personal Access Token (team admin)"
- Setup section 3: Rewrote from "Create the Figma OAuth App" to "Generate a Figma Personal Access Token"
- Env var commands: `FIGMA_CLIENT_ID`/`SECRET` → `FIGMA_ADMIN_TOKEN`/`FIGMA_TEAM_ID`
- Step 5 text: Removed "and Figma app redirect URLs"
- How It Works: Removed "Connect Figma" step, renumbered remaining steps
- Architecture description: "handles OAuth flows" → "handles Slack OAuth"
- Security section: "Figma OAuth tokens encrypted at rest" → "Figma admin token stored as Vercel env var"
- Env vars table: Updated to show `FIGMA_ADMIN_TOKEN` and `FIGMA_TEAM_ID`
- Project structure: Marked figma.js and figma-callback.js as "(optional)"

---

## Change 8: Update PUBLISH-GUIDE.md

**File:** `PUBLISH-GUIDE.md`

**Changes:**

- Phase 4: Rewrote from "Create the Figma OAuth App" to "Generate a Figma Personal Access Token" with PAT instructions
- Env var commands in Phase 5: `FIGMA_CLIENT_ID`/`SECRET` → `FIGMA_ADMIN_TOKEN`/`FIGMA_TEAM_ID`
- Testing steps in Phase 6: Removed "Click Connect Figma Account" and "Enter your Figma Team ID"
- Troubleshooting: Updated webhook troubleshooting to reference `FIGMA_TEAM_ID` env var and `FIGMA_ADMIN_TOKEN` scope

---

## Change 9: New file — DEPLOYMENT-CHECKLIST.md

**File:** `DEPLOYMENT-CHECKLIST.md`

Step-by-step deployment guide with checkboxes covering: Supabase setup, Slack app creation, Figma PAT generation, encryption key, Vercel deployment + env vars, plugin URL updates, and GitHub push.

---

## Files NOT changed (kept as-is)

These files still reference Figma OAuth but are intentionally kept:

- `backend/api/auth/figma.js` — Optional Figma OAuth initiation endpoint
- `backend/api/auth/figma-callback.js` — Optional Figma OAuth callback endpoint
- `backend/lib/validators.js` — `assertFigmaTeamId` still exported (not imported by config.js anymore, but could be used elsewhere)
- `database/schema.sql` — `figma_tokens` table still exists (not used by the main flow, but no harm keeping it)
- `backend/vercel.json` — Still routes to figma auth endpoints (optional, no harm)

---

## Two placeholders that need updating before deploy

1. **`figma-plugin/ui.html` line ~400:** `const API_BASE = "https://library-pulse.vercel.app"` → change to actual Vercel URL
2. **`figma-plugin/manifest.json` line 11:** `"allowedDomains": ["https://library-pulse.vercel.app"]` → change to actual Vercel URL

> Note: confirmed the live URL **is** `https://library-pulse.vercel.app`, so these
> placeholders are already correct and need no change.

---

# Session 2 — Multi-tenant rebuild (file-context webhooks + real auth)

The single-team model from Session 1 (`FIGMA_ADMIN_TOKEN` + `FIGMA_TEAM_ID`) only
worked for the developer's own team. This session reworks it so **any** installer
works, and closes the security gaps found in review. Supersedes Changes 3–8 above
for the Figma side.

### Bug fix: Connect Slack button did nothing

- **`figma-plugin/ui.html`**: `crypto.randomUUID()` was called before the
  try/catch and throws in Figma's non-secure-context iframe, killing the click
  handler silently. Added `makeStateNonce()` (randomUUID → getRandomValues →
  fallback) and a guard for a missing `currentUser`.

### New: real authentication (replaces spoofable `X-Figma-User`)

- **NEW `backend/lib/session.js`**: HMAC-signed session tokens derived from
  `ENCRYPTION_KEY` (no new env var). `mintSession` / `verifySession` /
  `requireSession`.
- **`backend/api/auth/figma-callback.js`**: mints a session token on successful
  Figma OAuth and returns it via `auth-status` `result_data.session_token`.
- **`backend/api/config.js`**: all handlers now authenticate via
  `requireSession(req)` (bearer token) instead of trusting a header.

### New: file-context webhooks via per-user OAuth

- **`backend/api/config.js`**: `ensureWebhook(userId, fileKey)` registers a
  `LIBRARY_PUBLISH` webhook with `context: "file"`, `context_id: <fileKey>`
  using the user's decrypted OAuth token. Added `getFigmaAccessToken` (expiry
  check → `figma_reauth_required`) and `teardownWebhook` on config delete.
  Removed all `FIGMA_ADMIN_TOKEN` / `FIGMA_TEAM_ID` usage.

### Webhook receiver hardening

- **`backend/api/webhook.js`**: binds passcode to the webhook's owner + file,
  scopes config lookup by `figma_user_id` + `file_key`, rejects non-active /
  file-mismatched events, constant-time passcode compare via SHA-256 (no length
  leak), and per-channel delivery dedupe (retry re-drives only missing channels).
- **`backend/lib/idempotency.js`**: added `hasSentDelivery(eventKey, configId,
channelId)`.

### Atomicity

- **`backend/lib/auth-session.js`**: `claimAuthSession` is now a single
  conditional `UPDATE … RETURNING` (was a non-atomic SELECT).

### Plugin UI

- **`figma-plugin/ui.html`**: re-added the **Connect Figma** step (Step 2,
  Configure → Step 3), sends `Authorization: Bearer <sessionToken>`, stores
  `figma_auth`, and added a `ui-ready` handshake.
- **`figma-plugin/code.js`**: `INIT_PAYLOAD` re-sent on `ui-ready` to fix the
  init-message race; added `ui-ready` to the allow-list.
- **`figma-plugin/manifest.json`**: reasoning text mentions Figma OAuth again.

### Database (run `database/migrations/001-file-context-webhooks.sql` once)

- `figma_webhooks`: added `context`, `context_id`, `figma_user_id`; dropped the
  team-unique constraint; added `UNIQUE(figma_user_id, context_id)`.
- `configurations.figma_team_id` made nullable.
- `notification_log.event_key` added (per-channel dedupe).
- `database/schema.sql` updated to match for fresh installs.

### Tests

- **NEW `tests/session.test.js`** (9 tests). Full suite: 44 tests passing.

### Env var changes (Vercel)

- **Add**: `FIGMA_CLIENT_ID`, `FIGMA_CLIENT_SECRET` (you already have these).
- **Remove (optional)**: `FIGMA_ADMIN_TOKEN`, `FIGMA_TEAM_ID` (now unused).
- Figma OAuth app needs redirect URL `<PUBLIC_URL>/api/auth/figma-callback` and
  the `webhooks:write` scope.
