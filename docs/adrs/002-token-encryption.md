# ADR 002: AES-256-GCM for token storage

**Status:** Accepted
**Date:** 2026-04-20

## Context

The backend stores two kinds of secret credentials at rest:

- **Slack bot tokens** (`xoxb-…`) — let us post to any channel the bot is in, on behalf of every installed workspace.
- **Figma OAuth access + refresh tokens** — let us register webhooks against the user's team.

Supabase encrypts data at rest at the disk layer, but a leaked service-role key trivially decrypts everything stored that way. We want application-layer encryption so a database leak alone is not a token leak.

## Decision

- Symmetric **AES-256-GCM** via Node's built-in `node:crypto`.
- **Key:** 32 random bytes, hex-encoded into `ENCRYPTION_KEY` env var. Single key for the whole deployment.
- **IV:** 96-bit random per encryption (`randomBytes(12)`).
- **Auth tag:** 128-bit, GCM default. Tag verification on decrypt detects any tampering.
- **Wire format:** base64 of `iv || ciphertext || tag`. No key id — the wire format is intentionally single-key; rotation requires re-encrypting the whole column (see `docs/runbooks/rotate-encryption-key.md`).

## Alternatives considered

- **AWS KMS / Cloud KMS envelope encryption.** Higher operational complexity, IAM setup, and per-decrypt API cost. The threat model doesn't justify it: a stolen service-role key already gives an attacker every other database column.
- **`libsodium` / NaCl `secretbox`.** Equivalent security, but an extra runtime dependency for no functional gain in a Node environment that already ships `node:crypto`.
- **Key per row.** Defeats the purpose: where do you store the row keys? Either back to a single master (where we are) or to KMS (see above).
- **Storing tokens in plaintext** + relying on Supabase disk encryption. Rejected; doesn't survive a service-role key leak.

## Consequences

- The `ENCRYPTION_KEY` is the single most critical secret in the system. If it leaks, every stored OAuth token must be revoked at the providers. The runbook walks through the procedure.
- Rotating the key requires re-encrypting every `*_token_enc` row, because the wire format has no key id. We accept this — rotation is a planned operation, not an emergency one, and a one-off batch is straightforward to ship.
- GCM's auth tag means tampered ciphertext fails loudly (the `decrypt` call throws). Callers don't need to add extra HMAC checks.

## References

- `backend/lib/encryption.js`
- `tests/encryption.test.js` (round-trip + tampering coverage)
- `docs/runbooks/rotate-encryption-key.md`
