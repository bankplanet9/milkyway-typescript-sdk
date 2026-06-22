import { describe, expect, it } from "vitest";
import {
  MilkywayPaymentsClient,
  TransactionStatus,
  isTerminal,
} from "../src/index.js";
import { resolveOptions } from "../src/options.js";
import { stubFetch, tokenResponse, baseOptions, type StubResponse } from "./support.js";

function client(responses: StubResponse[]) {
  const f = stubFetch([tokenResponse(), ...responses]);
  const c = new MilkywayPaymentsClient(baseOptions(f.fetch));
  // Speed up waitForCompletion sleeps by stubbing the private sleep via prototype.
  (c as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async () => {};
  return { client: c, calls: f.calls };
}

describe("isTerminal", () => {
  it("classifies terminal vs non-terminal", () => {
    expect(isTerminal(TransactionStatus.Pending)).toBe(false);
    expect(isTerminal(TransactionStatus.CancelPending)).toBe(false);
    expect(isTerminal(TransactionStatus.Done)).toBe(true);
    expect(isTerminal(TransactionStatus.Cancelled)).toBe(true);
    expect(isTerminal(TransactionStatus.Failed)).toBe(true);
    expect(isTerminal(TransactionStatus.Stuck)).toBe(true);
  });
});

describe("waitForCompletion", () => {
  it("polls until a terminal status", async () => {
    const { client: c } = client([
      { status: 200, body: JSON.stringify({ transaction_id: 1, status: 0 }) },
      { status: 200, body: JSON.stringify({ transaction_id: 1, status: 0 }) },
      { status: 200, body: JSON.stringify({ transaction_id: 1, status: 1 }) },
    ]);
    const r = await c.waitForCompletion(1, { initialDelayMs: 1, maxDelayMs: 1 });
    expect(r.status).toBe(TransactionStatus.Done);
  });

  it("returns the last status when the budget is exhausted", async () => {
    const { client: c } = client([
      { status: 200, body: JSON.stringify({ transaction_id: 1, status: 0 }) },
    ]);
    const r = await c.waitForCompletion(1, {
      initialDelayMs: 10_000,
      timeoutMs: 1, // immediately over budget after the first poll
    });
    expect(r.status).toBe(TransactionStatus.Pending);
  });

  it("returns immediately if already terminal", async () => {
    const { client: c, calls } = client([
      { status: 200, body: JSON.stringify({ transaction_id: 1, status: 1 }) },
    ]);
    const r = await c.waitForCompletion(1);
    expect(r.status).toBe(TransactionStatus.Done);
    // token + a single postcheck.
    expect(calls).toHaveLength(2);
  });
});

describe("options validation", () => {
  it("rejects missing required fields", () => {
    expect(() => resolveOptions({ baseUrl: "", tokenUrl: "t", clientId: "c", clientSecret: "s" })).toThrow();
    expect(() => resolveOptions({ baseUrl: "b", tokenUrl: "", clientId: "c", clientSecret: "s" })).toThrow();
  });

  it("rejects negative maxRetries", () => {
    const f = stubFetch([tokenResponse()]);
    expect(() => resolveOptions(baseOptions(f.fetch, { maxRetries: -1 }))).toThrow(RangeError);
  });

  it("applies defaults", () => {
    const f = stubFetch([tokenResponse()]);
    const o = resolveOptions(baseOptions(f.fetch, { retryBaseDelayMs: undefined }));
    expect(o.maxRetries).toBe(3);
    expect(o.requestTimeoutMs).toBe(30_000);
    expect(o.tokenRefreshSkewMs).toBe(30_000);
  });
});
