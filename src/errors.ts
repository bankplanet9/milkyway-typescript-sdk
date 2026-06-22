/**
 * Error hierarchy for the MilkyWay Payments API.
 *
 * Every API error is a {@link MilkywayApiError} carrying the HTTP `statusCode`
 * and the server's `error` message when present. Specific status codes map to
 * dedicated subclasses so callers can branch with `instanceof`.
 */

/** Base error for all failures returned by the MilkyWay Payments API. */
export class MilkywayApiError extends Error {
  /** HTTP status code returned by the API (0 if the request never completed). */
  readonly statusCode: number;

  /** Raw response body, useful for diagnostics when no structured error was parsed. */
  readonly responseBody?: string;

  constructor(
    statusCode: number,
    message: string,
    options?: { responseBody?: string; cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.responseBody = options?.responseBody;
    // Restore prototype chain for instanceof across transpilation targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** HTTP 400 — request validation failed (bad amount, missing field, unresolvable FX rate). */
export class MilkywayValidationError extends MilkywayApiError {
  constructor(message: string, responseBody?: string) {
    super(400, message, { responseBody });
  }
}

/** HTTP 401 — missing, malformed, or invalid access token (incl. failed token acquisition). */
export class MilkywayAuthError extends MilkywayApiError {
  constructor(message: string, options?: { responseBody?: string; cause?: unknown }) {
    super(401, message, options);
  }
}

/**
 * HTTP 402 — rejected because the payment would breach a block-action exposure
 * limit (effective limit = configured limit + funded deposit balance).
 */
export class MilkywayExposureBlockedError extends MilkywayApiError {
  constructor(message: string, responseBody?: string) {
    super(402, message, { responseBody });
  }
}

/** HTTP 404 — transaction not found, or not owned by your institution. */
export class MilkywayNotFoundError extends MilkywayApiError {
  constructor(message: string, responseBody?: string) {
    super(404, message, { responseBody });
  }
}

/** HTTP 5xx — the API or a downstream recipient service is unavailable. */
export class MilkywayServiceUnavailableError extends MilkywayApiError {
  constructor(statusCode: number, message: string, responseBody?: string) {
    super(statusCode, message, { responseBody });
  }
}

/**
 * Maps an HTTP status + response body to the appropriate error subclass.
 * `400/401/402/404` map to their dedicated types; `>= 500` to
 * service-unavailable; everything else to the base {@link MilkywayApiError}.
 */
export function toApiError(status: number, body: string): MilkywayApiError {
  const message = extractErrorMessage(body) ?? `Request failed with status ${status}.`;
  switch (status) {
    case 400:
      return new MilkywayValidationError(message, body);
    case 401:
      return new MilkywayAuthError(message, { responseBody: body });
    case 402:
      return new MilkywayExposureBlockedError(message, body);
    case 404:
      return new MilkywayNotFoundError(message, body);
    default:
      if (status >= 500) return new MilkywayServiceUnavailableError(status, message, body);
      return new MilkywayApiError(status, message, { responseBody: body });
  }
}

/**
 * Pulls a human-readable message out of an error body. Prefers the structured
 * `{ "error": "..." }` shape; falls back to the trimmed raw body for plain-text
 * responses (e.g. a 500 from healthcheck).
 */
export function extractErrorMessage(body: string): string | undefined {
  if (!body || body.trim().length === 0) return undefined;
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === "object" && typeof parsed.error === "string") {
      return parsed.error;
    }
    return undefined;
  } catch {
    // Non-JSON body — use it as-is.
    return body.trim();
  }
}
