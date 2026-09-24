// @ts-check
/**
 * Parity pin: the composer paints a token pill over exactly the text the
 * backend will turn into a Slack mention. The UI's `mentionSegments` (inline
 * in figma-plugin/ui.html) re-implements `composeCustomNote`'s rule — longest
 * label first, every non-overlapping "@label" — so the two must never drift.
 * This test runs the UI function itself (extracted from ui.html) and checks
 * that rendering its segments reproduces `composeCustomNote` byte for byte.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, it, expect } from "vitest";
import { composeCustomNote } from "../backend/lib/slack-blocks.js";
import { escapeSlack } from "../backend/lib/escape.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI = resolve(__dirname, "../figma-plugin/ui.html");

/**
 * Pull one top-level function's source out of ui.html's inline script.
 *
 * @param {string} html
 * @param {string} name
 */
function extractFunction(html, name) {
  const start = html.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} not found in ui.html`);
  const open = html.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}" && --depth === 0) return html.slice(start, i + 1);
  }
  throw new Error(`Unbalanced braces while extracting ${name}`);
}

/** @typedef {{ id: string, type: "user" | "usergroup", label: string }} Mention */
/** @typedef {{ start: number, end: number, mention: Mention | null }} Segment */

/** @type {(text: string, mentions: Mention[]) => Segment[]} */
const mentionSegments = runInNewContext(
  `(${extractFunction(readFileSync(UI, "utf8"), "mentionSegments")})`,
);

/**
 * What the composer's tokens promise Slack will receive: plain segments
 * escaped, token segments swapped for the real mention syntax.
 *
 * @param {string} text
 * @param {Mention[]} mentions
 */
function renderAsTokensPromise(text, mentions) {
  return mentionSegments(text, mentions)
    .map((s) => {
      if (!s.mention) return escapeSlack(text.slice(s.start, s.end));
      return s.mention.type === "usergroup" ? `<!subteam^${s.mention.id}>` : `<@${s.mention.id}>`;
    })
    .join("");
}

/** @type {Mention} */ const PJ = { id: "U0PJ00001", type: "user", label: "PJ" };
/** @type {Mention} */ const PJ_SMITH = { id: "U0PJS0002", type: "user", label: "PJ Smith" };
/** @type {Mention} */ const AISHA = { id: "U0AISHA03", type: "user", label: "Aisha" };
/** @type {Mention} */ const DESIGN = { id: "S0DESIGN1", type: "usergroup", label: "design-team" };
/** @type {Mention} */ const RND = { id: "S0RND0001", type: "usergroup", label: "R&D" };
/** @type {Mention} */ const AT_HOME = { id: "U0ATHOME1", type: "user", label: "PJ@home" };
/** @type {Mention} */ const HOME = { id: "U0HOME001", type: "user", label: "home" };

/** @type {Array<[string, string, Mention[]]>} */
const CASES = [
  ["single mention", "Heads up @PJ, please review", [PJ]],
  ["longest label wins its span", "@PJ Smith and @PJ both", [PJ, PJ_SMITH]],
  ["every occurrence pings", "@PJ @PJ @PJ", [PJ]],
  ["adjacent tokens", "@PJ@Aisha side by side", [PJ, AISHA]],
  ["escaping around tokens", "ping @design-team <now> & @R&D", [DESIGN, RND]],
  ["'@' inside a longer label", "mail @PJ@home, not @home", [HOME, AT_HOME, PJ]],
  ["unpicked @text stays plain", "typed @Aisha but never picked", [PJ]],
  ["substring semantics match the backend", "@PJX is someone else", [PJ]],
  ["no mentions", "just a plain note", []],
];

describe("composer tokens ↔ composeCustomNote parity", () => {
  it.each(CASES)("%s", (_name, text, mentions) => {
    expect(renderAsTokensPromise(text, mentions)).toBe(composeCustomNote(text, mentions));
  });

  it("segments tile the whole text with no gaps or overlaps", () => {
    for (const [, text, mentions] of CASES) {
      const segs = mentionSegments(text, mentions);
      expect(segs.map((s) => text.slice(s.start, s.end)).join("")).toBe(text);
      segs.forEach((s, i) => expect(s.start).toBe(i === 0 ? 0 : segs[i - 1]?.end));
    }
  });

  it("marks exactly the picked mentions as tokens", () => {
    const text = "@PJ Smith, @PJ and typed @Aisha";
    const tokens = mentionSegments(text, [PJ, PJ_SMITH])
      .filter((s) => s.mention)
      .map((s) => text.slice(s.start, s.end));
    expect(tokens).toEqual(["@PJ Smith", "@PJ"]);
  });
});
