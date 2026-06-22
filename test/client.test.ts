import { describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import {
  MilkywayPaymentsClient,
  MilkywayAuthError,
  MilkywayExposureBlockedError,
  MilkywayNotFoundError,
  MilkywayServiceUnavailableError,
  MilkywayValidationError,
  TransactionStatus,
} from "../src/index.js";
import { stubFetch, tokenResponse, baseOptions, type StubResponse } from "./support.js";

function client(responses: StubResponse[], overrides = {}) {
  const f = stubFetch([tokenResponse(), ...responses]);
  return { client: new MilkywayPaymentsClient(baseOptions(f.fetch, overrides)), calls: f.calls };
}

describe("MilkywayPaymentsClient", () => {
  describe("healthcheck", () => {
    it("returns the plain-text status body", async () => {
      const { client: c, calls } = client([{ status: 200, body: "OK" }]);
      const result = await c.healthcheck("bank-beta", "card-payout");
      expect(result).toBe("OK");
      const url = calls.at(-1)!.url;
      expect(url).toContain("/payments/v1/healthcheck?third_party_id=bank-beta");
      expect(url).toContain("service_id=card-payout");
    });

    it("maps a 500 to service-unavailable", async () => {
      const { client: c } = client([
        { status: 500, body: "recipient down" },
        { status: 500, body: "recipient down" },
        { status: 500, body: "recipient down" },
        { status: 500, body: "recipient down" },
      ]);
      await expect(c.healthcheck("b", "s")).rejects.toBeInstanceOf(
        MilkywayServiceUnavailableError,
      );
    });
  });

  describe("precheck", () => {
    it("parses money fields as exact Decimals", async () => {
      // Hand-written raw JSON: a JS number literal here would already lose
      // precision at authoring time, defeating the point of the test.
      const body =
        '{"third_party_id":"bank-beta","service_id":"card-payout",' +
        '"recipient_id":"r-1","amount_credit":100.0,"currency_credit":"USD",' +
        '"amount_debit":9007199254740993.55,"currency_debit":"AED",' +
        '"rate":3.67250000001,"commission":1.5}';
      const { client: c } = client([{ status: 200, body }]);
      const result = await c.precheck({
        third_party_id_debit: "bank-beta",
        service_id: "card-payout",
        recipient_id: "r-1",
        amount_credit: 100,
        currency_credit: "USD",
      });
      expect(result.amount_credit).toBeInstanceOf(Decimal);
      expect(result.rate.toString()).toBe("3.67250000001");
      // Beyond float64 integer-precision; must survive exactly.
      expect(result.amount_debit.toFixed()).toBe("9007199254740993.55");
      expect(result.commission.equals(new Decimal("1.5"))).toBe(true);
    });

    it("serialises amount_credit as a bare JSON number, not a string", async () => {
      const { client: c, calls } = client([
        { status: 200, body: JSON.stringify({ amount_credit: 1, amount_debit: 1, rate: 1, commission: 0 }) },
      ]);
      await c.precheck({
        third_party_id_debit: "b",
        service_id: "s",
        recipient_id: "r",
        amount_credit: "100.25",
        currency_credit: "USD",
      });
      const sent = calls.at(-1)!.body!;
      expect(sent).toContain('"amount_credit":100.25');
      expect(sent).not.toContain('"amount_credit":"100.25"');
    });

    it("omits data when undefined", async () => {
      const { client: c, calls } = client([
        { status: 200, body: JSON.stringify({ amount_credit: 1, amount_debit: 1, rate: 1, commission: 0 }) },
      ]);
      await c.precheck({
        third_party_id_debit: "b",
        service_id: "s",
        recipient_id: "r",
        amount_credit: 1,
        currency_credit: "USD",
      });
      expect(calls.at(-1)!.body!).not.toContain("data");
    });
  });

  describe("error mapping", () => {
    const cases: Array<[number, any]> = [
      [400, MilkywayValidationError],
      [401, MilkywayAuthError],
      [402, MilkywayExposureBlockedError],
      [404, MilkywayNotFoundError],
    ];
    for (const [status, type] of cases) {
      it(`maps ${status} to ${type.name}`, async () => {
        // 401 needs two stubbed responses (refresh-replay) + a fresh token.
        const responses: StubResponse[] =
          status === 401
            ? [{ status, body: JSON.stringify({ error: "bad" }) }, tokenResponse("t2"), { status, body: JSON.stringify({ error: "bad" }) }]
            : [{ status, body: JSON.stringify({ error: "bad" }) }];
        const { client: c } = client(responses);
        const err = await c.postcheck(1).catch((e) => e);
        expect(err).toBeInstanceOf(type);
        expect(err.statusCode).toBe(status);
        expect(err.message).toBe("bad");
      });
    }

    it("does not retry a 402", async () => {
      const { client: c, calls } = client([{ status: 402, body: JSON.stringify({ error: "blocked" }) }]);
      await expect(c.postcheck(1)).rejects.toBeInstanceOf(MilkywayExposureBlockedError);
      // token + exactly one postcheck attempt.
      expect(calls).toHaveLength(2);
    });
  });

  describe("postcheck", () => {
    it("maps the status enum", async () => {
      const { client: c } = client([
        { status: 200, body: JSON.stringify({ transaction_id: 7, status: 3, error: "declined" }) },
      ]);
      const r = await c.postcheck(7);
      expect(r.status).toBe(TransactionStatus.Failed);
      expect(r.error).toBe("declined");
    });
  });

  describe("cancel", () => {
    it("returns the resulting status", async () => {
      const { client: c, calls } = client([{ status: 200, body: JSON.stringify({ status: 2 }) }]);
      const r = await c.cancel(7);
      expect(r.status).toBe(TransactionStatus.Cancelled);
      expect(calls.at(-1)!.body).toBe('{"transaction_id":7}');
    });
  });
});
