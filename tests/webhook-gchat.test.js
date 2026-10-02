// @ts-check
/**
 * Handler-level tests for /api/webhook with a Google Chat config: the fan-out
 * is delegated per config, its outcome drives delivery_status, and a
 * google_revoked flag (set by a token failure) survives a healthy send.
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
    sendPublishChats: /** @type {import("vitest").Mock} */ (/** @type {unknown} */ (null)),
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
  h.sendPublishChats = vi.fn(async () => ({
    sent: 2,
    failed: 0,
    skipped: 0,
    total: 2,
    errorCodes: [],
  }));
  return { ...actual, sendPublishChats: h.sendPublishChats };
});

import handler from "../backend/api/webhook.js";
import { createFakeResponse } from "./helpers/fake-supabase.js";

const FILE = "abcDEF123456";
const PASSCODE = "p".repeat(48);
const CONFIG_ID = "6f1c1b4e-6d0b-4a2e-9d1c-0b1c2d3e4f50";
const PAYLOAD = {
  event_type: "LIBRARY_PUBLISH",
  webhook_id: 4242,
  file_key: FILE,
  file_name: "DS Core",
  timestamp: "2026-07-30T14:15:00Z",
  triggered_by: { id: "1", handle: "rajat" },
  created_components: [{ key: "k1", name: "Button" }],
};

async function publish() {
  const res = createFakeResponse();
  await handler(
    /** @type {any} */ ({
      method: "POST",
      url: "/api/webhook",
      headers: { "x-figma-passcode": PASSCODE },
      query: {},
      body: PAYLOAD,
    }),
    /** @type {any} */ (res),
  );
  return res;
}

/** @param {Record<string, unknown>} over */
function seed(over = {}) {
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
        is_active: true,
        delivery_status: "ok",
        last_delivery_error: null,
        destination: "gchat",
        google_installation_id: "inst-1",
        gchat_spaces: [
          { name: "spaces/AAA", display_name: "Design" },
          { name: "spaces/BBB", display_name: "Ops" },
        ],
        gchat_timezone: "Asia/Kolkata",
        custom_message: null,
        ...over,
      },
    ],
    notification_log: [],
    webhook_events: [],
  });
}

beforeEach(() => {
  h.sendPublishChats.mockClear();
  h.sendPublishChats.mockImplementation(async () => ({
    sent: 2,
    failed: 0,
    skipped: 0,
    total: 2,
    errorCodes: [],
  }));
});

describe("POST /api/webhook — Google Chat config", () => {
  it("fans out to Chat for the file's config and reports the counts", async () => {
    seed();
    const res = await publish();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      status: "processed",
      results: [{ configId: CONFIG_ID, sent: 2, failed: 0, skipped: 0 }],
    });
    expect(h.sendPublishChats).toHaveBeenCalledTimes(1);
    const args = h.sendPublishChats.mock.calls[0][0];
    expect(args.config.id).toBe(CONFIG_ID);
    expect(args.fileKey).toBe(FILE);
    expect(typeof args.eventKey).toBe("string");
    expect(args.payload.file_name).toBe("DS Core");
  });

  it("marks the config send_failing when a post fails, and back to ok when it recovers", async () => {
    seed();
    h.sendPublishChats.mockImplementationOnce(async () => ({
      sent: 1,
      failed: 1,
      skipped: 0,
      total: 2,
      errorCodes: ["not_found"],
    }));
    await publish();
    expect(h.db.tables.configurations[0]).toMatchObject({
      delivery_status: "send_failing",
      last_delivery_error: "not_found",
    });
    await publish();
    expect(h.db.tables.configurations[0]).toMatchObject({
      delivery_status: "ok",
      last_delivery_error: null,
    });
  });

  it("never clears google_revoked on a healthy send (the account, not the posting, is broken)", async () => {
    seed({ delivery_status: "google_revoked", last_delivery_error: "invalid_grant" });
    await publish();
    expect(h.db.tables.configurations[0].delivery_status).toBe("google_revoked");
  });

  it("skips an inactive config", async () => {
    seed({ is_active: false });
    const res = await publish();
    expect(res.body).toEqual({ status: "no_configs" });
    expect(h.sendPublishChats).not.toHaveBeenCalled();
  });
});
