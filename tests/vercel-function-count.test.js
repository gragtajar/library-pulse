// @ts-check
/**
 * Every file under backend/api is its own Vercel Function, and the Hobby plan
 * allows 12 per deployment (vercel.com/docs/functions/runtimes — "Functions
 * created per deployment"). One file too many doesn't fail the build: the
 * deployment errors afterwards, with nothing in the build log. This fails
 * first, and says why.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const BACKEND = resolve(dirname(fileURLToPath(import.meta.url)), "../backend");
const HOBBY_FUNCTION_LIMIT = 12;

/** Every .js file under backend/api, as Vercel sees them (it skips `_` and `.` names). */
function functionFiles() {
  return readdirSync(join(BACKEND, "api"), { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter(
      (file) =>
        !relative(BACKEND, file)
          .split(/[\\/]/)
          .some((part) => /^[_.]/.test(part)),
    );
}

describe("Vercel deployment shape", () => {
  const files = functionFiles().map((f) => relative(BACKEND, f).split("\\").join("/"));

  it(`has at most ${HOBBY_FUNCTION_LIMIT} functions (Hobby plan limit)`, () => {
    expect(
      files.length,
      `backend/api has ${files.length} function files; merge endpoints (see api/email.js) or move logic to lib/`,
    ).toBeLessThanOrEqual(HOBBY_FUNCTION_LIMIT);
  });

  it("routes every function, and only functions that exist", () => {
    const config = JSON.parse(readFileSync(join(BACKEND, "vercel.json"), "utf8"));
    const dests = config.routes.map((/** @type {{ dest: string }} */ r) =>
      r.dest.replace(/^\//, ""),
    );
    expect([...dests].sort()).toEqual([...files].sort());
    for (const route of config.routes) {
      expect(`${route.src}.js`).toBe(route.dest);
    }
  });
});
