// @ts-check
import { describe, it, expect } from "vitest";
import {
  confirmedRecipients,
  mergeRecipients,
  normalizeRecipientList,
  setRecipientStatus,
} from "../backend/lib/email-recipients.js";

const NOW = "2026-09-28T10:00:00.000Z";

/** @type {import("../backend/lib/email-recipients.js").Recipient} */
const ANA = { email: "ana@example.com", status: "confirmed", added_at: NOW, confirmed_at: NOW };
/** @type {import("../backend/lib/email-recipients.js").Recipient} */
const BEN = { email: "ben@example.com", status: "pending", added_at: NOW, confirmed_at: null };
/** @type {import("../backend/lib/email-recipients.js").Recipient} */
const CHO = {
  email: "cho@example.com",
  status: "unsubscribed",
  added_at: NOW,
  confirmed_at: null,
};

describe("mergeRecipients", () => {
  it("keeps retained entries untouched, adds new ones as pending, drops removed ones", () => {
    const { recipients, added } = mergeRecipients(
      [ANA, BEN],
      ["ben@example.com", "dee@example.com"],
      NOW,
    );
    expect(recipients).toEqual([
      BEN,
      { email: "dee@example.com", status: "pending", added_at: NOW, confirmed_at: null },
    ]);
    expect(added).toEqual(["dee@example.com"]);
  });

  it("preserves the requested order", () => {
    const { recipients } = mergeRecipients([ANA, BEN], ["ben@example.com", "ana@example.com"]);
    expect(recipients.map((r) => r.email)).toEqual(["ben@example.com", "ana@example.com"]);
  });

  it("does not resurrect an unsubscribed address that is re-saved", () => {
    const { recipients, added } = mergeRecipients([CHO], ["cho@example.com"], NOW);
    expect(recipients).toEqual([CHO]);
    expect(added).toEqual([]);
  });

  it("re-adding a previously removed address starts a fresh confirmation", () => {
    const removed = mergeRecipients([CHO], ["ana@example.com"], NOW);
    expect(removed.recipients.map((r) => r.email)).toEqual(["ana@example.com"]);
    const back = mergeRecipients(removed.recipients, ["ana@example.com", "cho@example.com"], NOW);
    expect(back.added).toEqual(["cho@example.com"]);
    expect(back.recipients[1]?.status).toBe("pending");
  });
});

describe("confirmedRecipients", () => {
  it("returns only confirmed addresses", () => {
    expect(confirmedRecipients([ANA, BEN, CHO])).toEqual(["ana@example.com"]);
    expect(confirmedRecipients([])).toEqual([]);
  });
});

describe("setRecipientStatus", () => {
  it("confirms a pending address and stamps confirmed_at once", () => {
    const list = setRecipientStatus([BEN], "ben@example.com", "confirmed", NOW);
    expect(list?.[0]).toEqual({ ...BEN, status: "confirmed", confirmed_at: NOW });
    const again = setRecipientStatus(list ?? [], "ben@example.com", "confirmed", "later");
    expect(again?.[0]?.confirmed_at).toBe(NOW);
  });

  it("unsubscribes and clears confirmed_at", () => {
    const list = setRecipientStatus([ANA], "ana@example.com", "unsubscribed", NOW);
    expect(list?.[0]).toEqual({ ...ANA, status: "unsubscribed", confirmed_at: null });
  });

  it("returns null when the address is no longer on the list", () => {
    expect(setRecipientStatus([ANA], "gone@example.com", "confirmed")).toBeNull();
  });

  it("does not mutate its input", () => {
    const input = [{ ...BEN }];
    setRecipientStatus(input, "ben@example.com", "confirmed", NOW);
    expect(input[0]?.status).toBe("pending");
  });
});

describe("normalizeRecipientList", () => {
  it("drops malformed entries and defaults unknown statuses to pending", () => {
    const list = normalizeRecipientList([
      ANA,
      { email: "x@example.com", status: "bogus" },
      { status: "confirmed" },
      "not-an-object",
      null,
    ]);
    expect(list).toEqual([
      ANA,
      { email: "x@example.com", status: "pending", added_at: "", confirmed_at: null },
    ]);
    expect(normalizeRecipientList(null)).toEqual([]);
    expect(normalizeRecipientList("[]")).toEqual([]);
  });
});
