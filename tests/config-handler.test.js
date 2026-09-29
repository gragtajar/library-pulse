// @ts-check
/**
 * Handler-level tests for /api/config: what actually gets written for each
 * destination, that a build which predates destinations still behaves exactly
 * as before, and that email confirmations follow the save.
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
    sendEmail: /** @type {import("vitest").Mock} */ (/** @type {unknown} */ (null)),
    assertFileAccess: /** @type {import("vitest").Mock} */ (/** @type {unknown} */ (null)),
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
  h.sendEmail = vi.fn(async () => ({ messageId: "m-1" }));
  return { ...actual, sendEmail: h.sendEmail };
});

vi.mock("../backend/lib/figma-access.js", () => {
  h.assertFileAccess = vi.fn(async () => undefined);
  return {
    assertFileAccess: h.assertFileAccess,
    getFigmaAccessToken: vi.fn(async () => ({ token: "figma-access" })),
  };
});

import handler from "../backend/api/config.js";
import { EmailSendError } from "../backend/lib/email-send.js";
import { mintSession } from "../backend/lib/session.js";
import { createFakeResponse } from "./helpers/fake-supabase.js";

const FILE = "abcDEF123456";
const OWNER = "111111111";
const EDITOR = "222222222";
const CHANNELS = [{ id: "C0123456", name: "#design", is_private: false }];
const NOW = "2026-09-28T10:00:00.000Z";

/**
 * @param {string} method
 * @param {{ as?: string | null, body?: Record<string, unknown>, query?: Record<string, string> }} [opts]
 */
async function call(method, { as = OWNER, body, query = {} } = {}) {
  const res = createFakeResponse();
  await handler(
    {
      method,
      url: "/api/config",
      headers: as ? { authorization: `Bearer ${mintSession(as)}` } : {},
      query,
      body,
    },
    res,
  );
  return res;
}

const configs = () => h.db.tables.configurations ?? [];
const sentTo = () => h.sendEmail.mock.calls.map((c) => c[0].to).sort();

/** @param {Record<string, unknown>} over */
function seedConfig(over) {
  h.db.tables.configurations = [
    {
      id: "6f1c1b4e-6d0b-4a2e-9d1c-0b1c2d3e4f50",
      figma_user_id: OWNER,
      created_by: OWNER,
      figma_file_key: FILE,
      figma_file_name: "DS Core",
      is_active: true,
      delivery_status: "ok",
      custom_message: null,
      custom_mentions: [],
      ...over,
    },
  ];
}
const SLACK_ROW = { destination: "slack", slack_team_id: "T0123", channels: CHANNELS };
const EMAIL_ROW = {
  destination: "email",
  slack_team_id: null,
  channels: [],
  email_timezone: "Asia/Kolkata",
  email_recipients: [
    { email: "ana@example.com", status: "confirmed", added_at: NOW, confirmed_at: NOW },
    { email: "ben@example.com", status: "pending", added_at: NOW, confirmed_at: null },
  ],
};

beforeEach(() => {
  // An active webhook already exists, so saves don't call out to Figma.
  h.db.reset({
    configurations: [],
    notification_log: [],
    figma_webhooks: [{ id: "wh-1", context_id: FILE, status: "active" }],
  });
  h.sendEmail.mockReset();
  h.sendEmail.mockImplementation(async () => ({ messageId: "m-1" }));
  h.assertFileAccess.mockReset();
  h.assertFileAccess.mockImplementation(async () => undefined);
});

describe("POST /api/config — Slack", () => {
  it("a build that predates destinations writes exactly the columns it always did", async () => {
    const res = await call("POST", {
      body: {
        figmaUserId: OWNER,
        fileKey: FILE,
        fileName: "DS Core",
        slackTeamId: "T0123",
        channels: CHANNELS,
        customMessage: "Heads up @PJ",
        customMentions: [{ id: "U0PJ00001", type: "user", label: "PJ" }],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({ isOwner: true, webhookStatus: "existing" });
    expect(res.body).not.toHaveProperty("emailConfirmations");

    const { id: _id, created_at: _at, ...written } = configs()[0] ?? {};
    // No destination / email columns: safe on a database without migration 006.
    expect(written).toEqual({
      figma_user_id: OWNER,
      created_by: OWNER,
      figma_file_key: FILE,
      figma_file_name: "DS Core",
      is_active: true,
      slack_team_id: "T0123",
      channels: CHANNELS,
      custom_message: "Heads up @PJ",
      custom_mentions: [{ id: "U0PJ00001", type: "user", label: "PJ" }],
    });
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it("a current build also records the destination", async () => {
    const res = await call("POST", {
      body: { fileKey: FILE, destination: "slack", slackTeamId: "T0123", channels: CHANNELS },
    });
    expect(res.statusCode).toBe(201);
    expect(configs()[0]).toMatchObject({
      destination: "slack",
      slack_team_id: "T0123",
      channels: CHANNELS,
      email_recipients: [],
      email_timezone: null,
    });
  });

  it("still requires a workspace and 1–3 channels", async () => {
    const noTeam = await call("POST", { body: { fileKey: FILE, channels: CHANNELS } });
    expect(noTeam.statusCode).toBe(400);
    expect(noTeam.body.error).toBe("Missing slackTeamId");
    const noChannels = await call("POST", { body: { fileKey: FILE, slackTeamId: "T0123" } });
    expect(noChannels.statusCode).toBe(400);
    expect(configs()).toHaveLength(0);
  });
});

describe("POST /api/config — email", () => {
  const body = {
    fileKey: FILE,
    fileName: "DS Core",
    destination: "email",
    emailRecipients: ["Ana@Example.com", "ben@example.com"],
    timezone: "Asia/Kolkata",
    customMessage: "See the changelog",
    customMentions: [{ id: "U0PJ00001", type: "user", label: "PJ" }],
  };

  it("stores the addresses as pending and sends each a confirmation", async () => {
    const res = await call("POST", { body });
    expect(res.statusCode).toBe(201);
    expect(res.body.emailConfirmations).toEqual({ sent: 2, failed: 0, skipped: 0 });
    expect(configs()[0]).toMatchObject({
      destination: "email",
      slack_team_id: null,
      channels: [],
      email_timezone: "Asia/Kolkata",
      custom_message: "See the changelog",
      custom_mentions: [], // mentions are Slack-only, whatever the client sent
    });
    expect(configs()[0]?.email_recipients).toEqual([
      expect.objectContaining({ email: "ana@example.com", status: "pending", confirmed_at: null }),
      expect.objectContaining({ email: "ben@example.com", status: "pending", confirmed_at: null }),
    ]);
    expect(sentTo()).toEqual(["ana@example.com", "ben@example.com"]);
    expect(h.sendEmail.mock.calls[0]?.[0].subject).toBe(
      "Confirm Library Pulse updates for DS Core",
    );
  });

  it("rejects bad input before anything is written or sent", async () => {
    for (const bad of [
      { ...body, emailRecipients: ["ana@example.com", "nope"] },
      { ...body, emailRecipients: [] },
      { ...body, emailRecipients: ["a@x.io", "b@x.io", "c@x.io", "d@x.io", "e@x.io", "f@x.io"] },
      { ...body, timezone: "Mars/Phobos" },
      { ...body, timezone: undefined },
      { ...body, destination: "teams" },
    ]) {
      const res = await call("POST", { body: bad });
      expect(res.statusCode).toBe(400);
    }
    expect(configs()).toHaveLength(0);
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it("saves even when the confirmation can't be sent, and says so", async () => {
    h.sendEmail.mockImplementation(async () => {
      throw new EmailSendError("not_configured");
    });
    const res = await call("POST", { body });
    expect(res.statusCode).toBe(201);
    expect(res.body.emailConfirmations).toEqual({ sent: 0, failed: 2, skipped: 0 });
    expect(configs()).toHaveLength(1);
  });

  it("the setter re-saving keeps confirmed addresses confirmed", async () => {
    seedConfig(EMAIL_ROW);
    const res = await call("POST", {
      body: { ...body, emailRecipients: ["ana@example.com", "cho@example.com"] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.emailConfirmations).toEqual({ sent: 1, failed: 0, skipped: 0 });
    expect(configs()[0]?.email_recipients).toEqual([
      expect.objectContaining({ email: "ana@example.com", status: "confirmed" }),
      expect.objectContaining({ email: "cho@example.com", status: "pending" }),
    ]);
    expect(sentTo()).toEqual(["cho@example.com"]);
  });

  it("another user creating over an existing config gets the shared one back", async () => {
    seedConfig(EMAIL_ROW);
    const res = await call("POST", { as: EDITOR, body });
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ error: "config_exists", isOwner: false });
    expect(configs()[0]?.email_recipients).toEqual(EMAIL_ROW.email_recipients);
    expect(h.sendEmail).not.toHaveBeenCalled();
  });
});

describe("PUT /api/config", () => {
  it("any editor can change the list; their file access is checked", async () => {
    seedConfig(EMAIL_ROW);
    const res = await call("PUT", {
      as: EDITOR,
      body: {
        fileKey: FILE,
        destination: "email",
        emailRecipients: ["ana@example.com", "dee@example.com"],
        timezone: "Europe/London",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(h.assertFileAccess).toHaveBeenCalledWith(EDITOR, FILE);
    expect(res.body).toMatchObject({ isOwner: false, email_timezone: "Europe/London" });
    expect(res.body.emailConfirmations).toEqual({ sent: 1, failed: 0, skipped: 0 });
    expect(configs()[0]?.email_recipients).toEqual([
      expect.objectContaining({ email: "ana@example.com", status: "confirmed" }),
      expect.objectContaining({ email: "dee@example.com", status: "pending" }),
    ]);
    expect(sentTo()).toEqual(["dee@example.com"]);
  });

  it("an editor without access to the file is refused", async () => {
    seedConfig(EMAIL_ROW);
    const { ForbiddenError } = await import("../backend/lib/errors.js");
    h.assertFileAccess.mockImplementation(async () => {
      throw new ForbiddenError("figma_file_access_denied");
    });
    const res = await call("PUT", {
      as: EDITOR,
      body: { fileKey: FILE, destination: "email", emailRecipients: ["evil@example.com"] },
    });
    expect(res.statusCode).toBe(403);
    expect(configs()[0]?.email_recipients).toEqual(EMAIL_ROW.email_recipients);
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it("pausing an email config touches nothing else and sends nothing", async () => {
    seedConfig(EMAIL_ROW);
    const res = await call("PUT", { body: { fileKey: FILE, isActive: false } });
    expect(res.statusCode).toBe(200);
    expect(configs()[0]).toMatchObject({ ...EMAIL_ROW, is_active: false });
    expect(res.body).not.toHaveProperty("emailConfirmations");
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it("switching Slack → email clears the Slack side and resets the delivery record", async () => {
    seedConfig({
      ...SLACK_ROW,
      delivery_status: "slack_revoked",
      last_delivery_error: "token_revoked",
      custom_message: "Heads up @PJ",
      custom_mentions: [{ id: "U0PJ00001", type: "user", label: "PJ" }],
    });
    const res = await call("PUT", {
      body: {
        fileKey: FILE,
        destination: "email",
        emailRecipients: ["ana@example.com"],
        timezone: "Asia/Kolkata",
        customMessage: "Heads up @PJ",
        customMentions: [{ id: "U0PJ00001", type: "user", label: "PJ" }],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(configs()[0]).toMatchObject({
      destination: "email",
      slack_team_id: null,
      channels: [],
      custom_message: "Heads up @PJ",
      custom_mentions: [],
      delivery_status: "ok",
      last_delivery_error: null,
      email_timezone: "Asia/Kolkata",
    });
    expect(sentTo()).toEqual(["ana@example.com"]);
  });

  it("switching email → Slack needs a workspace and channels, and clears the addresses", async () => {
    seedConfig(EMAIL_ROW);
    const missing = await call("PUT", { body: { fileKey: FILE, destination: "slack" } });
    expect(missing.statusCode).toBe(400);
    expect(configs()[0]).toMatchObject(EMAIL_ROW);

    const res = await call("PUT", {
      body: { fileKey: FILE, destination: "slack", slackTeamId: "T0123", channels: CHANNELS },
    });
    expect(res.statusCode).toBe(200);
    expect(configs()[0]).toMatchObject({
      destination: "slack",
      slack_team_id: "T0123",
      channels: CHANNELS,
      email_recipients: [],
      email_timezone: null,
    });
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it("a Slack edit from a build that predates destinations is unchanged", async () => {
    seedConfig(SLACK_ROW);
    const two = [...CHANNELS, { id: "C0ABCDEF", name: "#eng" }];
    const res = await call("PUT", {
      body: { fileKey: FILE, channels: two, customMessage: null, customMentions: [] },
    });
    expect(res.statusCode).toBe(200);
    expect(configs()[0]).toMatchObject({
      destination: "slack",
      slack_team_id: "T0123",
      channels: two,
      custom_message: null,
    });
  });

  it("tells a build that predates destinations why it can't edit an email config", async () => {
    seedConfig(EMAIL_ROW);
    const res = await call("PUT", { body: { fileKey: FILE, channels: CHANNELS } });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/Update the Library Pulse plugin/);
    expect(configs()[0]).toMatchObject(EMAIL_ROW);
  });

  it("404s for a file with no config and 400s for an empty edit", async () => {
    expect((await call("PUT", { body: { fileKey: FILE, isActive: false } })).statusCode).toBe(404);
    seedConfig(SLACK_ROW);
    expect((await call("PUT", { body: { fileKey: FILE } })).statusCode).toBe(400);
  });
});

describe("GET /api/config and auth", () => {
  it("returns the shared config, addresses and states included", async () => {
    seedConfig(EMAIL_ROW);
    const res = await call("GET", { as: EDITOR, query: { fileKey: FILE } });
    expect(res.statusCode).toBe(200);
    expect(res.body.isOwner).toBe(false);
    expect(res.body.config.email_recipients).toEqual(EMAIL_ROW.email_recipients);
    expect(h.assertFileAccess).toHaveBeenCalledWith(EDITOR, FILE);
  });

  it("requires a session for every method", async () => {
    seedConfig(EMAIL_ROW);
    for (const method of ["GET", "POST", "PUT", "DELETE"]) {
      const res = await call(method, {
        as: null,
        body: { fileKey: FILE },
        query: { fileKey: FILE },
      });
      expect(res.statusCode).toBe(401);
    }
    expect(configs()[0]).toMatchObject(EMAIL_ROW);
  });
});
