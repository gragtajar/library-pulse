// @ts-check
/**
 * Parity pin: the plugin decides which addresses count toward "N/5" and
 * whether Save is enabled; the backend decides what is actually stored. Both
 * must accept and reject exactly the same strings, or the UI would offer a
 * save the API refuses (or block one it would accept). This test runs the
 * UI's own `isValidEmail` and `parseEmailInput` (extracted from ui.html)
 * against the backend validators.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, it, expect } from "vitest";
import {
  assertEmailList,
  assertTimezone,
  EMAIL_RECIPIENTS_MAX,
  isValidEmail,
  normalizeEmail,
} from "../backend/lib/validators.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(resolve(__dirname, "../figma-plugin/ui.html"), "utf8");

/**
 * Pull one top-level function's source out of ui.html's inline script.
 *
 * @param {string} name
 */
function extractFunction(name) {
  const start = HTML.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} not found in ui.html`);
  const open = HTML.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < HTML.length; i++) {
    if (HTML[i] === "{") depth++;
    else if (HTML[i] === "}" && --depth === 0) return HTML.slice(start, i + 1);
  }
  throw new Error(`Unbalanced braces while extracting ${name}`);
}

/** @type {{ isValidEmail: (v: unknown) => boolean, parseEmailInput: (text: string) => { valid: string[], invalid: string[], duplicates: number } }} */
const ui = runInNewContext(
  `${extractFunction("isValidEmail")}\n${extractFunction("parseEmailInput")}\n({ isValidEmail, parseEmailInput })`,
);

const CORPUS = [
  "ana@example.com",
  "first.last+tag@sub.example.co.uk",
  "o'neil@example.org",
  "user_name-1@ex-ample.io",
  "a@b.co",
  "x!#$%&'*+/=?^_`{|}~-@example.com",
  "UPPER@EXAMPLE.COM",
  "",
  "plainaddress",
  "@example.com",
  "ana@",
  "ana@localhost",
  "ana@example..com",
  "ana@.example.com",
  "ana@example.com.",
  "ana@-example.com",
  "ana@example-.com",
  "ana@exam ple.com",
  "ana@@example.com",
  "an a@example.com",
  "ana@example.com ",
  "<script>@example.com",
  'ana"quoted"@example.com',
  "ana@exa_mple.com",
  "ana@пример.рф",
  "ána@example.com",
  `${"a".repeat(64)}@example.com`,
  `${"a".repeat(65)}@example.com`,
  `ana@${"x".repeat(63)}.com`,
  `ana@${"x".repeat(64)}.com`,
  `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(57)}.com`, // 254
  `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(58)}.com`, // 255
];

describe("plugin ↔ backend email validation parity", () => {
  it.each(CORPUS)("agrees on %j", (candidate) => {
    expect(ui.isValidEmail(candidate)).toBe(isValidEmail(candidate));
  });

  it("agrees on non-strings", () => {
    for (const v of [undefined, null, 42, {}, []]) {
      expect(ui.isValidEmail(v)).toBe(isValidEmail(v));
    }
  });

  it("uses the same cap as the backend", () => {
    const max = /const EMAIL_MAX = (\d+);/.exec(HTML)?.[1];
    expect(Number(max)).toBe(EMAIL_RECIPIENTS_MAX);
  });
});

describe("parseEmailInput", () => {
  it("splits on commas, semicolons and whitespace", () => {
    const { valid, invalid, duplicates } = ui.parseEmailInput(
      "ana@example.com, ben@example.com;cho@example.com\n  dee@example.com\teve@example.com",
    );
    expect(Array.from(valid)).toEqual([
      "ana@example.com",
      "ben@example.com",
      "cho@example.com",
      "dee@example.com",
      "eve@example.com",
    ]);
    expect(Array.from(invalid)).toEqual([]);
    expect(duplicates).toBe(0);
  });

  it("lower-cases and counts duplicates once, like the backend", () => {
    const text = "Ana@Example.com\nana@example.com, BEN@example.com";
    const parsed = ui.parseEmailInput(text);
    expect(Array.from(parsed.valid)).toEqual(["ana@example.com", "ben@example.com"]);
    expect(parsed.duplicates).toBe(1);
    // What the plugin sends is exactly what the backend stores.
    expect(assertEmailList(Array.from(parsed.valid))).toEqual(Array.from(parsed.valid));
    expect(Array.from(parsed.valid)).toEqual(
      assertEmailList(text.split(/[\s,;]+/).map(normalizeEmail)),
    );
  });

  it("reports invalid entries as typed, each once", () => {
    const parsed = ui.parseEmailInput("ana@example.com, nope, Nope@, nope");
    expect(Array.from(parsed.valid)).toEqual(["ana@example.com"]);
    expect(Array.from(parsed.invalid)).toEqual(["nope", "Nope@"]);
  });

  it("handles empty and separator-only input", () => {
    for (const text of ["", "   ", ",;\n", undefined]) {
      const parsed = ui.parseEmailInput(/** @type {string} */ (text));
      expect(Array.from(parsed.valid)).toEqual([]);
      expect(Array.from(parsed.invalid)).toEqual([]);
    }
  });

  it("keeps counting past the cap so the UI can say how many to remove", () => {
    const seven = Array.from({ length: 7 }, (_, i) => `u${i}@example.com`).join(", ");
    expect(ui.parseEmailInput(seven).valid).toHaveLength(7);
  });
});

describe("time zone names", () => {
  it("the backend accepts every name the plugin can send after renaming (ZONE_RENAMES)", () => {
    const block = /const ZONE_RENAMES = \{([\s\S]*?)\};/.exec(HTML)?.[1] ?? "";
    const pairs = Array.from(block.matchAll(/"([^"]+)":\s*"([^"]+)"/g));
    expect(pairs.length).toBeGreaterThan(0);
    const at = new Date("2026-07-30T14:15:00Z");
    const wallClock = (/** @type {string} */ timeZone) =>
      new Intl.DateTimeFormat("en-GB", {
        dateStyle: "short",
        timeStyle: "medium",
        timeZone,
      }).format(at);
    for (const [, legacy, current] of pairs) {
      expect(assertTimezone(String(current))).toBe(current);
      // Old and new name are the same zone: same wall-clock time.
      expect(wallClock(String(current))).toBe(wallClock(String(legacy)));
    }
  });
});
