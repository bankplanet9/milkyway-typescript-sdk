import { describe, expect, it } from "vitest";
import {
  MilkywayApiError,
  MilkywayPaymentRejectedError,
  MilkywayPaymentsClient,
  MilkywayRecipientBankError,
  MilkywayServiceUnavailableError,
  MilkywayValidationError,
  StatusReason,
  TransactionStatus,
} from "../src/index.js";
import { stubFetch, tokenResponse, baseOptions, type StubResponse } from "./support.js";

function client(responses: StubResponse[]) {
  const f = stubFetch([tokenResponse(), ...responses]);
  return { client: new MilkywayPaymentsClient(baseOptions(f.fetch)), calls: f.calls };
}

const payReq = {
  third_party_id_debit: "bank-beta",
  service_id: "card",
  sender_id: "s-1",
  recipient_id: "r-1",
  amount_credit: 100,
  currency_credit: "USD",
};

const rejected: StubResponse = { status: 422, body: JSON.stringify({ error: "ErrPaymentRejected" }) };
const bankError: StubResponse = { status: 502, body: JSON.stringify({ error: "ErrRecipientBankError" }) };
const unavailable: StubResponse = {
  status: 503,
  body: JSON.stringify({ error: "ErrServiceUnavailable", service_id: "wallet", third_party_id: "recipient-bank" }),
};

describe("422 payment rejected", () => {
  it("maps precheck to MilkywayPaymentRejectedError without retrying", async () => {
    const { client: c, calls } = client([rejected]);
    const err = await c.precheck(payReq).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MilkywayPaymentRejectedError);
    expect(err).toBeInstanceOf(MilkywayApiError);
    expect(err).toMatchObject({ statusCode: 422, errorCode: "ErrPaymentRejected", message: "ErrPaymentRejected" });
    expect(calls).toHaveLength(2); // token + one attempt
  });

  it("is never retried on pay, even with an idempotency key", async () => {
    const { client: c, calls } = client([rejected, { status: 200, body: JSON.stringify({ transaction_id: 1 }) }]);
    await expect(c.pay(payReq, { idempotencyKey: "k-1" })).rejects.toBeInstanceOf(MilkywayPaymentRejectedError);
    expect(calls).toHaveLength(2);
  });
});

describe("502 recipient bank error", () => {
  it("is both a MilkywayRecipientBankError and a MilkywayServiceUnavailableError", async () => {
    const { client: c } = client([bankError]);
    const err = await c.precheck(payReq).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MilkywayRecipientBankError);
    expect(err).toBeInstanceOf(MilkywayServiceUnavailableError);
    expect(err).toMatchObject({ statusCode: 502, errorCode: "ErrRecipientBankError", name: "MilkywayRecipientBankError" });
  });

  it("is retried like any transient 5xx", async () => {
    const { client: c, calls } = client([bankError, { status: 200, body: JSON.stringify({ transaction_id: 7 }) }]);
    expect(await c.pay(payReq, { idempotencyKey: "k-1" })).toBe(7);
    expect(calls).toHaveLength(3); // token + 502 + retry success
  });

  it("is not retried on pay without an idempotency key", async () => {
    const { client: c, calls } = client([bankError, { status: 200, body: JSON.stringify({ transaction_id: 7 }) }]);
    await expect(c.pay(payReq)).rejects.toBeInstanceOf(MilkywayRecipientBankError);
    expect(calls).toHaveLength(2);
  });
});

describe("cancel", () => {
  it("maps a 503 to MilkywayServiceUnavailableError naming the failed service", async () => {
    const { client: c } = client([unavailable]);
    const err = await c.cancel(5).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MilkywayServiceUnavailableError);
    expect(err).not.toBeInstanceOf(MilkywayRecipientBankError);
    expect(err).toMatchObject({
      statusCode: 503,
      errorCode: "ErrServiceUnavailable",
      serviceId: "wallet",
      thirdPartyId: "recipient-bank",
    });
  });

  it("maps a 502 to MilkywayRecipientBankError", async () => {
    const { client: c } = client([bankError]);
    const err = await c.cancel(5).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MilkywayRecipientBankError);
    expect(err).toBeInstanceOf(MilkywayServiceUnavailableError);
  });
});

describe("400 field", () => {
  it.each(["recipient_id", "currency_credit"])("exposes field %s", async (field) => {
    const { client: c } = client([{ status: 400, body: JSON.stringify({ error: "ErrRecipientInvalid", field }) }]);
    const err = await c.precheck(payReq).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MilkywayValidationError);
    expect(err).toMatchObject({ field, errorCode: "ErrRecipientInvalid" });
  });
});

describe("errorCode", () => {
  it("is absent for a non-JSON body", async () => {
    const { client: c } = client([{ status: 503, body: "upstream down" }]);
    const err = (await c.postcheck(1).catch((e: unknown) => e)) as MilkywayServiceUnavailableError;
    expect(err.message).toBe("upstream down");
    expect(err.errorCode).toBeUndefined();
    expect(err.serviceId).toBeUndefined();
    expect(err.thirdPartyId).toBeUndefined();
  });
});

describe("StatusReason", () => {
  it("holds the postcheck reason codes", () => {
    expect(StatusReason).toEqual({
      PaymentRejected: "ErrPaymentRejected",
      RecipientNotFound: "ErrRecipientNotFound",
      RecipientInvalid: "ErrRecipientInvalid",
      ServiceUnavailable: "ErrServiceUnavailable",
      PaymentCannotBeCanceled: "ErrPaymentCannotBeCanceled",
    });
  });

  it("matches a failed postcheck's error, and an unknown code still arrives", async () => {
    const { client: c } = client([
      { status: 200, body: JSON.stringify({ transaction_id: 3, status: 3, error: "ErrRecipientNotFound" }) },
      { status: 200, body: JSON.stringify({ transaction_id: 4, status: 3, error: "ErrSomethingNew" }) },
    ]);
    const known = await c.postcheck(3);
    expect(known.status).toBe(TransactionStatus.Failed);
    expect(known.error).toBe(StatusReason.RecipientNotFound);
    expect((await c.postcheck(4)).error).toBe("ErrSomethingNew");
  });
});
