// @ts-check
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  buildSendInput,
  EmailSendError,
  sendEmail,
  sendErrorCode,
} from "../backend/lib/email-send.js";

const MSG = {
  to: "ana@example.com",
  subject: "DS Core published by rajat",
  html: "<p>hi</p>",
  text: "hi",
};
const SENDER = { from: "Library Pulse <notifications@updates.example.com>" };

describe("buildSendInput", () => {
  it("sends to exactly one recipient with both body parts in UTF-8", () => {
    const input = buildSendInput(MSG, SENDER);
    expect(input.FromEmailAddress).toBe(SENDER.from);
    expect(input.Destination).toEqual({ ToAddresses: ["ana@example.com"] });
    expect(input.Content.Simple.Subject).toEqual({ Data: MSG.subject, Charset: "UTF-8" });
    expect(input.Content.Simple.Body).toEqual({
      Html: { Data: "<p>hi</p>", Charset: "UTF-8" },
      Text: { Data: "hi", Charset: "UTF-8" },
    });
  });

  it("adds the RFC 8058 one-click headers only when there is an unsubscribe link", () => {
    expect(buildSendInput(MSG, SENDER).Content.Simple).not.toHaveProperty("Headers");
    const url = "https://library-pulse.vercel.app/api/email/unsubscribe?token=abc.def";
    const withLink = buildSendInput({ ...MSG, unsubscribeUrl: url }, SENDER);
    expect(withLink.Content.Simple.Headers).toEqual([
      { Name: "List-Unsubscribe", Value: `<${url}>` },
      { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
    ]);
  });

  it("routes replies and bounce/complaint forwards to the feedback address when set", () => {
    const plain = buildSendInput(MSG, SENDER);
    expect(plain).not.toHaveProperty("ReplyToAddresses");
    expect(plain).not.toHaveProperty("FeedbackForwardingEmailAddress");

    const input = buildSendInput(MSG, { ...SENDER, feedbackAddress: "owner@example.com" });
    expect(input.ReplyToAddresses).toEqual(["owner@example.com"]);
    expect(input.FeedbackForwardingEmailAddress).toBe("owner@example.com");
  });
});

describe("sendErrorCode", () => {
  it("uses the SES error name, never the message", () => {
    const err = Object.assign(new Error("Email address is not verified: ana@example.com"), {
      name: "MessageRejected",
    });
    expect(sendErrorCode(err)).toBe("MessageRejected");
    expect(sendErrorCode({ name: "TooManyRequestsException" })).toBe("TooManyRequestsException");
  });
  it("maps timeouts and falls back to unknown", () => {
    expect(sendErrorCode({ name: "TimeoutError" })).toBe("timeout");
    expect(sendErrorCode(new Error("boom"))).toBe("unknown");
    expect(sendErrorCode({ name: "weird name; drop table" })).toBe("unknown");
    expect(sendErrorCode("nope")).toBe("unknown");
    expect(sendErrorCode(null)).toBe("unknown");
  });
});

describe("sendEmail", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.EMAIL_FROM = SENDER.from;
    delete process.env.EMAIL_FEEDBACK_ADDRESS;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("sends the built input through the client and returns the message id", async () => {
    /** @type {any[]} */
    const sent = [];
    const client = {
      send: async (/** @type {any} */ command) => {
        sent.push(command.input);
        return { MessageId: "0100-abc" };
      },
    };
    const out = await sendEmail({ ...MSG, unsubscribeUrl: "https://x.test/u?token=t" }, { client });
    expect(out).toEqual({ messageId: "0100-abc" });
    expect(sent).toHaveLength(1);
    expect(sent[0].Destination.ToAddresses).toEqual(["ana@example.com"]);
    expect(sent[0].Content.Simple.Headers).toHaveLength(2);
  });

  it("wraps a client failure in EmailSendError with the SES code", async () => {
    const client = {
      send: async () => {
        throw Object.assign(new Error("not verified"), { name: "MessageRejected" });
      },
    };
    await expect(sendEmail(MSG, { client })).rejects.toMatchObject({
      name: "EmailSendError",
      code: "MessageRejected",
    });
  });

  it("fails with not_configured when the sender isn't set", async () => {
    delete process.env.EMAIL_FROM;
    const client = { send: async () => ({ MessageId: "x" }) };
    await expect(sendEmail(MSG, { client })).rejects.toBeInstanceOf(EmailSendError);
    await expect(sendEmail(MSG, { client })).rejects.toMatchObject({ code: "not_configured" });
  });
});
