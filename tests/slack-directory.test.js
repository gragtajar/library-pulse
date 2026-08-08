// @ts-check
import { describe, it, expect } from "vitest";
import {
  cacheFresh,
  normalizeMembers,
  DIRECTORY_CACHE_TTL_MS,
  PAGE_LIMIT,
  MAX_PAGES,
} from "../backend/lib/slack-directory.js";

describe("normalizeMembers", () => {
  it("keeps humans and drops deleted accounts, bots, and USLACKBOT", () => {
    const out = normalizeMembers([
      { id: "U1", name: "alice", profile: { display_name: "Alice" } },
      { id: "U2", name: "bob", deleted: true, profile: { display_name: "Bob" } },
      { id: "U3", name: "robo", is_bot: true, profile: { display_name: "Robo" } },
      { id: "USLACKBOT", name: "slackbot", profile: { display_name: "Slackbot" } },
    ]);
    expect(out.map((u) => u.id)).toEqual(["U1"]);
  });

  it("returns display name AND real name so search can match either", () => {
    const out = normalizeMembers([
      { id: "U1", name: "pj", profile: { display_name: "PJ", real_name: "Piyush Jain" } },
    ]);
    expect(out[0]).toEqual({ id: "U1", name: "PJ", real_name: "Piyush Jain" });
  });

  it("blanks real_name when it duplicates the display name", () => {
    const out = normalizeMembers([
      { id: "U1", name: "rg", profile: { display_name: "Rajat Garg", real_name: "Rajat Garg" } },
    ]);
    expect(out[0].real_name).toBe("");
  });

  it("falls back through real_name → top-level real_name → username", () => {
    const out = normalizeMembers([
      { id: "U1", name: "uname-only" },
      { id: "U2", name: "x", real_name: "Top Level" },
      { id: "U3", name: "y", profile: { real_name: "Profile Real" } },
    ]);
    expect(out.map((u) => u.name).sort()).toEqual(["Profile Real", "Top Level", "uname-only"]);
  });

  it("sorts alphabetically by display name and tolerates junk", () => {
    const out = normalizeMembers([
      { id: "U1", profile: { display_name: "Zoe" }, name: "z" },
      { id: "U2", profile: { display_name: "Anna" }, name: "a" },
      null,
      { name: "no-id" },
    ]);
    expect(out.map((u) => u.name)).toEqual(["Anna", "Zoe"]);
  });

  it("handles non-array input", () => {
    expect(normalizeMembers(/** @type {any} */ (null))).toEqual([]);
  });
});

describe("cacheFresh", () => {
  const now = Date.parse("2026-08-08T12:00:00Z");

  it("is fresh strictly within the TTL", () => {
    const recent = new Date(now - DIRECTORY_CACHE_TTL_MS + 1000).toISOString();
    expect(cacheFresh(recent, now)).toBe(true);
  });

  it("expires at/after the TTL and rejects junk timestamps", () => {
    const old = new Date(now - DIRECTORY_CACHE_TTL_MS - 1).toISOString();
    expect(cacheFresh(old, now)).toBe(false);
    expect(cacheFresh(null, now)).toBe(false);
    expect(cacheFresh("not-a-date", now)).toBe(false);
  });
});

describe("paging ceiling", () => {
  it("covers large orgs (≈9.6k records) and stays under Slack's limit cap", () => {
    expect(PAGE_LIMIT).toBeLessThan(1000);
    expect(PAGE_LIMIT * MAX_PAGES).toBeGreaterThanOrEqual(9000);
  });
});
