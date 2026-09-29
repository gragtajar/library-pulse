// @ts-check
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  process.env.LOG_LEVEL = "error";
  process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  process.env.PUBLIC_URL = "https://library-pulse.vercel.app/";
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

import {
  CONFIRMATIONS_PER_ADDRESS_PER_DAY,
  PUBLISH_EMAILS_PER_CONFIG_PER_DAY,
  sendConfirmations,
  sendPublishEmails,
} from "../backend/lib/email-delivery.js";
import { EmailSendError } from "../backend/lib/email-send.js";
import { verifyEmailToken } from "../backend/lib/email-tokens.js";

const NOW = new Date().toISOString();
const CONFIG = {
  id: "6f1c1b4e-6d0b-4a2e-9d1c-0b1c2d3e4f50",
  figma_file_key: "abcDEF123456",
  figma_file_name: "DS Core",
  email_timezone: "Asia/Kolkata",
  custom_message: "Check the changelog",
  email_recipients: [
    { email: "ana@example.com", status: "confirmed", added_at: NOW, confirmed_at: NOW },
    { email: "ben@example.com", status: "confirmed", added_at: NOW, confirmed_at: NOW },
    { email: "cho@example.com", status: "pending", added_at: NOW, confirmed_at: null },
    { email: "dee@example.com", status: "unsubscribed", added_at: NOW, confirmed_at: null },
  ],
};
const PAYLOAD = {
  event_type: "LIBRARY_PUBLISH",
  file_key: "abcDEF123456",
  file_name: "DS Core",
  timestamp: "2026-07-30T14:15:00Z",
  triggered_by: { id: "1", handle: "rajat" },
  created_components: [{ key: "k1", name: "Button" }],
};
const ARGS = { config: CONFIG, payload: PAYLOAD, fileKey: "abcDEF123456", eventKey: "figma:evt_1" };

/** @param {string} url */
function tokenOf(url) {
  return decodeURIComponent(new URL(url).searchParams.get("token") ?? "");
}

beforeEach(() => {
  h.db.reset({ notification_log: [] });
  h.sendEmail.mockReset();
  h.sendEmail.mockImplementation(async () => ({ messageId: "m-1" }));
});

describe("sendPublishEmails", () => {
  it("emails only confirmed recipients, one message each, and logs every send", async () => {
    const r = await sendPublishEmails(ARGS);
    expect(r).toEqual({ sent: 2, failed: 0, skipped: 0, total: 2, errorCodes: [] });

    const recipients = h.sendEmail.mock.calls.map((c) => c[0].to).sort();
    expect(recipients).toEqual(["ana@example.com", "ben@example.com"]);

    const log = h.db.tables.notification_log ?? [];
    expect(log).toHaveLength(2);
    for (const row of log) {
      expect(row).toMatchObject({
        configuration_id: CONFIG.id,
        figma_file_key: "abcDEF123456",
        event_type: "LIBRARY_PUBLISH",
        event_key: "figma:evt_1",
        status: "sent",
        error_message: null,
      });
    }
  });

  it("gives every recipient their own unsubscribe link, in the body and the headers", async () => {
    await sendPublishEmails(ARGS);
    for (const [mail] of h.sendEmail.mock.calls) {
      expect(mail.unsubscribeUrl).toMatch(
        /^https:\/\/library-pulse\.vercel\.app\/api\/email\/unsubscribe\?token=/,
      );
      expect(verifyEmailToken(tokenOf(mail.unsubscribeUrl), "unsubscribe")).toEqual({
        configId: CONFIG.id,
        email: mail.to,
      });
      expect(mail.text).toContain(`Unsubscribe: ${mail.unsubscribeUrl}`);
      expect(mail.html).toContain("Check the changelog");
      expect(mail.html).toContain("Asia/Kolkata");
    }
  });

  it("is retry-safe: a repeated event sends nothing", async () => {
    await sendPublishEmails(ARGS);
    h.sendEmail.mockClear();
    const again = await sendPublishEmails(ARGS);
    expect(again).toMatchObject({ sent: 0, failed: 0, skipped: 2 });
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it("reports a failed recipient and re-drives only that one on retry", async () => {
    h.sendEmail.mockImplementation(async (/** @type {{ to: string }} */ mail) => {
      if (mail.to === "ben@example.com") throw new EmailSendError("MessageRejected");
      return { messageId: "m-1" };
    });
    const first = await sendPublishEmails(ARGS);
    expect(first).toMatchObject({
      sent: 1,
      failed: 1,
      skipped: 0,
      errorCodes: ["MessageRejected"],
    });
    const failedRow = (h.db.tables.notification_log ?? []).find((r) => r.status === "failed");
    expect(failedRow).toMatchObject({
      recipient: "ben@example.com",
      error_message: "MessageRejected",
    });

    h.sendEmail.mockReset();
    h.sendEmail.mockImplementation(async () => ({ messageId: "m-2" }));
    const retry = await sendPublishEmails(ARGS);
    expect(retry).toMatchObject({ sent: 1, failed: 0, skipped: 1 });
    expect(h.sendEmail.mock.calls.map((c) => c[0].to)).toEqual(["ben@example.com"]);
  });

  it("sends nothing when no one has confirmed", async () => {
    const config = {
      ...CONFIG,
      email_recipients: [{ email: "cho@example.com", status: "pending", added_at: NOW }],
    };
    const r = await sendPublishEmails({ ...ARGS, config });
    expect(r).toEqual({ sent: 0, failed: 0, skipped: 0, total: 0, errorCodes: [] });
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it("stops at the per-file daily cap", async () => {
    h.db.tables.notification_log = Array.from(
      { length: PUBLISH_EMAILS_PER_CONFIG_PER_DAY - 1 },
      (_, i) => ({
        configuration_id: CONFIG.id,
        event_type: "LIBRARY_PUBLISH",
        event_key: `figma:old_${i}`,
        recipient: "ana@example.com",
        status: "sent",
        created_at: NOW,
      }),
    );
    const r = await sendPublishEmails(ARGS);
    expect(r).toMatchObject({ sent: 1, failed: 0, skipped: 1 });
    expect(h.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("does not count other files, failed sends, or yesterday's sends toward the cap", async () => {
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const filler = (/** @type {Record<string, unknown>} */ over) =>
      Array.from({ length: PUBLISH_EMAILS_PER_CONFIG_PER_DAY }, (_, i) => ({
        configuration_id: CONFIG.id,
        event_type: "LIBRARY_PUBLISH",
        event_key: `figma:old_${i}`,
        recipient: "ana@example.com",
        status: "sent",
        created_at: NOW,
        ...over,
      }));
    h.db.tables.notification_log = [
      ...filler({ configuration_id: "another-config" }),
      ...filler({ status: "failed" }),
      ...filler({ created_at: old }),
    ];
    const r = await sendPublishEmails(ARGS);
    expect(r).toMatchObject({ sent: 2, skipped: 0 });
  });

  it("sends nothing when the cap can't be checked", async () => {
    h.db.failCounts = true;
    const r = await sendPublishEmails(ARGS);
    expect(r).toMatchObject({ sent: 0, failed: 0, skipped: 2 });
    expect(h.sendEmail).not.toHaveBeenCalled();
  });
});

describe("sendConfirmations", () => {
  it("sends a confirmation with a link that confirms exactly that address", async () => {
    const r = await sendConfirmations(CONFIG, ["cho@example.com"]);
    expect(r).toEqual({ sent: 1, failed: 0, skipped: 0 });

    const [mail] = h.sendEmail.mock.calls[0] ?? [];
    expect(mail.to).toBe("cho@example.com");
    expect(mail.subject).toBe("Confirm Library Pulse updates for DS Core");
    expect(mail.unsubscribeUrl).toBeUndefined();
    const url = /Confirm: (\S+)/.exec(mail.text)?.[1] ?? "";
    expect(url).toMatch(/^https:\/\/library-pulse\.vercel\.app\/api\/email\/confirm\?token=/);
    expect(verifyEmailToken(tokenOf(url), "confirm")).toEqual({
      configId: CONFIG.id,
      email: "cho@example.com",
    });

    expect(h.db.tables.notification_log).toEqual([
      expect.objectContaining({
        event_type: "EMAIL_CONFIRM",
        event_key: null,
        recipient: "cho@example.com",
        status: "sent",
      }),
    ]);
  });

  it("limits confirmations per address per day", async () => {
    for (let i = 0; i < CONFIRMATIONS_PER_ADDRESS_PER_DAY; i++) {
      expect(await sendConfirmations(CONFIG, ["cho@example.com"])).toMatchObject({ sent: 1 });
    }
    const over = await sendConfirmations(CONFIG, ["cho@example.com", "eve@example.com"]);
    expect(over).toEqual({ sent: 1, failed: 0, skipped: 1 });
    expect(h.sendEmail.mock.calls.at(-1)?.[0].to).toBe("eve@example.com");
  });

  it("counts a failed send and never throws", async () => {
    h.sendEmail.mockImplementation(async () => {
      throw new EmailSendError("not_configured");
    });
    const r = await sendConfirmations(CONFIG, ["cho@example.com", "eve@example.com"]);
    expect(r).toEqual({ sent: 0, failed: 2, skipped: 0 });
    expect((h.db.tables.notification_log ?? []).every((row) => row.status === "failed")).toBe(true);
  });

  it("a failed confirmation doesn't use up the daily allowance", async () => {
    h.sendEmail.mockImplementation(async () => {
      throw new EmailSendError("timeout");
    });
    for (let i = 0; i < CONFIRMATIONS_PER_ADDRESS_PER_DAY + 1; i++) {
      await sendConfirmations(CONFIG, ["cho@example.com"]);
    }
    h.sendEmail.mockImplementation(async () => ({ messageId: "m-1" }));
    expect(await sendConfirmations(CONFIG, ["cho@example.com"])).toMatchObject({ sent: 1 });
  });
});
