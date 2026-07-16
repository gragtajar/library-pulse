// @ts-check
import { describe, it, expect } from "vitest";
import { deliveryStatusFor } from "../backend/lib/delivery-status.js";

describe("deliveryStatusFor", () => {
  it("→ ok when nothing failed", () => {
    expect(deliveryStatusFor([], 0)).toEqual({ status: "ok", lastError: null });
  });

  it("→ slack_revoked on an auth error (even alongside other failures)", () => {
    expect(deliveryStatusFor(["channel_not_found", "token_revoked"], 2)).toEqual({
      status: "slack_revoked",
      lastError: "token_revoked",
    });
    expect(deliveryStatusFor(["invalid_auth"], 1).status).toBe("slack_revoked");
    expect(deliveryStatusFor(["account_inactive"], 1).status).toBe("slack_revoked");
  });

  it("→ send_failing on non-auth failures", () => {
    expect(deliveryStatusFor(["channel_not_found"], 1)).toEqual({
      status: "send_failing",
      lastError: "channel_not_found",
    });
  });

  it("→ send_failing with a fallback code when failed but no codes captured", () => {
    expect(deliveryStatusFor([], 1)).toEqual({ status: "send_failing", lastError: "send_failed" });
  });
});
