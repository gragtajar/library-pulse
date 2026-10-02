# Security policy

Library Pulse is a Figma plugin that posts a Slack message, or sends an email, when a
Figma library is published. This document describes how it protects data, and how to
report a vulnerability.

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

- **Figma scopes:** the plugin requests `webhooks:write`, `webhooks:read`, and
  `library_assets:read`. `webhooks:write` registers and deletes a `LIBRARY_PUBLISH`
  webhook on the file the user selects; `webhooks:read` lists a file's webhooks so
  the backend can confirm a caller can access that file before returning or changing
  its shared config; `library_assets:read` resolves one of the open file's published
  component/style keys to the file's id (Figma doesn't expose file ids to public
  Community plugins), reading only published-asset metadata. The plugin **never
  reads file contents, designs, or layers.**
- **From the Figma plugin API** it reads only the current file's key and name and the
  current user's id and display name — used to label configurations and to bind a
  webhook to the file.
- **Slack scopes:** `chat:write`, `chat:write.public`, `channels:read`, `groups:read`,
  `users:read`, `usergroups:read` — used to post notifications to the channels the
  user chooses, to list a workspace's channels for the picker, and to list member /
  user-group names for the custom-note mention picker. Message content is never read.
- **Email:** the plugin connects to no mail account and reads no mailbox. For a file
  that uses the email destination, it stores the addresses an editor types (at most
  five per file) and sends to them through Amazon SES, only after each address has
  confirmed (see "Email consent" below).

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

## Email consent

- **Double opt-in.** A newly added address is stored as _pending_ and is sent one
  confirmation email. It receives notifications only after its owner opens that
  email and presses **Confirm address**. Editors cannot mark an address confirmed.
- **Unsubscribe.** Every notification has an unsubscribe link and RFC 8058 one-click
  unsubscribe headers. Unsubscribing takes effect immediately and is sticky: an
  editor re-saving the list does not undo it. To receive updates again the address
  has to be removed and added back, which sends a new confirmation its owner can
  ignore.
- **Links are credentials, and they are narrow.** Confirm and unsubscribe links carry
  an HMAC-SHA256 token (signing key derived from `ENCRYPTION_KEY` under its own
  label, so session tokens and link tokens never validate each other) bound to one
  config and one address. Confirm links expire after 7 days. A link can only confirm
  or unsubscribe that one address; it gives no access to the config.
- **Link scanners can't act.** Both pages only act on a button press (`POST`). A mail
  gateway that follows links (`GET`) gets the page and changes nothing.
- **Limits.** At most 5 addresses per file, 3 confirmation emails per address per
  day, and 150 notification emails per file per day. When a limit can't be checked
  (database error), nothing is sent.

## Google Chat

- **Sign-in asks for the least it can.** The Google sign-in requests
  `chat.spaces.readonly` (list the spaces the user belongs to),
  `chat.memberships.app` (add the Library Pulse app to a space the user chose) and
  `openid email` (who connected). The scope list is pinned in `lib/google-oauth.js`
  and the callback refuses a grant that left out either Chat scope.
- **The user's token is never used to post.** Updates are posted by the Library
  Pulse Chat app itself (`chat.bot`), with credentials obtained through Workload
  Identity Federation from Vercel's OIDC token (or a service-account key). Chat marks
  such messages as coming from an app.
- **A connected account is private.** An installation can be put on a file only by
  the Figma user who signed in with it; other editors of that file may then edit the
  spaces, but cannot take the account elsewhere.
- **Events are authenticated.** Google Chat calls `/api/gchat/events` with a
  Google-signed OIDC ID token whose audience is that URL and whose issuer email is
  `chat@system.gserviceaccount.com`; the token is verified with google-auth-library
  before the body is read. The endpoint answers within Chat's 30-second window.
- **No injection through names.** Text in an update neutralises Chat's `<…>` syntax,
  so a component called `<users/all>` cannot mention everyone and a crafted name
  cannot smuggle a link.
- **Revocation is observed.** If Google rejects the stored refresh token, the
  installation is marked revoked and its files show "Reconnect Google Chat". Removing
  the app from a space in Chat stops posts to that space; `@Library Pulse stop`
  pauses them.

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
| Secrets in logs          | Structured logs scrub token/secret/passcode fields by key name; email addresses are masked (`a***@example.com`)                                                          |
| Unwanted email           | Double opt-in per address, sticky unsubscribe, signed single-purpose links, per-address and per-file sending limits (see "Email consent")                                |
| Email retries            | Per-recipient delivery de-duplication on the same event id (`notification_log.recipient`), since Amazon SES has no idempotency token                                     |
| Content injection        | Every user-controlled value in an email or on a confirm/unsubscribe page is HTML-escaped; the pages ship a CSP with no scripts                                           |

## Data we store & privacy

- **Locally**, in `figma.clientStorage` (sandboxed to this plugin), keys namespaced
  `lp/v1/*`: the app session token, the connected Slack workspace id/name, the Figma
  user id, and the saved configuration id.
- **In the backend** (Postgres on Supabase, serverless API on Vercel): the Figma user
  id, the selected file key and file name, the chosen Slack channel IDs, and the OAuth
  tokens — tokens encrypted at rest with AES-256-GCM. **No file contents are stored.**
- **For the Google Chat destination:** for each Google account that connected: its
  stable Google id, email address and Workspace domain, the Figma user who connected
  it, and its OAuth refresh token (encrypted at rest); for each file: the chosen spaces
  (id and display name) and the time zone of the editor who saved them; for each space
  the app was added to: its id, name, who added the app and when, whether the app is
  still a member, and whether updates were paused; and, in the delivery log, which
  space each update was posted to and whether it succeeded. Google processes the
  messages as the Chat app's provider.
- **For the email destination:** the addresses entered for a file, each with its state
  (pending, confirmed, unsubscribed) and the time it was added and confirmed; the time
  zone of the editor who saved the list; and, in the delivery log, which address each
  email was sent to and whether it succeeded. Addresses are visible to everyone who can
  edit that file. They are used only to send that file's notifications and are passed
  to Amazon SES for delivery.
- **Access** is limited to the maintainer, only via the Supabase service-role key held
  in a server environment variable; Row-Level Security is enabled on all tables. The
  data is never sold or shared and is used solely to deliver the user's own Slack
  notifications.
- **Deletion:** removing a configuration in the plugin deletes the corresponding
  database row and tears down the Figma webhook. Removing an address from a file's list, or switching the file to Slack, deletes it from the configuration. Delivery-log rows keep the address they were sent to; the optional cleanup job in `database/schema.sql` (`gc-notification-log`) deletes rows older than 90 days when it is enabled. Data requests: rajatgarg1809@gmail.com.

## Infrastructure & compliance

The backend runs on providers that maintain independent audits:

- **Vercel** (serverless functions) — SOC 2 Type II and ISO 27001:2022.
- **Supabase** (Postgres database) — SOC 2 Type II.
- **Amazon SES** (email delivery, only for files that use the email destination) — an AWS service. AWS publishes which services each of its compliance programs covers at [aws.amazon.com/compliance/services-in-scope](https://aws.amazon.com/compliance/services-in-scope/).

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
