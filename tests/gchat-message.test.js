// @ts-check
import { describe, it, expect } from "vitest";
import { buildChatText, CHAT_REPLIES, escapeChat } from "../backend/lib/gchat-message.js";
import { CHAT_MESSAGE_MAX_BYTES } from "../backend/lib/google-chat.js";

const PAYLOAD = {
  file_key: "abcDEF123456",
  file_name: "Design System",
  timestamp: "2026-07-30T14:15:00Z",
  triggered_by: { id: "1", handle: "rajat" },
  description: "New buttons & a *fix*",
  created_components: [
    { key: "k1", name: "Button" },
    { key: "k2", name: "Card" },
  ],
  modified_styles: [{ key: "s1", name: "Text/Body" }],
  deleted_variables: [{ key: "v1", name: "spacing/old" }],
};

describe("buildChatText", () => {
  const text = buildChatText(PAYLOAD, "abcDEF123456", {
    note: "Please update your files",
    timezone: "Asia/Kolkata",
  });

  it("carries every fact the Slack message and the email carry", () => {
    expect(text).toContain("*📦 Library published: Design System*");
    expect(text).toContain("Published by *rajat*");
    expect(text).toContain("30 Jul 2026, 19:45 Asia/Kolkata (GMT+5:30)");
    expect(text).toContain("*Description:* New buttons & a *fix*");
    expect(text).toContain("💬 Please update your files");
    expect(text).toContain("*Components:* 2 added, 0 modified, 0 removed");
    expect(text).toContain("- Added: Button, Card");
    expect(text).toContain("*Styles:* 0 added, 1 modified, 0 removed");
    expect(text).toContain("- Modified: Text/Body");
    expect(text).toContain("*Variables:* 0 added, 0 modified, 1 removed");
    expect(text).toContain("- Removed: spacing/old");
    expect(text).toContain(
      "<https://www.figma.com/file/abcDEF123456|Open in Figma> · Library Pulse",
    );
  });

  it("says when the publisher left no description, and skips the note when there is none", () => {
    const t = buildChatText({ ...PAYLOAD, description: "" }, "abcDEF123456", {});
    expect(t).toContain("_No description provided. Please add one when publishing._");
    expect(t).not.toContain("💬");
  });

  it("says when the payload itemizes nothing", () => {
    const t = buildChatText(
      { file_key: "k", file_name: "F", triggered_by: { handle: "x" } },
      "k",
      {},
    );
    expect(t).toContain("_No itemized changes were included in the publish._");
  });

  it("neutralises Chat's mention and link syntax in user-controlled names", () => {
    const t = buildChatText(
      {
        ...PAYLOAD,
        file_name: "<users/all> wake up",
        description: "see <https://evil.example|here>",
        created_components: [{ key: "k", name: "<users/all>" }],
      },
      "abcDEF123456",
      { note: "<users/all>" },
    );
    expect(t).not.toContain("<users/all>");
    expect(t).not.toContain("<https://evil.example|here>");
    expect(t).toContain("‹users/all›");
    // The one link in the message is ours.
    expect(t.match(/<https:\/\//g)?.length).toBe(1);
    expect(escapeChat("<b>")).toBe("‹b›");
  });

  it("lists at most 20 names per list and counts the rest", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ key: `k${i}`, name: `Item ${i}` }));
    const t = buildChatText({ ...PAYLOAD, created_components: many }, "abcDEF123456", {});
    expect(t).toContain("Item 19");
    expect(t).not.toContain("Item 20,");
    expect(t).toContain("_…and 5 more_");
    expect(t).toContain("*Components:* 25 added");
  });

  it("stays under Chat's message limit even for a huge publish", () => {
    const huge = Array.from({ length: 3000 }, (_, i) => ({ key: `k${i}`, name: "x".repeat(80) }));
    const t = buildChatText(
      {
        ...PAYLOAD,
        description: "d".repeat(5000),
        created_components: huge,
        modified_components: huge,
        deleted_components: huge,
      },
      "abcDEF123456",
      { note: "n".repeat(2000) },
    );
    expect(Buffer.byteLength(t, "utf8")).toBeLessThan(CHAT_MESSAGE_MAX_BYTES);
    expect(t).toContain("*Components:* 3000 added, 3000 modified, 3000 removed");
  });

  it("renders the time in UTC when no zone was saved", () => {
    const t = buildChatText(PAYLOAD, "abcDEF123456", {});
    expect(t).toContain("30 Jul 2026, 14:15 UTC");
  });
});

describe("the app's replies", () => {
  it("cover what the Marketplace review checks for: welcome, help, and turning notifications off", () => {
    expect(CHAT_REPLIES.welcome).toMatch(/Library Pulse/);
    expect(CHAT_REPLIES.help).toMatch(/\*stop\*/);
    expect(CHAT_REPLIES.help).toMatch(/\*start\*/);
    expect(CHAT_REPLIES.help).toMatch(/support/i);
    for (const v of Object.values(CHAT_REPLIES)) {
      expect(Buffer.byteLength(v, "utf8")).toBeLessThan(2000);
      expect(v).not.toMatch(/<users\//);
    }
  });
});
