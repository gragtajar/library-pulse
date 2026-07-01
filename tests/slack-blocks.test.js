// @ts-check
import { describe, it, expect } from "vitest";
import { buildSlackBlocks, fallbackText } from "../backend/lib/slack-blocks.js";

function findText(blocks, predicate) {
  for (const b of blocks) {
    const t = b?.text?.text;
    if (typeof t === "string" && predicate(t)) return t;
    if (Array.isArray(b?.fields)) {
      for (const f of b.fields) {
        if (typeof f?.text === "string" && predicate(f.text)) return f.text;
      }
    }
  }
  return null;
}

describe("slack-blocks", () => {
  it("renders the header with the file name", () => {
    const blocks = buildSlackBlocks({ file_name: "DS Core", file_key: "abc" }, "abc");
    expect(blocks[0]).toMatchObject({ type: "header" });
    expect(blocks[0].text.text).toMatch(/Library Published — DS Core/);
  });

  it("escapes <!channel> and other mentions in description", () => {
    const blocks = buildSlackBlocks(
      { file_name: "x", description: "<!channel> please review", file_key: "k" },
      "k",
    );
    const desc = findText(blocks, (t) => t.includes("Description"));
    expect(desc).toContain("&lt;!channel&gt;");
    expect(desc).not.toContain("<!channel>");
  });

  it("escapes component names that contain Slack mention syntax", () => {
    const blocks = buildSlackBlocks(
      {
        file_name: "x",
        file_key: "k",
        created_components: [{ name: "<!here> Button" }, { name: "Card" }],
      },
      "k",
    );
    const section = findText(blocks, (t) => t.includes("Added"));
    expect(section).toContain("&lt;!here&gt;");
  });

  it("warns when no description provided", () => {
    const blocks = buildSlackBlocks({ file_name: "x", file_key: "k" }, "k");
    const warn = findText(blocks, (t) => t.includes("No description provided"));
    expect(warn).toBeTruthy();
  });

  it("truncates long item lists with a '…and N more' tail", () => {
    const created = Array.from({ length: 30 }, (_, i) => ({ name: `Comp${i}` }));
    const blocks = buildSlackBlocks(
      { file_name: "x", file_key: "k", created_components: created },
      "k",
    );
    const section = findText(blocks, (t) => t.includes("…and 10 more"));
    expect(section).toBeTruthy();
  });

  it("fallbackText produces a non-empty string with publisher and file", () => {
    expect(fallbackText({ file_name: "DS", triggered_by: { handle: "@me" } })).toMatch(/@me .* DS/);
  });

  it("uses encodeURIComponent for the file-link URL", () => {
    const blocks = buildSlackBlocks(
      { file_name: "x", file_key: "weird key/path" },
      "weird key/path",
    );
    const ctx = blocks.find((b) => b.type === "context");
    expect(ctx.elements[0].text).toContain("weird%20key%2Fpath");
  });
});
