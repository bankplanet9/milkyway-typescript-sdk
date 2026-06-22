import { describe, expect, it } from "vitest";
import { MilkywayPaymentsClient, MilkywayValidationError } from "../src/index.js";
import { HttpTransport } from "../src/http.js";
import { resolveOptions } from "../src/options.js";
import { stubFetch, tokenResponse, baseOptions, type StubResponse } from "./support.js";

function transport(responses: StubResponse[], overrides = {}) {
  const f = stubFetch([tokenResponse(), ...responses]);
  const t = new HttpTransport(resolveOptions(baseOptions(f.fetch, overrides)));
  // Make backoff instant and deterministic.
  t.sleep = async () => {};
  t.random = () => 0.5;
  return { transport: t, calls: f.calls };
}

describe("retry behaviour", () => {
  it("retries 5xx up to maxRetries then surfaces the result", async () => {
    const { transport: t, calls } = transport(
      [
        { status: 500, body: "1" },
        { status: 500, body: "2" },
        { status: 500, body: "3" },
        { status: 500, body: "4" },
      ],
      { maxRetries: 3 },
    );
    const r = await t.send({ method: "GET", path: "payments/v1/postcheck?transaction_id=1" });
    expect(r.status).toBe(500);
    // token + 4 attempts (1 + 3 retries)
    expect(calls).toHaveLength(5);
  });

  it("retries 408", async () => {
    const { transport: t, calls } = transport([
      { status: 408, body: "" },
      { status: 200, body: "{}" },
    ]);
    const r = await t.send({ method: "GET", path: "payments/v1/postcheck?transaction_id=1" });
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(3); // token + 408 + success
  });

  it("retries network failures", async () => {
    const { transport: t, calls } = transport([
      { throw: new TypeError("fetch failed") },
      { status: 200, body: "{}" },
    ]);
    const r = await t.send({ method: "GET", path: "payments/v1/postcheck?transaction_id=1" });
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(3);
  });

  it("never retries a 400", async () => {
    const f = stubFetch([tokenResponse(), { status: 400, body: JSON.stringify({ error: "bad" }) }]);
    const c = new MilkywayPaymentsClient(baseOptions(f.fetch));
    await expect(c.postcheck(1)).rejects.toBeInstanceOf(MilkywayValidationError);
    expect(f.calls).toHaveLength(2); // token + one attempt
  });

  it("does not retry when suppressRetry is set", async () => {
    const { transport: t, calls } = transport([
      { status: 500, body: "1" },
      { status: 200, body: "{}" },
    ]);
    const r = await t.send({
      method: "POST",
      path: "payments/v1",
      jsonBody: "{}",
      suppressRetry: true,
    });
    expect(r.status).toBe(500);
    expect(calls).toHaveLength(2); // token + one attempt
  });
});

describe("401 refresh-replay", () => {
  it("force-refreshes the token and replays once on a 401", async () => {
    const f = stubFetch([
      tokenResponse("tok-1"),
      { status: 401, body: JSON.stringify({ error: "expired" }) },
      tokenResponse("tok-2"),
      { status: 200, body: JSON.stringify({ transaction_id: 5, status: 1 }) },
    ]);
    const c = new MilkywayPaymentsClient(baseOptions(f.fetch));
    const r = await c.postcheck(5);
    expect(r.status).toBe(1);
    // first token, 401 attempt (Bearer tok-1), token refresh, replay (Bearer tok-2)
    expect(f.calls).toHaveLength(4);
    expect(f.calls[1]!.headers["authorization"]).toBe("Bearer tok-1");
    expect(f.calls[3]!.headers["authorization"]).toBe("Bearer tok-2");
  });

  it("surfaces a 401 that persists after the single replay", async () => {
    const f = stubFetch([
      tokenResponse("tok-1"),
      { status: 401, body: JSON.stringify({ error: "expired" }) },
      tokenResponse("tok-2"),
      { status: 401, body: JSON.stringify({ error: "still bad" }) },
    ]);
    const c = new MilkywayPaymentsClient(baseOptions(f.fetch));
    await expect(c.postcheck(5)).rejects.toMatchObject({ statusCode: 401 });
    // Exactly one replay — no infinite loop.
    expect(f.calls).toHaveLength(4);
  });
});

describe("cancellation", () => {
  it("propagates a caller AbortSignal without retrying", async () => {
    const controller = new AbortController();
    const f = stubFetch([tokenResponse(), { throw: new DOMException("Aborted", "AbortError") }]);
    const c = new MilkywayPaymentsClient(baseOptions(f.fetch));
    controller.abort();
    await expect(c.postcheck(1, { signal: controller.signal })).rejects.toBeTruthy();
  });
});
