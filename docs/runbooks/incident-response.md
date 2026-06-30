# Runbook: incident response

**When to use:** anything that's not a normal deploy regression — token leak, webhook flood, Slack ban, Figma API outage.

## Incident severities

| Severity | Definition | Response time |
|---|---|---|
| **SEV-1** | Tokens leaked, db wiped, Slack bot suspended for abuse | < 1 hour |
| **SEV-2** | Production endpoint down for > 30 minutes, all teams affected | < 4 hours |
| **SEV-3** | Single team broken, no data loss, no security impact | < 24 hours |
| **SEV-4** | Cosmetic bug, low user impact | Next sprint |

## Common scenarios

### Webhook is hot — Figma is hammering us

**Symptoms:** Vercel function invocations spike, `notification_log` insert rate climbs, possibly Slack returns `rate_limited`.

**Likely cause:** Figma firing many `LIBRARY_PUBLISH` events for a single team (mass component edit), or a Figma retry loop.

**Action:**
1. Check `webhook_events` table — are we de-duping correctly? Same `event_key` more than once means our idempotency is broken; investigate `deriveEventKey`.
2. Slack rate-limit is per-channel, not per-token. If a single channel is the bottleneck, check `notification_log` for `error_message ILIKE '%rate_limited%'` rows.
3. Temporary mitigation: lower `SLACK_POST_CONCURRENCY` in `backend/api/webhook.js` from 4 to 1, redeploy. Slack queues per-channel so this slows fan-out but reduces 429s.
4. Long-term: introduce a real queue (Upstash / SQS / pg-cron processor). Out of scope until volume justifies it.

### Slack bot is being rate-limited

**Symptoms:** rows in `notification_log` with `error_message LIKE 'ratelimited%'`.

**Action:**
1. Identify which workspace — `notification_log` joins to `configurations.slack_team_id`.
2. The token isn't expired; Slack is throttling. Slow down our fan-out (see above) and back off automatically — current code does NOT auto-backoff, so this is a known gap. Track as a follow-up issue.

### Figma OAuth token expired for a user

**Symptoms:** `figma_webhook` registration starts failing for one team; new configs fail with `figma_token_persist_failed` or `401 Unauthorized` upstream.

**Action:**
1. Check `figma_tokens.expires_at` for the user.
2. v1 of the code does NOT refresh tokens — the user must reconnect Figma via the plugin. Tell the user to delete their config and run setup again.
3. Long-term fix: implement refresh-token flow. Tracked in CHANGELOG as a known gap.

### `ENCRYPTION_KEY` leaked

**SEV-1.** Stop. Follow `rotate-encryption-key.md`. Revoke every Slack bot token at the Slack admin panel and every Figma OAuth grant at the user's Figma settings. Notify affected workspaces.

### Database was wiped or corrupted

**SEV-1.**
1. Pause all webhook traffic: in Vercel, set `NODE_OPTIONS=--unhandled-rejections=throw` plus a feature-flag env that the webhook handler short-circuits on. Or roll back to a deploy that returns 503 from `/api/webhook`.
2. Restore from Supabase point-in-time recovery (free tier offers 7 days). Dashboard → Project Settings → Database → Backups.
3. After restore, the `webhook_events` table may be stale — Figma retries during the outage might be re-delivered and post duplicate Slack messages. Accept this, or temporarily increase the dedupe window by extending the `gc-webhook-events` retention.

### Sentry alert: "unhandled_exception in /api/…"

1. Open the Sentry issue. Look at the stack trace and the redacted log line emitted from `logger.error("unhandled_exception", ...)`.
2. If reproducible, write a failing test, fix, ship.
3. If not, add more structured logging to the suspect code path and wait for the next occurrence.

## Communication template

```
🚨 SEV-<N>: <one-line summary>
Detected: <when>
Impact: <which teams / users / endpoints>
Mitigation in flight: <what we're doing>
ETA: <when we expect resolution>
Owner: <name>
```

Post in #library-pulse-ops (or wherever the team coordinates). Update every 30 minutes for SEV-1/2.
