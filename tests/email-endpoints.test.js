// @ts-check
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  process.env.LOG_LEVEL = "error";
  process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  return {
    db: /** @type {import("./helpers/fake-supabase.js").FakeSupabase} */ (
      /** @type {unknown} */ (null)
    ),
  };
});

vi.mock("../backend/lib/supabase.js", async () => {
  const { createFakeSupabase } = await import("./helpers/fake-supabase.js");
  h.db = createFakeSupabase();
  return { default: h.db };
});

import handler from "../backend/api/email.js";
import { mintEmailToken } from "../backend/lib/email-tokens.js";
import { createFakeResponse } from "./helpers/fake-supabase.js";

const NOW = new Date().toISOString();
const ID = "6f1c1b4e-6d0b-4a2e-9d1c-0b1c2d3e4f50";

function seed() {
  h.db.reset({
    configurations: [
      {
        id: ID,
        figma_file_name: "DS <Core>",
        destination: "email",
        email_recipients: [
          { email: "ana@example.com", status: "confirmed", added_at: NOW, confirmed_at: NOW },
          { email: "cho@example.com", status: "pending", added_at: NOW, confirmed_at: null },
          { email: "dee@example.com", status: "unsubscribed", added_at: NOW, confirmed_at: null },
        ],
      },
    ],
  });
}

/** @param {string} email */
function statusOf(email) {
  const row = (h.db.tables.configurations ?? [])[0];
  return row?.email_recipients.find((/** @type {{ email: string }} */ r) => r.email === email)
    ?.status;
}

/**
 * @param {"confirm" | "unsubscribe" | string | undefined} action
 * @param {{ method: string, token?: string, body?: unknown }} opts
 */
async function call(action, { method, token, body }) {
  const res = createFakeResponse();
  // Only the parameters that were given, as a real request would carry them.
  const query = Object.fromEntries(
    Object.entries({ action, token }).filter(([, value]) => value !== undefined),
  );
  await handler({ method, url: "/api/email", headers: {}, query, body }, res);
  return res;
}
const confirm = "confirm";
const unsubscribe = "unsubscribe";

beforeEach(seed);

describe("/api/email?action=confirm", () => {
  it("GET shows a confirm button and changes nothing (link scanners can't confirm)", async () => {
    const token = mintEmailToken("confirm", ID, "cho@example.com");
    const res = await call(confirm, { method: "GET", token });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.headers["content-security-policy"]).toContain("form-action 'self'");
    expect(res.body).toContain('<form method="post"');
    expect(res.body).toContain("Confirm address");
    expect(statusOf("cho@example.com")).toBe("pending");
  });

  it("POST confirms the address", async () => {
    const token = mintEmailToken("confirm", ID, "cho@example.com");
    const res = await call(confirm, { method: "POST", token });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("You&#39;re confirmed");
    expect(statusOf("cho@example.com")).toBe("confirmed");
    // Other recipients are untouched.
    expect(statusOf("ana@example.com")).toBe("confirmed");
    expect(statusOf("dee@example.com")).toBe("unsubscribed");
  });

  it("is idempotent for an already-confirmed address", async () => {
    const token = mintEmailToken("confirm", ID, "ana@example.com");
    const res = await call(confirm, { method: "POST", token });
    expect(res.body).toContain("already confirmed");
    expect(statusOf("ana@example.com")).toBe("confirmed");
  });

  it("does not re-subscribe someone who unsubscribed", async () => {
    const token = mintEmailToken("confirm", ID, "dee@example.com");
    const res = await call(confirm, { method: "POST", token });
    expect(res.body).toContain("You unsubscribed from these updates");
    expect(statusOf("dee@example.com")).toBe("unsubscribed");
  });

  it("tells a removed address it's no longer on the list", async () => {
    const token = mintEmailToken("confirm", ID, "gone@example.com");
    const res = await call(confirm, { method: "POST", token });
    expect(res.body).toContain("no longer on the list");
  });

  it("treats a config that moved back to Slack as no longer listed", async () => {
    const row = (h.db.tables.configurations ?? [])[0];
    if (row) row.destination = "slack";
    const token = mintEmailToken("confirm", ID, "cho@example.com");
    const res = await call(confirm, { method: "POST", token });
    expect(res.body).toContain("no longer on the list");
    expect(statusOf("cho@example.com")).toBe("pending");
  });

  it("rejects expired, forged, wrong-purpose and missing tokens with a 400 page", async () => {
    const expired = mintEmailToken("confirm", ID, "cho@example.com", -10);
    const resExpired = await call(confirm, { method: "POST", token: expired });
    expect(resExpired.statusCode).toBe(400);
    expect(resExpired.body).toContain("This link has expired");

    const wrongPurpose = mintEmailToken("unsubscribe", ID, "cho@example.com");
    for (const token of [wrongPurpose, "forged.token", "", undefined]) {
      const res = await call(confirm, { method: "POST", token });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain("This link isn&#39;t valid");
    }
    expect(statusOf("cho@example.com")).toBe("pending");
  });

  it("escapes the file name in the page", async () => {
    const token = mintEmailToken("confirm", ID, "cho@example.com");
    const res = await call(confirm, { method: "GET", token });
    expect(res.body).toContain("DS &lt;Core&gt;");
    expect(res.body).not.toContain("DS <Core>");
  });

  it("reports a failed save instead of claiming success", async () => {
    h.db.failUpdates = true;
    const token = mintEmailToken("confirm", ID, "cho@example.com");
    const res = await call(confirm, { method: "POST", token });
    expect(res.statusCode).toBe(502);
    expect(res.body).toContain("Something went wrong");
  });

  it("allows only GET and POST", async () => {
    const res = await call(confirm, { method: "PUT", token: "x" });
    expect(res.statusCode).toBe(405);
  });
});

describe("/api/email?action=unsubscribe", () => {
  it("GET shows an unsubscribe button and changes nothing", async () => {
    const token = mintEmailToken("unsubscribe", ID, "ana@example.com");
    const res = await call(unsubscribe, { method: "GET", token });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<form method="post"');
    expect(res.body).toContain("Unsubscribe");
    expect(statusOf("ana@example.com")).toBe("confirmed");
  });

  it("POST from the page unsubscribes and shows the result", async () => {
    const token = mintEmailToken("unsubscribe", ID, "ana@example.com");
    const res = await call(unsubscribe, { method: "POST", token });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("You&#39;re unsubscribed");
    expect(statusOf("ana@example.com")).toBe("unsubscribed");
    expect(statusOf("cho@example.com")).toBe("pending");
  });

  it("answers a mail client's one-click POST with a bare 200", async () => {
    const token = mintEmailToken("unsubscribe", ID, "ana@example.com");
    const parsed = await call(unsubscribe, {
      method: "POST",
      token,
      body: { "List-Unsubscribe": "One-Click" },
    });
    expect(parsed.statusCode).toBe(200);
    expect(parsed.body).toBe("Unsubscribed");
    expect(statusOf("ana@example.com")).toBe("unsubscribed");

    seed();
    const raw = await call(unsubscribe, {
      method: "POST",
      token,
      body: "List-Unsubscribe=One-Click",
    });
    expect(raw.body).toBe("Unsubscribed");
    expect(statusOf("ana@example.com")).toBe("unsubscribed");
  });

  it("gives the same answer for an address that isn't on the list", async () => {
    const token = mintEmailToken("unsubscribe", ID, "gone@example.com");
    const res = await call(unsubscribe, { method: "POST", token });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("You&#39;re unsubscribed");

    const otherConfig = mintEmailToken(
      "unsubscribe",
      "00000000-0000-4000-8000-000000000000",
      "a@x.io",
    );
    const res2 = await call(unsubscribe, { method: "POST", token: otherConfig });
    expect(res2.statusCode).toBe(200);
  });

  it("rejects invalid tokens (page for browsers, bare 400 for one-click)", async () => {
    const page = await call(unsubscribe, { method: "GET", token: "forged.token" });
    expect(page.statusCode).toBe(400);
    expect(page.body).toContain("This link isn&#39;t valid");

    const confirmToken = mintEmailToken("confirm", ID, "ana@example.com");
    const oneClick = await call(unsubscribe, {
      method: "POST",
      token: confirmToken,
      body: { "List-Unsubscribe": "One-Click" },
    });
    expect(oneClick.statusCode).toBe(400);
    expect(statusOf("ana@example.com")).toBe("confirmed");
  });

  it("reports a failed save instead of claiming success", async () => {
    h.db.failUpdates = true;
    const token = mintEmailToken("unsubscribe", ID, "ana@example.com");
    const res = await call(unsubscribe, { method: "POST", token });
    expect(res.statusCode).toBe(502);
  });
});

describe("/api/email routing", () => {
  it("rejects a missing or unknown action without touching anything", async () => {
    const token = mintEmailToken("confirm", ID, "cho@example.com");
    for (const action of [undefined, "", "delete", "confirmx"]) {
      const res = await call(action, { method: "POST", token });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain("This link isn&#39;t valid");
    }
    expect(statusOf("cho@example.com")).toBe("pending");
  });

  it("a confirm token can't unsubscribe and an unsubscribe token can't confirm", async () => {
    const c = mintEmailToken("confirm", ID, "ana@example.com");
    expect((await call("unsubscribe", { method: "POST", token: c })).statusCode).toBe(400);
    expect(statusOf("ana@example.com")).toBe("confirmed");
    const u = mintEmailToken("unsubscribe", ID, "cho@example.com");
    expect((await call("confirm", { method: "POST", token: u })).statusCode).toBe(400);
    expect(statusOf("cho@example.com")).toBe("pending");
  });

  it("the pages post back to the same endpoint with the action and token", async () => {
    const c = mintEmailToken("confirm", ID, "cho@example.com");
    const page = await call("confirm", { method: "GET", token: c });
    expect(page.body).toContain(
      `action="&#x2F;api&#x2F;email?action=confirm&amp;token=${encodeURIComponent(c)}"`,
    );
    const u = mintEmailToken("unsubscribe", ID, "ana@example.com");
    const page2 = await call("unsubscribe", { method: "GET", token: u });
    expect(page2.body).toContain(
      `action="&#x2F;api&#x2F;email?action=unsubscribe&amp;token=${encodeURIComponent(u)}"`,
    );
  });
});
