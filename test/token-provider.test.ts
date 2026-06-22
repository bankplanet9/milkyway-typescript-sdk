import { describe, expect, it } from "vitest";
import { KeycloakTokenProvider } from "../src/token-provider.js";
import { MilkywayAuthError } from "../src/index.js";
import { resolveOptions } from "../src/options.js";
import { stubFetch, tokenResponse, baseOptions } from "./support.js";

function provider(responses: ReturnType<typeof stubFetch>) {
  const opts = resolveOptions(baseOptions(responses.fetch));
  return new KeycloakTokenProvider(opts);
}

describe("KeycloakTokenProvider", () => {
  it("acquires and caches a token", async () => {
    const f = stubFetch([tokenResponse("tok-1", 300)]);
    const p = provider(f);

    expect(await p.getAccessToken()).toBe("tok-1");
    expect(await p.getAccessToken()).toBe("tok-1");
    // Only one network call — second read came from cache.
    expect(f.calls).toHaveLength(1);
  });

  it("sends the client-credentials form with scope when set", async () => {
    const f = stubFetch([tokenResponse()]);
    const opts = resolveOptions(baseOptions(f.fetch, { scope: "payments" }));
    const p = new KeycloakTokenProvider(opts);
    await p.getAccessToken();

    const body = f.calls[0]!.body!;
    expect(body).toContain("grant_type=client_credentials");
    expect(body).toContain("client_id=client-1");
    expect(body).toContain("client_secret=secret-1");
    expect(body).toContain("scope=payments");
  });

  it("refreshes shortly before expiry (skew)", async () => {
    const f = stubFetch([tokenResponse("tok-1", 300), tokenResponse("tok-2", 300)]);
    const opts = resolveOptions(baseOptions(f.fetch, { tokenRefreshSkewMs: 30_000 }));
    const p = new KeycloakTokenProvider(opts);
    let clock = 0;
    p.now = () => clock;

    expect(await p.getAccessToken()).toBe("tok-1");
    // Within validity window minus skew → still cached.
    clock = 269_000;
    expect(await p.getAccessToken()).toBe("tok-1");
    // Past (expiry - skew) → refresh.
    clock = 271_000;
    expect(await p.getAccessToken()).toBe("tok-2");
    expect(f.calls).toHaveLength(2);
  });

  it("force-refresh bypasses the cache", async () => {
    const f = stubFetch([tokenResponse("tok-1", 300), tokenResponse("tok-2", 300)]);
    const p = provider(f);
    expect(await p.getAccessToken()).toBe("tok-1");
    expect(await p.getAccessToken(true)).toBe("tok-2");
    expect(f.calls).toHaveLength(2);
  });

  it("single-flights concurrent acquisitions", async () => {
    const f = stubFetch([tokenResponse("tok-1", 300)]);
    const p = provider(f);
    const [a, b, c] = await Promise.all([
      p.getAccessToken(),
      p.getAccessToken(),
      p.getAccessToken(),
    ]);
    expect([a, b, c]).toEqual(["tok-1", "tok-1", "tok-1"]);
    // Three concurrent callers, ONE token fetch.
    expect(f.calls).toHaveLength(1);
  });

  it("throws MilkywayAuthError on non-2xx token response", async () => {
    const f = stubFetch([{ status: 401, body: "nope" }]);
    const p = provider(f);
    await expect(p.getAccessToken()).rejects.toBeInstanceOf(MilkywayAuthError);
  });

  it("throws MilkywayAuthError on network failure", async () => {
    const f = stubFetch([{ throw: new Error("ECONNREFUSED") }]);
    const p = provider(f);
    await expect(p.getAccessToken()).rejects.toBeInstanceOf(MilkywayAuthError);
  });

  it("throws when response has no access_token", async () => {
    const f = stubFetch([{ status: 200, body: JSON.stringify({ expires_in: 10 }) }]);
    const p = provider(f);
    await expect(p.getAccessToken()).rejects.toThrow(/no access_token/);
  });

  it("does not retry the token endpoint", async () => {
    // Even with a 500, the token fetch is a single attempt (no retry pipeline).
    const f = stubFetch([{ status: 500, body: "boom" }]);
    const p = provider(f);
    await expect(p.getAccessToken()).rejects.toBeInstanceOf(MilkywayAuthError);
    expect(f.calls).toHaveLength(1);
  });
});
