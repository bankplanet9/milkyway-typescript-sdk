/** An injectable `fetch` implementation (defaults to the global `fetch`). */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Configuration for {@link MilkywayPaymentsClient}: API endpoint, Keycloak
 * client-credentials, and resilience tuning.
 */
export interface MilkywayOptions {
  /** Base URL of the Payments API, e.g. `https://milkyway.stage.planet9.ae`. */
  baseUrl: string;

  /**
   * Keycloak token endpoint for the client-credentials grant, e.g.
   * `https://keycloak.ac8o.planet9.ae/realms/planet9-stage/protocol/openid-connect/token`.
   */
  tokenUrl: string;

  /** Keycloak client id issued to your institution (becomes the `azp` claim). */
  clientId: string;

  /** Keycloak client secret issued to your institution. */
  clientSecret: string;

  /** Optional OAuth scope to request. */
  scope?: string;

  /**
   * How long before a token's stated expiry it is considered stale and
   * refreshed, in ms. Guards against clock skew and in-flight latency.
   * Default 30000 (30s).
   */
  tokenRefreshSkewMs?: number;

  /** Per-attempt request timeout, in ms. Default 30000 (30s). */
  requestTimeoutMs?: number;

  /** Maximum automatic retries for transient failures (5xx, 408, network). Default 3. */
  maxRetries?: number;

  /** Base delay for exponential backoff between retries, in ms. Default 500. */
  retryBaseDelayMs?: number;

  /** Injectable `fetch` (for testing). Defaults to the global `fetch`. */
  fetch?: FetchLike;
}

/** Fully-resolved options with defaults applied. */
export interface ResolvedOptions extends Required<Omit<MilkywayOptions, "scope" | "fetch">> {
  scope?: string;
  fetch: FetchLike;
}

const DEFAULTS = {
  tokenRefreshSkewMs: 30_000,
  requestTimeoutMs: 30_000,
  maxRetries: 3,
  retryBaseDelayMs: 500,
} as const;

/** Validates and applies defaults, throwing on missing required fields. */
export function resolveOptions(options: MilkywayOptions): ResolvedOptions {
  if (!options) throw new TypeError("options is required.");
  requireNonEmpty(options.baseUrl, "baseUrl");
  requireNonEmpty(options.tokenUrl, "tokenUrl");
  requireNonEmpty(options.clientId, "clientId");
  requireNonEmpty(options.clientSecret, "clientSecret");

  const maxRetries = options.maxRetries ?? DEFAULTS.maxRetries;
  if (maxRetries < 0) throw new RangeError("maxRetries cannot be negative.");

  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new TypeError(
      "No fetch implementation available. Provide options.fetch or run on Node 18+.",
    );
  }

  return {
    baseUrl: options.baseUrl,
    tokenUrl: options.tokenUrl,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    scope: options.scope,
    tokenRefreshSkewMs: options.tokenRefreshSkewMs ?? DEFAULTS.tokenRefreshSkewMs,
    requestTimeoutMs: options.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs,
    maxRetries,
    retryBaseDelayMs: options.retryBaseDelayMs ?? DEFAULTS.retryBaseDelayMs,
    fetch: fetchImpl,
  };
}

function requireNonEmpty(value: string | undefined, name: string): void {
  if (!value || value.trim().length === 0) {
    throw new TypeError(`${name} is required.`);
  }
}
