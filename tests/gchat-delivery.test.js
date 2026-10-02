// @ts-check
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  process.env.LOG_LEVEL = "error";
  process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  return {
    db: /** @type {import("./helpers/fake-supabase.js").FakeSupabase} */ (
      /** @type {unknown} */ (null)
    ),
    addAppToSpace: /** @type {import("vitest").Mock} */ (/** @type {unknown} */ (null)),
    postMessage: /** @type {import("vitest").Mock} */ (/** @type {unknown} */ (null)),
    getAppAccessToken: /** @type {import("vitest").Mock} */ (/** @type {unknown} */ (null)),
    userAccessToken: /** @type {import("vitest").Mock} */ (/** @type {unknown} */ (null)),
  };
});

vi.mock("../backend/lib/supabase.js", async () => {
  const { createFakeSupabase } = await import("./helpers/fake-supabase.js");
  h.db = createFakeSupabase();
  return { default: h.db };
});
vi.mock("../backend/lib/google-chat.js", async (importOriginal) => {
  const actual = /** @type {typeof import("../backend/lib/google-chat.js")} */ (
    await importOriginal()
  );
  h.addAppToSpace = vi.fn(async () => undefined);
  h.postMessage = vi.fn(async () => ({ name: "spaces/X/messages/1" }));
  return { ...actual, addAppToSpace: h.addAppToSpace, postMessage: h.postMessage };
});
vi.mock("../backend/lib/google-app-auth.js", async (importOriginal) => {
  const actual = /** @type {typeof import("../backend/lib/google-app-auth.js")} */ (
    await importOriginal()
  );
  h.getAppAccessToken = vi.fn(async () => "app-token");
  return { ...actual, getAppAccessToken: h.getAppAccessToken };
});
vi.mock("../backend/lib/google-installations.js", async (importOriginal) => {
  const actual = /** @type {typeof import("../backend/lib/google-installations.js")} */ (
    await importOriginal()
  );
  h.userAccessToken = vi.fn(async () => "user-token");
  return { ...actual, userAccessToken: h.userAccessToken };
});

import {
  ensureAppMemberships,
  normalizeSpaceList,
  sendPublishChats,
} from "../backend/lib/gchat-delivery.js";
import { ChatApiError } from "../backend/lib/google-chat.js";
import { AppAuthError } from "../backend/lib/google-app-auth.js";
import { UpstreamError } from "../backend/lib/errors.js";

const INST = /** @type {any} */ ({ id: "inst-1", refresh_token_enc: "x", revoked_at: null });
const CONFIG = {
  id: "cfg-1",
  figma_file_key: "abcDEF123456",
  gchat_spaces: [
    { name: "spaces/AAA", display_name: "Design" },
    { name: "spaces/BBB", display_name: "Ops" },
  ],
  gchat_timezone: "Asia/Kolkata",
  custom_message: "Heads up",
  google_installation_id: "inst-1",
};
const PAYLOAD = {
  file_key: "abcDEF123456",
  file_name: "DS",
  timestamp: "2026-07-30T14:15:00Z",
  triggered_by: { handle: "rajat" },
  created_components: [{ key: "k", name: "Button" }],
};

beforeEach(() => {
  h.db.reset({ gchat_spaces: [], notification_log: [] });
  h.addAppToSpace.mockClear();
  h.postMessage.mockClear();
  h.getAppAccessToken.mockClear();
  h.userAccessToken.mockClear();
});

describe("normalizeSpaceList", () => {
  it("keeps well-formed, unique space names only", () => {
    expect(
      normalizeSpaceList([
        "spaces/AAA",
        { name: "spaces/AAA", display_name: "dup" },
        { name: "spaces/BBB", display_name: "Ops" },
        { name: "users/1" },
        null,
      ]),
    ).toEqual([
      { name: "spaces/AAA", display_name: "" },
      { name: "spaces/BBB", display_name: "Ops" },
    ]);
    expect(normalizeSpaceList("nope")).toEqual([]);
  });
});

describe("ensureAppMemberships", () => {
  it("adds the app to each space with the user's token and remembers the membership", async () => {
    const r = await ensureAppMemberships(INST, CONFIG.gchat_spaces);
    expect(r).toEqual({ added: 2, failed: 0, errors: [] });
    expect(h.addAppToSpace.mock.calls.map((c) => c)).toEqual([
      ["user-token", "spaces/AAA"],
      ["user-token", "spaces/BBB"],
    ]);
    expect(h.db.tables.gchat_spaces.map((s) => [s.space_name, s.app_member])).toEqual([
      ["spaces/AAA", true],
      ["spaces/BBB", true],
    ]);
  });

  it("counts a refused space without giving up on the others", async () => {
    h.addAppToSpace.mockImplementationOnce(async () => {
      throw new ChatApiError("permission_denied", 403);
    });
    const r = await ensureAppMemberships(INST, CONFIG.gchat_spaces);
    expect(r).toEqual({ added: 1, failed: 1, errors: ["permission_denied"] });
  });

  it("fails every space when the user's grant is gone", async () => {
    h.userAccessToken.mockImplementationOnce(async () => {
      throw new UpstreamError("google_revoked");
    });
    const r = await ensureAppMemberships(INST, CONFIG.gchat_spaces);
    expect(r).toEqual({ added: 0, failed: 2, errors: ["google_revoked", "google_revoked"] });
    expect(h.addAppToSpace).not.toHaveBeenCalled();
  });
});

describe("sendPublishChats", () => {
  const log = () => h.db.tables.notification_log;

  it("posts to every space as the app, once, and logs each", async () => {
    const r = await sendPublishChats({
      config: CONFIG,
      payload: PAYLOAD,
      fileKey: "abcDEF123456",
      eventKey: "ev1",
    });
    expect(r).toEqual({ sent: 2, failed: 0, skipped: 0, total: 2, errorCodes: [] });
    expect(h.getAppAccessToken).toHaveBeenCalledTimes(1);
    expect(h.postMessage.mock.calls.map((c) => [c[0], c[1], c[3]])).toEqual([
      ["app-token", "spaces/AAA", "ev1:cfg-1:spaces/AAA"],
      ["app-token", "spaces/BBB", "ev1:cfg-1:spaces/BBB"],
    ]);
    const text = h.postMessage.mock.calls[0][2];
    expect(text).toContain("Published by *rajat*");
    expect(text).toContain("19:45 Asia/Kolkata");
    expect(text).toContain("💬 Heads up");
    expect(log().map((l) => [l.recipient, l.status, l.event_key])).toEqual([
      ["spaces/AAA", "sent", "ev1"],
      ["spaces/BBB", "sent", "ev1"],
    ]);
  });

  it("re-drives only the spaces a retry missed", async () => {
    h.db.tables.notification_log.push({
      configuration_id: "cfg-1",
      event_key: "ev1",
      recipient: "spaces/AAA",
      status: "sent",
    });
    const r = await sendPublishChats({
      config: CONFIG,
      payload: PAYLOAD,
      fileKey: "k",
      eventKey: "ev1",
    });
    expect(r).toMatchObject({ sent: 1, skipped: 1 });
    expect(h.postMessage.mock.calls.map((c) => c[1])).toEqual(["spaces/BBB"]);
  });

  it("skips spaces the app was removed from or that said stop", async () => {
    h.db.tables.gchat_spaces.push(
      { space_name: "spaces/AAA", app_member: false, muted: false },
      { space_name: "spaces/BBB", app_member: true, muted: true },
    );
    const r = await sendPublishChats({
      config: CONFIG,
      payload: PAYLOAD,
      fileKey: "k",
      eventKey: "ev2",
    });
    expect(r).toEqual({ sent: 0, failed: 0, skipped: 2, total: 2, errorCodes: [] });
    expect(h.getAppAccessToken).not.toHaveBeenCalled();
  });

  it("records a space that no longer has the app, and keeps going", async () => {
    h.postMessage.mockImplementationOnce(async () => {
      throw new ChatApiError("not_found", 404);
    });
    const r = await sendPublishChats({
      config: CONFIG,
      payload: PAYLOAD,
      fileKey: "k",
      eventKey: "ev3",
    });
    expect(r).toMatchObject({ sent: 1, failed: 1, errorCodes: ["not_found"] });
    expect(log().find((l) => l.recipient === "spaces/AAA")).toMatchObject({
      status: "failed",
      error_message: "not_found",
    });
    expect(h.db.tables.gchat_spaces.find((s) => s.space_name === "spaces/AAA")).toMatchObject({
      app_member: false,
    });
  });

  it("fails every pending space, with the reason, when the app can't authenticate", async () => {
    h.getAppAccessToken.mockImplementationOnce(async () => {
      throw new AppAuthError("app_auth_unconfigured");
    });
    const r = await sendPublishChats({
      config: CONFIG,
      payload: PAYLOAD,
      fileKey: "k",
      eventKey: "ev4",
    });
    expect(r).toEqual({
      sent: 0,
      failed: 2,
      skipped: 0,
      total: 2,
      errorCodes: ["app_auth_unconfigured", "app_auth_unconfigured"],
    });
    expect(h.postMessage).not.toHaveBeenCalled();
    expect(log()).toHaveLength(2);
  });

  it("does nothing for a config with no spaces", async () => {
    const r = await sendPublishChats({
      config: { ...CONFIG, gchat_spaces: [] },
      payload: PAYLOAD,
      fileKey: "k",
      eventKey: "ev5",
    });
    expect(r).toEqual({ sent: 0, failed: 0, skipped: 0, total: 0, errorCodes: [] });
  });
});
