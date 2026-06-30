# ADR 001: Vercel serverless + Supabase backend

**Status:** Accepted
**Date:** 2026-04-20

## Context

Library Pulse needs:

1. A handful of HTTP endpoints to terminate OAuth flows and receive a Figma webhook.
2. Persistent storage for encrypted OAuth tokens, per-user configurations, and an audit log.
3. Free-tier costs at the foreseeable scale (single-digit thousands of users).
4. Zero-ops — the maintainer is one person plus Claude Code.

We have no real-time requirement, no SSR requirement, and almost no compute requirement (a webhook handler invoked at most a few times per minute per active team).

## Decision

- **Hosting:** Vercel serverless functions. Each `backend/api/*.js` exports a default handler. Vercel handles routing, TLS, regions, and atomic deploys.
- **Database:** Supabase (managed Postgres) with the service-role key used from the backend. Row-Level Security stays enabled defence-in-depth even though the service role bypasses it.

## Alternatives considered

- **Cloudflare Workers + D1.** Cheaper at scale, but D1 is still maturing for relational features (CTEs, JSONB-style queries we use for `channels`). Workers' bundler also requires more setup for ESM Node libs like `@supabase/supabase-js`.
- **A single Express service on Fly.io / Render.** Lower per-cold-start latency but reintroduces server lifecycle management. Not worth the operational tax at this scale.
- **Supabase Edge Functions instead of Vercel.** Tighter Supabase coupling and a less mature local-dev story (`vercel dev` works well; `supabase functions serve` is more fiddly). Reconsider if we ever need RPC-style colocation.
- **Self-hosted Postgres.** Cheaper at low scale, but ops cost (backups, upgrades, monitoring) is the wrong trade for a side project.

## Consequences

- We're tied to Vercel's request/response shape and 15s `maxDuration` ceiling. Long-running fan-out (>15 s) would require a queue, which the architecture currently doesn't have. Worth revisiting once a single config has >20 channels.
- We pay for the cold-start tax on infrequently-hit endpoints (`auth/*`). Acceptable because OAuth is a one-time user flow.
- Supabase's free tier covers the storage + bandwidth we need. If we exceed it, migration to a self-managed Postgres is non-trivial because we use `pgcrypto`, `uuid-ossp`, and (eventually) `pg_cron` — all easy on Supabase, harder on RDS.

## References

- `ARCHITECTURE.md` §1, §3
- `backend/vercel.json`
- `database/schema.sql`
