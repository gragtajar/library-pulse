# Library Pulse

[![CI](https://github.com/gragtajar/library-pulse/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/gragtajar/library-pulse/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

**Figma plugin that sends rich Slack notifications whenever a Figma library is published.**

When someone on your team publishes changes to a Figma library (components, styles, variables), Library Pulse posts a detailed Slack message listing everything that was added, modified, or removed — along with who published and the description they entered.

> **Install:** _Library Pulse is currently in review on the Figma Community._ Once approved, the listing URL goes here.

---

## Quick links

- [Architecture overview](./ARCHITECTURE.md) — three runtimes, data flow, security boundaries
- [Contributing guide](./CONTRIBUTING.md) — setup, branching, PR checklist
- [Security & privacy policy](./SECURITY.md) — data handling and how to report a vulnerability
- [Architecture Decision Records](./docs/adrs/)
- [Runbooks](./docs/runbooks/) — rollback, incident response, key rotation
- [Figma-plugin best practices](./docs/FIGMA-PLUGIN-BEST-PRACTICES.md) — 10 patterns this codebase enforces
- [Changelog](./CHANGELOG.md)

---

## Architecture

```
┌─────────────────┐       ┌──────────────────────┐       ┌───────────┐
│  Figma Plugin    │──────▶│  Vercel Backend       │──────▶│  Slack    │
│  (UI + code.js)  │ REST  │  (Serverless funcs)   │ API   │  Channel  │
└─────────────────┘       └──────────┬───────────┘       └───────────┘
                                     │
                           ┌─────────▼─────────┐
                           │  Supabase (Postgres)│
                           │  encrypted tokens   │
                           └─────────────────────┘
                                     ▲
                           ┌─────────┴─────────┐
                           │  Figma Webhooks    │
                           │  LIBRARY_PUBLISH   │
                           └───────────────────┘
```

**Three components:**

1. **Figma Plugin** — runs inside Figma; handles Figma + Slack OAuth, file selection, and channel configuration.
2. **Vercel Backend** — serverless functions for OAuth callbacks, configuration CRUD, and receiving Figma webhook events.
3. **Supabase Database** — stores encrypted Slack bot tokens, Figma OAuth tokens, webhook registrations, and user configurations.

Each user authorizes Figma with a single scope (`webhooks:write`), and the backend registers a **file-context** `LIBRARY_PUBLISH` webhook on the specific file they select, using their own access. There is no shared admin token and no team-admin requirement.

---

## Prerequisites

Before setting up Library Pulse, you'll need accounts/apps on these services:

| Service  | What you need             | Where to create                                                    |
| -------- | ------------------------- | ------------------------------------------------------------------ |
| Vercel   | Account + project         | [vercel.com](https://vercel.com)                                   |
| Supabase | Project (free tier works) | [supabase.com](https://supabase.com)                               |
| Slack    | OAuth App                 | [api.slack.com/apps](https://api.slack.com/apps)                   |
| Figma    | OAuth app (any plan)      | [figma.com/developers/apps](https://www.figma.com/developers/apps) |

---

## Setup Guide

### 1. Create the Supabase Database

1. Create a new Supabase project.
2. Go to the SQL Editor and run the contents of `database/schema.sql` (canonical full schema for a fresh install).
3. If you are upgrading an existing database, apply the incremental files in `database/migrations/` in order instead.
4. Note your **Project URL** and **Service Role Key** from Settings → API.

### 2. Create the Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App → From scratch**.
2. Name it **Library Pulse**, pick your workspace.
3. Under **OAuth & Permissions → Bot Token Scopes**, add:
   - `chat:write`
   - `chat:write.public`
   - `channels:read`
   - `groups:read`
4. Under **OAuth & Permissions → Redirect URLs**, add:
   ```
   https://YOUR-VERCEL-DOMAIN/api/auth/slack-callback
   ```
5. Note the **Client ID** and **Client Secret** from Basic Information.

### 3. Create the Figma OAuth App

1. Go to [figma.com/developers/apps](https://www.figma.com/developers/apps) → **Create a new app**.
2. Add an OAuth **redirect URL**: `https://YOUR-VERCEL-DOMAIN/api/auth/figma-callback`.
3. On the **OAuth scopes** page, select **only** `webhooks:write`. (That is the only Figma API the backend calls — it never reads file contents.)
4. Note the **Client ID** and **Client Secret** — you'll set them as `FIGMA_CLIENT_ID` / `FIGMA_CLIENT_SECRET`.

Each installer authorizes this app once; the backend then registers a `LIBRARY_PUBLISH` webhook on **their** selected file using **their** authorization. No team-admin rights and no shared token are required — only edit access to the file (which the user already has).

### 4. Deploy the Backend

1. Install the Vercel CLI:

   ```bash
   npm install -g vercel
   ```

2. From the `backend/` folder:

   ```bash
   cd backend
   npm install
   vercel
   ```

3. Set environment variables:

   ```bash
   vercel env add SUPABASE_URL
   vercel env add SUPABASE_SERVICE_ROLE_KEY
   vercel env add ENCRYPTION_KEY          # Generate: openssl rand -hex 32
   vercel env add SLACK_CLIENT_ID
   vercel env add SLACK_CLIENT_SECRET
   vercel env add SLACK_SIGNING_SECRET
   vercel env add FIGMA_CLIENT_ID          # Figma OAuth app client ID
   vercel env add FIGMA_CLIENT_SECRET      # Figma OAuth app client secret
   vercel env add PUBLIC_URL              # e.g. https://library-pulse.vercel.app
   ```

4. Deploy to production:

   ```bash
   vercel --prod
   ```

5. Update your Slack and Figma app redirect URLs with the actual Vercel domain.

### 5. Install the Figma Plugin

**For development:**

1. Set `API_BASE` in `figma-plugin/ui.html` to your Vercel deployment URL, and make sure your domain is in `manifest.json` → `networkAccess.allowedDomains`.
2. Open Figma → Plugins → Development → Import plugin from manifest.
3. Select `figma-plugin/manifest.json`.

**For public distribution:**

1. In the Figma desktop app: Plugins → Manage plugins → **Publish**. This uploads the plugin (`manifest.json`, `code.js`, `ui.html`) to Figma for review — you do not host the plugin code yourself.
2. Publishing your public **OAuth app** (with the `webhooks:write` scope) is a separate submission at [figma.com/developers/apps](https://www.figma.com/developers/apps).

---

## How It Works

### First-time setup (in the plugin)

1. **Open the plugin** — it connects your Figma account automatically. A browser tab opens once so you can authorize the app (scope: `webhooks:write`); no need to sign in again.
2. **Connect Slack** — OAuth flow opens in your browser. Authorize Library Pulse to post messages.
3. **Select a file** — the current file is auto-detected, or you can paste a file key/URL.
4. **Add Slack channels** — enter 1–3 channel IDs where notifications should be posted.
5. **Save & Activate** — the backend registers a `LIBRARY_PUBLISH` webhook on that file using your Figma authorization.

### When a library is published

1. Figma fires a `LIBRARY_PUBLISH` webhook event for that file.
2. The backend verifies the passcode (bound to the specific webhook, its owner, and its file), then looks up that owner's active configurations for the file.
3. For each configuration, it decrypts the stored Slack bot token and posts a rich Block Kit message to the configured channels (de-duplicated per channel so retries never double-post).
4. Each notification is logged to the `notification_log` table.

---

## Slack Message Format

```
📦 Library Published — My Design System
─────────────────────────────────────
Published by: Rajat        When: Jun 30, 2026, 2:15 PM

Description:
Updated button colors and added new badge component

─────────────────────────────────────
Components

➕ Added (2):
• Badge/Status
• Button/Tertiary

✏️ Modified (3):
• Button/Primary
• Input/Text Field
• Dialog/Modal

─────────────────────────────────────
Open in Figma · Library Pulse
```

---

## Security

- **Least privilege:** the plugin requests a single Figma scope, `webhooks:write`, and never reads file contents.
- **Encrypted at rest:** Slack bot tokens and Figma OAuth tokens are encrypted with AES-256-GCM. The encryption key lives only in a Vercel environment variable.
- **Real API auth:** config API calls are authenticated with a signed (HMAC-SHA256) session token minted after Figma OAuth and bound to the Figma user id, so a user can only read or change their own configuration.
- **Webhook authenticity & isolation:** each file webhook has its own high-entropy passcode, verified with a constant-time compare; a valid webhook can only post to the configuration owned by the user who registered it, for the exact file it was registered on.
- **CSRF / replay protection:** OAuth `state` is single-use and expires after 10 minutes; webhook retries are de-duplicated.
- **Row-Level Security** is enabled on all Supabase tables; the backend uses the service-role key.

See [SECURITY.md](./SECURITY.md) for the full policy and threat model.

---

## Environment Variables

| Variable                    | Description                                   |
| --------------------------- | --------------------------------------------- |
| `SUPABASE_URL`              | Supabase project URL                          |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (full DB access)    |
| `ENCRYPTION_KEY`            | 64-char hex string for AES-256-GCM encryption |
| `SLACK_CLIENT_ID`           | Slack OAuth app client ID                     |
| `SLACK_CLIENT_SECRET`       | Slack OAuth app client secret                 |
| `SLACK_SIGNING_SECRET`      | Slack app signing secret                      |
| `FIGMA_CLIENT_ID`           | Figma OAuth app client ID                     |
| `FIGMA_CLIENT_SECRET`       | Figma OAuth app client secret                 |
| `PUBLIC_URL`                | Your deployed Vercel URL (no trailing slash)  |

---

## Known Limitations

1. **Publishing requires a paid Figma plan.** Registering the webhook and running the plugin work on any account, but _publishing_ a Figma library (which fires the event) is a paid-plan Figma feature. The plugin itself is free.

2. **File-context webhooks.** Each config registers a webhook on its specific library file (Figma allows up to 3 webhooks per file). The publisher needs edit access to that file — which they have, since it's their library.

3. **Figma token expiry.** Webhook registration uses the user's OAuth token. If it has expired, the plugin asks them to reconnect Figma before saving. (Automatic refresh is a planned follow-up.)

---

## Project Structure

```
library-pulse/
├── figma-plugin/
│   ├── manifest.json      Figma plugin manifest (network allow-list, plugin id)
│   ├── code.js            Plugin sandbox (Figma API access; no network/DOM)
│   └── ui.html            Plugin UI (HTML + CSS + JS; talks to the backend)
├── backend/
│   ├── api/
│   │   ├── auth/
│   │   │   ├── slack.js           Slack OAuth initiation
│   │   │   ├── slack-callback.js  Slack OAuth callback
│   │   │   ├── figma.js           Figma OAuth initiation
│   │   │   └── figma-callback.js  Figma OAuth callback (mints the session token)
│   │   ├── auth-status.js         Poll OAuth completion
│   │   ├── config.js              Config CRUD + file-webhook registration/teardown
│   │   ├── webhook.js             Figma LIBRARY_PUBLISH receiver → Slack fan-out
│   │   └── health.js              Health check
│   ├── lib/
│   │   ├── supabase.js            Supabase client
│   │   ├── session.js             HMAC-signed session tokens
│   │   ├── auth-session.js        OAuth state lifecycle (atomic claim)
│   │   ├── encryption.js          AES-256-GCM helpers
│   │   ├── idempotency.js         Per-channel delivery de-dupe (notification_log)
│   │   ├── slack-blocks.js        Slack Block Kit builder
│   │   ├── validators.js          Input validation
│   │   ├── http.js / errors.js / logger.js / types.js
│   │   └── oauth-result-page.js   Escaped OAuth result page
│   ├── package.json
│   └── vercel.json
├── database/
│   ├── schema.sql                 Canonical full schema (fresh installs)
│   └── migrations/                Incremental migrations (existing installs)
├── tests/                         Vitest unit tests
├── docs/                          ADRs + runbooks
├── .env.example                   Environment variable template
└── README.md
```

---

## Support

Questions or issues: **rajatgarg1809@gmail.com**. Security reports: see [SECURITY.md](./SECURITY.md).

Licensed under [MIT](./LICENSE).
