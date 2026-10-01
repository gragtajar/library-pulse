// @ts-check
/**
 * Every file under backend/api is its own Vercel Function: "every API maps
 * directly to one Vercel Function. [...] For Hobby, this approach is limited
 * to 12 Vercel Functions per deployment" (vercel.com/docs/functions/runtimes).
 * A 13th doesn't fail the build: the deployment errors afterwards with nothing
 * in the build log (seen 2026-09-29). This fails first, and says why.
 *
 * Related endpoints therefore share a Function (lib/dispatch.js), and
 * vercel.json is the only place that maps public paths to files. The public
 * paths are pinned here: the plugin, Figma, Slack and the links in sent
 * emails all depend on them.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";

vi.mock("../backend/lib/supabase.js", () => ({ default: {} }));

const BACKEND = resolve(dirname(fileURLToPath(import.meta.url)), "../backend");
const HOBBY_FUNCTION_LIMIT = 12;

/** The URLs the outside world uses. Changing one is a breaking change. */
const PUBLIC_PATHS = [
  "/api/auth/figma",
  "/api/auth/figma-callback",
  "/api/auth/slack",
  "/api/auth/slack-callback",
  "/api/auth-status",
  "/api/config",
  "/api/slack/channels",
  "/api/slack/mentions",
  "/api/figma/resolve-file",
  "/api/email",
  "/api/webhook",
  "/api/health",
];

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

/** @type {{ src: string, dest: string }[]} */
const routes = JSON.parse(readFileSync(join(BACKEND, "vercel.json"), "utf8")).routes;

/** @param {string} dest */
function splitDest(dest) {
  const [path, query = ""] = dest.split("?");
  const fn = new URLSearchParams(query).get("fn");
  return { file: path.replace(/^\//, ""), fn };
}

describe("Vercel deployment shape", () => {
  const files = functionFiles().map((f) => relative(BACKEND, f).split("\\").join("/"));

  it(`has at most ${HOBBY_FUNCTION_LIMIT} functions (Hobby plan limit)`, () => {
    expect(
      files.length,
      `backend/api has ${files.length} function files; group endpoints with lib/dispatch.js (see api/auth.js)`,
    ).toBeLessThanOrEqual(HOBBY_FUNCTION_LIMIT);
  });

  it("keeps every public path, and only those", () => {
    expect(routes.map((r) => r.src).sort()).toEqual([...PUBLIC_PATHS].sort());
  });

  it("routes every function, and only functions that exist", () => {
    const dests = new Set(routes.map((r) => splitDest(r.dest).file));
    expect([...dests].sort()).toEqual([...files].sort());
  });

  it("names a handler the grouped function actually has", async () => {
    for (const route of routes) {
      const { file, fn } = splitDest(route.dest);
      const mod = await import(join(BACKEND, file));
      const handlers = /** @type {string[] | undefined} */ (mod.default.handlers);
      if (handlers) {
        expect(fn, `${route.src} → ${route.dest}`).not.toBeNull();
        expect(handlers, `${route.src} → ${route.dest}`).toContain(fn);
      } else {
        expect(fn, `${route.src}: ${file} is not a dispatcher`).toBeNull();
      }
    }
  });

  it("gives each grouped handler exactly one public path", async () => {
    const seen = new Map();
    for (const route of routes) {
      const { file, fn } = splitDest(route.dest);
      if (fn) seen.set(`${file}?${fn}`, (seen.get(`${file}?${fn}`) ?? 0) + 1);
    }
    for (const [key, count] of seen) expect(count, key).toBe(1);
    for (const file of files) {
      const mod = await import(join(BACKEND, file));
      for (const fn of mod.default.handlers ?? []) {
        expect(seen.has(`${file}?${fn}`), `${file}?fn=${fn} has no route`).toBe(true);
      }
    }
  });
});
