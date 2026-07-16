// @ts-check
import { describe, it, expect } from "vitest";
import { normalizeChannels } from "../backend/lib/slack-channels.js";

describe("normalizeChannels", () => {
  it("sorts by num_members desc (most-populated first)", () => {
    const out = normalizeChannels([
      { id: "C1", name: "a", num_members: 5 },
      { id: "C2", name: "b", num_members: 210 },
      { id: "C3", name: "c", num_members: 64 },
    ]);
    expect(out.map((c) => c.name)).toEqual(["b", "c", "a"]);
  });

  it("maps to { id, name, is_private, num_members }", () => {
    const out = normalizeChannels([{ id: "C1", name: "x", is_private: true, num_members: 3 }]);
    expect(out[0]).toEqual({ id: "C1", name: "x", is_private: true, num_members: 3 });
  });

  it("defaults num_members to 0 and is_private to false", () => {
    const out = normalizeChannels([{ id: "C1", name: "x" }]);
    expect(out[0].num_members).toBe(0);
    expect(out[0].is_private).toBe(false);
  });

  it("drops entries missing id or name", () => {
    const out = normalizeChannels([
      { id: "C1" },
      { name: "y" },
      { id: "C2", name: "ok", num_members: 1 },
    ]);
    expect(out.map((c) => c.id)).toEqual(["C2"]);
  });

  it("handles non-array input", () => {
    expect(normalizeChannels(/** @type {any} */ (null))).toEqual([]);
    expect(normalizeChannels(/** @type {any} */ (undefined))).toEqual([]);
  });
});
