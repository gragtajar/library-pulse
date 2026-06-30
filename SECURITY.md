# Security policy

## Reporting a vulnerability

If you find a security issue in Library Pulse, please **do not open a public GitHub issue**.

Email: `security@gragtajar.dev` (until a dedicated address is set up, use the maintainer's GitHub-listed contact email)

What to include:

- A clear description of the issue
- Steps to reproduce (ideally with a minimal payload)
- The affected endpoint / file / commit hash
- Your assessment of impact and any mitigations you've already tried

We aim to acknowledge within **48 hours** and to ship a fix within **14 days** for high-severity issues. You'll be credited in the fix's release notes unless you'd rather stay anonymous.

## Threat model summary

| Asset | What protects it |
|---|---|
| Slack bot tokens | AES-256-GCM at rest with auth-tag verification; only the service-role key can read them; never logged |
| Figma OAuth tokens | Same as above |
| `ENCRYPTION_KEY` | Vercel environment variable, encrypted at rest by Vercel; never committed; rotation procedure in `docs/runbooks/rotate-encryption-key.md` |
| Webhook authenticity | Hard-required `X-Figma-Passcode` header, timing-safe compare against per-team passcode |
| OAuth replay | `auth_sessions.used_at` is set on first consumption; subsequent callbacks 403 |
| Webhook replay | `webhook_events.event_key UNIQUE` constraint; Figma retries are silently de-duped |
| Cross-user enumeration | Backend requires `X-Figma-User` header and compares to row's `figma_user_id` |

## What's NOT in the threat model

- A malicious user with the `ENCRYPTION_KEY`. Game over — see the rotation runbook.
- A malicious Figma plugin embedding our manifest's UI in a different sandbox. Acceptable: the only secrets ever in the UI are the Figma user ID and the (intentionally public) Slack channel IDs.
- DoS at the Vercel function layer. Vercel provides per-account rate limiting; we don't add application-level rate limiting yet.

## Dependencies

- `npm audit` runs in CI weekly (see `.github/workflows/codeql.yml` schedule).
- Dependabot is enabled at the repo level for security updates.
- Major version bumps are reviewed manually; minor/patch get an auto-merge after CI passes.

## Past advisories

None yet. When an issue is reported and fixed, it gets a short entry here with the issue number, severity, and the commit that fixed it.
