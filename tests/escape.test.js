// @ts-check
import { describe, it, expect } from "vitest";
import { escapeHtml, escapeSlack } from "../backend/lib/escape.js";

describe("escapeHtml", () => {
  it("escapes the standard XSS payload", () => {
    expect(escapeHtml('<img src=x onerror="alert(1)">')).toBe(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
    );
  });

  it("escapes attribute-breakers", () => {
    expect(escapeHtml(`"' onclick="x"`)).toBe(
      "&quot;&#39; onclick=&quot;x&quot;",
    );
  });

  it("handles nullish values without crashing", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });

  it("coerces non-strings", () => {
    expect(escapeHtml(42)).toBe("42");
  });
});

describe("escapeSlack", () => {
  it("only escapes &, <, > (per Slack mrkdwn rules)", () => {
    expect(escapeSlack("<!channel> & friends")).toBe(
      "&lt;!channel&gt; &amp; friends",
    );
  });

  it("leaves backticks and underscores alone (mrkdwn formatting)", () => {
    expect(escapeSlack("`code` _italic_")).toBe("`code` _italic_");
  });

  it("returns '' for nullish", () => {
    expect(escapeSlack(undefined)).toBe("");
    expect(escapeSlack(null)).toBe("");
  });
});
