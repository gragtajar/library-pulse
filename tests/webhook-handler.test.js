// @ts-check
/**
 * Handler-level tests for /api/webhook: the email fan-out, and that the Slack
 * fan-out is untouched by it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const h = vi.hoisted(() => {
  process.env.LOG_LEVEL = "error";
  process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  process.env.PUBLIC_URL = "https://library-pulse.vercel.app";
  return {
    db: /** @type {import("./helpers/fake-supabase.js").FakeSupabase} */ (
      /** @type {unknown} */ (null)
    ),
    sendEmail: /** @type {import("vitest").Mock} */ (/** @type {unknown} */ (null)),
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

import handler from "../backend/api/webhook.js";
import { EmailSendError } from "../backend/lib/email-send.js";
import { encrypt } from "../backend/lib/encryption.js";
import { createFakeResponse } from "./helpers/fake-supabase.js";

const FILE = "abcDEF123456";
const PASSCODE = "p".repeat(48);
const NOW = "2026-09-28T10:00:00.000Z";
const CONFIG_ID = "6f1c1b4e-6d0b-4a2e-9d1c-0b1c2d3e4f50";

const PAYLOAD = {
  event_type: "LIBRARY_PUBLISH",
  webhook_id: 4242,
  file_key: FILE,
  file_name: "DS Core",
  timestamp: "2026-07-30T14:15:00Z",
  triggered_by: { id: "1", handle: "rajat" },
  description: "New buttons",
  created_components: [{ key: "k1", name: "Button" }],
};

/** @type {import("vitest").Mock} */
let slackFetch;

/**
 * @param {Record<string, unknown>} [body]
 * @param {Record<string, string>} [headers]
 */
async function publish(body = PAYLOAD, headers = { "x-figma-passcode": PASSCODE }) {
  const res = createFakeResponse();
  await handler({ method: "POST", url: "/api/webhook", headers, query: {}, body }, res);
  return res;
}

/** @param {Record<string, unknown>} config */
function seed(config) {
  h.db.reset({
    figma_webhooks: [
      {
        id: "wh-1",
        webhook_id: "4242",
        passcode: PASSCODE,
        status: "active",
        figma_user_id: "111111111",
        context_id: FILE,
      },
    ],
    configurations: [
      {
        id: CONFIG_ID,
        figma_file_key: FILE,
        figma_file_name: "DS Core",
        is_active: true,
        delivery_status: "ok",
        last_delivery_error: null,
        custom_message: "See the changelog",
        custom_mentions: [],
        ...config,
      },
    ],
    notification_log: [],
  });
}

const EMAIL = {
  destination: "email",
  slack_team_id: null,
  slack_installations: null,
  channels: [],
  email_timezone: "Asia/Kolkata",
  email_recipients: [
    { email: "ana@example.com", status: "confirmed", added_at: NOW, confirmed_at: NOW },
    { email: "ben@example.com", status: "confirmed", added_at: NOW, confirmed_at: NOW },
    { email: "cho@example.com", status: "pending", added_at: NOW, confirmed_at: null },
    { email: "dee@example.com", status: "unsubscribed", added_at: NOW, confirmed_at: null },
  ],
};
const slackConfig = () => ({
  // No `destination` key at all: a row from before migration 006.
  slack_team_id: "T0123",
  slack_installations: { bot_token_enc: encrypt("xoxb-test-token"), slack_team_name: "Acme" },
  channels: [
    { id: "C0123456", name: "#design" },
    { id: "C0ABCDEF", name: "#eng" },
  ],
});

const log = () => h.db.tables.notification_log ?? [];
const config = () => (h.db.tables.configurations ?? [])[0] ?? {};

beforeEach(() => {
  h.sendEmail.mockReset();
  h.sendEmail.mockImplementation(async () => ({ messageId: "m-1" }));
  slackFetch = vi.fn(async () => ({ json: async () => ({ ok: true, ts: "1.0" }) }));
  vi.stubGlobal("fetch", slackFetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("/api/webhook — email destination", () => {
  it("emails the confirmed recipients, and only them", async () => {
    seed(EMAIL);
    const res = await publish();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      status: "processed",
      results: [{ configId: CONFIG_ID, sent: 2, failed: 0, skipped: 0 }],
    });
    expect(h.sendEmail.mock.calls.map((c) => c[0].to).sort()).toEqual([
      "ana@example.com",
      "ben@example.com",
    ]);
    expect(slackFetch).not.toHaveBeenCalled();

    const [mail] = h.sendEmail.mock.calls[0] ?? [];
    expect(mail.subject).toBe("DS Core published by rajat");
    expect(mail.text).toContain("When: 30 Jul 2026, 19:45 Asia/Kolkata (GMT+5:30)");
    expect(mail.text).toContain("Description: New buttons");
    expect(mail.text).toContain("Team note: See the changelog");
    expect(mail.text).toContain("    - Button");
    expect(mail.unsubscribeUrl).toContain("/api/email?action=unsubscribe&token=");

    expect(
      log()
        .map((r) => [r.recipient, r.status, r.event_type])
        .sort(),
    ).toEqual([
      ["ana@example.com", "sent", "LIBRARY_PUBLISH"],
      ["ben@example.com", "sent", "LIBRARY_PUBLISH"],
    ]);
    expect(config().delivery_status).toBe("ok");
  });

  it("a Figma retry of the same publish emails no one twice", async () => {
    seed(EMAIL);
    await publish();
    h.sendEmail.mockClear();
    const res = await publish();
    expect(res.body.results).toEqual([{ configId: CONFIG_ID, sent: 0, failed: 0, skipped: 2 }]);
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it("flags failing deliveries, retries only the missed recipient, then recovers", async () => {
    seed(EMAIL);
    h.sendEmail.mockImplementation(async (/** @type {{ to: string }} */ mail) => {
      if (mail.to === "ben@example.com") throw new EmailSendError("MessageRejected");
      return { messageId: "m-1" };
    });
    const first = await publish();
    expect(first.body.results).toEqual([{ configId: CONFIG_ID, sent: 1, failed: 1, skipped: 0 }]);
    expect(config()).toMatchObject({
      delivery_status: "send_failing",
      last_delivery_error: "MessageRejected",
    });

    h.sendEmail.mockReset();
    h.sendEmail.mockImplementation(async () => ({ messageId: "m-2" }));
    const retry = await publish();
    expect(retry.body.results).toEqual([{ configId: CONFIG_ID, sent: 1, failed: 0, skipped: 1 }]);
    expect(h.sendEmail.mock.calls.map((c) => c[0].to)).toEqual(["ben@example.com"]);
    expect(config()).toMatchObject({ delivery_status: "ok", last_delivery_error: null });
  });

  it("sends nothing while no one has confirmed, without flagging a failure", async () => {
    seed({
      ...EMAIL,
      email_recipients: [{ email: "cho@example.com", status: "pending", added_at: NOW }],
    });
    const res = await publish();
    expect(res.body.results).toEqual([{ configId: CONFIG_ID, sent: 0, failed: 0, skipped: 0 }]);
    expect(h.sendEmail).not.toHaveBeenCalled();
    expect(config().delivery_status).toBe("ok");
  });

  it("does not deliver for a paused config, a wrong passcode, or another file", async () => {
    seed({ ...EMAIL, is_active: false });
    expect((await publish()).body).toEqual({ status: "no_configs" });

    seed(EMAIL);
    const forged = await publish(PAYLOAD, { "x-figma-passcode": "wrong" });
    expect(forged.statusCode).toBe(403);
    const otherFile = await publish({ ...PAYLOAD, file_key: "zzzZZZ999999" });
    expect(otherFile.body).toMatchObject({ status: "ignored", reason: "file_mismatch" });
    const unknown = await publish({ ...PAYLOAD, webhook_id: 1 });
    expect(unknown.statusCode).toBe(403);

    expect(h.sendEmail).not.toHaveBeenCalled();
    expect(log()).toHaveLength(0);
  });
});

describe("/api/webhook — Slack destination (unchanged)", () => {
  it("posts to each channel with the bot token and logs per channel", async () => {
    seed(slackConfig());
    const res = await publish();
    expect(res.body).toEqual({
      status: "processed",
      results: [{ configId: CONFIG_ID, sent: 2, failed: 0, skipped: 0 }],
    });
    expect(h.sendEmail).not.toHaveBeenCalled();

    expect(slackFetch).toHaveBeenCalledTimes(2);
    const posts = slackFetch.mock.calls.map(([url, init]) => ({
      url,
      auth: init.headers.Authorization,
      body: JSON.parse(init.body),
    }));
    expect(posts.map((p) => p.url)).toEqual([
      "https://slack.com/api/chat.postMessage",
      "https://slack.com/api/chat.postMessage",
    ]);
    expect(posts.map((p) => p.auth)).toEqual(["Bearer xoxb-test-token", "Bearer xoxb-test-token"]);
    expect(posts.map((p) => p.body.channel).sort()).toEqual(["C0123456", "C0ABCDEF"]);
    expect(posts[0]?.body.blocks[0]).toMatchObject({ type: "header" });

    expect(
      log()
        .map((r) => [r.slack_channel_id, r.status, r.recipient ?? null])
        .sort(),
    ).toEqual([
      ["C0123456", "sent", null],
      ["C0ABCDEF", "sent", null],
    ]);
  });

  it("still surfaces a revoked Slack token", async () => {
    seed(slackConfig());
    slackFetch.mockImplementation(async () => ({
      json: async () => ({ ok: false, error: "token_revoked" }),
    }));
    const res = await publish();
    expect(res.body.results).toEqual([{ configId: CONFIG_ID, sent: 0, failed: 2, skipped: 0 }]);
    expect(config()).toMatchObject({
      delivery_status: "slack_revoked",
      last_delivery_error: "token_revoked",
    });
  });

  it("a config explicitly marked slack behaves the same", async () => {
    seed({ ...slackConfig(), destination: "slack" });
    const res = await publish();
    expect(res.body.results).toEqual([{ configId: CONFIG_ID, sent: 2, failed: 0, skipped: 0 }]);
    expect(h.sendEmail).not.toHaveBeenCalled();
  });
});
