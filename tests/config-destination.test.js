// @ts-check
import { describe, it, expect } from "vitest";
import { planCreate, planUpdate } from "../backend/lib/config-destination.js";
import { ValidationError } from "../backend/lib/errors.js";

const NOW = "2026-09-28T10:00:00.000Z";
const CHANNELS = [{ id: "C0123456", name: "#design", is_private: false }];
const pending = (/** @type {string} */ email) => ({
  email,
  status: "pending",
  added_at: NOW,
  confirmed_at: null,
});
const confirmed = (/** @type {string} */ email) => ({
  email,
  status: "confirmed",
  added_at: NOW,
  confirmed_at: NOW,
});

describe("planCreate", () => {
  it("plans a Slack config exactly as before for a build that doesn't send destination", () => {
    const plan = planCreate({ slackTeamId: "T0123", channels: CHANNELS });
    expect(plan.destination).toBe("slack");
    // Only the columns older builds always wrote — safe on a pre-006 database.
    expect(plan.fields).toEqual({ slack_team_id: "T0123", channels: CHANNELS });
    expect(plan.addedEmails).toEqual([]);
  });

  it("writes the destination columns when the build names the destination", () => {
    const plan = planCreate({ destination: "slack", slackTeamId: "T0123", channels: CHANNELS });
    expect(plan.fields).toEqual({
      slack_team_id: "T0123",
      channels: CHANNELS,
      destination: "slack",
      email_recipients: [],
      email_timezone: null,
    });
  });

  it("keeps the Slack requirements", () => {
    expect(() => planCreate({ channels: CHANNELS })).toThrow(/Missing slackTeamId/);
    expect(() => planCreate({ slackTeamId: "T0123", channels: [] })).toThrow(ValidationError);
    expect(() => planCreate({ slackTeamId: "T0123" })).toThrow(ValidationError);
  });

  it("plans an email config with every address pending", () => {
    const plan = planCreate(
      {
        destination: "email",
        emailRecipients: ["Ana@Example.com", "ben@example.com"],
        timezone: "Asia/Kolkata",
      },
      NOW,
    );
    expect(plan.destination).toBe("email");
    expect(plan.fields).toEqual({
      destination: "email",
      slack_team_id: null,
      channels: [],
      email_recipients: [pending("ana@example.com"), pending("ben@example.com")],
      email_timezone: "Asia/Kolkata",
    });
    expect(plan.addedEmails).toEqual(["ana@example.com", "ben@example.com"]);
  });

  it("requires addresses and a timezone for email", () => {
    expect(() => planCreate({ destination: "email", timezone: "UTC" })).toThrow(ValidationError);
    expect(() => planCreate({ destination: "email", emailRecipients: ["a@x.io"] })).toThrow(
      /timezone/i,
    );
    expect(() =>
      planCreate({ destination: "email", emailRecipients: ["nope"], timezone: "UTC" }),
    ).toThrow(/Invalid email address/);
  });

  it("rejects an unknown destination", () => {
    expect(() => planCreate({ destination: "teams" })).toThrow(/Destination/);
  });
});

describe("planUpdate — staying on Slack", () => {
  const existing = { destination: "slack" };

  it("updates only what the request mentions", () => {
    expect(planUpdate({ channels: CHANNELS }, existing).fields).toEqual({ channels: CHANNELS });
    expect(planUpdate({ slackTeamId: "T9" }, existing).fields).toEqual({ slack_team_id: "T9" });
    expect(planUpdate({ isActive: false }, existing).fields).toEqual({});
  });

  it("treats a row without the column (pre-006 database) as Slack", () => {
    const plan = planUpdate({ channels: CHANNELS }, {});
    expect(plan.destination).toBe("slack");
    expect(plan.fields).toEqual({ channels: CHANNELS });
  });

  it("ignores email fields sent without a destination switch", () => {
    const plan = planUpdate({ emailRecipients: ["a@x.io"], timezone: "UTC" }, existing);
    expect(plan.fields).toEqual({});
    expect(plan.addedEmails).toEqual([]);
  });
});

describe("planUpdate — staying on email", () => {
  const existing = {
    destination: "email",
    email_recipients: [confirmed("ana@example.com"), pending("ben@example.com")],
  };

  it("keeps confirmation state for retained addresses and confirms only new ones", () => {
    const plan = planUpdate(
      { emailRecipients: ["ana@example.com", "cho@example.com"] },
      existing,
      NOW,
    );
    expect(plan.fields).toEqual({
      email_recipients: [confirmed("ana@example.com"), pending("cho@example.com")],
    });
    expect(plan.addedEmails).toEqual(["cho@example.com"]);
  });

  it("updates the timezone on its own", () => {
    expect(planUpdate({ timezone: "Europe/London" }, existing).fields).toEqual({
      email_timezone: "Europe/London",
    });
  });

  it("leaves everything alone for an unrelated edit (pause, note)", () => {
    const plan = planUpdate({ isActive: false, customMessage: "hi" }, existing);
    expect(plan.destination).toBe("email");
    expect(plan.fields).toEqual({});
  });

  it("tells an older build why it can't edit an email config", () => {
    expect(() => planUpdate({ channels: CHANNELS }, existing)).toThrow(
      /Update the Library Pulse plugin/,
    );
  });
});

describe("planUpdate — switching destination", () => {
  it("Slack → email needs addresses and a timezone, and clears the Slack side", () => {
    const plan = planUpdate(
      { destination: "email", emailRecipients: ["ana@example.com"], timezone: "Asia/Kolkata" },
      { destination: "slack", email_recipients: [] },
      NOW,
    );
    expect(plan.destination).toBe("email");
    expect(plan.fields).toEqual({
      destination: "email",
      slack_team_id: null,
      channels: [],
      custom_mentions: [],
      email_recipients: [pending("ana@example.com")],
      email_timezone: "Asia/Kolkata",
      delivery_status: "ok",
      last_delivery_error: null,
    });
    expect(plan.addedEmails).toEqual(["ana@example.com"]);

    expect(() => planUpdate({ destination: "email" }, { destination: "slack" })).toThrow(
      ValidationError,
    );
    expect(() =>
      planUpdate({ destination: "email", emailRecipients: ["a@x.io"] }, { destination: "slack" }),
    ).toThrow(/timezone/i);
  });

  it("email → Slack needs a workspace and channels, and clears the email side", () => {
    const plan = planUpdate(
      { destination: "slack", slackTeamId: "T0123", channels: CHANNELS },
      { destination: "email", email_recipients: [confirmed("ana@example.com")] },
    );
    expect(plan.destination).toBe("slack");
    expect(plan.fields).toEqual({
      destination: "slack",
      slack_team_id: "T0123",
      channels: CHANNELS,
      email_recipients: [],
      email_timezone: null,
      delivery_status: "ok",
      last_delivery_error: null,
    });
    expect(plan.addedEmails).toEqual([]);

    expect(() =>
      planUpdate({ destination: "slack", channels: CHANNELS }, { destination: "email" }),
    ).toThrow(/Missing slackTeamId/);
    expect(() =>
      planUpdate({ destination: "slack", slackTeamId: "T0123" }, { destination: "email" }),
    ).toThrow(ValidationError);
  });

  it("a previously confirmed address must confirm again after a round trip through Slack", () => {
    const toSlack = planUpdate(
      { destination: "slack", slackTeamId: "T0123", channels: CHANNELS },
      { destination: "email", email_recipients: [confirmed("ana@example.com")] },
    );
    const back = planUpdate(
      { destination: "email", emailRecipients: ["ana@example.com"], timezone: "UTC" },
      { destination: "slack", email_recipients: toSlack.fields.email_recipients },
      NOW,
    );
    expect(back.fields.email_recipients).toEqual([pending("ana@example.com")]);
    expect(back.addedEmails).toEqual(["ana@example.com"]);
  });
});
