// @ts-check
import { describe, it, expect } from "vitest";
import { assertAssetCandidates } from "../backend/lib/validators.js";
import { ValidationError } from "../backend/lib/errors.js";

describe("assertAssetCandidates", () => {
  const key = "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567";

  it("accepts well-formed style/component/component_set candidates", () => {
    const out = assertAssetCandidates([
      { key, type: "style" },
      { key: key.slice(0, 20), type: "component" },
      { key: "abc_DEF-123456", type: "component_set" },
    ]);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ key, type: "style" });
  });

  it("rejects empty, non-array, and oversized lists", () => {
    expect(() => assertAssetCandidates([])).toThrow(ValidationError);
    expect(() => assertAssetCandidates("nope")).toThrow(ValidationError);
    const many = Array.from({ length: 11 }, () => ({ key, type: "style" }));
    expect(() => assertAssetCandidates(many)).toThrow(ValidationError);
  });

  it("rejects malformed keys and unknown types", () => {
    expect(() => assertAssetCandidates([{ key: "short", type: "style" }])).toThrow(ValidationError);
    expect(() => assertAssetCandidates([{ key: "has spaces here", type: "style" }])).toThrow(
      ValidationError,
    );
    expect(() => assertAssetCandidates([{ key: "../../etc/passwd", type: "style" }])).toThrow(
      ValidationError,
    );
    expect(() => assertAssetCandidates([{ key, type: "frame" }])).toThrow(ValidationError);
    expect(() => assertAssetCandidates([{ key, type: null }])).toThrow(ValidationError);
  });
});
