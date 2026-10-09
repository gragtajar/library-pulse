# Library Pulse

[![CI](https://github.com/gragtajar/library-pulse/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/gragtajar/library-pulse/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

**Figma plugin that tells your team, in Slack, in Google Chat or by email, whenever a Figma library is published.**

When someone on your team publishes changes to a Figma library (components, styles, variables), Library Pulse posts a detailed message in Slack or Google Chat, or emails up to five addresses, listing everything that was added, modified, or removed, along with who published and the description they entered. Each file uses one destination: Slack, Google Chat or email.

> **Install:** _Library Pulse is live on the Figma Community._ (Listing URL goes here.)

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
┌─────────────────┐       ┌──────────────────────┐ API   ┌─────────────────┐
│  Figma Plugin    │──────▶│  Vercel Backend       │──────▶│  Slack channels  │
│  (UI + code.js)  │ REST  │  (Serverless funcs)   │       ├─────────────────┤
└─────────────────┘       │                       │──────▶│  Amazon SES      │
                          └──────────┬───────────┘ API   │  (email)         │
                                     │                   └─────────────────┘
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

1. **Figma Plugin** — runs inside Figma; handles the Figma, Slack and Google sign-ins, file selection, the destination choice (Slack, Google Chat or email), and the channels, spaces or addresses.
2. **Vercel Backend** — serverless functions for OAuth callbacks, configuration CRUD, receiving Figma webhook events, Google Chat's app events, and the confirm/unsubscribe links in emails. It posts to Slack and Google Chat and sends email through Amazon SES.
3. **Supabase Database** — stores encrypted Slack bot tokens, Google refresh tokens and Figma OAuth tokens, webhook registrations, and the per-file configurations (including each email address and whether it has confirmed).

Configuration is **org-shared per file**: anyone with edit access to a file manages that file's single shared config. Each user authorizes Figma with three scopes — `webhooks:write` (register the `LIBRARY_PUBLISH` webhook on the file), `webhooks:read` (list a file's webhooks to confirm a user can access it before showing or editing that file's shared config), and `library_assets:read` (resolve one of the open file's published component/style keys to the file's id — Figma doesn't expose file ids to public Community plugins, so the plugin identifies the file from its own published assets, with no manual input). The backend registers a **file-context** webhook using the setter's own access — no shared admin token, no team-admin requirement.

---

## Prerequisites

Before setting up Library Pulse, you'll need accounts/apps on these services:

| Service  | What you need                              | Where to create                                                    |
| -------- | ------------------------------------------ | ------------------------------------------------------------------ |
| Vercel   | Account + project                          | [vercel.com](https://vercel.com)                                   |
| Supabase | Project (free tier works)                  | [supabase.com](https://supabase.com)                               |
| Slack    | OAuth App                                  | [api.slack.com/apps](https://api.slack.com/apps)                   |
| Figma    | OAuth app (any plan)                       | [figma.com/developers/apps](https://www.figma.com/developers/apps) |
| AWS      | Amazon SES, only for the email destination | [aws.amazon.com/ses](https://aws.amazon.com/ses/)                  |

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
   - `users:read`
   - `usergroups:read`

   (Keep this list in sync with `backend/lib/slack-oauth.js` — the scopes the backend actually requests during OAuth.)

4. Under **OAuth & Permissions → Redirect URLs**, add:
   ```
   https://YOUR-VERCEL-DOMAIN/api/auth/slack-callback
   ```
5. Note the **Client ID** and **Client Secret** from Basic Information.

### 3. Create the Figma OAuth App

1. Go to [figma.com/developers/apps](https://www.figma.com/developers/apps) → **Create a new app**.
2. Add an OAuth **redirect URL**: `https://YOUR-VERCEL-DOMAIN/api/auth/figma-callback`.
3. On the **OAuth scopes** page, select `webhooks:write`, `webhooks:read`, **and** `library_assets:read`. (`webhooks:write` registers/deletes the `LIBRARY_PUBLISH` webhook; `webhooks:read` lists a file's webhooks to confirm a user can access it before showing or editing that file's shared config; `library_assets:read` resolves a published component/style key to its file id so the plugin can identify the open file automatically. The app never reads file contents. Keep this list in sync with `backend/lib/figma-oauth.js` — the scopes the backend actually requests.)
4. Note the **Client ID** and **Client Secret** — you'll set them as `FIGMA_CLIENT_ID` / `FIGMA_CLIENT_SECRET`.

Each installer authorizes this app once; the backend then registers a `LIBRARY_PUBLISH` webhook on **their** selected file using **their** authorization. No team-admin rights and no shared token are required — only edit access to the file (which the user already has).

### 4. Set up email sending (optional)

Only needed for the **email** destination. Library Pulse sends through [Amazon SES](https://aws.amazon.com/ses/).

1. Open **Amazon SES** in the AWS region you'll send from. Vercel's default function region is `iad1`, which is AWS `us-east-1`. SES identities, the sandbox, and sending quotas are all per region.
2. **Create a domain identity** for the domain you'll send from, with Easy DKIM, and add the three CNAME records SES shows to your DNS. AWS recommends a subdomain (for example `updates.example.com`) for this kind of mail. DNS changes can take up to 72 hours to be detected.
3. **Verify the mailbox** (an email identity) that should receive replies and SES's bounce and complaint forwards. While the account is in the SES sandbox, every recipient has to be a verified identity as well, so this is also the address you test with.
4. **Request production access** (SES → Account dashboard → Request production access; mail type _Transactional_). Until it is granted, the account can only email verified addresses, at most 200 messages per 24 hours and 1 per second.
5. **Create an IAM user** for the backend whose only permission is sending from your address, then create an access key for it:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": ["ses:SendEmail", "ses:SendRawEmail"],
         "Resource": "*",
         "Condition": {
           "StringEquals": { "ses:FromAddress": "notifications@updates.example.com" }
         }
       }
     ]
   }
   ```

6. (Recommended) Publish a DMARC record for the sending domain, starting with `p=none`.

Apply `database/migrations/006-email-destination.sql` if your database predates it.

### 5. Set up Google Chat (optional)

Only needed for the **Google Chat** destination. Users sign in with Google from the plugin, pick the spaces they belong to, and Library Pulse adds itself to those spaces; updates are then posted by the Library Pulse Chat app itself. Everything below happens in one Google Cloud project owned by a Google Workspace account (the Chat API requires "A Business or Enterprise Google Workspace account").

1. **Cloud project:** create one under your Workspace organisation, enable the **Google Chat API**, and note the **project number**.
2. **OAuth consent screen** (Google Auth platform): External audience. Branding links: home page, privacy policy and terms on a domain you verified in Search Console. Data Access: add `https://www.googleapis.com/auth/chat.spaces.readonly`, `https://www.googleapis.com/auth/chat.memberships.app`, `openid` and `email`. The two Chat scopes are classed _sensitive_ by Google: while the app is in Testing only listed test users can sign in (their grants expire after 7 days); in production, users see an "unverified app" screen and a lifetime cap of 100 users applies until Google's verification of those scopes completes.
3. **OAuth client:** Web application, authorized redirect URI `<GOOGLE_PUBLIC_URL>/api/gchat/callback`. Copy the client id and secret into Vercel.
4. **Chat app configuration** (Chat API → Configuration): clear _Build this Chat app as a Google Workspace add-on_; app name, avatar URL and description; Functionality: _Join spaces and group conversations_; Connection settings: HTTP endpoint URL `<GOOGLE_PUBLIC_URL>/api/gchat/events`, **Authentication Audience: HTTP endpoint URL**; Visibility: the people or groups who may use it (or a Marketplace listing for other organisations); App status: Live.
5. **The app's own credentials** (to post as the app): a service account in the project, with either
   - **Workload Identity Federation** from Vercel's OIDC token (no key stored): enable _Secure Backend Access with OIDC Federation_ (Team mode) in the Vercel project; in Google Cloud create a workload identity pool and an OIDC provider with issuer `https://oidc.vercel.com/<team-slug>`, allowed audience `https://vercel.com/<team-slug>`, mapping `google.subject = assertion.sub`; grant the principal `…/subject/owner:<team>:project:<project>:environment:production` the _Workload Identity User_ role on the service account; set `GCP_PROJECT_NUMBER`, `GCP_WORKLOAD_IDENTITY_POOL_ID`, `GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID`, `GCP_SERVICE_ACCOUNT_EMAIL`. Google's docs require billing to be enabled on the project for this, or
   - a **service-account JSON key** in `GOOGLE_SERVICE_ACCOUNT_KEY` (organisations created on or after 3 May 2024 block key creation by default; an organisation-policy override is needed).
6. Set `GOOGLE_PUBLIC_URL` to the origin Google talks to (a custom domain on the Vercel project), `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

Apply `database/migrations/007-google-chat.sql` and `database/migrations/008-google-chat-columns.sql` if your database predates them (008 adds two columns that an early copy of 007 lacked; it is safe to run either way).

### 6. Deploy the Backend

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

   # Email destination only (see step 4):
   vercel env add SES_REGION              # e.g. us-east-1
   vercel env add SES_ACCESS_KEY_ID
   vercel env add SES_SECRET_ACCESS_KEY
   vercel env add EMAIL_FROM              # e.g. Library Pulse <notifications@updates.example.com>
   vercel env add EMAIL_FEEDBACK_ADDRESS  # verified mailbox for replies and bounce/complaint forwards

   # Google Chat destination only (see step 5):
   vercel env add GOOGLE_PUBLIC_URL       # e.g. https://updates.example.com
   vercel env add GOOGLE_CLIENT_ID
   vercel env add GOOGLE_CLIENT_SECRET
   vercel env add GCP_PROJECT_NUMBER      # Workload Identity Federation…
   vercel env add GCP_WORKLOAD_IDENTITY_POOL_ID
   vercel env add GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID
   vercel env add GCP_SERVICE_ACCOUNT_EMAIL
   # …or instead a key: vercel env add GOOGLE_SERVICE_ACCOUNT_KEY
   ```

4. Deploy to production:

   ```bash
   vercel --prod
   ```

5. Update your Slack and Figma app redirect URLs with the actual Vercel domain.

### 7. Install the Figma Plugin

**For development:**

1. Set `API_BASE` in `figma-plugin/ui.html` to your Vercel deployment URL, and make sure your domain is in `manifest.json` → `networkAccess.allowedDomains`.
2. Open Figma → Plugins → Development → Import plugin from manifest.
3. Select `figma-plugin/manifest.json`.

**For public distribution:**

1. In the Figma desktop app: Plugins → Manage plugins → **Publish**. This uploads the plugin (`manifest.json`, `code.js`, `ui.html`) to Figma for review — you do not host the plugin code yourself.
2. Publishing your public **OAuth app** (with the `webhooks:write`, `webhooks:read`, and `library_assets:read` scopes) is a separate submission at [figma.com/developers/apps](https://www.figma.com/developers/apps) — and any later **scope change requires a re-review** before it takes effect. Never add a scope to the backend's authorize URL before Figma approves it (an unapproved scope 400s every sign-in).

---

## How It Works

### First-time setup (in the plugin)

The plugin walks you through four numbered steps:

1. **Connect Figma** — automatic on open. A browser tab opens once so you can authorize the app (scopes: `webhooks:write`, `webhooks:read`, `library_assets:read`); no need to sign in again.
2. **Choose where to get updates** — a list of **Slack** (up to 3 channels), **Google Chat** (up to 3 spaces) and **Email** (up to 5 addresses), one per file (you can switch later). Choosing Slack shows **Connect to Slack**, an OAuth flow in your browser. Choosing Google Chat shows Google's own **Sign in with Google** button (built to Google's branding guidelines), which opens the Google sign-in in your browser; Google lists the two Chat permissions with a checkbox each, and both must be selected (the plugin says so before you sign in). Email has nothing to connect.
3. **Select file** — the file you have open is **identified automatically**: Figma doesn't expose file ids to Community plugins, so the plugin resolves one of the file's own published component/style keys to its file id via the backend. (A library that has never been published shows "publish it once, then Refresh".) There's no way to target a different file.
4. **Add channels, spaces or addresses** — depending on step 2:
   - **Slack:** pick 1–3 channels from a **searchable dropdown** (sorted by member count; `#` public, 🔒 private). Optionally add a **custom message** posted with every notification — type `@` to mention people or user groups from a searchable picker (they're pinged in Slack).
   - **Google Chat:** pick 1–3 named spaces you belong to from a **searchable dropdown**. When you save, Library Pulse adds itself to each new space. The optional custom message is posted with every update.
   - **Email:** type 1–5 addresses, one per line or separated by commas. They are checked as you type, and a live counter (`2/5 addresses`) shows how many of the five are used. Each new address is sent a **confirmation email** and only receives updates once its owner confirms. The optional custom message is included in every email as plain text.

   Then **Save & Activate** — the backend registers a `LIBRARY_PUBLISH` webhook on that file using your Figma authorization.

If the file already has a config, anyone with edit access sees the same **shared config** and can edit its channels, spaces or addresses and its custom message — they don't start from a blank setup. For email, the dashboard lists every address with its state (Confirmed, Pending, Unsubscribed). Switching a file to another destination asks for a second click, because it removes the current destination's channels, spaces or addresses for everyone. Only the **original setter** can remove the Figma connection (delete the file's webhook); any editor can pause/disable notifications.

### When a library is published

1. Figma fires a `LIBRARY_PUBLISH` webhook event for that file.
2. The backend verifies the passcode (bound to the specific webhook and its file), then looks up the file's single active configuration.
3. **Slack config:** it decrypts the stored Slack bot token and posts a rich Block Kit message to the configured channels (de-duplicated per channel so retries never double-post). The team's custom message — with real `@` mentions for picker-chosen people/groups — is included; publish times render in **each viewer's own timezone** (Slack date token). If Slack rejects the token, the config is flagged so the plugin can show a "reconnect" banner.
4. **Email config:** it sends one email per **confirmed** address through Amazon SES (de-duplicated per recipient, so a retry never emails anyone twice). The publish time is shown in the time zone saved with the address list. Every email has an unsubscribe link and one-click unsubscribe headers. If sends fail, the config is flagged so the plugin shows a "Deliveries failing" banner.
5. **Google Chat config:** it posts the update in each chosen space as the Library Pulse app (de-duplicated per space, so a retry never posts twice). Spaces that removed the app, or were paused with `@Library Pulse stop`, are skipped. The publish time is shown in the time zone saved with the spaces. If posts fail, the config is flagged so the plugin shows a "Deliveries failing" banner.
6. Each notification is logged to the `notification_log` table.

---

## Slack Message Format

```
📦 Library Published — My Design System
─────────────────────────────────────
Published by: Rajat        When: Jun 30, 2026, 2:15 PM   (shown in each viewer's timezone)

Description:
Updated button colors and added new badge component

💬 Heads up @design-team — new Badge set is live, migrate by Friday.

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

## Email Format

Subject: `My Design System published by Rajat`

```
My Design System
Library published in Figma

PUBLISHED BY            WHEN
Rajat                   30 Jun 2026, 19:45 Asia/Kolkata (GMT+5:30)

DESCRIPTION
Updated button colors and added new badge component

TEAM NOTE
Heads up, the new Badge set is live. Migrate by Friday.
─────────────────────────────────────
Components
Added (2)
• Badge/Status
• Button/Tertiary
Modified (3)
• Button/Primary
• Input/Text Field
• Dialog/Modal

[ Open in Figma ]

You're receiving this because ana@example.com is on the notification list
for "My Design System" in Library Pulse, a Figma plugin.
Unsubscribe
```

Sent as HTML with a plain-text alternative. Each list shows up to 20 items, then "…and N more", like the Slack message.

---

## Security

- **Least privilege:** the plugin requests only `webhooks:write` + `webhooks:read` + `library_assets:read` on Figma — enough to manage the file's webhook, confirm a caller can access the file, and resolve a published asset key to the file's id — and never reads file contents. On Slack it requests exactly the scopes its features consume (posting, the channel picker, the mention picker); the scope lists are pinned by tests on both sides.
- **Mentions can't be injected:** free text in the custom message is escaped — only mentions chosen from the picker (validated Slack ids) ever ping anyone. A pasted `@channel` or `<!channel>` stays plain text.
- **Email is opt-in, per address:** an address receives notifications only after its owner confirms from a link sent to that address (double opt-in). Every notification carries an unsubscribe link and one-click unsubscribe headers (RFC 8058). Unsubscribing takes effect immediately, and an editor can't undo it by re-saving the list.
- **Signed, expiring email links:** confirm and unsubscribe links carry an HMAC-SHA256 token bound to the file's config and the address (confirm links expire after 7 days). Both pages act only when their button is pressed (a `POST`), so mail scanners that follow links can't confirm or unsubscribe anyone.
- **Bounded sending:** at most 5 addresses per file, 3 confirmation emails per address per day, and 150 notification emails per file per day.
- **Google Chat posts as the app, never as a person:** the user's Google token is used only to list their spaces and to add the app to the ones they chose; updates are posted with the app's own credentials (`chat.bot`), obtained through Workload Identity Federation from Vercel's OIDC token so no key has to be stored. Chat's events are accepted only with a valid Google-signed ID token for our endpoint. Text in updates has Chat's `<…>` syntax neutralised, so a component named `<users/all>` can't ping a space.
- **Encrypted at rest:** Slack bot tokens, Figma OAuth tokens and Google refresh tokens are encrypted with AES-256-GCM. The encryption key lives only in a Vercel environment variable.
- **Real API auth:** config API calls are authenticated with a signed (HMAC-SHA256) session token minted after Figma OAuth and bound to the Figma user id.
- **Org-shared access control:** config is keyed by file. The original setter is trusted for their own file; any other user is verified against the file with their own Figma token (`webhooks:read`) before the backend returns or changes that file's shared config.
- **Webhook authenticity & isolation:** each file webhook has its own high-entropy passcode, verified with a constant-time compare; a valid webhook can only post to the configuration owned by the user who registered it, for the exact file it was registered on.
- **CSRF / replay protection:** OAuth `state` is single-use and expires after 10 minutes; webhook retries are de-duplicated.
- **Row-Level Security** is enabled on all Supabase tables; the backend uses the service-role key.

See [SECURITY.md](./SECURITY.md) for the full policy and threat model.

---

## Environment Variables

| Variable                                 | Description                                                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `SUPABASE_URL`                           | Supabase project URL                                                                                    |
| `SUPABASE_SERVICE_ROLE_KEY`              | Supabase service role key (full DB access)                                                              |
| `ENCRYPTION_KEY`                         | 64-char hex string for AES-256-GCM encryption                                                           |
| `SLACK_CLIENT_ID`                        | Slack OAuth app client ID                                                                               |
| `SLACK_CLIENT_SECRET`                    | Slack OAuth app client secret                                                                           |
| `SLACK_SIGNING_SECRET`                   | Slack app signing secret                                                                                |
| `FIGMA_CLIENT_ID`                        | Figma OAuth app client ID                                                                               |
| `FIGMA_CLIENT_SECRET`                    | Figma OAuth app client secret                                                                           |
| `PUBLIC_URL`                             | Your deployed Vercel URL (no trailing slash)                                                            |
| `SES_REGION`                             | Email only: AWS region of your SES identity (e.g. `us-east-1`)                                          |
| `SES_ACCESS_KEY_ID`                      | Email only: access key of the IAM user allowed to send                                                  |
| `SES_SECRET_ACCESS_KEY`                  | Email only: that user's secret key                                                                      |
| `EMAIL_FROM`                             | Email only: verified sender, e.g. `Library Pulse <notifications@updates.example.com>`                   |
| `EMAIL_FEEDBACK_ADDRESS`                 | Email only, recommended: verified mailbox that receives replies and SES's bounce and complaint forwards |
| `GOOGLE_PUBLIC_URL`                      | Google Chat only: the origin Google talks to (redirect URI and Chat endpoint), defaults to `PUBLIC_URL` |
| `GOOGLE_CLIENT_ID`                       | Google Chat only: OAuth client id (Web application)                                                     |
| `GOOGLE_CLIENT_SECRET`                   | Google Chat only: that client's secret                                                                  |
| `GCP_PROJECT_NUMBER`                     | Google Chat only, WIF: the Cloud project number                                                         |
| `GCP_WORKLOAD_IDENTITY_POOL_ID`          | Google Chat only, WIF: pool id (e.g. `vercel`)                                                          |
| `GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID` | Google Chat only, WIF: provider id (e.g. `vercel`)                                                      |
| `GCP_SERVICE_ACCOUNT_EMAIL`              | Google Chat only, WIF: the service account that posts as the app                                        |
| `GOOGLE_SERVICE_ACCOUNT_KEY`             | Google Chat only, alternative to WIF: the service account's JSON key (raw or base64)                    |

The SES credentials use their own names on purpose. Vercel's function runtime can pre-populate the standard `AWS_*` variables with values that grant no permissions, and the backend passes `SES_*` to the SDK explicitly so the two never mix.

---

## Known Limitations

1. **Publishing requires a paid Figma plan.** Registering the webhook and running the plugin work on any account, but _publishing_ a Figma library (which fires the event) is a paid-plan Figma feature. The plugin itself is free.

2. **File-context webhooks.** Each config registers a webhook on its specific library file (Figma allows up to 3 webhooks per file). The publisher needs edit access to that file — which they have, since it's their library.

3. **Figma token expiry.** Webhook registration uses the user's OAuth token. If it has expired, the plugin asks them to reconnect Figma before saving. (Automatic refresh is a planned follow-up.)

4. **The library must have been published at least once** for automatic file identification — the plugin resolves the file id from its own published components/styles (Figma hides file ids from Community plugins). A never-published library shows "publish it once, then Refresh". A library publishing _only variables_ (no styles or components) can't be identified — published-variables lookups are Enterprise-only in Figma's API.

5. **Slack user groups need a paid Slack plan.** The `@`-mention picker lists people on any plan; user groups only exist on Standard and above (free workspaces simply see people).

6. **Very large Slack workspaces.** The pickers fetch up to ~9,600 raw records per directory (with a per-workspace 10-minute cache). Beyond that, the list is served partially and the UI shows a "list may be incomplete" hint.

7. **Email shows one time zone per file.** Slack shows each reader their own local time; email can't. Publish times use the time zone of whoever last saved the address list, and the email names that zone.

8. **Bounced addresses aren't marked in the plugin yet.** Amazon SES stops delivering to an address that hard-bounces (its account-level suppression list) and forwards bounce and complaint notices to `EMAIL_FEEDBACK_ADDRESS`, but the plugin still lists the address as Confirmed.

9. **A lost confirmation email** is re-sent by removing the address and adding it again (at most 3 per address per day).

10. **One destination per file.** A file notifies Slack, email or Google Chat, not several.

11. **Vercel Hobby allows 12 functions per deployment**, and `backend/api/` has 8. Related endpoints share a function (`lib/dispatch.js`); a test guards the count.

12. **Google Chat before verification.** The two Chat scopes the sign-in asks for are classed sensitive by Google. Until Google verifies them, an app in production shows an "unverified app" warning and stops at 100 users for the project's lifetime; an app in Testing is limited to listed test users, whose grants expire after 7 days (the plugin then asks them to sign in with Google again).

13. **Google Chat shows one time zone per file**, like email: the zone of whoever last saved the spaces.

14. **Google Chat lists named spaces only.** Group chats and direct messages have no display name to pick by, so the picker shows spaces (`spaceType = "SPACE"`).

---

## Project Structure

```
library-pulse/
├── figma-plugin/
│   ├── manifest.json      Figma plugin manifest (network allow-list, plugin id)
│   ├── code.js            Plugin sandbox (Figma API access; no network/DOM)
│   └── ui.html            Plugin UI (HTML + CSS + JS; talks to the backend)
├── backend/
│   ├── api/                       One Vercel Function per file; vercel.json maps the public paths
│   │   ├── auth.js                /api/auth/{figma,slack}(-callback), /api/auth-status
│   │   ├── config.js              /api/config: config CRUD + file-webhook registration/teardown
│   │   ├── figma.js               /api/figma/resolve-file
│   │   ├── gchat.js               /api/gchat/{start,callback,spaces,events}
│   │   ├── slack.js               /api/slack/channels, /api/slack/mentions
│   │   ├── email.js               Links in emails: ?action=confirm | unsubscribe (GET page, POST acts)
│   │   ├── webhook.js             Figma LIBRARY_PUBLISH receiver → Slack or email fan-out
│   │   └── health.js              Health check
│   ├── lib/
│   │   ├── dispatch.js            Several public paths on one Function (`?fn=`)
│   │   ├── handlers/
│   │   │   ├── auth-slack-start.js      Slack OAuth initiation
│   │   │   ├── auth-slack-callback.js   Slack OAuth callback
│   │   │   ├── auth-figma-start.js      Figma OAuth initiation
│   │   │   ├── auth-figma-callback.js   Figma OAuth callback (mints the session token)
│   │   │   ├── auth-status.js           Poll OAuth completion
│   │   │   ├── figma-resolve-file.js    Published-asset key → file id (auto file identification)
│   │   │   ├── gchat-start.js           Google sign-in initiation
│   │   │   ├── gchat-callback.js        Google sign-in callback (stores the refresh token)
│   │   │   ├── gchat-spaces.js          Space-picker directory (spaces.list, user token)
│   │   │   ├── gchat-events.js          Google Chat interaction events (added, removed, @mention)
│   │   │   ├── slack-channels.js        Channel-picker directory (conversations.list)
│   │   │   └── slack-mentions.js        Mention-picker directory (users.list + usergroups.list)
│   │   ├── google-oauth.js        Google OAuth: authorize URL, code exchange, refresh, ID token
│   │   ├── google-chat.js         Chat API calls: spaces.list, members.create (users/app), messages.create
│   │   ├── google-app-auth.js     The app's own token (chat.bot) via Vercel OIDC → WIF, or a key
│   │   ├── google-installations.js  Connected Google accounts, user tokens, revocation
│   │   ├── gchat-message.js       The update in Chat markup (mention syntax neutralised)
│   │   ├── gchat-delivery.js      Add the app to new spaces; per-space deduped fan-out
│   │   ├── gchat-events.js        Verify Chat's ID token; welcome / help / stop / start
│   │   ├── supabase.js            Supabase client
│   │   ├── session.js             HMAC-signed session tokens
│   │   ├── auth-session.js        OAuth state lifecycle (atomic claim)
│   │   ├── encryption.js          AES-256-GCM helpers
│   │   ├── idempotency.js         Per-channel / per-recipient delivery de-dupe (notification_log)
│   │   ├── config-destination.js  Plans a config write per destination, incl. Slack ↔ email switches (pure)
│   │   ├── email-recipients.js    Recipient list + confirmation states (pure)
│   │   ├── email-tokens.js        HMAC-signed confirm / unsubscribe link tokens
│   │   ├── email-message.js       Notification + confirmation email builder (HTML + text)
│   │   ├── email-send.js          Amazon SES (API v2) send adapter
│   │   ├── email-delivery.js      Confirmation + notification sending, rate limits, logging
│   │   ├── email-links.js         The confirm and unsubscribe actions behind /api/email
│   │   ├── email-pages.js         Escaped confirm / unsubscribe pages
│   │   ├── slack-blocks.js        Slack Block Kit builder + custom-note composition
│   │   ├── slack-oauth.js         Slack OAuth scopes (single source, test-pinned)
│   │   ├── slack-workspace.js     Workspace-token resolution for the pickers
│   │   ├── slack-channels.js      Channel normalization/sorting (pure)
│   │   ├── slack-directory.js     Directory pager + per-workspace cache + member normalization
│   │   ├── delivery-status.js     Slack-delivery status decision (revocation surfacing)
│   │   ├── figma-oauth.js         Figma OAuth scopes (single source, test-pinned) + helpers
│   │   ├── figma-access.js        File-access verification (webhooks:read probe)
│   │   ├── validators.js          Input validation
│   │   ├── http.js / errors.js / logger.js / types.js
│   │   └── oauth-result-page.js   Escaped OAuth result page
│   ├── package.json
│   └── vercel.json
├── database/
│   ├── schema.sql                 Canonical full schema (fresh installs)
│   └── migrations/                001–006 incremental migrations (existing installs)
├── tests/                         Vitest unit tests
├── docs/                          ADRs + runbooks
├── .env.example                   Environment variable template
└── README.md
```

---

## Support

Questions or issues: **rajatgarg1809@gmail.com**. Security reports: see [SECURITY.md](./SECURITY.md).

Licensed under [MIT](./LICENSE).
