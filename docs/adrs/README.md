# Architecture Decision Records

We use ADRs to record meaningful architectural choices — the ones we'd otherwise re-debate every six months. Format borrowed from Michael Nygard's template, slimmed slightly.

| #   | Title                                                | Status   |
| --- | ---------------------------------------------------- | -------- |
| 001 | [Vercel serverless + Supabase backend](./001-vercel-and-supabase.md) | Accepted |
| 002 | [AES-256-GCM for token storage](./002-token-encryption.md)            | Accepted |
| 003 | [Webhook passcode authentication model](./003-webhook-passcode-model.md) | Accepted |
| 004 | [Plugin ↔ UI message contract](./004-plugin-ui-message-contract.md)   | Accepted |

## When to write a new ADR

- You're making a choice that's hard to reverse (data model, encryption scheme, hosting).
- You're rejecting an obvious alternative for non-obvious reasons.
- A future contributor would likely revisit this if not documented.

## When not to

- "Should this function be named X or Y" — name it, move on.
- "Which lint rule to enable" — config, not architecture.
- A choice you'll change in a sprint or two — wait until it stabilizes.

## Template

```markdown
# ADR NNN: <title>

**Status:** Accepted | Proposed | Deprecated | Superseded by ADR XXX
**Date:** YYYY-MM-DD

## Context
What problem are we solving? What constraints exist?

## Decision
What we decided, in one paragraph.

## Alternatives considered
- Alternative A — why rejected
- Alternative B — why rejected

## Consequences
What we gain. What we accept. What we leave on the table.

## References
Links to code, prior art, related ADRs.
```
