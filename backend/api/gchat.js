// @ts-check
/**
 * The Google Chat destination, one Function (lib/dispatch.js):
 *
 *   POST /api/gchat/start     fn=start     lib/handlers/gchat-start.js
 *   GET  /api/gchat/callback  fn=callback  lib/handlers/gchat-callback.js
 *   GET  /api/gchat/spaces    fn=spaces    lib/handlers/gchat-spaces.js
 *   POST /api/gchat/events    fn=events    lib/handlers/gchat-events.js
 */
import { dispatch } from "../lib/dispatch.js";
import start from "../lib/handlers/gchat-start.js";
import callback from "../lib/handlers/gchat-callback.js";
import spaces from "../lib/handlers/gchat-spaces.js";
import events from "../lib/handlers/gchat-events.js";

export default dispatch({ start, callback, spaces, events });
