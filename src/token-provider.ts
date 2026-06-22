import { MilkywayAuthError } from "./errors.js";
import type { FetchLike, ResolvedOptions } from "./options.js";

interface TokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
}

/**
 * Acquires access tokens via the Keycloak client-credentials grant and caches
 * them until shortly before expiry. Concurrent callers share a single in-flight
 * acquisition (single-flight via a shared Promise) so a burst of requests
 * triggers at most one token fetch.
 *
 * The fetch used here is a plain `fetch` that does NOT route through the SDK's
 * auth/retry pipeline — avoiding recursion and unwanted retries on the token
 * endpoint.
 */
export class KeycloakTokenProvider {
  private readonly options: ResolvedOptions;
  private readonly fetchImpl: FetchLike;

  private cachedToken: string | null = null;
  private expiresAtMs = 0;
  private inflight: Promise<string> | null = null;

  /** Clock seam for tests. Defaults to `Date.now`. */
  now: () => number = () => Date.now();

  constructor(options: ResolvedOptions) {
    this.options = options;
    this.fetchImpl = options.fetch;
  }

  /**
   * Returns a valid access token, fetching one if the cache is empty/stale.
   * `forceRefresh` bypasses the cache (used on a 401 replay).
   */
  async getAccessToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh) {
      const cached = this.tryGetCached();
      if (cached) return cached;
    } else {
      // Invalidate so concurrent non-forced callers don't read a stale token.
      this.cachedToken = null;
    }

    // Single-flight: collapse concurrent acquisitions onto one Promise.
    if (this.inflight) return this.inflight;

    this.inflight = this.acquire().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private tryGetCached(): string | null {
    if (this.cachedToken && this.now() < this.expiresAtMs - this.options.tokenRefreshSkewMs) {
      return this.cachedToken;
    }
    return null;
  }

  private async acquire(): Promise<string> {
    const form = new URLSearchParams();
    form.set("grant_type", "client_credentials");
    form.set("client_id", this.options.clientId);
    form.set("client_secret", this.options.clientSecret);
    if (this.options.scope && this.options.scope.trim().length > 0) {
      form.set("scope", this.options.scope);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(this.options.tokenUrl, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: form.toString(),
      });
    } catch (err) {
      throw new MilkywayAuthError("Failed to reach the Keycloak token endpoint.", { cause: err });
    }

    const body = await response.text();
    if (!response.ok) {
      throw new MilkywayAuthError(`Token acquisition failed with status ${response.status}.`, {
        responseBody: body,
      });
    }

    let parsed: TokenResponse;
    try {
      parsed = JSON.parse(body) as TokenResponse;
    } catch (err) {
      throw new MilkywayAuthError("Token endpoint returned a malformed response.", {
        responseBody: body,
        cause: err,
      });
    }

    if (!parsed.access_token) {
      throw new MilkywayAuthError("Token endpoint response contained no access_token.", {
        responseBody: body,
      });
    }

    const expiresInSec = typeof parsed.expires_in === "number" ? parsed.expires_in : 0;
    this.cachedToken = parsed.access_token;
    this.expiresAtMs = this.now() + expiresInSec * 1000;
    return this.cachedToken;
  }
}
