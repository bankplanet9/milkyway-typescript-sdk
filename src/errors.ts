/**
 * Error hierarchy for the MilkyWay Payments API.
 *
 * Every API error is a {@link MilkywayApiError} carrying the HTTP `statusCode`,
 * the server's `error` message and the same value as `errorCode` when the body
 * is structured JSON. Specific status codes map to dedicated subclasses so
 * callers can branch with `instanceof`.
 */

/** Base error for all failures returned by the MilkyWay Payments API. */
export class MilkywayApiError extends Error {
  /** HTTP status code returned by the API (0 if the request never completed). */
  readonly statusCode: number;

  /** Raw response body, useful for diagnostics when no structured error was parsed. */
  readonly responseBody?: string;

  /**
   * The request field at fault on a field-level 400, by its JSON name or path
   * (e.g. `amount_credit`, `sender_info.date_of_birth`). Absent otherwise.
   */
  readonly field?: string;

  /**
   * The `error` value of a structured `{ "error": "..." }` body, verbatim — e.g.
   * `ErrPaymentRejected`, `ErrRecipientBankError`, `ErrServiceUnavailable`.
   * Absent when the body was empty or not JSON.
   */
  readonly errorCode?: string;

  constructor(
    statusCode: number,
    message: string,
    options?: { responseBody?: string; cause?: unknown; field?: string },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.responseBody = options?.responseBody;
    this.field = options?.field;
    this.errorCode = extractErrorCode(options?.responseBody);
    // Restore prototype chain for instanceof across transpilation targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * HTTP 400 — request validation failed (bad amount, missing field, unresolvable FX rate).
 * `field` names the request field at fault when the server reports one.
 */
export class MilkywayValidationError extends MilkywayApiError {
  constructor(message: string, responseBody?: string, field?: string) {
    super(400, message, { responseBody, field });
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

/**
 * HTTP 422 (`ErrPaymentRejected`) — the recipient bank refused the payment on
 * its merits (e.g. a limit or a blocked account). The request was well formed,
 * but repeating it will not change the answer, so it is never retried. Nothing
 * was created or debited; the bank's own reason is not disclosed.
 */
export class MilkywayPaymentRejectedError extends MilkywayApiError {
  constructor(message: string, responseBody?: string) {
    super(422, message, { responseBody });
  }
}

/**
 * HTTP 5xx — the API or a downstream recipient service is unavailable.
 *
 * When the recipient bank's service could not price or take the payment (503),
 * the body names it: `serviceId` and `thirdPartyId` are set. Nothing was
 * created or debited; safe to retry once the service recovers.
 */
export class MilkywayServiceUnavailableError extends MilkywayApiError {
  /** The recipient service that failed (`service_id` in the body), when reported. */
  readonly serviceId?: string;

  /** The recipient institution that failed (`third_party_id` in the body), when reported. */
  readonly thirdPartyId?: string;

  constructor(statusCode: number, message: string, responseBody?: string) {
    super(statusCode, message, { responseBody });
    this.serviceId = extractStringProperty(responseBody, "service_id");
    this.thirdPartyId = extractStringProperty(responseBody, "third_party_id");
  }
}

/**
 * HTTP 502 (`ErrRecipientBankError`) — the recipient bank's connector failed in
 * a way MilkyWay could not classify. Nothing was created or debited. A
 * {@link MilkywayServiceUnavailableError}, so it is retried like any transient
 * 5xx and existing `instanceof MilkywayServiceUnavailableError` checks still
 * catch it; retry later or route the payment through another service.
 */
export class MilkywayRecipientBankError extends MilkywayServiceUnavailableError {
  constructor(message: string, responseBody?: string) {
    super(502, message, responseBody);
  }
}

/**
 * Maps an HTTP status + response body to the appropriate error subclass.
 * `400/401/402/404/422/502` map to their dedicated types; any other `>= 500` to
 * service-unavailable; everything else to the base {@link MilkywayApiError}.
 */
export function toApiError(status: number, body: string): MilkywayApiError {
  const message = extractErrorMessage(body) ?? `Request failed with status ${status}.`;
  switch (status) {
    case 400:
      return new MilkywayValidationError(message, body, extractErrorField(body));
    case 401:
      return new MilkywayAuthError(message, { responseBody: body });
    case 402:
      return new MilkywayExposureBlockedError(message, body);
    case 404:
      return new MilkywayNotFoundError(message, body);
    case 422:
      return new MilkywayPaymentRejectedError(message, body);
    case 502:
      return new MilkywayRecipientBankError(message, body);
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

/** Pulls the `field` of a structured `{ "error": "...", "field": "..." }` body. */
export function extractErrorField(body: string): string | undefined {
  return extractStringProperty(body, "field");
}

/** Pulls the `error` of a structured `{ "error": "..." }` body; never the raw text. */
function extractErrorCode(body: string | undefined): string | undefined {
  return extractStringProperty(body, "error");
}

function extractStringProperty(body: string | undefined, key: string): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === "object" && typeof parsed[key] === "string") {
      return parsed[key];
    }
  } catch {
    // Non-JSON body — no structured property.
  }
  return undefined;
}
