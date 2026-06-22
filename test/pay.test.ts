import { describe, expect, it } from "vitest";
import { MilkywayPaymentsClient } from "../src/index.js";
import { stubFetch, tokenResponse, baseOptions, type StubResponse } from "./support.js";

function client(responses: StubResponse[]) {
  const f = stubFetch([tokenResponse(), ...responses]);
  return { client: new MilkywayPaymentsClient(baseOptions(f.fetch)), calls: f.calls };
}

const payReq = {
  third_party_id_debit: "bank-beta",
  service_id: "card-payout",
  sender_id: "s-1",
  recipient_id: "r-1",
  amount_credit: 100,
  currency_credit: "USD",
};

describe("pay", () => {
  it("returns the transaction id", async () => {
    const { client: c } = client([{ status: 200, body: JSON.stringify({ transaction_id: 42 }) }]);
    expect(await c.pay(payReq, { idempotencyKey: "key-1" })).toBe(42);
  });

  it("passes the Idempotency-Key header", async () => {
    const { client: c, calls } = client([{ status: 200, body: JSON.stringify({ transaction_id: 1 }) }]);
    await c.pay(payReq, { idempotencyKey: "abc-123" });
    expect(calls.at(-1)!.headers["idempotency-key"]).toBe("abc-123");
  });

  it("retries on 5xx WHEN an idempotency key is present", async () => {
    const { client: c, calls } = client([
      { status: 503, body: "down" },
      { status: 200, body: JSON.stringify({ transaction_id: 9 }) },
    ]);
    expect(await c.pay(payReq, { idempotencyKey: "key-1" })).toBe(9);
    // token + 503 + retry success = 3
    expect(calls).toHaveLength(3);
  });

  it("does NOT retry when no idempotency key is supplied", async () => {
    const { client: c, calls } = client([
      { status: 503, body: "down" },
      { status: 200, body: JSON.stringify({ transaction_id: 9 }) },
    ]);
    await expect(c.pay(payReq)).rejects.toMatchObject({ statusCode: 503 });
    // token + ONE pay attempt only — no retry.
    expect(calls).toHaveLength(2);
  });

  it("sends amount_credit as an exact bare number", async () => {
    const { client: c, calls } = client([{ status: 200, body: JSON.stringify({ transaction_id: 1 }) }]);
    await c.pay({ ...payReq, amount_credit: "100.99" }, { idempotencyKey: "k" });
    expect(calls.at(-1)!.body).toContain('"amount_credit":100.99');
  });
});
