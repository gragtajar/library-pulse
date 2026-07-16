# Security policy

Library Pulse is a Figma plugin that posts a Slack message when a Figma library is
published. This document describes how it protects data, and how to report a
vulnerability.

## Reporting a vulnerability

If you find a security issue in Library Pulse, please **do not open a public GitHub
issue**.

**Email:** rajatgarg1809@gmail.com

What to include:

- A clear description of the issue
- Steps to reproduce (ideally with a minimal payload)
- The affected endpoint / file / commit hash
- Your assessment of impact and any mitigations you've already tried

We aim to acknowledge within **48 hours** and to ship a fix within **14 days** for
high-severity issues. You'll be credited in the fix's release notes unless you'd
rather stay anonymous.

## What the plugin can access

- **Figma scopes:** the plugin requests `webhooks:write` and `webhooks:read`.
  `webhooks:write` registers and deletes a `LIBRARY_PUBLISH` webhook on the file the
  user selects; `webhooks:read` lists a file's webhooks so the backend can confirm a
  caller can access that file before returning or changing its shared config. The
  plugin **never reads file contents, designs, or layers.**
- **From the Figma plugin API** it reads only the current file's key and name and the
  current user's id and display name — used to label configurations and to bind a
  webhook to the file.
- **Slack scopes:** `chat:write`, `chat:write.public`, `channels:read`, `groups:read`
  — used to post notifications to the channels the user chooses and to list a
  workspace's channels for the picker.

## Org-shared, per-file access control

Configuration is keyed by **file**, not user: anyone with edit access to a file
manages that file's single shared config. The backend enforces this as follows:

- The **original setter** (`created_by`) is trusted for their own file — the same
  trust the app used before this model (they proved edit access when they registered
  the webhook).
- **Any other user** is verified against the file with **their own** Figma token
  (`GET /v2/webhooks?context=file`, requiring `webhooks:read`) before the backend
  returns or mutates that file's config. No access → `403`.
- **Creating** the webhook is edit-gated by Figma for free (`POST /v2/webhooks`
  requires "Can edit"). Only the original setter can **remove** the Figma connection
  (delete the webhook); any editor can edit channels or disable notifications.

## How authentication works

- **No passwords.** Authentication is delegated entirely to **Figma OAuth 2.0** and
  **Slack OAuth 2.0**. Figma and Slack verify the user's credentials; Library Pulse
  only ever receives OAuth tokens.
- **CSRF protection:** each OAuth flow uses a single-use, random `state` nonce that
  expires in 10 minutes. The callback claims the session atomically (a conditional
  `UPDATE`), so a `state` value can never be replayed.
- **API authentication:** after Figma OAuth, the backend issues an
  **HMAC-SHA256-signed session token** (30-day expiry, signing key derived from
  `ENCRYPTION_KEY`) bound to the verified Figma user id. Every
  configuration API call must present this token as a bearer credential; the user id
  is derived from the verified token, never from a client-supplied header. One user
  therefore cannot read or modify another user's configuration.

## Threat model summary

| Asset / risk             | What protects it                                                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Slack bot tokens         | AES-256-GCM at rest (random IV per record, auth-tag verified); readable only with the service-role key; never logged                                                     |
| Figma OAuth tokens       | Same as above                                                                                                                                                            |
| `ENCRYPTION_KEY`         | Vercel environment variable, encrypted at rest by Vercel; never committed; rotation procedure in `docs/runbooks/rotate-encryption-key.md`                                |
| API / cross-user access  | HMAC-SHA256-signed session token bound to the Figma user id; every request is verified and ownership-checked before any read or mutation                                 |
| Webhook authenticity     | Each file webhook has its own high-entropy passcode; the receiver verifies it with a constant-time, length-safe (SHA-256) compare                                        |
| Webhook tenant isolation | A validated webhook can only post to the configuration owned by the user who registered it, for the exact file it was registered on                                      |
| OAuth replay             | `auth_sessions.used_at` is set atomically on first use; later callbacks are rejected; sessions expire after 10 minutes                                                   |
| Webhook replay / retries | Per-channel delivery de-duplication keyed on the derived event id (`notification_log.event_key`): a Figma retry re-sends only the channels that hadn't already succeeded |
| Secrets in logs          | Structured logs scrub token/secret/passcode fields by key name                                                                                                           |

## Data we store & privacy

- **Locally**, in `figma.clientStorage` (sandboxed to this plugin), keys namespaced
  `lp/v1/*`: the app session token, the connected Slack workspace id/name, the Figma
  user id, and the saved configuration id.
- **In the backend** (Postgres on Supabase, serverless API on Vercel): the Figma user
  id, the selected file key and file name, the chosen Slack channel IDs, and the OAuth
  tokens — tokens encrypted at rest with AES-256-GCM. **No file contents are stored.**
- **Access** is limited to the maintainer, only via the Supabase service-role key held
  in a server environment variable; Row-Level Security is enabled on all tables. The
  data is never sold or shared and is used solely to deliver the user's own Slack
  notifications.
- **Deletion:** removing a configuration in the plugin deletes the corresponding
  database row and tears down the Figma webhook. Data requests: rajatgarg1809@gmail.com.

## Infrastructure & compliance

The backend runs on providers that maintain independent audits:

- **Vercel** (serverless functions) — SOC 2 Type II and ISO 27001:2022.
- **Supabase** (Postgres database) — SOC 2 Type II.

Library Pulse itself is an independent, solo-maintained project and is not separately
audited; OAuth tokens are additionally encrypted at rest by the application on top of
the providers' own encryption.

## What's out of scope

- A malicious party who already holds the `ENCRYPTION_KEY`. That is a full compromise —
  see the rotation runbook.
- Application-level rate limiting / DoS. We rely on Vercel's per-account limits and do
  not yet add app-level rate limiting.
- The session token is a bearer credential stored in the plugin's sandboxed
  `clientStorage`; if a user's own device is compromised it could be reused, but it only
  authorizes actions on that same user's configuration and cannot read file contents.

## Dependencies

- GitHub **Dependabot** proposes dependency and GitHub Actions updates weekly
  (`.github/dependabot.yml`).
- GitHub **CodeQL** (default setup) scans the repository on every push and pull request.
- Dependency bumps are reviewed and merged manually after CI passes; incompatible
  ones (e.g. a major that a plugin peer doesn't yet support) are held or closed.

## Past advisories

None yet. When an issue is reported and fixed, it gets a short entry here with the
severity and the commit that fixed it.
