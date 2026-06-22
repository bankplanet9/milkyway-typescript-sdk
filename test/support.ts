import { vi } from "vitest";
import type { FetchLike, MilkywayOptions } from "../src/index.js";

export interface StubResponse {
  status?: number;
  body?: string;
  /** Throw this instead of returning a response (simulates a network failure). */
  throw?: unknown;
}

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/**
 * A scripted fetch: each call shifts the next response off the queue. When the
 * queue is exhausted the last response repeats. Records every request.
 */
export function stubFetch(responses: StubResponse[]): {
  fetch: FetchLike;
  calls: RecordedRequest[];
} {
  const calls: RecordedRequest[] = [];
  let idx = 0;

  const fetch: FetchLike = vi.fn(async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers as Record<string, string> | undefined;
    if (rawHeaders) {
      for (const [k, v] of Object.entries(rawHeaders)) headers[k.toLowerCase()] = v;
    }
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    });

    // Respect aborts so cancellation tests behave like real fetch.
    if (init?.signal?.aborted) {
      throw init.signal.reason ?? new DOMException("Aborted", "AbortError");
    }

    const spec = responses[Math.min(idx, responses.length - 1)] ?? { status: 200, body: "{}" };
    idx++;
    if (spec.throw) throw spec.throw;
    return new Response(spec.body ?? "", {
      status: spec.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });

  return { fetch, calls };
}

/** A successful Keycloak token response. */
export function tokenResponse(token = "test-token", expiresIn = 300): StubResponse {
  return { status: 200, body: JSON.stringify({ access_token: token, expires_in: expiresIn }) };
}

export function baseOptions(fetch: FetchLike, overrides: Partial<MilkywayOptions> = {}): MilkywayOptions {
  return {
    baseUrl: "https://api.example.test",
    tokenUrl: "https://kc.example.test/token",
    clientId: "client-1",
    clientSecret: "secret-1",
    fetch,
    retryBaseDelayMs: 1,
    ...overrides,
  };
}
