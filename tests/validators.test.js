// @ts-check
import { describe, it, expect } from "vitest";
import {
  assertSlackChannelId,
  assertFigmaFileKey,
  assertFigmaTeamId,
  assertFigmaUserId,
  assertUuid,
  assertChannelList,
} from "../backend/lib/validators.js";
import { ValidationError } from "../backend/lib/errors.js";

describe("validators", () => {
  describe("assertSlackChannelId", () => {
    it("accepts well-formed C/G/D/MP IDs", () => {
      for (const id of ["C0123456", "GABCDEF1", "D1234567", "MP01234567"]) {
        expect(assertSlackChannelId(id)).toBe(id);
      }
    });
    it("rejects malformed IDs", () => {
      for (const bad of ["", "c0123456", "C012", "<!channel>", "C0123456'--"]) {
        expect(() => assertSlackChannelId(bad)).toThrow(ValidationError);
      }
    });
  });

  describe("assertFigmaFileKey", () => {
    it("accepts alphanumeric keys 8-40 chars", () => {
      expect(assertFigmaFileKey("jxunc0ljQa3mKVki8K5kj9")).toBe(
        "jxunc0ljQa3mKVki8K5kj9",
      );
    });
    it("rejects keys with slashes or special chars", () => {
      expect(() => assertFigmaFileKey("ab/cd/ef")).toThrow(ValidationError);
      expect(() => assertFigmaFileKey("../etc/passwd")).toThrow(ValidationError);
    });
  });

  describe("assertFigmaTeamId / UserId", () => {
    it("accepts numeric strings", () => {
      expect(assertFigmaTeamId("123456789")).toBe("123456789");
      expect(assertFigmaUserId("987654321")).toBe("987654321");
    });
    it("rejects non-numeric strings", () => {
      expect(() => assertFigmaTeamId("abc")).toThrow(ValidationError);
      expect(() => assertFigmaUserId("123abc")).toThrow(ValidationError);
    });
  });

  describe("assertUuid", () => {
    it("accepts a v4 UUID", () => {
      const u = "a1b2c3d4-e5f6-4a7b-8c9d-0123456789ab";
      expect(assertUuid(u)).toBe(u);
    });
    it("rejects non-UUID strings", () => {
      expect(() => assertUuid("not-a-uuid")).toThrow(ValidationError);
    });
  });

  describe("assertChannelList", () => {
    it("accepts 1–3 string IDs", () => {
      expect(assertChannelList(["C0123456"])).toEqual([{ id: "C0123456" }]);
      expect(assertChannelList(["C0123456", "GABCDEF1"])).toEqual([
        { id: "C0123456" },
        { id: "GABCDEF1" },
      ]);
    });
    it("accepts objects with names", () => {
      expect(assertChannelList([{ id: "C0123456", name: "#design" }])).toEqual([
        { id: "C0123456", name: "#design" },
      ]);
    });
    it("rejects empty, > 3, or invalid IDs", () => {
      expect(() => assertChannelList([])).toThrow(ValidationError);
      expect(() => assertChannelList(["a", "b", "c", "d"])).toThrow(ValidationError);
      expect(() => assertChannelList(["xss-payload"])).toThrow(ValidationError);
    });
  });
});
