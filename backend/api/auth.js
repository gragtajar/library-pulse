// @ts-check
/**
 * The OAuth endpoints, one Function (lib/dispatch.js):
 *
 *   POST /api/auth/figma           fn=figma-start     lib/handlers/auth-figma-start.js
 *   GET  /api/auth/figma-callback  fn=figma-callback  lib/handlers/auth-figma-callback.js
 *   POST /api/auth/slack           fn=slack-start     lib/handlers/auth-slack-start.js
 *   GET  /api/auth/slack-callback  fn=slack-callback  lib/handlers/auth-slack-callback.js
 *   GET  /api/auth-status          fn=status          lib/handlers/auth-status.js
 */
import { dispatch } from "../lib/dispatch.js";
import figmaStart from "../lib/handlers/auth-figma-start.js";
import figmaCallback from "../lib/handlers/auth-figma-callback.js";
import slackStart from "../lib/handlers/auth-slack-start.js";
import slackCallback from "../lib/handlers/auth-slack-callback.js";
import status from "../lib/handlers/auth-status.js";

export default dispatch({
  "figma-start": figmaStart,
  "figma-callback": figmaCallback,
  "slack-start": slackStart,
  "slack-callback": slackCallback,
  status,
});
