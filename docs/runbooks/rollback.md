# Runbook: rollback a bad deploy

**When to use:** a production deploy is broken (5xx spike, missing env, broken UI). Reverting the commit on `main` and waiting for the next deploy is too slow — Vercel's atomic deploys let you flip a switch.

## TL;DR

```
gh auth status                       # confirm you're on the gragtajar account
vercel deployments list --prod       # find the previous good deploy URL
vercel promote <previous-deploy-url> # promote it to the production alias
```

That's it. The previous deploy is now serving production traffic.

## Step-by-step

### 1. Confirm there's a problem

- Check `/api/health` — if it returns the new commit SHA but the page is broken, the deploy itself is bad.
- Check Vercel dashboard logs (`Functions → /api/webhook`) for the spike of 5xx.
- Check the `notification_log` table — `status='failed'` rows with new `error_message` values are a strong signal.

### 2. Identify the last good deploy

In Vercel dashboard: **Deployments** tab → find the most recent deploy with green status and traffic before the problem started. Note its hash (e.g. `library-pulse-abc123.vercel.app`).

Via CLI:

```bash
vercel deployments list --prod --token "$VERCEL_TOKEN"
```

### 3. Promote it

```bash
vercel promote https://library-pulse-abc123.vercel.app --token "$VERCEL_TOKEN"
```

The production alias (`library-pulse.vercel.app`) flips to the older build atomically. No DNS change, no plugin reinstall required.

### 4. Verify

```bash
curl -s https://library-pulse.vercel.app/api/health | jq .version
```

Should now report the older commit SHA.

### 5. Tell the on-call channel

```
🚨 Rolled back Library Pulse to <commit-sha>
Reason: <one-liner>
Bad commit: <commit-sha>
Next step: open issue, hold deploys until fixed.
```

### 6. Open a follow-up issue

Use the `incident` issue template. Include:

- Timeline (when broke, when noticed, when rolled back)
- What broke (errored endpoint, user-visible symptom)
- The bad commit hash
- Whether the fix needs DB migration / token re-encryption (most rollbacks don't)

### 7. Block deploys until fixed

Pause GitHub Actions on `main` (Settings → Actions → Disable for now). Document why in the issue. Resume once the fix is merged and tested in a preview deploy.

## What this runbook does NOT cover

- **Bad database migration.** If a deploy ran a destructive SQL migration, a Vercel rollback won't undo it — restore from Supabase point-in-time recovery first. See `incident-response.md`.
- **Leaked `ENCRYPTION_KEY`.** Different runbook — `rotate-encryption-key.md`.
