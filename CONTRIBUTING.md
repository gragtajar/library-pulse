# Contributing

Welcome — quick guide to getting set up and shipping changes that survive review.

## Prerequisites

- Node 20+ (`.nvmrc` pins the major version — `nvm use` if you have nvm)
- npm 10+
- `vercel` CLI (only if you want to run `npm run dev` in `backend/`)
- A Supabase project (free tier works) for local backend runs

## First-time setup

```bash
git clone git@github.com:gragtajar/library-pulse.git
cd library-pulse
nvm use
npm install            # also runs `husky` via the prepare script
cp .env.example backend/.env   # then fill in real values
```

Verify the toolchain:

```bash
npm run verify         # format check + lint + typecheck + manifest validate + tests
```

Everything should pass on a fresh clone. If anything fails, fix it before starting work.

## Branching

- Trunk-based. Feature branches are short-lived: `feat/<short-slug>`, `fix/<short-slug>`, `chore/<short-slug>`.
- Rebase onto `main` before opening a PR — we keep linear history on `main`.
- One conceptual change per PR. Splitting "tooling change + behaviour change" into two PRs makes review trivial; merging them makes review impossible.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/). `commitlint` enforces this at `commit-msg` time. Allowed types: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `security`, `revert`.

```
feat(webhook): dedupe Figma retries via webhook_events
fix(auth): enforce auth_sessions.expires_at in callbacks
docs(adr): record ADR-003 webhook passcode model
security(slack-blocks): escape <!channel> in mrkdwn output
```

Subject in lowercase, imperative mood, no trailing period.

## Pre-commit hooks

`husky` is installed by `npm install`. Three hooks run automatically:

| Hook | What it does |
|---|---|
| `pre-commit` | `lint-staged`: ESLint + Prettier on staged files |
| `commit-msg` | `commitlint` on the message |
| `pre-push` | `npm run typecheck && npm test` |

If a hook fails, fix the underlying issue and stage + commit again. **Do not `--no-verify`** unless you have a written reason (e.g. an emergency hotfix) and you've opened a follow-up to fix the lint failure.

## Adding code

### A new backend endpoint

1. Create `backend/api/<name>.js` exporting a default `(req, res) => …` handler.
2. Wrap it in `withErrorHandling` from `lib/http.js` so thrown `LibraryPulseError`s become typed responses.
3. Add a route in `backend/vercel.json`.
4. Validate every input at the boundary using helpers from `lib/validators.js`.
5. Never `console.log` — import `logger` from `lib/logger.js`.
6. If the endpoint mutates state, require the `X-Figma-User` header and compare it to the row's `figma_user_id`. See `api/config.js` for the pattern.

### A new database column or table

1. Update `database/schema.sql` (the canonical full schema for fresh installs).
2. Add a migration file in `database/migrations/NNNN-<slug>.sql` that runs against an existing database. Migrations are append-only — never edit a published one.
3. Update relevant code to handle both schemas during the rollout window if the change isn't backwards-compatible.

### A new plugin UI feature

1. Add the markup to `figma-plugin/ui.html`.
2. Use the `api(...)` wrapper — never call `fetch(API_BASE + …)` directly. The wrapper injects `X-Figma-User`.
3. Validate user input client-side AND on the backend. Client validation is UX; backend validation is security.
4. If you need a new sandbox capability, extend the `ALLOWED_UI_MESSAGE_TYPES` set in `code.js` and add the case to the message handler.

### A new external API call

1. Add the origin (e.g. `https://api.example.com`) to `figma-plugin/manifest.json`'s `networkAccess.allowedDomains`.
2. CI's `npm run check:api-base` script enforces this — it will fail if you forget.

## Tests

```bash
npm test               # full run
npm run test:watch     # watch mode while iterating
npm run test:coverage  # with v8 coverage
```

What we test:
- **Lib helpers** (`backend/lib/*`): full unit coverage for pure functions — encryption round-trip + tampering, validators, escape, idempotency key derivation, slack-blocks formatting + escaping.
- **API handlers:** not yet — needs a Supabase test harness. PRs welcome.
- **UI:** not yet — happy-dom + dispatching `postMessage` is feasible; tracked as future work.

## Pull request checklist

Copy-pasted into every PR by the template:

- [ ] Tests added or updated
- [ ] `npm run verify` passes locally
- [ ] If you added an API endpoint: docs / runbook updated
- [ ] If you added an external host: `manifest.json` updated
- [ ] If you made an architectural decision: ADR added in `docs/adrs/`
- [ ] No `--no-verify` commits
- [ ] No secrets in code or in test fixtures

## Reporting a security issue

Don't open a public issue. See [SECURITY.md](./SECURITY.md).
