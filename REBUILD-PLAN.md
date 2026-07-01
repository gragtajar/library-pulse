# Library Pulse — Multi-Tenant Rebuild Plan

Goal: make the plugin work for **anyone** who installs it (any personal or work
Figma account), not just one team. Fix the security gaps from the review at the
same time.

Approach chosen: **file-context webhooks + per-user Figma OAuth.**
When a user saves a config, the backend registers a webhook _on that user's
selected file_ using _that user's own_ Figma authorization. This needs only
"Can edit" on the file (which they have) — no team-admin, no shared admin PAT,
no Team ID typing.

---

## What changes, and why

### A. Figma OAuth app (you do this once, in the browser)

- We need a Figma OAuth app so each user can authorize Library Pulse.
- You likely already created one in the original setup (`FIGMA_CLIENT_ID` /
  `FIGMA_CLIENT_SECRET`). We reuse it.
- Required redirect URL: `https://library-pulse.vercel.app/api/auth/figma-callback`
- Required scope: `webhooks:write` (the app already requests it).
- `FIGMA_ADMIN_TOKEN` and `FIGMA_TEAM_ID` are no longer used by the core flow
  (leave them in Vercel or delete — harmless).

### B. Plugin UI (`figma-plugin/ui.html`, `code.js`)

- Re-add a **"Connect Figma"** step (it was removed). This is what gives the
  backend permission to register the webhook on the user's behalf.
- No Team ID field (we use the selected file's key automatically).
- Send a real signed session token on API calls instead of the spoofable
  `X-Figma-User` header.
- Fix the `init` message race (ready-handshake) so the UI never hangs on
  "Loading".

### C. Real authentication (new `backend/lib/session.js`)

- After Figma OAuth, the backend mints a short-lived **HMAC-signed session
  token** bound to the verified Figma user id, and returns it to the plugin.
- `config.js` verifies that token's signature + expiry and derives the user id
  from it. This closes the "anyone can edit/delete anyone's config" hole (review
  finding H1) and makes the `Origin: null` CORS issue (H2) no longer load-bearing.

### D. Webhook registration (`backend/api/config.js`)

- `ensureWebhook` switches from team-context (admin PAT) to **file-context**
  using the user's decrypted OAuth token:
  `POST /v2/webhooks { event_type: LIBRARY_PUBLISH, context: "file",
context_id: <fileKey>, endpoint, passcode }`.
- Stored per (user, file). Handles token-expiry by asking the user to reconnect.

### E. Webhook receiver (`backend/api/webhook.js`)

- Bind the passcode to the specific webhook row + file, so one webhook can only
  post to the config that owns it (review C2/C3).
- Constant-time passcode compare without length leak; add timestamp freshness;
  dedupe per-channel delivery so a mid-fan-out crash can't silently drop or
  double-post (review H3).

### F. Database (`database/schema.sql` + migration)

- `figma_webhooks`: add `context`, `context_id`, `figma_user_id`; relax the
  team-unique constraint; key webhooks per file.
- Ship a migration `.sql` you run once in Supabase (additive, non-destructive).

### G. Auth-session atomicity (`backend/lib/auth-session.js`)

- Make `claimAuthSession` an atomic conditional UPDATE (review C1).

### H. Tests + docs

- Update Vitest tests; run them.
- Update README, PUBLISH-GUIDE, .env.example, DEPLOYMENT-CHECKLIST, and the
  Claude-Code changelog.

---

## What you'll need to do (I'll guide each, nothing now)

1. Confirm/curate the Figma OAuth app: redirect URL + `webhooks:write` scope.
2. Run one additive SQL migration in Supabase.
3. `vercel --prod` to redeploy.
4. Reload the dev plugin and test: Connect Slack, Connect Figma, save, publish.

## What stays untouched

- Supabase project, Slack app, encryption key, all existing env vars.
- The AES encryption, Slack Block Kit builder, OAuth result page (all reviewed
  as solid).
