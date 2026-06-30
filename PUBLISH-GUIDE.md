# Publishing Library Pulse — Complete Step-by-Step Guide

This guide assumes you've never published a Figma plugin before. Follow each step in order.

---

## Phase 1: Prepare Your Accounts (one-time setup)

You need four accounts/services. You probably have most of these already.

### 1.1 Figma Account

You already have this (rajatg@lambdatest.com). Make sure you have a **Professional, Organization, or Enterprise** plan — free/Starter plans can create plugins but have some limitations on OAuth app creation.

### 1.2 Vercel Account

1. Go to [vercel.com](https://vercel.com) and sign up (or log in).
2. Connect your GitHub account when prompted — this makes deployment automatic later.

### 1.3 Supabase Account

1. Go to [supabase.com](https://supabase.com) and sign up.
2. Click **New Project**.
3. Name it `library-pulse`, set a database password (save this somewhere), pick a region close to you.
4. Wait for the project to finish provisioning (~2 minutes).

### 1.4 GitHub Repository

1. Go to [github.com/new](https://github.com/new).
2. Name it `library-pulse`.
3. Set it to **Public**.
4. Don't initialize with README (you already have one).
5. Click **Create repository**.
6. Push your code:
   ```bash
   cd library-pulse
   git init
   git add .
   git commit -m "Initial commit — Library Pulse v1.0"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/library-pulse.git
   git push -u origin main
   ```

---

## Phase 2: Set Up the Database

### 2.1 Run the schema

1. In your Supabase dashboard, click **SQL Editor** in the left sidebar.
2. Click **New query**.
3. Copy the entire contents of `database/schema.sql` and paste it into the editor.
4. Click **Run** (or Cmd+Enter).
5. You should see "Success. No rows returned" — that's correct.

### 2.2 Note your credentials

1. Go to **Settings** (gear icon) → **API**.
2. Copy these two values (you'll need them for Vercel):
   - **Project URL** → this is your `SUPABASE_URL`
   - **service_role key** (under "Project API keys", click to reveal) → this is your `SUPABASE_SERVICE_ROLE_KEY`

**Important:** The `service_role` key bypasses Row Level Security. Never expose it in client-side code or commit it to Git.

---

## Phase 3: Create the Slack App

### 3.1 Create the app

1. Go to [api.slack.com/apps](https://api.slack.com/apps).
2. Click **Create New App** → **From scratch**.
3. App Name: `Library Pulse`
4. Pick your Slack workspace.
5. Click **Create App**.

### 3.2 Set permissions

1. In the left sidebar, click **OAuth & Permissions**.
2. Scroll down to **Bot Token Scopes** and add these four scopes:
   - `chat:write` — post messages
   - `chat:write.public` — post to any public channel without being invited
   - `channels:read` — list public channels (for future channel picker)
   - `groups:read` — list private channels the bot is in
3. Scroll up to **Redirect URLs** and add:
   ```
   https://library-pulse.vercel.app/api/auth/slack-callback
   ```
   (You'll update this URL after you deploy to Vercel if the domain is different.)

### 3.3 Note your credentials

1. Go to **Basic Information** in the left sidebar.
2. Under **App Credentials**, copy:
   - **Client ID** → `SLACK_CLIENT_ID`
   - **Client Secret** → `SLACK_CLIENT_SECRET`
   - **Signing Secret** → `SLACK_SIGNING_SECRET`

### 3.4 Customize the app (optional but recommended)

1. Still in **Basic Information**, scroll to **Display Information**.
2. Add an app icon (512x512 PNG — use the same icon you'll use for the Figma plugin).
3. Set the background color to match your brand.
4. Add a short description: "Get Slack notifications when Figma libraries are published."

---

## Phase 4: Create the Figma OAuth App

This is separate from the Figma plugin — it's an OAuth application that lets users authorize Library Pulse to register webhooks on their behalf.

### 4.1 Register the app

1. Go to [figma.com/developers](https://www.figma.com/developers).
2. Click **My apps** in the top navigation.
3. Click **Create a new app**.
4. Fill in:
   - **App name:** Library Pulse
   - **Website URL:** Your GitHub repo URL
   - **Callback URL:**
     ```
     https://library-pulse.vercel.app/api/auth/figma-callback
     ```
   - **Scopes:** Check `files:read` and `webhooks:write`
5. Click **Save**.
6. Copy:
   - **Client ID** → `FIGMA_CLIENT_ID`
   - **Client Secret** → `FIGMA_CLIENT_SECRET`

---

## Phase 5: Deploy the Backend to Vercel

### 5.1 Install prerequisites

```bash
npm install -g vercel    # Vercel CLI
```

### 5.2 Generate your encryption key

This key encrypts all stored OAuth tokens. Generate it once, save it safely:

```bash
openssl rand -hex 32
```

Copy the output — that's your `ENCRYPTION_KEY`.

### 5.3 Deploy

```bash
cd backend
npm install
vercel
```

Vercel will ask a few questions:
- **Set up and deploy?** → Yes
- **Which scope?** → Your personal account (or team)
- **Link to existing project?** → No
- **What's your project's name?** → `library-pulse`
- **In which directory is your code located?** → `./` (current directory)
- **Want to modify settings?** → No

### 5.4 Set environment variables

Run these one by one. Vercel will prompt you to paste each value:

```bash
vercel env add SUPABASE_URL
vercel env add SUPABASE_SERVICE_ROLE_KEY
vercel env add ENCRYPTION_KEY
vercel env add SLACK_CLIENT_ID
vercel env add SLACK_CLIENT_SECRET
vercel env add SLACK_SIGNING_SECRET
vercel env add FIGMA_CLIENT_ID
vercel env add FIGMA_CLIENT_SECRET
vercel env add PUBLIC_URL
```

For `PUBLIC_URL`, enter your Vercel deployment URL (e.g., `https://library-pulse.vercel.app`). **No trailing slash.**

When asked which environments, select all three: **Production, Preview, Development**.

### 5.5 Deploy to production

```bash
vercel --prod
```

### 5.6 Verify deployment

Open your browser and go to:
```
https://YOUR-VERCEL-DOMAIN/api/health
```

You should see:
```json
{"status":"ok","service":"library-pulse","version":"1.0.0","timestamp":"..."}
```

### 5.7 Update redirect URLs

If your Vercel domain is different from `library-pulse.vercel.app`, go back and update:
- **Slack app** → OAuth & Permissions → Redirect URLs
- **Figma app** → My apps → Edit → Callback URL

---

## Phase 6: Set Up the Figma Plugin

### 6.1 Update the API base URL

Before importing into Figma, open `figma-plugin/ui.html` and find this line near the top of the `<script>` section:

```javascript
const API_BASE = "https://library-pulse.vercel.app";
```

Replace it with your actual Vercel deployment URL.

### 6.2 Create the plugin in Figma

1. Open the **Figma desktop app** (not the browser — plugin development works best in the desktop app).
2. Open any Figma file.
3. Right-click on the canvas → **Plugins** → **Development** → **Import plugin from manifest…**
4. Navigate to your `library-pulse/figma-plugin/` folder and select `manifest.json`.
5. Figma will import the plugin. You'll see a success message.

### 6.3 Get your real plugin ID

When you import the manifest, Figma assigns a real numeric plugin ID. You need to update your manifest with it:

1. Right-click → **Plugins** → **Development** → **Manage plugins in development**
2. Find **Library Pulse** in the list.
3. Click the **⋯** menu → **Copy link**.
4. The link will look like: `https://www.figma.com/community/plugin/123456789/Library-Pulse`
5. That number (`123456789`) is your plugin ID.
6. Open `figma-plugin/manifest.json` and replace `"id": "library-pulse"` with `"id": "123456789"`.

### 6.4 Test the plugin

1. Right-click on canvas → **Plugins** → **Development** → **Library Pulse**.
2. The plugin UI should appear.
3. Walk through the full setup flow:
   - Click **Connect to Slack** → complete the OAuth in your browser.
   - Click **Connect Figma Account** → complete the OAuth.
   - Select the current file or enter a file ID.
   - Enter your Figma Team ID.
   - Add 1–3 Slack channel IDs.
   - Click **Save & Activate**.
4. Now publish a small change in your Figma library and verify the Slack message arrives.

---

## Phase 7: Publish to Figma Community

### 7.1 Prepare your listing assets

You'll need these before submitting:

| Asset | Specs | Purpose |
|-------|-------|---------|
| **Plugin icon** | 128 × 128 PNG, no transparency | Shows in the plugin list and Community page |
| **Cover image** | 1920 × 960 PNG or JPG | Banner at the top of your Community listing |
| **Screenshots** | 1-5 images, any size (16:9 recommended) | Show the plugin UI in action |

Tips for screenshots:
- Capture the plugin running inside Figma (use Cmd+Shift+4 on Mac).
- Show each state: setup flow, dashboard, and the Slack message output.
- Add brief annotations if helpful.

### 7.2 Write your listing copy

Prepare these ahead of time:

**Tagline** (max 60 chars):
> Slack notifications when your Figma library is published.

**Description** (plain text, will display on the Community page):
> Library Pulse sends a rich Slack message whenever changes are published to your Figma library. See exactly what was added, modified, or removed — components, styles, and variables — along with who published and the description they entered.
>
> Setup takes under 2 minutes:
> 1. Connect your Slack workspace (secure OAuth).
> 2. Connect your Figma account (for automatic webhook setup).
> 3. Pick a file and up to 3 Slack channels.
>
> That's it. Every future library publish triggers a detailed notification.
>
> Works with any Figma library file. Supports 1–3 Slack channels per configuration.

**Tags:** design-systems, slack, notifications, library, workflow

### 7.3 Submit for review

1. Go to [figma.com](https://www.figma.com) in your browser and log in.
2. Click your **avatar** (top-right) → **Plugins and widgets** (or go to figma.com/developers → My plugins).
3. Find **Library Pulse** in your list.
4. Click the **⋯** menu → **Publish new release** (or **Publish to Community** if first time).
5. Fill in:
   - **Plugin icon** — upload your 128×128 PNG.
   - **Cover image** — upload your 1920×960 image.
   - **Tagline** — paste from above.
   - **Description** — paste from above.
   - **Tags** — add the relevant tags.
   - **Screenshots** — upload 1–5 screenshots.
   - **Support contact** — your email (rajatgarg1809@gmail.com).
   - **Source code link** — your GitHub repo URL (optional but builds trust for a security-focused plugin).
6. Review everything in the preview.
7. Click **Submit for review**.

### 7.4 The review process

- Figma's plugin review team will test your plugin.
- Typical review time: **3–7 business days** (can vary).
- They check for: functionality, security (OAuth flows, network access), policy compliance, and UI quality.
- You'll get an email when it's approved or if they need changes.
- Common reasons for rejection:
  - Plugin crashes or doesn't load.
  - Network domains in manifest don't match actual requests.
  - Missing or unclear description.
  - OAuth flows that don't work.
- If rejected, fix the issues, and resubmit.

### 7.5 After approval

Your plugin will appear at:
```
https://www.figma.com/community/plugin/YOUR_PLUGIN_ID/Library-Pulse
```

Anyone can install it from the Figma Community. Share this link!

---

## Phase 8: Submit to Slack App Directory (optional)

If you want Library Pulse discoverable inside Slack's app marketplace:

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → select **Library Pulse**.
2. Click **Manage Distribution** in the left sidebar.
3. Under **Share Your App with Other Workspaces**, complete the checklist:
   - Remove hardcoded info — already done.
   - Review scopes — already minimal.
   - Add redirect URLs — already done.
   - Enable public distribution — toggle on.
4. Click **Submit to the Slack App Directory**.
5. Fill in the listing form (similar to Figma: icon, description, category, screenshots).
6. Slack reviews typically take **1–2 weeks**.

---

## Updating the Plugin After Publishing

When you make changes and want to release an update:

1. Make your code changes.
2. If backend changes: `cd backend && vercel --prod`
3. If plugin changes:
   - Update the plugin files.
   - Go to Figma → your plugin → **Publish new release**.
   - Bump the version in your manifest if needed.
   - Add release notes describing what changed.
   - Submit — updates usually get reviewed faster than the initial submission.

---

## Troubleshooting

**Plugin doesn't appear in Figma:**
Make sure you're using the **desktop app**, not the browser. Plugin development requires the desktop app.

**OAuth redirect fails:**
Double-check that the redirect URLs in your Slack/Figma app settings exactly match your Vercel deployment URL (including `https://`, no trailing slash).

**Webhook not firing:**
Figma webhooks are team-level. Make sure the Team ID you entered is correct (from the URL: figma.com/files/team/**THIS_NUMBER**/…).

**Slack message not appearing:**
Check the Vercel function logs (`vercel logs --follow`) for errors. Common issues: bot not in the channel (use `chat:write.public` scope), or channel ID is wrong.
