// @ts-check
/**
 * Custom error hierarchy for Library Pulse. Per v2 §T5 — every error path
 * has a typed class so handlers can map exceptions → HTTP status without
 * leaking internal details.
 */

export class LibraryPulseError extends Error {
  /** HTTP status this error should map to. */
  status = 500;
  /** Public-safe message. `message` may contain internal context. */
  publicMessage = "Internal error";

  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class ValidationError extends LibraryPulseError {
  status = 400;
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.publicMessage = message;
  }
}

export class AuthError extends LibraryPulseError {
  status = 401;
  publicMessage = "Authentication required";
}

export class ForbiddenError extends LibraryPulseError {
  status = 403;
  publicMessage = "Forbidden";
}

export class NotFoundError extends LibraryPulseError {
  status = 404;
  publicMessage = "Not found";
}

export class UpstreamError extends LibraryPulseError {
  status = 502;
  publicMessage = "Upstream service error";
}

/**
 * Map any thrown value to a `{ status, body }` shape safe to send to the
 * client. Internal messages are logged server-side; only `publicMessage`
 * is returned.
 *
 * @param {unknown} err
 * @returns {{ status: number, body: { error: string, code?: string } }}
 */
export function errorToResponse(err) {
  if (err instanceof LibraryPulseError) {
    return { status: err.status, body: { error: err.publicMessage, code: err.name } };
  }
  return { status: 500, body: { error: "Internal error" } };
}
