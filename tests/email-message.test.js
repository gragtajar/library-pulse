// @ts-check
import { describe, it, expect } from "vitest";
import { buildConfirmEmail, buildPublishEmail, formatWhen } from "../backend/lib/email-message.js";

const OPTS = {
  recipient: "ana@example.com",
  unsubscribeUrl: "https://library-pulse.vercel.app/api/email?action=unsubscribe&token=abc.def",
  timezone: "Asia/Kolkata",
};

describe("buildPublishEmail", () => {
  it("names the file and publisher in the subject and body", () => {
    const m = buildPublishEmail(
      { file_name: "DS Core", file_key: "abc", triggered_by: { handle: "rajat" } },
      "abc",
      OPTS,
    );
    expect(m.subject).toBe("DS Core published by rajat");
    expect(m.html).toContain("DS Core");
    expect(m.html).toContain("rajat");
    expect(m.text).toContain("Published by: rajat");
  });

  it("escapes user-controlled text in the HTML and leaves the text version raw", () => {
    const m = buildPublishEmail(
      {
        file_name: "<b>x</b>",
        file_key: "k",
        description: "<script>alert(1)</script> review",
        created_components: [{ name: "<img src=x onerror=alert(1)> Button" }],
      },
      "k",
      { ...OPTS, note: "ping @design <now> & co" },
    );
    expect(m.html).not.toContain("<script>");
    expect(m.html).not.toContain("<img");
    expect(m.html).toContain("&lt;script&gt;");
    expect(m.html).toContain("&lt;img src=x onerror=alert(1)&gt; Button");
    expect(m.html).toContain("ping @design &lt;now&gt; &amp; co");
    expect(m.text).toContain("Team note: ping @design <now> & co");
  });

  it("renders every change category with counts and the '…and N more' tail", () => {
    const created = Array.from({ length: 30 }, (_, i) => ({ name: `Comp${i}` }));
    const m = buildPublishEmail(
      {
        file_name: "x",
        file_key: "k",
        created_components: created,
        modified_styles: [{ name: "Text/Body" }],
        deleted_variables: [{ name: "color/old" }],
      },
      "k",
      OPTS,
    );
    expect(m.html).toContain("Added (30)");
    expect(m.html).toContain("…and 10 more");
    expect(m.html).toContain("Modified (1)");
    expect(m.html).toContain("Removed (1)");
    expect(m.html).toContain("Variables / Tokens");
    expect(m.text).toContain("  Added (30):");
    expect(m.text).toContain("    ...and 10 more");
    expect(m.text).toContain("    - Text/Body");
    expect(m.text).toContain("Removed (1):");
  });

  it("nudges for a missing description and notes an empty payload", () => {
    const m = buildPublishEmail({ file_name: "x", file_key: "k" }, "k", OPTS);
    expect(m.html).toContain("No description provided");
    expect(m.html).toContain("No itemized changes were included");
    expect(m.text).toContain("Description: No description provided.");
  });

  it("shows the publish time in the saved timezone", () => {
    const m = buildPublishEmail(
      { file_name: "x", file_key: "k", timestamp: "2026-07-30T14:15:00Z" },
      "k",
      OPTS,
    );
    expect(m.html).toContain("30 Jul 2026, 19:45 Asia/Kolkata (GMT+5:30)");
    expect(m.text).toContain("When: 30 Jul 2026, 19:45 Asia/Kolkata (GMT+5:30)");
  });

  it("links to the file with an encoded key and carries the unsubscribe link in both parts", () => {
    const m = buildPublishEmail(
      { file_name: "x", file_key: "weird key/path" },
      "weird key/path",
      OPTS,
    );
    expect(m.html).toContain("https://www.figma.com/file/weird%20key%2Fpath");
    expect(m.text).toContain("Open in Figma: https://www.figma.com/file/weird%20key%2Fpath");
    expect(m.html).toContain(OPTS.unsubscribeUrl.replace(/&/g, "&amp;"));
    expect(m.text).toContain(`Unsubscribe: ${OPTS.unsubscribeUrl}`);
    expect(m.html).toContain("ana@example.com is on the notification list");
  });

  it("contains no Slack mention tokens or emoji", () => {
    const m = buildPublishEmail(
      { file_name: "x", file_key: "k", created_components: [{ name: "A" }] },
      "k",
      { ...OPTS, note: "hey @design-team" },
    );
    expect(m.html).not.toMatch(/<@|<!subteam|<!channel/);
    // No emoji: nothing in the Supplemental Symbols / Emoticons planes.
    const hasEmoji = Array.from(m.html).some((ch) => (ch.codePointAt(0) ?? 0) >= 0x1f300);
    expect(hasEmoji).toBe(false);
  });
});

describe("email HTML is well-formed for mail clients", () => {
  const publish = buildPublishEmail(
    {
      file_name: 'Quote "test" <x>',
      file_key: "k",
      description: "multi\nline",
      created_components: [{ name: 'A "quoted" name' }],
      deleted_styles: [{ name: "S" }],
    },
    "k",
    { ...OPTS, note: 'say "hi"' },
  );
  const confirm = buildConfirmEmail({
    fileName: 'Quote "test"',
    recipient: "ana@example.com",
    confirmUrl: "https://library-pulse.vercel.app/api/email?action=confirm&token=abc.def",
  });

  it.each([
    ["publish", publish.html],
    ["confirm", confirm.html],
  ])("%s: no attribute is cut short by a stray quote", (_name, html) => {
    // A double quote inside a style/href value ends the attribute early; what
    // follows then looks like `"Segoe UI"…` — a closing quote glued to text.
    const attrs = Array.from(html.matchAll(/\s(?:style|href)="([^"]*)"(.)/g));
    expect(attrs.length).toBeGreaterThan(5);
    for (const [, value, next] of attrs) {
      expect([" ", ">"], `attribute "${value}" is followed by ${JSON.stringify(next)}`).toContain(
        next,
      );
    }
  });

  it.each([
    ["publish", publish.html],
    ["confirm", confirm.html],
  ])("%s: every style declaration survives (fonts, colours, the button)", (_name, html) => {
    const styles = Array.from(html.matchAll(/style="([^"]*)"/g)).map((m) => String(m[1]));
    // Each inline style ends on a complete declaration.
    for (const s of styles) expect(s.trim()).toMatch(/[;a-z0-9)%']$/i);
    expect(styles.some((s) => s.includes("'Segoe UI'") && s.includes("sans-serif"))).toBe(true);
    expect(html).toMatch(/<a href="https:[^"]+" style="[^"]*background:#0969da[^"]*color:#ffffff/);
    expect(html).not.toContain('"Segoe UI"');
  });

  it("user-supplied double quotes are escaped, not emitted raw", () => {
    expect(publish.html).toContain("Quote &quot;test&quot; &lt;x&gt;");
    expect(publish.html).toContain("A &quot;quoted&quot; name");
    expect(publish.html).toContain("say &quot;hi&quot;");
    expect(publish.html).toContain("multi<br>line");
  });
});

describe("formatWhen", () => {
  it("falls back to UTC without a zone and to 'just now' without a timestamp", () => {
    expect(formatWhen("2026-07-30T14:15:00Z", null)).toBe("30 Jul 2026, 14:15 UTC");
    expect(formatWhen(undefined, "UTC")).toBe("just now");
    expect(formatWhen("not-a-date", "UTC")).toBe("just now");
  });
  it("survives an unknown zone", () => {
    expect(formatWhen("2026-07-30T14:15:00Z", "Mars/Phobos")).toBe("2026-07-30 14:15 UTC");
  });
});

describe("buildConfirmEmail", () => {
  it("names the file and address and carries the link in both parts", () => {
    const m = buildConfirmEmail({
      fileName: "DS <Core>",
      recipient: "ana@example.com",
      confirmUrl: "https://library-pulse.vercel.app/api/email?action=confirm&token=abc.def",
    });
    expect(m.subject).toBe("Confirm Library Pulse updates for DS <Core>");
    expect(m.html).toContain("DS &lt;Core&gt;");
    expect(m.html).not.toContain("DS <Core>");
    expect(m.html).toContain("ana@example.com");
    expect(m.html).toContain("Confirm address");
    expect(m.html).toContain("token=abc.def");
    expect(m.text).toContain(
      "Confirm: https://library-pulse.vercel.app/api/email?action=confirm&token=abc.def",
    );
    expect(m.text).toContain("expires in 7 days");
  });
});
