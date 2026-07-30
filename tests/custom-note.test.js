// @ts-check
import { describe, it, expect } from "vitest";
import { buildSlackBlocks, composeCustomNote } from "../backend/lib/slack-blocks.js";
import { assertCustomMessage, assertMentionList } from "../backend/lib/validators.js";
import { ValidationError } from "../backend/lib/errors.js";

describe("composeCustomNote", () => {
  it("returns null for empty/missing text", () => {
    expect(composeCustomNote(null, [])).toBeNull();
    expect(composeCustomNote("", [])).toBeNull();
    expect(composeCustomNote("   ", [])).toBeNull();
  });

  it("substitutes a user mention label with the <@id> token", () => {
    const out = composeCustomNote("Heads up @Rajat Garg — new tokens shipped", [
      { id: "U012ABC3DE", type: "user", label: "Rajat Garg" },
    ]);
    expect(out).toBe("Heads up <@U012ABC3DE> — new tokens shipped");
  });

  it("substitutes a usergroup label with the <!subteam^id> token", () => {
    const out = composeCustomNote("FYI @design-team please review", [
      { id: "S0614TZR7", type: "usergroup", label: "design-team" },
    ]);
    expect(out).toBe("FYI <!subteam^S0614TZR7> please review");
  });

  it("escapes free text so typed mention syntax can never ping", () => {
    const out = composeCustomNote("<!channel> <@U999> hello", []);
    expect(out).toBe("&lt;!channel&gt; &lt;@U999&gt; hello");
  });

  it("matches longer labels first so overlapping names don't clobber", () => {
    const out = composeCustomNote("ping @design and @design-leads", [
      { id: "S1111AAAA", type: "usergroup", label: "design" },
      { id: "S2222BBBB", type: "usergroup", label: "design-leads" },
    ]);
    expect(out).toBe("ping <!subteam^S1111AAAA> and <!subteam^S2222BBBB>");
  });

  it("degrades gracefully when a label was edited out of the text", () => {
    const out = composeCustomNote("no mentions here", [
      { id: "U012ABC3DE", type: "user", label: "Rajat Garg" },
    ]);
    expect(out).toBe("no mentions here");
  });

  it("matches labels containing characters that escapeSlack rewrites", () => {
    const out = composeCustomNote("ask @R&D Team about it", [
      { id: "S0614TZR7", type: "usergroup", label: "R&D Team" },
    ]);
    expect(out).toBe("ask <!subteam^S0614TZR7> about it");
  });
});

describe("buildSlackBlocks with a custom note", () => {
  const payload = { file_name: "DS", file_key: "k" };

  it("inserts the note section before the first divider", () => {
    const blocks = buildSlackBlocks(payload, "k", {
      text: "Ship it @design-team",
      mentions: [{ id: "S0614TZR7", type: "usergroup", label: "design-team" }],
    });
    const idx = blocks.findIndex((b) => b?.text?.text?.includes("<!subteam^S0614TZR7>"));
    const firstDivider = blocks.findIndex((b) => b.type === "divider");
    expect(idx).toBeGreaterThan(-1);
    expect(idx).toBeLessThan(firstDivider);
    expect(blocks[idx].text.text).toContain("💬 ");
  });

  it("emits no note block when custom is absent (backward compatible)", () => {
    const withNull = buildSlackBlocks(payload, "k", null);
    const without = buildSlackBlocks(payload, "k");
    expect(withNull.some((b) => b?.text?.text?.startsWith("💬"))).toBe(false);
    expect(without.length).toBe(withNull.length);
  });
});

describe("assertCustomMessage", () => {
  it("returns trimmed text and null for empty", () => {
    expect(assertCustomMessage("  hello  ")).toBe("hello");
    expect(assertCustomMessage("")).toBeNull();
    expect(assertCustomMessage(null)).toBeNull();
    expect(assertCustomMessage("   ")).toBeNull();
  });

  it("rejects non-strings and over-long messages", () => {
    expect(() => assertCustomMessage(42)).toThrow(ValidationError);
    expect(() => assertCustomMessage("x".repeat(501))).toThrow(ValidationError);
    expect(assertCustomMessage("x".repeat(500))).toHaveLength(500);
  });
});

describe("assertMentionList", () => {
  it("accepts well-formed user and usergroup mentions", () => {
    const out = assertMentionList([
      { id: "U012ABC3DE", type: "user", label: "Rajat" },
      { id: "W012ABC3DE", type: "user", label: "Enterprise W id" },
      { id: "S0614TZR7", type: "usergroup", label: "design-team" },
    ]);
    expect(out).toHaveLength(3);
  });

  it("normalizes null/undefined to []", () => {
    expect(assertMentionList(null)).toEqual([]);
    expect(assertMentionList(undefined)).toEqual([]);
  });

  it("rejects bad ids, bad types, and missing labels", () => {
    expect(() => assertMentionList([{ id: "X123", type: "user", label: "a" }])).toThrow(
      ValidationError,
    );
    expect(() => assertMentionList([{ id: "U012ABC3DE", type: "channel", label: "a" }])).toThrow(
      ValidationError,
    );
    // usergroup id used for a user mention (and vice versa) must fail.
    expect(() => assertMentionList([{ id: "S0614TZR7", type: "user", label: "a" }])).toThrow(
      ValidationError,
    );
    expect(() => assertMentionList([{ id: "U012ABC3DE", type: "usergroup", label: "a" }])).toThrow(
      ValidationError,
    );
    expect(() => assertMentionList([{ id: "U012ABC3DE", type: "user", label: "" }])).toThrow(
      ValidationError,
    );
  });

  it("caps the list size", () => {
    const many = Array.from({ length: 21 }, (_, i) => ({
      id: `U01234567${i % 10}`,
      type: "user",
      label: `u${i}`,
    }));
    expect(() => assertMentionList(many)).toThrow(ValidationError);
  });
});
