// @ts-check
/**
 * Handler-level tests for /api/config with the Google Chat destination: what
 * a save writes, that the app is added to the newly chosen spaces with the
 * connecting account's token, who may name an installation, and switching.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  process.env.LOG_LEVEL = "error";
  process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  process.env.PUBLIC_URL = "https://library-pulse.vercel.app";
  return {
    db: /** @type {import("./helpers/fake-supabase.js").FakeSupabase} */ (
      /** @type {unknown} */ (null)
    ),
    ensureAppMemberships: /** @type {import("vitest").Mock} */ (/** @type {unknown} */ (null)),
    assertFileAccess: /** @type {import("vitest").Mock} */ (/** @type {unknown} */ (null)),
  };
});

vi.mock("../backend/lib/supabase.js", async () => {
  const { createFakeSupabase } = await import("./helpers/fake-supabase.js");
  h.db = createFakeSupabase();
  return { default: h.db };
});
vi.mock("../backend/lib/gchat-delivery.js", async (importOriginal) => {
  const actual = /** @type {typeof import("../backend/lib/gchat-delivery.js")} */ (
    await importOriginal()
  );
  h.ensureAppMemberships = vi.fn(async (_inst, spaces) => ({
    added: spaces.length,
    failed: 0,
    errors: [],
  }));
  return { ...actual, ensureAppMemberships: h.ensureAppMemberships };
});
vi.mock("../backend/lib/figma-access.js", () => {
  h.assertFileAccess = vi.fn(async () => undefined);
  return {
    assertFileAccess: h.assertFileAccess,
    getFigmaAccessToken: vi.fn(async () => ({ token: "figma-access" })),
  };
});

import handler from "../backend/api/config.js";
import { mintSession } from "../backend/lib/session.js";
import { createFakeResponse } from "./helpers/fake-supabase.js";

const FILE = "abcDEF123456";
const OWNER = "111111111";
const EDITOR = "222222222";
const INST = "0b1c2d3e-4f50-4a2e-9d1c-6f1c1b4e6d0b";
const INST_OTHER = "1b1c2d3e-4f50-4a2e-9d1c-6f1c1b4e6d0c";
const SPACES = [
  { name: "spaces/AAA", display_name: "Design" },
  { name: "spaces/BBB", display_name: "Ops" },
];

/**
 * @param {string} method
 * @param {{ as?: string, body?: Record<string, unknown>, query?: Record<string, string> }} [opts]
 */
async function call(method, { as = OWNER, body, query = {} } = {}) {
  const res = createFakeResponse();
  await handler(
    /** @type {any} */ ({
      method,
      url: "/api/config",
      headers: { authorization: `Bearer ${mintSession(as)}` },
      query,
      body,
    }),
    /** @type {any} */ (res),
  );
  return res;
}

const configs = () => h.db.tables.configurations ?? [];

beforeEach(() => {
  h.db.reset({
    configurations: [],
    notification_log: [],
    figma_webhooks: [{ id: "wh-1", context_id: FILE, status: "active" }],
    google_installations: [
      {
        id: INST,
        google_sub: "g-1",
        google_email: "hi@rajatg.in",
        google_hd: "rajatg.in",
        figma_user_id: OWNER,
        refresh_token_enc: "x",
        revoked_at: null,
      },
      {
        id: INST_OTHER,
        google_sub: "g-2",
        google_email: "other@example.com",
        google_hd: null,
        figma_user_id: EDITOR,
        refresh_token_enc: "x",
        revoked_at: null,
      },
    ],
  });
  h.ensureAppMemberships.mockClear();
  h.assertFileAccess.mockClear();
});

describe("POST /api/config — Google Chat", () => {
  it("writes the destination, the account, the spaces and the time zone, and adds the app to the spaces", async () => {
    const res = await call("POST", {
      body: {
        fileKey: FILE,
        fileName: "DS Core",
        destination: "gchat",
        googleInstallationId: INST,
        gchatSpaces: SPACES,
        timezone: "Asia/Kolkata",
        customMessage: "Heads up @PJ",
        customMentions: [{ id: "U0PJ00001", type: "user", label: "PJ" }],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({
      isOwner: true,
      webhookStatus: "existing",
      spaceMemberships: { added: 2, failed: 0, errors: [] },
    });
    expect(configs()[0]).toMatchObject({
      destination: "gchat",
      google_installation_id: INST,
      gchat_spaces: SPACES,
      gchat_timezone: "Asia/Kolkata",
      custom_message: "Heads up @PJ",
      custom_mentions: [], // mentions are Slack-only
    });
    for (const col of ["slack_team_id", "channels", "email_recipients", "email_timezone"]) {
      expect(configs()[0]).not.toHaveProperty(col);
    }
    expect(h.ensureAppMemberships).toHaveBeenCalledTimes(1);
    expect(h.ensureAppMemberships.mock.calls[0][0]).toMatchObject({ id: INST });
    expect(h.ensureAppMemberships.mock.calls[0][1]).toEqual(SPACES);
  });

  it("refuses an installation that belongs to someone else, a revoked one, and an unknown one", async () => {
    const base = { fileKey: FILE, destination: "gchat", gchatSpaces: SPACES, timezone: "UTC" };
    expect(
      (await call("POST", { body: { ...base, googleInstallationId: INST_OTHER } })).statusCode,
    ).toBe(403);
    expect(
      (
        await call("POST", {
          body: { ...base, googleInstallationId: "6f1c1b4e-6d0b-4a2e-9d1c-0b1c2d3e4f99" },
        })
      ).statusCode,
    ).toBe(404);
    h.db.tables.google_installations[0].revoked_at = "2026-01-01";
    const res = await call("POST", { body: { ...base, googleInstallationId: INST } });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("google_reauth_required");
    expect(configs()).toHaveLength(0);
    expect(h.ensureAppMemberships).not.toHaveBeenCalled();
  });

  it("validates the spaces and needs the account", async () => {
    const base = {
      fileKey: FILE,
      destination: "gchat",
      googleInstallationId: INST,
      timezone: "UTC",
    };
    expect((await call("POST", { body: { ...base, gchatSpaces: [] } })).statusCode).toBe(400);
    expect(
      (await call("POST", { body: { ...base, gchatSpaces: [{ name: "users/1" }] } })).statusCode,
    ).toBe(400);
    expect(
      (
        await call("POST", {
          body: { ...base, gchatSpaces: SPACES.concat(SPACES, SPACES, SPACES) },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await call("POST", {
          body: { fileKey: FILE, destination: "gchat", gchatSpaces: SPACES, timezone: "UTC" },
        })
      ).statusCode,
    ).toBe(400);
  });
});

describe("PUT /api/config — Google Chat", () => {
  const seed = () =>
    h.db.tables.configurations.push({
      id: "6f1c1b4e-6d0b-4a2e-9d1c-0b1c2d3e4f50",
      figma_user_id: OWNER,
      created_by: OWNER,
      figma_file_key: FILE,
      is_active: true,
      delivery_status: "ok",
      destination: "gchat",
      google_installation_id: INST,
      gchat_spaces: [SPACES[0]],
      gchat_timezone: "UTC",
      custom_mentions: [],
    });

  it("adds the app only to spaces that are new to the config", async () => {
    seed();
    const res = await call("PUT", { as: EDITOR, body: { fileKey: FILE, gchatSpaces: SPACES } });
    expect(res.statusCode).toBe(200);
    expect(h.assertFileAccess).toHaveBeenCalledWith(EDITOR, FILE);
    expect(configs()[0].gchat_spaces).toEqual(SPACES);
    expect(configs()[0].google_installation_id).toBe(INST); // another editor keeps the setter's account
    expect(h.ensureAppMemberships.mock.calls[0][1]).toEqual([SPACES[1]]);
    expect(res.body.spaceMemberships).toEqual({ added: 1, failed: 0, errors: [] });
  });

  it("switching to email clears the Google Chat side", async () => {
    seed();
    const res = await call("PUT", {
      body: {
        fileKey: FILE,
        destination: "email",
        emailRecipients: ["ana@example.com"],
        timezone: "UTC",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(configs()[0]).toMatchObject({
      destination: "email",
      google_installation_id: null,
      gchat_spaces: [],
      gchat_timezone: null,
      delivery_status: "ok",
    });
    expect(h.ensureAppMemberships).not.toHaveBeenCalled();
  });

  it("a build that predates destinations can't edit a Google Chat config by accident", async () => {
    seed();
    const res = await call("PUT", { body: { fileKey: FILE, channels: [{ id: "C0123456" }] } });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/Google Chat notifications/);
  });
});
