// @ts-check
/**
 * Slack OAuth scope constants — defined once, imported by the authorize
 * endpoint (api/auth/slack.js) and pinned by tests, so a scope some endpoint
 * depends on can never silently go missing from the authorize request again.
 *
 * That was the bug behind "@mentions are unavailable until Slack is
 * reconnected": /api/slack/mentions required users:read + usergroups:read,
 * but the authorize URL never requested them — Slack grants exactly what is
 * REQUESTED, so no amount of reconnecting could mint a token that worked.
 * (Ticking scopes in the Slack app dashboard changes the app's declared
 * config, not this URL.)
 *
 * NOTE: Slack's OAuth v2 `scope` param is COMMA-separated — unlike Figma's
 * space-separated param (lib/figma-oauth.js). Don't unify them.
 */

export const SLACK_OAUTH_SCOPES = [
  "chat:write", // post the notification message
  "chat:write.public", // post to public channels without inviting the bot
  "channels:read", // channel picker: list public channels
  "groups:read", // channel picker: private channels the bot was added to
  "users:read", // mention picker: list workspace members (users.list)
  "usergroups:read", // mention picker: list user groups (usergroups.list)
];

export const SLACK_OAUTH_SCOPE_PARAM = SLACK_OAUTH_SCOPES.join(",");
