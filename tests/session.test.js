// @ts-check
import { describe, it, expect, beforeAll } from "vitest";
import { mintSession, verifySession, requireSession } from "../backend/lib/session.js";
import { AuthError } from "../backend/lib/errors.js";

beforeAll(() => {
  process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
});

describe("session tokens", () => {
  it("round-trips a minted token to the same user id", () => {
    const token = mintSession("123456789");
    expect(verifySession(token)).toEqual({ uid: "123456789" });
  });

  it("coerces numeric ids to strings", () => {
    const token = mintSession(987654321);
    expect(verifySession(token).uid).toBe("987654321");
  });

  it("rejects a tampered payload (re-signing required)", () => {
    const token = mintSession("123456789");
    const [, sig] = token.split(".");
    // Swap the body for a different uid but keep the original signature.
    const forgedBody = Buffer.from(JSON.stringify({ uid: "000000000", exp: 9999999999 })).toString(
      "base64url",
    );
    expect(() => verifySession(`${forgedBody}.${sig}`)).toThrow(AuthError);
  });

  it("rejects a tampered signature", () => {
    const token = mintSession("123456789");
    const [body] = token.split(".");
    expect(() => verifySession(`${body}.deadbeef`)).toThrow(AuthError);
  });

  it("rejects an expired token", () => {
    const token = mintSession("123456789", -10); // already expired
    expect(() => verifySession(token)).toThrow(/session_expired/);
  });

  it("rejects malformed tokens", () => {
    expect(() => verifySession("")).toThrow(AuthError);
    expect(() => verifySession("no-dot")).toThrow(AuthError);
    // @ts-expect-error runtime guard
    expect(() => verifySession(undefined)).toThrow(AuthError);
  });

  it("is not forgeable under a different signing key", () => {
    const token = mintSession("123456789");
    process.env.ENCRYPTION_KEY = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    expect(() => verifySession(token)).toThrow(AuthError);
    // restore for any later tests
    process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  });

  describe("requireSession", () => {
    it("extracts a bearer token from the Authorization header", () => {
      const token = mintSession("555555555");
      expect(requireSession({ headers: { authorization: `Bearer ${token}` } })).toBe("555555555");
    });

    it("rejects a missing or non-bearer header", () => {
      expect(() => requireSession({ headers: {} })).toThrow(AuthError);
      expect(() => requireSession({ headers: { authorization: "Basic abc" } })).toThrow(AuthError);
    });
  });
});
