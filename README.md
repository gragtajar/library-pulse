# Library Pulse

[![CI](https://github.com/gragtajar/library-pulse/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/gragtajar/library-pulse/actions/workflows/ci.yml)
[![CodeQL](https://github.com/gragtajar/library-pulse/actions/workflows/codeql.yml/badge.svg)](https://github.com/gragtajar/library-pulse/actions/workflows/codeql.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

**Figma plugin that sends rich Slack notifications whenever a Figma library is published.**

When someone on your team publishes changes to a Figma library (components, styles, variables), Library Pulse posts a detailed Slack message listing everything that was added, modified, or removed — along with who published and the description they entered.

---

## Quick links

- [Architecture overview](./ARCHITECTURE.md) — three runtimes, data flow, security boundaries
- [Contributing guide](./CONTRIBUTING.md) — setup, branching, PR checklist
- [Security policy](./SECURITY.md) — how to report a vulnerability
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

1. **Figma Plugin** — runs inside Figma; handles Slack OAuth, file selection, and channel configuration.
2. **Vercel Backend** — serverless functions for OAuth callbacks, configuration CRUD, and receiving Figma webhook events.
3. **Supabase Database** — stores encrypted Slack bot tokens, Figma OAuth tokens, webhook registrations, and user configurations.

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
2. Go to the SQL Editor and run the contents of `database/schema.sql`.
3. Note your **Project URL** and **Service Role Key** from Settings → API.

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
3. Ensure the app can request the `webhooks:write` scope (plus a file-read scope).
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

5. Update your Slack app redirect URL with the actual Vercel domain.

### 5. Install the Figma Plugin

**For development:**

1. Open Figma → Plugins → Development → Import plugin from manifest.
2. Select `figma-plugin/manifest.json`.
3. Update `API_BASE` in `ui.html` to your Vercel deployment URL.

**For public distribution:**

1. Go to your Figma plugin's listing page.
2. Upload the plugin files.
3. Submit for Figma Community review.
4. Update `manifest.json` with the actual plugin ID assigned by Figma.

---

## How It Works

### First-time setup (in the plugin)

1. **Connect Slack** — OAuth flow opens in your browser. Authorize Library Pulse to post messages.
2. **Connect Figma** — authorize Library Pulse to watch your file. Needs only edit access to the file, not team-admin.
3. **Select a file** — use the current file or enter a file ID/URL manually.
4. **Add Slack channels** — enter 1–3 channel IDs where notifications should be posted.
5. **Save & Activate** — the backend registers a `LIBRARY_PUBLISH` webhook on that file using your Figma authorization.

### When a library is published

1. Figma fires a `LIBRARY_PUBLISH` webhook event for that file.
2. The backend verifies the passcode (bound to the webhook's owner + file), then looks up that owner's active configurations for the file.
3. For each configuration, it decrypts the stored Slack bot token and posts a rich Block Kit message to the configured channels.
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

- **Slack bot tokens** are encrypted with AES-256-GCM before storage. The encryption key never leaves Vercel environment variables.
- **Figma access is per-user OAuth.** Each user's token is encrypted at rest and used only to register a webhook on their own file — there is no shared admin token.
- **Config API calls are authenticated** with a signed (HMAC) session token minted after Figma OAuth, so a user can only read or change their own configurations.
- **Webhook passcodes** are randomly generated per team and verified on every incoming event.
- **OAuth state parameters** are validated to prevent CSRF attacks. Sessions expire after 10 minutes.
- **Row-Level Security** is enabled on all Supabase tables. The backend uses the service role key.

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

1. **Variables/Tokens**: Figma's `LIBRARY_PUBLISH` webhook may not itemize individual variable changes yet. The handler is pre-coded to support `created_variables`, `modified_variables`, and `deleted_variables` when Figma adds them.

2. **File-context webhooks**: Each config registers a webhook on its specific library file (Figma allows up to 3 webhooks per file). The publisher must have edit access to that file — which they do, since it's their library.

3. **Figma token expiry**: Webhook registration uses the user's OAuth token. If it has expired, the plugin asks them to reconnect Figma before saving. (Automatic refresh is a planned follow-up.)

---

## Project Structure

```
library-pulse/
├── figma-plugin/
│   ├── manifest.json      Figma plugin manifest
│   ├── code.js            Plugin sandbox code (Figma API access)
│   └── ui.html            Plugin UI (HTML + CSS + JS)
├── backend/
│   ├── api/
│   │   ├── auth/
│   │   │   ├── slack.js           Slack OAuth initiation
│   │   │   ├── slack-callback.js  Slack OAuth callback
│   │   │   ├── figma.js           Figma OAuth initiation (optional)
│   │   │   └── figma-callback.js  Figma OAuth callback (optional)
│   │   ├── auth-status.js         Poll OAuth completion
│   │   ├── config.js              CRUD for configurations
│   │   ├── webhook.js             Figma webhook receiver
│   │   └── health.js              Health check
│   ├── lib/
│   │   ├── supabase.js            Supabase client
│   │   ├── encryption.js          AES-256-GCM helpers
│   │   └── slack-blocks.js        Slack Block Kit builder
│   ├── package.json
│   └── vercel.json
├── database/
│   └── schema.sql                 Supabase migration
├── .env.example                   Environment variable template
└── README.md
```
