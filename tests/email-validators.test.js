// @ts-check
import { describe, it, expect } from "vitest";
import {
  assertDestination,
  assertEmailList,
  assertTimezone,
  isValidEmail,
  normalizeEmail,
} from "../backend/lib/validators.js";
import { ValidationError } from "../backend/lib/errors.js";

describe("assertDestination", () => {
  it("defaults to slack when absent (older plugin builds)", () => {
    expect(assertDestination(undefined)).toBe("slack");
    expect(assertDestination(null)).toBe("slack");
  });
  it("accepts the two destinations and rejects anything else", () => {
    expect(assertDestination("slack")).toBe("slack");
    expect(assertDestination("email")).toBe("email");
    for (const bad of ["", "teams", "EMAIL", 1, {}]) {
      expect(() => assertDestination(bad)).toThrow(ValidationError);
    }
  });
});

describe("isValidEmail", () => {
  it("accepts ordinary and unusual-but-valid addresses", () => {
    for (const ok of [
      "ana@example.com",
      "first.last+tag@sub.example.co.uk",
      "o'neil@example.org",
      "user_name-1@ex-ample.io",
      "a@b.co",
      "x!#$%&'*+/=?^_`{|}~-@example.com",
    ]) {
      expect(isValidEmail(ok), ok).toBe(true);
    }
  });

  it("rejects malformed addresses", () => {
    for (const bad of [
      "",
      "plainaddress",
      "@example.com",
      "ana@",
      "ana@localhost", // no dot in the domain
      "ana@example..com", // empty label
      "ana@-example.com", // label can't start with a hyphen
      "ana@example-.com",
      "ana@exam ple.com",
      "ana@@example.com",
      "an a@example.com",
      "ana@example.com ", // untrimmed (normalize first)
      "<script>@example.com",
      `${"a".repeat(65)}@example.com`, // local part > 64
      `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.com`, // > 254
      "ana@" + "x".repeat(64) + ".com", // label > 63
    ]) {
      expect(isValidEmail(bad), bad).toBe(false);
    }
    expect(isValidEmail(undefined)).toBe(false);
    expect(isValidEmail(42)).toBe(false);
  });
});

describe("normalizeEmail / assertEmailList", () => {
  it("trims and lower-cases", () => {
    expect(normalizeEmail("  Ana@Example.COM ")).toBe("ana@example.com");
  });

  it("returns normalized, de-duplicated addresses in order", () => {
    expect(assertEmailList(["Ana@Example.com", " ben@example.com", "ana@example.com"])).toEqual([
      "ana@example.com",
      "ben@example.com",
    ]);
  });

  it("enforces the 1–5 bound on the raw list", () => {
    expect(() => assertEmailList([])).toThrow(/between 1 and 5/);
    expect(() =>
      assertEmailList(["a@x.io", "b@x.io", "c@x.io", "d@x.io", "e@x.io", "f@x.io"]),
    ).toThrow(/between 1 and 5/);
    expect(() => assertEmailList("a@x.io")).toThrow(ValidationError);
    expect(() => assertEmailList(undefined)).toThrow(ValidationError);
  });

  it("rejects the first invalid entry, naming it", () => {
    expect(() => assertEmailList(["ana@example.com", "nope"])).toThrow(
      /Invalid email address: nope/,
    );
    expect(() => assertEmailList([42])).toThrow(/must be strings/);
  });
});

describe("assertTimezone", () => {
  it("accepts IANA names, aliases and UTC", () => {
    for (const tz of ["Asia/Kolkata", "America/New_York", "Europe/London", "UTC", "Etc/UTC"]) {
      expect(assertTimezone(tz)).toBe(tz);
    }
  });

  it("rejects unknown or malformed zones", () => {
    for (const bad of ["Mars/Phobos", "", "Asia/Kolkata; DROP", "<b>", 12, null, "a".repeat(65)]) {
      expect(() => assertTimezone(bad)).toThrow(ValidationError);
    }
  });
});
