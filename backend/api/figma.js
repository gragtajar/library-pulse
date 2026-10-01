// @ts-check
/**
 * The Figma-side endpoints, one Function (lib/dispatch.js):
 *
 *   POST /api/figma/resolve-file  fn=resolve-file  lib/handlers/figma-resolve-file.js
 */
import { dispatch } from "../lib/dispatch.js";
import resolveFile from "../lib/handlers/figma-resolve-file.js";

export default dispatch({ "resolve-file": resolveFile });
