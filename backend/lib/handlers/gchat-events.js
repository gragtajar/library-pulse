// @ts-check
/**
 * POST /api/gchat/events — Google Chat calls this for every interaction
 * with the Library Pulse app (added to a space, removed, @mentioned). The
 * request is verified first (lib/gchat-events.js), then answered within
 * Chat's 30-second window with a `Message` or `{}`.
 *
 * Server-to-server: no CORS. A GET answers 200 so the URL can be checked in a
 * browser.
 */
import { withErrorHandling } from "../http.js";
import { logger } from "../logger.js";
import { handleChatEvent, verifyChatRequest } from "../gchat-events.js";

export default withErrorHandling(
  /**
   * @param {import("../types.js").VercelRequest} req
   * @param {import("../types.js").VercelResponse} res
   */
  async function handler(req, res) {
    if (req.method === "GET") {
      return res.status(200).json({ status: "ok", service: "library-pulse-gchat" });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const auth = req.headers?.authorization;
    if (!(await verifyChatRequest(Array.isArray(auth) ? auth[0] : auth))) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const event = req.body ?? {};
    try {
      const reply = await handleChatEvent(event);
      return res.status(200).json(reply);
    } catch (err) {
      // Chat retries non-2xx deliveries a few times; a failure here is ours,
      // so log it and acknowledge rather than make Chat replay it.
      logger.error("gchat_event_failed", {
        type: typeof event?.type === "string" ? event.type : "",
        err,
      });
      return res.status(200).json({});
    }
  },
);
