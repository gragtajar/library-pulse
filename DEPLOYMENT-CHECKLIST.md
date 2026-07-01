# Library Pulse — Deployment Checklist

Everything you need to do, in order, to go from code to a working plugin.

---

## 1. Supabase (Database)

- [ ] Create a new Supabase project at [supabase.com](https://supabase.com) (free tier works)
- [ ] Go to **SQL Editor** → paste and run the contents of `database/schema.sql`
- [ ] Go to **Settings → API** and copy:
  - **Project URL** → you'll need this as `SUPABASE_URL`
  - **Service Role Key** (under "service_role") → `SUPABASE_SERVICE_ROLE_KEY`

---

## 2. Slack App

- [ ] Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App → From scratch**
- [ ] Name: **Library Pulse**, pick your workspace
- [ ] Go to **OAuth & Permissions → Bot Token Scopes**, add:
  - `chat:write`
  - `chat:write.public`
  - `channels:read`
  - `groups:read`
- [ ] Go to **OAuth & Permissions → Redirect URLs**, add:
  ```
  https://YOUR-VERCEL-DOMAIN/api/auth/slack-callback
  ```
  (Use a placeholder for now — you'll update this after Vercel deploy)
- [ ] Go to **Basic Information** and copy:
  - **Client ID** → `SLACK_CLIENT_ID`
  - **Client Secret** → `SLACK_CLIENT_SECRET`
  - **Signing Secret** → `SLACK_SIGNING_SECRET`

---

## 3. Figma OAuth App

Each installer authorizes their own file webhook — no shared token, no team admin.

- [ ] Go to [figma.com/developers/apps](https://www.figma.com/developers/apps) → **Create a new app**
- [ ] Add OAuth redirect URL: `https://YOUR-VERCEL-DOMAIN/api/auth/figma-callback`
- [ ] Ensure it can request the `webhooks:write` scope (plus a file-read scope)
- [ ] Copy **Client ID** → `FIGMA_CLIENT_ID`
- [ ] Copy **Client Secret** → `FIGMA_CLIENT_SECRET`

---

## 4. Generate Encryption Key

Run this in your terminal:

```bash
openssl rand -hex 32
```

Copy the 64-character output → `ENCRYPTION_KEY`

---

## 5. Vercel (Backend Deployment)

### 5.1 Initial deploy

```bash
cd library-pulse/backend
npm install
vercel          # Follow prompts to link/create project
```

### 5.2 Set environment variables

```bash
vercel env add SUPABASE_URL
vercel env add SUPABASE_SERVICE_ROLE_KEY
vercel env add ENCRYPTION_KEY
vercel env add SLACK_CLIENT_ID
vercel env add SLACK_CLIENT_SECRET
vercel env add SLACK_SIGNING_SECRET
vercel env add FIGMA_CLIENT_ID
vercel env add FIGMA_CLIENT_SECRET
vercel env add PUBLIC_URL              # Your Vercel URL, e.g. https://library-pulse.vercel.app
```

When asked which environments → select all three: **Production, Preview, Development**.

### 5.3 Production deploy

```bash
vercel --prod
```

### 5.4 Verify

```bash
curl https://YOUR-VERCEL-DOMAIN/api/health
# Should return: {"status":"ok","timestamp":"..."}
```

### 5.5 Update Slack redirect URL

- [ ] Go back to [api.slack.com/apps](https://api.slack.com/apps) → your app
- [ ] Update the **Redirect URL** under OAuth & Permissions to:
  ```
  https://YOUR-ACTUAL-VERCEL-DOMAIN/api/auth/slack-callback
  ```

---

## 6. Figma Plugin (Two things to update)

### 6.1 Update `API_BASE` in `figma-plugin/ui.html`

Find this line near the top of the `<script>` section:

```js
const API_BASE = "https://library-pulse.vercel.app";
```

Change it to your actual Vercel deployment URL.

### 6.2 Update `allowedDomains` in `figma-plugin/manifest.json`

```json
"networkAccess": {
  "allowedDomains": ["https://YOUR-ACTUAL-VERCEL-DOMAIN"],
  ...
}
```

### 6.3 Re-import in Figma

- [ ] Open Figma → **Plugins → Development → Import plugin from manifest**
- [ ] Select `figma-plugin/manifest.json`
- [ ] Run the plugin and test the full flow:
  1. Click **Connect to Slack** → complete OAuth in browser
  2. Select a file (current or manual ID)
  3. Add 1–3 Slack channel IDs
  4. Click **Save & Activate**
- [ ] Publish a small library change and verify the Slack message arrives

---

## 7. GitHub (Push Code)

- [ ] Push all code changes to the `library-pulse` repo
- [ ] Make sure `.env` files are NOT committed (`.gitignore` already handles this)

---

## Quick Reference: All Environment Variables

| Variable                    | Where to get it                                |
| --------------------------- | ---------------------------------------------- |
| `SUPABASE_URL`              | Supabase → Settings → API → Project URL        |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API → service_role key   |
| `ENCRYPTION_KEY`            | `openssl rand -hex 32`                         |
| `SLACK_CLIENT_ID`           | Slack app → Basic Information                  |
| `SLACK_CLIENT_SECRET`       | Slack app → Basic Information                  |
| `SLACK_SIGNING_SECRET`      | Slack app → Basic Information                  |
| `FIGMA_CLIENT_ID`           | figma.com/developers/apps → your app           |
| `FIGMA_CLIENT_SECRET`       | figma.com/developers/apps → your app           |
| `PUBLIC_URL`                | Your Vercel deployment URL (no trailing slash) |
