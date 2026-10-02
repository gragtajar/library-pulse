// @ts-check
/**
 * The grouped Functions (api/auth.js, api/slack.js, api/figma.js) hand each
 * public path to the handler it always had. The handlers are mocked here so
 * this proves the wiring only; their own behaviour is tested where it lives.
 */
import { describe, it, expect, vi } from "vitest";
import { dispatch } from "../backend/lib/dispatch.js";
import { createFakeResponse } from "./helpers/fake-supabase.js";

/** @param {string} name */
const stub = (name) => vi.fn((_req, res) => res.status(200).json({ handler: name }));

vi.mock("../backend/lib/handlers/auth-figma-start.js", () => ({ default: stub("figma-start") }));
vi.mock("../backend/lib/handlers/auth-figma-callback.js", () => ({
  default: stub("figma-callback"),
}));
vi.mock("../backend/lib/handlers/auth-slack-start.js", () => ({ default: stub("slack-start") }));
vi.mock("../backend/lib/handlers/auth-slack-callback.js", () => ({
  default: stub("slack-callback"),
}));
vi.mock("../backend/lib/handlers/auth-status.js", () => ({ default: stub("status") }));
vi.mock("../backend/lib/handlers/slack-channels.js", () => ({ default: stub("channels") }));
vi.mock("../backend/lib/handlers/slack-mentions.js", () => ({ default: stub("mentions") }));
vi.mock("../backend/lib/handlers/figma-resolve-file.js", () => ({
  default: stub("resolve-file"),
}));
vi.mock("../backend/lib/handlers/gchat-start.js", () => ({ default: stub("start") }));
vi.mock("../backend/lib/handlers/gchat-callback.js", () => ({ default: stub("callback") }));
vi.mock("../backend/lib/handlers/gchat-spaces.js", () => ({ default: stub("spaces") }));
vi.mock("../backend/lib/handlers/gchat-events.js", () => ({ default: stub("events") }));

/**
 * @param {Record<string, unknown>} query
 * @param {string} [method]
 */
function request(query, method = "GET") {
  return /** @type {any} */ ({ method, query, headers: {}, url: "/api/x" });
}

describe("dispatch()", () => {
  const handler = dispatch({
    one: (_req, res) => res.status(200).json({ handler: "one" }),
    two: (_req, res) => res.status(200).json({ handler: "two" }),
  });

  it("routes by the `fn` query parameter and lists its handlers", async () => {
    for (const fn of ["one", "two"]) {
      const res = createFakeResponse();
      await handler(request({ fn }), /** @type {any} */ (res));
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ handler: fn });
    }
    expect(handler.handlers).toEqual(["one", "two"]);
  });

  it("answers 404 for a missing or unknown `fn`, including inherited names", async () => {
    for (const query of [
      {},
      { fn: "" },
      { fn: "three" },
      { fn: "constructor" },
      { fn: "__proto__" },
    ]) {
      const res = createFakeResponse();
      await handler(request(query), /** @type {any} */ (res));
      expect(res.statusCode, JSON.stringify(query)).toBe(404);
      expect(res.body).toEqual({ error: "Not found" });
    }
  });

  it("refuses a request that carries two `fn` values", async () => {
    const res = createFakeResponse();
    await handler(request({ fn: ["one", "two"] }), /** @type {any} */ (res));
    expect(res.statusCode).toBe(400);
  });
});

describe("the grouped Functions", () => {
  it("api/auth.js reaches the five OAuth handlers", async () => {
    const { default: auth } = await import("../backend/api/auth.js");
    expect(auth.handlers).toEqual([
      "figma-start",
      "figma-callback",
      "slack-start",
      "slack-callback",
      "status",
    ]);
    for (const fn of auth.handlers) {
      const res = createFakeResponse();
      await auth(request({ fn }), /** @type {any} */ (res));
      expect(res.body).toEqual({ handler: fn });
    }
  });

  it("api/slack.js reaches the two picker handlers", async () => {
    const { default: slack } = await import("../backend/api/slack.js");
    expect(slack.handlers).toEqual(["channels", "mentions"]);
    for (const fn of slack.handlers) {
      const res = createFakeResponse();
      await slack(request({ fn }), /** @type {any} */ (res));
      expect(res.body).toEqual({ handler: fn });
    }
  });

  it("api/figma.js reaches the file resolver", async () => {
    const { default: figma } = await import("../backend/api/figma.js");
    expect(figma.handlers).toEqual(["resolve-file"]);
    const res = createFakeResponse();
    await figma(request({ fn: "resolve-file" }, "POST"), /** @type {any} */ (res));
    expect(res.body).toEqual({ handler: "resolve-file" });
  });

  it("api/gchat.js reaches the four Google Chat handlers", async () => {
    const { default: gchat } = await import("../backend/api/gchat.js");
    expect(gchat.handlers).toEqual(["start", "callback", "spaces", "events"]);
    for (const fn of gchat.handlers) {
      const res = createFakeResponse();
      await gchat(request({ fn }), /** @type {any} */ (res));
      expect(res.body).toEqual({ handler: fn });
    }
  });

  it("hands the request through untouched", async () => {
    const { default: figma } = await import("../backend/api/figma.js");
    const { default: resolveFile } = await import("../backend/lib/handlers/figma-resolve-file.js");
    const req = request({ fn: "resolve-file", other: "kept" }, "POST");
    const res = createFakeResponse();
    await figma(req, /** @type {any} */ (res));
    expect(resolveFile).toHaveBeenLastCalledWith(req, res);
  });
});
