// @ts-check
import { describe, it, expect, beforeAll } from "vitest";
import { encrypt, decrypt } from "../backend/lib/encryption.js";

beforeAll(() => {
  // 32 random bytes hex-encoded. Deterministic for tests.
  process.env.ENCRYPTION_KEY =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
});

describe("encryption", () => {
  it("round-trips utf-8 plaintext", () => {
    const samples = [
      "xoxb-1234567890-abcdef",
      "🔐 token with emoji",
      "a".repeat(2048),
      "{\"json\":\"payload\",\"n\":42}",
    ];
    for (const s of samples) {
      const ct = encrypt(s);
      expect(ct).not.toBe(s);
      expect(decrypt(ct)).toBe(s);
    }
  });

  it("rejects tampering with the auth tag", () => {
    const ct = encrypt("secret");
    const buf = Buffer.from(ct, "base64");
    buf[buf.length - 1] ^= 0x01; // flip one bit of the auth tag
    expect(() => decrypt(buf.toString("base64"))).toThrow();
  });

  it("rejects tampering with the ciphertext", () => {
    const ct = encrypt("secret");
    const buf = Buffer.from(ct, "base64");
    buf[20] ^= 0x01; // flip one bit of ciphertext
    expect(() => decrypt(buf.toString("base64"))).toThrow();
  });

  it("produces a different ciphertext each call (random IV)", () => {
    const a = encrypt("same");
    const b = encrypt("same");
    expect(a).not.toBe(b);
  });

  it("rejects malformed inputs", () => {
    // @ts-expect-error -- testing runtime guard
    expect(() => encrypt(undefined)).toThrow(TypeError);
    expect(() => decrypt("")).toThrow(TypeError);
    expect(() => decrypt("abc")).toThrow(/too short/);
  });

  it("rejects a missing or wrong-length ENCRYPTION_KEY", () => {
    const prev = process.env.ENCRYPTION_KEY;
    try {
      delete process.env.ENCRYPTION_KEY;
      expect(() => encrypt("x")).toThrow(/ENCRYPTION_KEY/);
      process.env.ENCRYPTION_KEY = "tooShort";
      expect(() => encrypt("x")).toThrow(/ENCRYPTION_KEY/);
    } finally {
      process.env.ENCRYPTION_KEY = prev;
    }
  });
});
