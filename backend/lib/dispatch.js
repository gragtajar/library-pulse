// @ts-check
/**
 * One Vercel Function, several public URLs.
 *
 * Every file under `api/` is its own Function and the Hobby plan caps them
 * per deployment (tests/vercel-function-count.test.js), so related endpoints
 * share a file. `vercel.json` keeps every public path exactly as it was and
 * rewrites it to its Function with a `fn` query parameter naming the handler,
 * for example `/api/auth/figma` → `/api/auth.js?fn=figma-start`. The handler
 * is the same code it always was, now under lib/handlers/.
 *
 * `fn` decides only WHICH public endpoint runs; each of them is reachable on
 * its own anyway, so a caller who sets `fn` by hand gains nothing. A request
 * that carries two values (one from the rewrite, one of its own) is refused
 * rather than guessed at.
 */

/**
 * @typedef {(req: import("./types.js").VercelRequest, res: import("./types.js").VercelResponse) => unknown} Handler
 */

/**
 * @param {Record<string, Handler>} table handler per `fn` value
 * @returns {Handler & { handlers: string[] }}
 */
export function dispatch(table) {
  /** @type {Handler} */
  const handler = (req, res) => {
    const raw = req.query?.fn;
    if (Array.isArray(raw)) {
      return res.status(400).json({ error: "Ambiguous endpoint" });
    }
    const fn = typeof raw === "string" ? raw : "";
    const target = Object.hasOwn(table, fn) ? table[fn] : undefined;
    if (!target) {
      return res.status(404).json({ error: "Not found" });
    }
    return target(req, res);
  };
  return Object.assign(handler, { handlers: Object.keys(table) });
}
