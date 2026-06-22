import { MilkywayApiError } from "./errors.js";
import type { FetchLike, ResolvedOptions } from "./options.js";
import { KeycloakTokenProvider } from "./token-provider.js";

/** A completed HTTP exchange: status + already-read text body. */
export interface HttpResult {
  status: number;
  body: string;
}

export interface RequestSpec {
  method: string;
  /** Path relative to the base URL (no leading slash needed). */
  path: string;
  /** Serialised JSON body, if any. */
  jsonBody?: string;
  /** Extra headers (e.g. Idempotency-Key). */
  headers?: Record<string, string>;
  /** Caller-supplied cancellation signal. */
  signal?: AbortSignal;
  /**
   * When true, the request is sent exactly once (no retries) — used for `pay`
   * without an Idempotency-Key, where a retry could duplicate a payment.
   */
  suppressRetry?: boolean;
}

/**
 * Thrown internally to flag a transient failure (network/timeout). Carries no
 * public meaning — it is converted by the retry loop or surfaced as a generic
 * {@link MilkywayApiError} when retries are exhausted.
 */
class TransientError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
  }
}

/**
 * The HTTP transport: attaches a bearer token, applies a per-attempt timeout
 * via {@link AbortSignal}, retries transient failures (5xx, 408, network) with
 * exponential backoff + jitter, and performs a single force-refresh + replay on
 * a 401.
 *
 * Deterministic outcomes (400/401-after-replay/402/404) are never retried.
 */
export class HttpTransport {
  private readonly options: ResolvedOptions;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;

  /** Test seam for sleeps; defaults to a real timer. */
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  /** Test seam for jitter; defaults to `Math.random`. */
  random: () => number = () => Math.random();

  constructor(
    options: ResolvedOptions,
    readonly tokenProvider: KeycloakTokenProvider = new KeycloakTokenProvider(options),
  ) {
    this.options = options;
    this.fetchImpl = options.fetch;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
  }

  async send(spec: RequestSpec): Promise<HttpResult> {
    const maxAttempts = spec.suppressRetry ? 1 : this.options.maxRetries + 1;
    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const result = await this.attemptWithAuth(spec);
        if (this.isTransientStatus(result.status) && attempt < maxAttempts - 1) {
          lastError = new MilkywayApiError(result.status, `Transient ${result.status}.`, {
            responseBody: result.body,
          });
          await this.backoff(attempt);
          continue;
        }
        return result;
      } catch (err) {
        if (err instanceof TransientError && attempt < maxAttempts - 1) {
          lastError = err;
          await this.backoff(attempt);
          continue;
        }
        throw err;
      }
    }

    // Exhausted retries on a transient outcome.
    if (lastError instanceof MilkywayApiError) return { status: lastError.statusCode, body: lastError.responseBody ?? "" };
    throw new MilkywayApiError(0, "Request failed after retries.", { cause: lastError });
  }

  /** One logical request: attach token, send; on 401 refresh once and replay. */
  private async attemptWithAuth(spec: RequestSpec): Promise<HttpResult> {
    const token = await this.tokenProvider.getAccessToken(false);
    const result = await this.attempt(spec, token);
    if (result.status !== 401) return result;

    const fresh = await this.tokenProvider.getAccessToken(true);
    return this.attempt(spec, fresh);
  }

  /** A single network attempt with a per-attempt timeout. */
  private async attempt(spec: RequestSpec, token: string): Promise<HttpResult> {
    const url = `${this.baseUrl}/${spec.path.replace(/^\/+/, "")}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...spec.headers,
    };
    if (spec.jsonBody !== undefined) headers["content-type"] = "application/json";

    const controller = new AbortController();
    const onAbort = () => controller.abort((spec.signal as AbortSignal).reason);
    if (spec.signal) {
      if (spec.signal.aborted) controller.abort(spec.signal.reason);
      else spec.signal.addEventListener("abort", onAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(new Error("Request timed out.")), this.options.requestTimeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        method: spec.method,
        headers,
        body: spec.jsonBody,
        signal: controller.signal,
      });
      const body = await response.text();
      return { status: response.status, body };
    } catch (err) {
      // A caller-initiated abort is propagated, not retried.
      if (spec.signal?.aborted) throw err;
      throw new TransientError("Network or timeout failure.", err);
    } finally {
      clearTimeout(timer);
      if (spec.signal) spec.signal.removeEventListener("abort", onAbort);
    }
  }

  private isTransientStatus(status: number): boolean {
    return status >= 500 || status === 408;
  }

  /** Exponential backoff with full jitter: delay ∈ [0, base * 2^attempt]. */
  private async backoff(attempt: number): Promise<void> {
    const ceiling = this.options.retryBaseDelayMs * 2 ** attempt;
    const delay = this.random() * ceiling;
    await this.sleep(delay);
  }
}
