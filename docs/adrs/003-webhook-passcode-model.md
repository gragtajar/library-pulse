# ADR 003: Webhook passcode authentication model

**Status:** Accepted
**Date:** 2026-04-20

## Context

The `/api/webhook` endpoint is publicly reachable — Figma's webhook system POSTs `LIBRARY_PUBLISH` events to it from Figma's infrastructure. We need to authenticate every incoming request so an attacker can't spoof a publish event and trigger arbitrary Slack messages.

Figma's webhook API supports one mechanism: a per-webhook **passcode** that we provide at registration time and Figma echoes back on every event (in the body and the `X-Figma-Passcode` header).

## Decision

1. When `config.js` registers a webhook for a team, we generate a fresh 24-byte random passcode (`crypto.randomBytes(24).toString("hex")`) and store it in `figma_webhooks.passcode`.
2. On every inbound event, the webhook handler:
   1. Hard-requires `payload.webhook_id`. No id → 403.
   2. Looks up the stored passcode by `webhook_id`. Unknown id → 403.
   3. Reads the supplied passcode from the `X-Figma-Passcode` header (preferred) or `payload.passcode` (fallback).
   4. Compares with `timingSafeEqual` to avoid length / byte-by-byte side channels.
3. Idempotency runs AFTER passcode validation — a forged unauthenticated request must never even reach the idempotency table.

## Alternatives considered

- **Sign requests with HMAC-SHA256.** Slack's model. Figma doesn't offer this for webhooks today (only OAuth web flow signatures). Re-evaluate if Figma adds HMAC signing.
- **IP allow-list.** Figma doesn't publish a stable list of webhook-egress IPs. Brittle.
- **mTLS.** Vercel doesn't support arbitrary client-cert verification in serverless handlers.
- **Single shared secret across all teams.** Simpler but a single leak breaks every team's webhook. Per-team passcodes contain the blast radius.

## Consequences

- **Fail-closed.** v1 of the code fell open when `webhook_id` was missing. v2 returns 403. We accept that a legitimate Figma event without a `webhook_id` (which shouldn't happen per their docs) will be dropped — and that's the correct trade.
- **Constant-time compare.** `timingSafeEqual` rejects different-length inputs immediately, but we coerce both sides to `Buffer` of equal length first so the comparison cost is the same regardless of where bytes diverge.
- **Header-first, body-fallback.** Figma's docs say both are sent; preferring the header makes intent clearer and avoids any chance of body-parsing differences mattering.
- **Rotation:** to rotate a passcode, delete the row from `figma_webhooks` and re-call the Figma webhook update API. Out of scope for v1; track as a follow-up if a team's passcode ever leaks.

## References

- `backend/api/webhook.js` (passcode check)
- `backend/api/config.js` `ensureWebhook` (passcode generation)
- `database/schema.sql` `figma_webhooks` + `webhook_events`
- Figma webhooks docs: <https://www.figma.com/developers/api#webhooks-v2>
