// @ts-check
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  process.env.LOG_LEVEL = "error";
  process.env.GOOGLE_PUBLIC_URL = "https://updates.rajatg.in";
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

import {
  CHAT_ISSUER_EMAIL,
  eventsAudience,
  handleChatEvent,
  verifyChatRequest,
} from "../backend/lib/gchat-events.js";
import { CHAT_REPLIES } from "../backend/lib/gchat-message.js";

/** @param {Record<string, unknown> | null} payload */
const fakeClient = (payload) =>
  /** @type {any} */ ({
    verifyIdToken: vi.fn(async () => ({ getPayload: () => payload })),
  });

const SPACE = { name: "spaces/AAA", displayName: "Design", spaceType: "SPACE" };
const USER = { name: "users/123", displayName: "Rajat", email: "hi@rajatg.in" };

beforeEach(() => h.db.reset({ gchat_spaces: [] }));

describe("verifyChatRequest", () => {
  it("checks the token against our endpoint URL and Chat's issuer email", async () => {
    const client = fakeClient({ email: CHAT_ISSUER_EMAIL, email_verified: true });
    expect(await verifyChatRequest("Bearer abc", { client })).toBe(true);
    expect(client.verifyIdToken).toHaveBeenCalledWith({
      idToken: "abc",
      audience: "https://updates.rajatg.in/api/gchat/events",
    });
    expect(eventsAudience()).toBe("https://updates.rajatg.in/api/gchat/events");
  });

  it("rejects another issuer, an unverified email, a bad token and a missing header", async () => {
    expect(
      await verifyChatRequest("Bearer abc", {
        client: fakeClient({ email: "someone@else.example", email_verified: true }),
      }),
    ).toBe(false);
    expect(
      await verifyChatRequest("Bearer abc", {
        client: fakeClient({ email: CHAT_ISSUER_EMAIL, email_verified: false }),
      }),
    ).toBe(false);
    const throwing = /** @type {any} */ ({
      verifyIdToken: vi.fn(async () => {
        throw new Error("Wrong recipient");
      }),
    });
    expect(await verifyChatRequest("Bearer abc", { client: throwing })).toBe(false);
    expect(await verifyChatRequest(undefined, { client: fakeClient({}) })).toBe(false);
    expect(await verifyChatRequest("", { client: fakeClient({}) })).toBe(false);
  });
});

describe("handleChatEvent", () => {
  const spaces = () => h.db.tables.gchat_spaces;

  it("remembers a space the app was added to and greets", async () => {
    const reply = await handleChatEvent({ type: "ADDED_TO_SPACE", space: SPACE, user: USER });
    expect(reply).toEqual({ text: CHAT_REPLIES.welcome });
    expect(spaces()).toHaveLength(1);
    expect(spaces()[0]).toMatchObject({
      space_name: "spaces/AAA",
      display_name: "Design",
      space_type: "SPACE",
      app_member: true,
      muted: false,
      added_by: "users/123",
      removed_at: null,
    });
  });

  it("answers the command that came with an @mention that added the app", async () => {
    const reply = await handleChatEvent({
      type: "ADDED_TO_SPACE",
      space: SPACE,
      user: USER,
      message: { text: "@Library Pulse stop", argumentText: " stop" },
    });
    expect(reply).toEqual({ text: CHAT_REPLIES.stopped });
  });

  it("marks a space the app was removed from, keeping its history", async () => {
    await handleChatEvent({ type: "ADDED_TO_SPACE", space: SPACE, user: USER });
    const reply = await handleChatEvent({ type: "REMOVED_FROM_SPACE", space: SPACE, user: USER });
    expect(reply).toEqual({});
    expect(spaces()).toHaveLength(1);
    expect(spaces()[0].app_member).toBe(false);
    expect(spaces()[0].removed_at).toEqual(expect.any(String));
  });

  it("handles help, stop, start and anything else when @mentioned", async () => {
    await handleChatEvent({ type: "ADDED_TO_SPACE", space: SPACE, user: USER });
    const say = (argumentText) =>
      handleChatEvent({ type: "MESSAGE", space: SPACE, user: USER, message: { argumentText } });

    expect(await say(" help ")).toEqual({ text: CHAT_REPLIES.help });
    expect(await say("")).toEqual({ text: CHAT_REPLIES.help });
    expect(await say("STOP please")).toEqual({ text: CHAT_REPLIES.stopped });
    expect(spaces()[0].muted).toBe(true);
    expect(await say("start")).toEqual({ text: CHAT_REPLIES.started });
    expect(spaces()[0].muted).toBe(false);
    expect(await say("dance")).toEqual({ text: CHAT_REPLIES.unknown });
  });

  it("acknowledges other interaction types without touching the database", async () => {
    expect(await handleChatEvent({ type: "CARD_CLICKED", space: SPACE, user: USER })).toEqual({});
    expect(await handleChatEvent({ type: "MESSAGE" })).toEqual({});
    expect(await handleChatEvent({})).toEqual({});
    expect(spaces()).toHaveLength(0);
  });
});
