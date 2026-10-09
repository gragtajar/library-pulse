// @ts-check
/**
 * Saves against the production database as it was on 2026-10-08: migration
 * 007 applied from an early copy that lacked `configurations.gchat_timezone`.
 * Every save then failed with PGRST204, email included, because email and
 * Slack saves also wrote the (empty) Google Chat columns. A save now names
 * only the columns of the destinations it involves, so only a Google Chat
 * save needs that column, and migration 008 adds it.
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
  };
});

vi.mock("../backend/lib/supabase.js", async () => {
  const { createFakeSupabase } = await import("./helpers/fake-supabase.js");
  h.db = createFakeSupabase();
  return { default: h.db };
});
vi.mock("../backend/lib/email-send.js", async (importOriginal) => {
  const actual = /** @type {typeof import("../backend/lib/email-send.js")} */ (
    await importOriginal()
  );
  return { ...actual, sendEmail: vi.fn(async () => ({ messageId: "m-1" })) };
});
vi.mock("../backend/lib/gchat-delivery.js", async (importOriginal) => {
  const actual = /** @type {typeof import("../backend/lib/gchat-delivery.js")} */ (
    await importOriginal()
  );
  return {
    ...actual,
    ensureAppMemberships: vi.fn(async (_inst, spaces) => ({
      added: spaces.length,
      failed: 0,
      errors: [],
    })),
  };
});
vi.mock("../backend/lib/figma-access.js", () => ({
  assertFileAccess: vi.fn(async () => undefined),
  getFigmaAccessToken: vi.fn(async () => ({ token: "figma-access" })),
}));

import handler from "../backend/api/config.js";
import { mintSession } from "../backend/lib/session.js";
import { createFakeResponse } from "./helpers/fake-supabase.js";

const FILE = "abcDEF123456";
const OWNER = "111111111";
const INST = "0b1c2d3e-4f50-4a2e-9d1c-6f1c1b4e6d0b";
const CONFIG_ID = "6f1c1b4e-6d0b-4a2e-9d1c-0b1c2d3e4f50";
const CHANNELS = [{ id: "C0123456", name: "#design", is_private: false }];
const SPACES = [{ name: "spaces/AAA", display_name: "Design" }];

/** `configurations` in production on 2026-10-08: schema.sql + 003–007 (early 007). */
const PRODUCTION_COLUMNS = [
  "id",
  "figma_user_id",
  "created_by",
  "figma_team_id",
  "figma_file_key",
  "figma_file_name",
  "destination",
  "slack_team_id",
  "channels",
  "email_recipients",
  "email_timezone",
  "custom_message",
  "custom_mentions",
  "is_active",
  "delivery_status",
  "last_delivery_error",
  "created_at",
  "updated_at",
  "google_installation_id",
  "gchat_spaces",
];

/**
 * @param {string} method
 * @param {Record<string, unknown>} body
 */
async function call(method, body) {
  const res = createFakeResponse();
  await handler(
    /** @type {any} */ ({
      method,
      url: "/api/config",
      headers: { authorization: `Bearer ${mintSession(OWNER)}` },
      query: {},
      body,
    }),
    /** @type {any} */ (res),
  );
  return res;
}

/** @param {boolean} migrated  whether migration 008 has run */
function seed(migrated) {
  h.db.reset({
    configurations: [],
    notification_log: [],
    figma_webhooks: [{ id: "wh-1", context_id: FILE, status: "active" }],
    google_installations: [
      { id: INST, google_sub: "g-1", figma_user_id: OWNER, refresh_token_enc: "x" },
    ],
  });
  // `created_at` and `id` come from the fake itself on insert.
  h.db.columns.configurations = new Set(
    migrated ? [...PRODUCTION_COLUMNS, "gchat_timezone"] : PRODUCTION_COLUMNS,
  );
}

/** @param {Record<string, unknown>} row */
function existing(row) {
  h.db.tables.configurations.push({
    id: CONFIG_ID,
    figma_user_id: OWNER,
    created_by: OWNER,
    figma_file_key: FILE,
    is_active: true,
    delivery_status: "ok",
    custom_mentions: [],
    ...row,
  });
}

describe("before migration 008 (no configurations.gchat_timezone)", () => {
  beforeEach(() => seed(false));

  it("an email setup saves", async () => {
    const res = await call("POST", {
      fileKey: FILE,
      destination: "email",
      emailRecipients: ["ana@example.com"],
      timezone: "Asia/Kolkata",
    });
    expect(res.statusCode).toBe(201);
    expect(h.db.tables.configurations[0]).toMatchObject({ destination: "email" });
  });

  it("a Slack setup from the current plugin saves", async () => {
    const res = await call("POST", {
      fileKey: FILE,
      destination: "slack",
      slackTeamId: "T0123",
      channels: CHANNELS,
    });
    expect(res.statusCode).toBe(201);
  });

  it("switching Slack → email, and email → Slack, saves", async () => {
    existing({ destination: "slack", slack_team_id: "T0123", channels: CHANNELS });
    let res = await call("PUT", {
      fileKey: FILE,
      destination: "email",
      emailRecipients: ["ana@example.com"],
      timezone: "UTC",
    });
    expect(res.statusCode).toBe(200);
    res = await call("PUT", {
      fileKey: FILE,
      destination: "slack",
      slackTeamId: "T0123",
      channels: CHANNELS,
    });
    expect(res.statusCode).toBe(200);
    expect(h.db.tables.configurations[0]).toMatchObject({ destination: "slack" });
  });

  it("a Google Chat setup still fails, which migration 008 fixes", async () => {
    const res = await call("POST", {
      fileKey: FILE,
      destination: "gchat",
      googleInstallationId: INST,
      gchatSpaces: SPACES,
      timezone: "UTC",
    });
    expect(res.statusCode).toBe(502);
  });
});

describe("after migration 008", () => {
  beforeEach(() => seed(true));

  it("a Google Chat setup saves", async () => {
    const res = await call("POST", {
      fileKey: FILE,
      destination: "gchat",
      googleInstallationId: INST,
      gchatSpaces: SPACES,
      timezone: "Asia/Kolkata",
    });
    expect(res.statusCode).toBe(201);
    expect(h.db.tables.configurations[0]).toMatchObject({
      destination: "gchat",
      gchat_timezone: "Asia/Kolkata",
    });
  });

  it("switching Google Chat → email clears the Google Chat columns", async () => {
    existing({ destination: "gchat", google_installation_id: INST, gchat_spaces: SPACES });
    const res = await call("PUT", {
      fileKey: FILE,
      destination: "email",
      emailRecipients: ["ana@example.com"],
      timezone: "UTC",
    });
    expect(res.statusCode).toBe(200);
    expect(h.db.tables.configurations[0]).toMatchObject({
      destination: "email",
      google_installation_id: null,
      gchat_spaces: [],
      gchat_timezone: null,
    });
  });
});
