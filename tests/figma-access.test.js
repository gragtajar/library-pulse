// @ts-check
import { describe, it, expect } from "vitest";
import { FIGMA_OAUTH_SCOPES, scopeGranted, classifyAccess } from "../backend/lib/figma-oauth.js";

describe("FIGMA_OAUTH_SCOPES", () => {
  it("requests both webhook scopes", () => {
    const scopes = FIGMA_OAUTH_SCOPES.split(" ");
    expect(scopes).toContain("webhooks:write");
    expect(scopes).toContain("webhooks:read");
  });

  it("is space-delimited (comma-joining is parsed by Figma as one invalid scope)", () => {
    expect(FIGMA_OAUTH_SCOPES).not.toContain(",");
  });
});

describe("scopeGranted", () => {
  it("detects a scope present in the granted string", () => {
    expect(scopeGranted("webhooks:write webhooks:read", "webhooks:read")).toBe(true);
    expect(scopeGranted("webhooks:write webhooks:read", "webhooks:write")).toBe(true);
  });

  it("returns false when the scope is absent", () => {
    expect(scopeGranted("webhooks:write", "webhooks:read")).toBe(false);
  });

  it("handles null/empty/whitespace safely", () => {
    expect(scopeGranted(null, "webhooks:read")).toBe(false);
    expect(scopeGranted(undefined, "webhooks:read")).toBe(false);
    expect(scopeGranted("", "webhooks:read")).toBe(false);
    expect(scopeGranted("   ", "webhooks:read")).toBe(false);
  });
});

describe("classifyAccess", () => {
  it("→ reauth when the token lacks webhooks:read (regardless of status)", () => {
    expect(classifyAccess({ hasReadScope: false, ok: false, status: 403 })).toBe("reauth");
    expect(classifyAccess({ hasReadScope: false, ok: true, status: 200 })).toBe("reauth");
  });

  it("→ ok on any 2xx", () => {
    expect(classifyAccess({ hasReadScope: true, ok: true, status: 200 })).toBe("ok");
  });

  it("→ reauth on 401 (token revoked/expired)", () => {
    expect(classifyAccess({ hasReadScope: true, ok: false, status: 401 })).toBe("reauth");
  });

  it("→ forbidden on 403 (no file access)", () => {
    expect(classifyAccess({ hasReadScope: true, ok: false, status: 403 })).toBe("forbidden");
  });

  it("→ error on other non-2xx", () => {
    expect(classifyAccess({ hasReadScope: true, ok: false, status: 500 })).toBe("error");
    expect(classifyAccess({ hasReadScope: true, ok: false, status: 429 })).toBe("error");
  });
});
