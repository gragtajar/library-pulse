// @ts-check
/**
 * Handler-level tests for /api/gchat: the sign-in start and callback, the
 * space list, and the Chat events endpoint, all through the grouped Function.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  process.env.LOG_LEVEL = "error";
  process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  process.env.PUBLIC_URL = "https://library-pulse.vercel.app";
  process.env.GOOGLE_PUBLIC_URL = "https://updates.rajatg.in";
  process.env.GOOGLE_CLIENT_ID = "cid.apps.googleusercontent.com";
  process.env.GOOGLE_CLIENT_SECRET = "csecret";
  return {
    db: /** @type {import("./helpers/fake-supabase.js").FakeSupabase} */ (
      /** @type {unknown} */ (null)
    ),
    exchange: /** @type {import("vitest").Mock} */ (/** @type {unknown} */ (null)),
    verifyId: /** @type {import("vitest").Mock} */ (/** @type {unknown} */ (null)),
    refresh: /** @type {import("vitest").Mock} */ (/** @type {unknown} */ (null)),
    listSpaces: /** @type {import("vitest").Mock} */ (/** @type {unknown} */ (null)),
    verifyChat: /** @type {import("vitest").Mock} */ (/** @type {unknown} */ (null)),
    assertFileAccess: /** @type {import("vitest").Mock} */ (/** @type {unknown} */ (null)),
  };
});

vi.mock("../backend/lib/supabase.js", async () => {
  const { createFakeSupabase } = await import("./helpers/fake-supabase.js");
  h.db = createFakeSupabase();
  h.db.unique.google_installations = "google_sub";
  return { default: h.db };
});
vi.mock("../backend/lib/google-oauth.js", async (importOriginal) => {
  const actual = /** @type {typeof import("../backend/lib/google-oauth.js")} */ (
    await importOriginal()
  );
  h.exchange = vi.fn();
  h.verifyId = vi.fn();
  h.refresh = vi.fn(async () => ({ accessToken: "user-token", expiresIn: 3600 }));
  return {
    ...actual,
    exchangeGoogleCode: h.exchange,
    verifyGoogleIdToken: h.verifyId,
    refreshGoogleAccessToken: h.refresh,
  };
});
vi.mock("../backend/lib/google-chat.js", async (importOriginal) => {
  const actual = /** @type {typeof import("../backend/lib/google-chat.js")} */ (
    await importOriginal()
  );
  h.listSpaces = vi.fn(async () => ({
    spaces: [
      { name: "spaces/BBB", displayName: "Ops", spaceType: "SPACE" },
      { name: "spaces/AAA", displayName: "Design", spaceType: "SPACE" },
    ],
    truncated: false,
  }));
  return { ...actual, listSpaces: h.listSpaces };
});
vi.mock("../backend/lib/gchat-events.js", async (importOriginal) => {
  const actual = /** @type {typeof import("../backend/lib/gchat-events.js")} */ (
    await importOriginal()
  );
  h.verifyChat = vi.fn(async () => true);
  return { ...actual, verifyChatRequest: h.verifyChat };
});
vi.mock("../backend/lib/figma-access.js", () => {
  h.assertFileAccess = vi.fn(async () => undefined);
  return { assertFileAccess: h.assertFileAccess, getFigmaAccessToken: vi.fn() };
});

import gchat from "../backend/api/gchat.js";
import { GOOGLE_OAUTH_SCOPES } from "../backend/lib/google-oauth.js";
import { mintSession } from "../backend/lib/session.js";
import { decrypt, encrypt } from "../backend/lib/encryption.js";
import { _clearTokenCache } from "../backend/lib/google-installations.js";
import { CHAT_REPLIES } from "../backend/lib/gchat-message.js";
import { createFakeResponse } from "./helpers/fake-supabase.js";

const STATE = "6f1c1b4e-6d0b-4a2e-9d1c-0b1c2d3e4f50";
const INST_ID = "0b1c2d3e-4f50-4a2e-9d1c-6f1c1b4e6d0b";
const ME = "111111111";
const OTHER = "222222222";

/**
 * @param {string} fn
 * @param {{ method?: string, as?: string | null, body?: unknown, query?: Record<string, string>, headers?: Record<string, string> }} [o]
 */
async function call(fn, { method = "GET", as = ME, body, query = {}, headers = {} } = {}) {
  const res = createFakeResponse();
  await gchat(
    /** @type {any} */ ({
      method,
      url: `/api/gchat/${fn}`,
      headers: { ...(as ? { authorization: `Bearer ${mintSession(as)}` } : {}), ...headers },
      query: { fn, ...query },
      body,
    }),
    /** @type {any} */ (res),
  );
  return res;
}

const sessions = () => h.db.tables.auth_sessions;
const installs = () => h.db.tables.google_installations;

beforeEach(() => {
  h.db.reset({ auth_sessions: [], google_installations: [], configurations: [], gchat_spaces: [] });
  h.db.unique.google_installations = "google_sub";
  _clearTokenCache();
  h.exchange.mockReset();
  h.verifyId.mockReset();
  h.refresh.mockClear();
  h.listSpaces.mockClear();
  h.verifyChat.mockClear();
  h.verifyChat.mockImplementation(async () => true);
});

describe("POST /api/gchat/start", () => {
  it("needs the plugin session, records a pending Google session bound to the caller, and returns the sign-in URL", async () => {
    expect(
      (await call("start", { method: "POST", as: null, body: { state: STATE } })).statusCode,
    ).toBe(401);

    const res = await call("start", { method: "POST", body: { state: STATE } });
    expect(res.statusCode).toBe(200);
    const url = new URL(res.body.url);
    expect(url.host).toBe("accounts.google.com");
    expect(url.searchParams.get("state")).toBe(STATE);
    expect(url.searchParams.get("scope")?.split(" ")).toEqual(GOOGLE_OAUTH_SCOPES);
    expect(sessions()).toHaveLength(1);
    expect(sessions()[0]).toMatchObject({
      state: STATE,
      provider: "google",
      figma_user_id: ME,
      status: "pending",
    });
  });

  it("rejects a malformed state", async () => {
    expect((await call("start", { method: "POST", body: { state: "nope" } })).statusCode).toBe(400);
  });
});

describe("GET /api/gchat/callback", () => {
  const pendingSession = () =>
    sessions().push({
      state: STATE,
      provider: "google",
      figma_user_id: ME,
      status: "pending",
      used_at: null,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
  const goodTokens = {
    accessToken: "at",
    refreshToken: "rt",
    expiresIn: 3600,
    scope: GOOGLE_OAUTH_SCOPES.join(" "),
    idToken: "idt",
  };

  it("stores the account with its refresh token encrypted and completes the session", async () => {
    pendingSession();
    h.exchange.mockResolvedValue(goodTokens);
    h.verifyId.mockResolvedValue({ sub: "g-1", email: "hi@rajatg.in", hd: "rajatg.in" });

    const res = await call("callback", { as: null, query: { code: "c", state: STATE } });
    expect(res.statusCode).toBe(200);
    expect(String(res.body)).toContain("Connected as hi@rajatg.in");

    expect(installs()).toHaveLength(1);
    const inst = installs()[0];
    expect(inst).toMatchObject({
      google_sub: "g-1",
      google_email: "hi@rajatg.in",
      google_hd: "rajatg.in",
      figma_user_id: ME,
      revoked_at: null,
    });
    expect(inst.refresh_token_enc).not.toContain("rt");
    expect(decrypt(inst.refresh_token_enc)).toBe("rt");

    expect(sessions()[0]).toMatchObject({
      status: "completed",
      result_data: {
        google_installation_id: inst.id,
        google_email: "hi@rajatg.in",
        google_hd: "rajatg.in",
      },
    });
  });

  it("refuses when a Chat scope was unticked, and fails the session", async () => {
    pendingSession();
    h.exchange.mockResolvedValue({
      ...goodTokens,
      scope: "openid email https://www.googleapis.com/auth/chat.spaces.readonly",
    });
    const res = await call("callback", { as: null, query: { code: "c", state: STATE } });
    expect(String(res.body)).toContain("both Google Chat permissions");
    expect(installs()).toHaveLength(0);
    expect(sessions()[0]).toMatchObject({
      status: "failed",
      result_data: { error: "scopes_declined" },
    });
  });

  it("handles a denial, a missing code, a bad state and a replayed state", async () => {
    pendingSession();
    let res = await call("callback", { as: null, query: { error: "access_denied", state: STATE } });
    expect(String(res.body)).toContain("Authorization was denied.");
    expect(sessions()[0].status).toBe("failed");

    res = await call("callback", { as: null, query: { state: STATE } });
    expect(String(res.body)).toContain("Missing code or state.");
    res = await call("callback", { as: null, query: { code: "c", state: "zzz" } });
    expect(String(res.body)).toContain("Invalid state parameter.");
    // Already finalized above → the conditional claim finds no pending row.
    res = await call("callback", { as: null, query: { code: "c", state: STATE } });
    expect(res.statusCode).toBe(403);
    expect(h.exchange).not.toHaveBeenCalled();
  });

  it("clears a revoked flag on this account's configs when it reconnects", async () => {
    installs().push({
      id: INST_ID,
      google_sub: "g-1",
      figma_user_id: ME,
      refresh_token_enc: "old",
      revoked_at: "2026-01-01",
    });
    h.db.tables.configurations.push({
      id: "cfg",
      google_installation_id: INST_ID,
      delivery_status: "google_revoked",
      last_delivery_error: "invalid_grant",
    });
    pendingSession();
    h.exchange.mockResolvedValue(goodTokens);
    h.verifyId.mockResolvedValue({ sub: "g-1", email: "hi@rajatg.in", hd: "rajatg.in" });
    await call("callback", { as: null, query: { code: "c", state: STATE } });
    expect(installs()).toHaveLength(1);
    expect(installs()[0].revoked_at).toBeNull();
    expect(h.db.tables.configurations[0]).toMatchObject({
      delivery_status: "ok",
      last_delivery_error: null,
    });
  });
});

describe("GET /api/gchat/spaces", () => {
  const seedInstall = (owner = ME) =>
    installs().push({
      id: INST_ID,
      google_sub: "g-1",
      google_email: "hi@rajatg.in",
      figma_user_id: owner,
      refresh_token_enc: encrypt("rt"),
      revoked_at: null,
    });

  it("lists the caller's own installation's spaces, sorted by name", async () => {
    seedInstall();
    const res = await call("spaces", { query: { installationId: INST_ID } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      spaces: [
        { name: "spaces/AAA", displayName: "Design" },
        { name: "spaces/BBB", displayName: "Ops" },
      ],
    });
    expect(h.listSpaces).toHaveBeenCalledWith("user-token");
  });

  it("refuses another user's installation, and asks for a reconnect when the grant is gone", async () => {
    seedInstall(OTHER);
    expect((await call("spaces", { query: { installationId: INST_ID } })).statusCode).toBe(403);

    h.db.tables.google_installations = [];
    seedInstall();
    installs()[0].revoked_at = "2026-01-01";
    const res = await call("spaces", { query: { installationId: INST_ID } });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("google_reauth_required");
  });

  it("lets another editor of a file use the installation on that file's config", async () => {
    seedInstall(OTHER);
    h.db.tables.configurations.push({
      id: "cfg",
      figma_file_key: "abcDEF123456",
      created_by: OTHER,
      google_installation_id: INST_ID,
    });
    const res = await call("spaces", { query: { fileKey: "abcDEF123456" } });
    expect(res.statusCode).toBe(200);
    expect(h.assertFileAccess).toHaveBeenCalledWith(ME, "abcDEF123456");
  });

  it("needs a session and a target", async () => {
    expect(
      (await call("spaces", { as: null, query: { installationId: INST_ID } })).statusCode,
    ).toBe(401);
    expect((await call("spaces")).statusCode).toBe(400);
  });
});

describe("POST /api/gchat/events", () => {
  const SPACE = { name: "spaces/AAA", displayName: "Design", spaceType: "SPACE" };

  it("rejects a request Chat didn't sign", async () => {
    h.verifyChat.mockImplementation(async () => false);
    const res = await call("events", {
      method: "POST",
      as: null,
      body: { type: "ADDED_TO_SPACE", space: SPACE },
    });
    expect(res.statusCode).toBe(401);
    expect(h.db.tables.gchat_spaces).toHaveLength(0);
  });

  it("handles a verified event and replies in Chat's message shape", async () => {
    const res = await call("events", {
      method: "POST",
      as: null,
      headers: { authorization: "Bearer good" },
      body: { type: "ADDED_TO_SPACE", space: SPACE, user: { name: "users/1" } },
    });
    expect(h.verifyChat).toHaveBeenCalledWith("Bearer good");
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ text: CHAT_REPLIES.welcome });
    expect(h.db.tables.gchat_spaces[0]).toMatchObject({
      space_name: "spaces/AAA",
      app_member: true,
    });
  });

  it("answers GET so the URL can be checked, and refuses other methods", async () => {
    expect((await call("events", { method: "GET", as: null })).statusCode).toBe(200);
    expect((await call("events", { method: "PUT", as: null })).statusCode).toBe(405);
  });
});

describe("the grouped Function", () => {
  it("exposes exactly the four handlers", () => {
    expect(gchat.handlers).toEqual(["start", "callback", "spaces", "events"]);
  });
});
