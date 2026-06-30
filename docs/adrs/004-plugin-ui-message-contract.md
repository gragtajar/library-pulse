# ADR 004: Plugin ↔ UI message contract

**Status:** Accepted
**Date:** 2026-04-20

## Context

Figma plugins are split between two runtimes that can only communicate via `postMessage`:

- **Sandbox** (`code.js`) — has `figma.*`, no DOM, no network.
- **UI** (`ui.html`) — has DOM, `fetch`, no `figma.*`.

Every plugin needs a custom protocol between the two. The shape of that protocol is shipped to users and is hard to change later — if a future UI sends a payload the sandbox doesn't understand, the user sees a frozen plugin.

## Decision

1. **Closed message set.** Both sides have an explicit allow-list. The sandbox defines `ALLOWED_UI_MESSAGE_TYPES`; an unknown `type` immediately calls `figma.notify(..., { error: true })` and aborts. The UI has the symmetric `case` statement in its `onmessage` handler.
2. **All messages are objects with a `type: string` discriminator.** Documented as JSDoc typedefs in `backend/lib/types.js` (`UiToPluginMessage`, `PluginToUiMessage`).
3. **Storage keys are namespaced.** Every `figma.clientStorage` key the UI requests is prefixed with `lp/v1/` server-side. The `v1` lets us bump the prefix on breaking schema changes without colliding with a future namespace.
4. **Storage values have a hard byte cap.** Currently 200 KB. Figma's per-plugin quota is 5 MB; capping per-value avoids a runaway UI pinning the whole budget.
5. **`open-url` is `https://` only.** Defence-in-depth — even if the UI is XSS'd, an attacker can't pivot to opening a `file://` or `javascript:` URL via the sandbox.
6. **Top-level error boundary.** Every sandbox handler is wrapped in `safe(type, fn)`. A thrown error surfaces via `figma.notify` (visible to the user) AND posts a `{ type: "error" }` message to the UI (so the UI can clean up loading spinners).

## Alternatives considered

- **Free-form messages with runtime type narrowing.** What v1 had. Easy to write, very easy to break — adding a typo'd `type` silently does nothing.
- **A shared TypeScript declaration file imported by both runtimes.** Right answer if the codebase migrates to TS. Today we get the same enforcement via JSDoc + the allow-list set.
- **Custom RPC layer with response correlation IDs.** Overkill for ~6 message types. If the protocol grows past ~20 messages, revisit.

## Consequences

- Adding a new message type requires changes in three places: the `ALLOWED_UI_MESSAGE_TYPES` set, the sandbox `switch`, and the JSDoc typedef. This is a feature — it makes "I added a message but forgot to wire it up" a compile-time error in `npm run typecheck`.
- Storage payloads larger than 200 KB throw. Future feature requests (e.g. caching team rosters) will need a smarter strategy — chunking, or moving to backend storage.
- The `lp/v1/` prefix is forever. If we ever ship a v2 with incompatible storage, we can roll forward to `lp/v2/` and migrate or discard the v1 namespace.

## References

- `figma-plugin/code.js` (sandbox + allow-list)
- `figma-plugin/ui.html` (UI side of the protocol)
- `backend/lib/types.js` (JSDoc typedefs — also imported by other modules for `req`/`res` shapes)
