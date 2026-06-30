// @ts-check
import { describe, it, expect } from "vitest";
import { deriveEventKey } from "../backend/lib/idempotency.js";

describe("deriveEventKey", () => {
  it("uses event_id verbatim when Figma provides one", () => {
    const k = deriveEventKey({ event_id: "evt_abc123", file_key: "x" });
    expect(k).toBe("figma:evt_abc123");
  });

  it("derives a stable hash when event_id is missing", () => {
    const payload = {
      file_key: "k",
      timestamp: "2026-04-20T00:00:00Z",
      webhook_id: "wh_1",
      created_components: [{ name: "A" }, { name: "B" }],
      modified_components: [{ name: "C" }],
    };
    const k1 = deriveEventKey(payload);
    const k2 = deriveEventKey(payload);
    expect(k1).toBe(k2);
    expect(k1.startsWith("figma:hash:")).toBe(true);
  });

  it("produces the same hash regardless of item order (sorted internally)", () => {
    const a = {
      file_key: "k",
      timestamp: "t",
      created_components: [{ name: "A" }, { name: "B" }],
    };
    const b = {
      file_key: "k",
      timestamp: "t",
      created_components: [{ name: "B" }, { name: "A" }],
    };
    expect(deriveEventKey(a)).toBe(deriveEventKey(b));
  });

  it("produces different hashes for different payloads", () => {
    const a = deriveEventKey({ file_key: "k", timestamp: "t" });
    const b = deriveEventKey({ file_key: "k", timestamp: "t2" });
    expect(a).not.toBe(b);
  });
});
