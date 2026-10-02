// @ts-check
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  ChatApiError,
  addAppToSpace,
  assertSpaceName,
  listSpaces,
  postMessage,
} from "../backend/lib/google-chat.js";

/** @param {number} status @param {unknown} body */
const reply = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("listSpaces (user token)", () => {
  it("asks for named spaces only, follows pages, and keeps name + display name", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        reply(200, {
          spaces: [
            { name: "spaces/AAA", displayName: "Design", spaceType: "SPACE" },
            { name: "spaces/BBB", displayName: "Ops", spaceType: "SPACE" },
          ],
          nextPageToken: "p2",
        }),
      )
      .mockResolvedValueOnce(reply(200, { spaces: [{ name: "spaces/CCC", spaceType: "SPACE" }] }));
    vi.stubGlobal("fetch", fetchMock);

    const { spaces, truncated } = await listSpaces("user-token");
    expect(spaces.map((s) => s.name)).toEqual(["spaces/AAA", "spaces/BBB", "spaces/CCC"]);
    expect(spaces[2].displayName).toBe("");
    expect(truncated).toBe(false);

    const first = new URL(fetchMock.mock.calls[0][0]);
    expect(first.origin + first.pathname).toBe("https://chat.googleapis.com/v1/spaces");
    expect(first.searchParams.get("filter")).toBe('spaceType = "SPACE"');
    expect(first.searchParams.get("pageSize")).toBe("1000");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer user-token");
    expect(new URL(fetchMock.mock.calls[1][0]).searchParams.get("pageToken")).toBe("p2");
  });

  it("stops after a bounded number of pages and says so", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply(200, { spaces: [{ name: "spaces/X" }], nextPageToken: "more" })),
    );
    const { truncated } = await listSpaces("t", { maxPages: 2 });
    expect(truncated).toBe(true);
  });

  it("maps an expired token to `unauthenticated`", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply(401, { error: { status: "UNAUTHENTICATED" } })),
    );
    await expect(listSpaces("t")).rejects.toMatchObject({ code: "unauthenticated", status: 401 });
  });
});

describe("addAppToSpace (user token)", () => {
  it("creates the app's own membership: users/app, type BOT", async () => {
    const fetchMock = vi.fn(async () => reply(200, { name: "spaces/AAA/members/app" }));
    vi.stubGlobal("fetch", fetchMock);
    await addAppToSpace("user-token", "spaces/AAA");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://chat.googleapis.com/v1/spaces/AAA/members");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ member: { name: "users/app", type: "BOT" } });
  });

  it("treats 'already a member' as done, and surfaces a refusal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply(409, { error: { status: "ALREADY_EXISTS" } })),
    );
    await expect(addAppToSpace("t", "spaces/AAA")).resolves.toBeUndefined();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply(403, { error: { status: "PERMISSION_DENIED" } })),
    );
    await expect(addAppToSpace("t", "spaces/AAA")).rejects.toMatchObject({
      code: "permission_denied",
    });
  });

  it("refuses a malformed space name before any request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(addAppToSpace("t", "spaces/../x")).rejects.toBeInstanceOf(ChatApiError);
    expect(() => assertSpaceName("users/123")).toThrow(ChatApiError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("postMessage (app token)", () => {
  it("posts the text with a deterministic request id, so a retry can't double-post", async () => {
    const fetchMock = vi.fn(async () => reply(200, { name: "spaces/AAA/messages/1" }));
    vi.stubGlobal("fetch", fetchMock);
    await postMessage("app-token", "spaces/AAA", "hello", "event:cfg:spaces/AAA");
    await postMessage("app-token", "spaces/AAA", "hello", "event:cfg:spaces/AAA");
    const ids = fetchMock.mock.calls.map((c) => new URL(c[0]).searchParams.get("requestId"));
    expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(ids[0]).toBe(ids[1]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ text: "hello" });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer app-token");
  });

  it("maps the failures a publish can meet", async () => {
    for (const [status, body, code] of [
      [404, { error: { status: "NOT_FOUND" } }, "not_found"],
      [401, {}, "unauthenticated"],
      [429, {}, "rate_limited"],
      [500, {}, "http_500"],
    ]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => reply(/** @type {number} */ (status), body)),
      );
      await expect(postMessage("t", "spaces/AAA", "x", "k")).rejects.toMatchObject({ code });
    }
  });

  it("reports a network failure as its own code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("ECONNRESET"))),
    );
    await expect(postMessage("t", "spaces/AAA", "x", "k")).rejects.toMatchObject({
      code: "network",
    });
  });
});
