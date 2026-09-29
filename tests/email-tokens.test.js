// @ts-check
import { describe, it, expect, beforeAll } from "vitest";
import { mintEmailToken, verifyEmailToken } from "../backend/lib/email-tokens.js";
import { ValidationError } from "../backend/lib/errors.js";

const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const CONFIG = "6f1c1b4e-6d0b-4a2e-9d1c-0b1c2d3e4f50";

beforeAll(() => {
  process.env.ENCRYPTION_KEY = KEY;
});

describe("email link tokens", () => {
  it("round-trips a confirm token to its config id and address", () => {
    const token = mintEmailToken("confirm", CONFIG, "ana@example.com");
    expect(verifyEmailToken(token, "confirm")).toEqual({
      configId: CONFIG,
      email: "ana@example.com",
    });
  });

  it("round-trips an unsubscribe token", () => {
    const token = mintEmailToken("unsubscribe", CONFIG, "ana@example.com");
    expect(verifyEmailToken(token, "unsubscribe")).toEqual({
      configId: CONFIG,
      email: "ana@example.com",
    });
  });

  it("refuses a token presented for the wrong purpose", () => {
    const token = mintEmailToken("confirm", CONFIG, "ana@example.com");
    expect(() => verifyEmailToken(token, "unsubscribe")).toThrow(/email_link_invalid/);
  });

  it("rejects a tampered body (re-signing required)", () => {
    const token = mintEmailToken("unsubscribe", CONFIG, "ana@example.com");
    const [, sig] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ p: "u", c: CONFIG, e: "victim@example.com", exp: 9999999999 }),
    ).toString("base64url");
    expect(() => verifyEmailToken(`${forged}.${sig}`, "unsubscribe")).toThrow(ValidationError);
  });

  it("rejects a tampered signature and malformed input", () => {
    const token = mintEmailToken("confirm", CONFIG, "ana@example.com");
    const [body] = token.split(".");
    expect(() => verifyEmailToken(`${body}.deadbeef`, "confirm")).toThrow(/email_link_invalid/);
    expect(() => verifyEmailToken("", "confirm")).toThrow(ValidationError);
    expect(() => verifyEmailToken("no-dot", "confirm")).toThrow(ValidationError);
    expect(() => verifyEmailToken(undefined, "confirm")).toThrow(ValidationError);
    expect(() => verifyEmailToken("a".repeat(2000), "confirm")).toThrow(ValidationError);
  });

  it("reports expiry distinctly", () => {
    const token = mintEmailToken("confirm", CONFIG, "ana@example.com", -10);
    expect(() => verifyEmailToken(token, "confirm")).toThrow(/email_link_expired/);
  });

  it("is not forgeable under a different signing key", () => {
    const token = mintEmailToken("confirm", CONFIG, "ana@example.com");
    process.env.ENCRYPTION_KEY = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    expect(() => verifyEmailToken(token, "confirm")).toThrow(ValidationError);
    process.env.ENCRYPTION_KEY = KEY;
  });

  it("uses a different key than plugin sessions (domain separation)", async () => {
    const { mintSession, verifySession } = await import("../backend/lib/session.js");
    // A session token body has a different shape, but the point is the two
    // signers never validate each other's output.
    const session = mintSession("123456789");
    expect(() => verifyEmailToken(session, "confirm")).toThrow(ValidationError);
    const link = mintEmailToken("confirm", CONFIG, "ana@example.com");
    expect(() => verifySession(link)).toThrow();
  });
});
