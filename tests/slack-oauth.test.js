// @ts-check
import { describe, it, expect } from "vitest";
import { SLACK_OAUTH_SCOPES, SLACK_OAUTH_SCOPE_PARAM } from "../backend/lib/slack-oauth.js";

describe("SLACK_OAUTH_SCOPES", () => {
  it("pins the exact scope set the backend's endpoints depend on", () => {
    // chat:write + chat:write.public → webhook.js chat.postMessage
    // channels:read + groups:read    → api/slack/channels.js conversations.list
    // users:read                     → api/slack/mentions.js users.list
    // usergroups:read                → api/slack/mentions.js usergroups.list
    // A scope an endpoint needs but the authorize URL doesn't request produces
    // tokens that can never work, no matter how often users reconnect — the
    // "@mentions are unavailable" bug. Update this list and the authorize
    // request together, never separately.
    expect([...SLACK_OAUTH_SCOPES].sort()).toEqual(
      [
        "chat:write",
        "chat:write.public",
        "channels:read",
        "groups:read",
        "users:read",
        "usergroups:read",
      ].sort(),
    );
  });

  it("joins with commas for Slack's OAuth v2 scope param (no spaces)", () => {
    expect(SLACK_OAUTH_SCOPE_PARAM).toBe(SLACK_OAUTH_SCOPES.join(","));
    expect(SLACK_OAUTH_SCOPE_PARAM).not.toContain(" ");
    expect(SLACK_OAUTH_SCOPE_PARAM).toContain("users:read");
    expect(SLACK_OAUTH_SCOPE_PARAM).toContain("usergroups:read");
  });
});
