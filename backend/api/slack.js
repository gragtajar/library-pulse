// @ts-check
/**
 * The Slack directory endpoints behind the plugin's pickers, one Function
 * (lib/dispatch.js):
 *
 *   GET /api/slack/channels  fn=channels  lib/handlers/slack-channels.js
 *   GET /api/slack/mentions  fn=mentions  lib/handlers/slack-mentions.js
 */
import { dispatch } from "../lib/dispatch.js";
import channels from "../lib/handlers/slack-channels.js";
import mentions from "../lib/handlers/slack-mentions.js";

export default dispatch({ channels, mentions });
