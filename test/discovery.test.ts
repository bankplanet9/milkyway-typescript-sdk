import { describe, expect, it } from "vitest";
import {
  MilkywayPaymentsClient,
  MilkywayAuthError,
  MilkywayNotFoundError,
} from "../src/index.js";
import { stubFetch, tokenResponse, baseOptions, type StubResponse } from "./support.js";

function client(responses: StubResponse[], overrides = {}) {
  const f = stubFetch([tokenResponse(), ...responses]);
  return { client: new MilkywayPaymentsClient(baseOptions(f.fetch, overrides)), calls: f.calls };
}

const catalogBody = JSON.stringify({
  destinations: [
    {
      third_party_id: "bank-beta",
      partner_name: "Bank Beta",
      country: "TJ",
      services: [
        {
          service_id: "card-payout",
          payout_method: "card",
          recipient: "pan",
          payout_currencies: ["TJS", "USD"],
        },
      ],
    },
  ],
});

describe("MilkywayPaymentsClient discovery", () => {
  describe("discovery", () => {
    it("lists all destinations without a country filter", async () => {
      const { client: c, calls } = client([{ status: 200, body: catalogBody }]);
      const destinations = await c.discovery();
      const url = calls.at(-1)!.url;
      expect(url).toContain("/payments/v1/discovery");
      expect(url).not.toContain("country=");
      expect(destinations).toHaveLength(1);
      expect(destinations[0]!.third_party_id).toBe("bank-beta");
      expect(destinations[0]!.services[0]!.payout_currencies).toEqual(["TJS", "USD"]);
    });

    it("adds the country query param when provided", async () => {
      const { client: c, calls } = client([{ status: 200, body: catalogBody }]);
      await c.discovery("TJ");
      expect(calls.at(-1)!.url).toContain("/payments/v1/discovery?country=TJ");
    });

    it("returns an empty array when the catalog is empty", async () => {
      const { client: c } = client([{ status: 200, body: JSON.stringify({ destinations: [] }) }]);
      expect(await c.discovery()).toEqual([]);
    });

    it("maps a 401 to an auth error", async () => {
      const { client: c } = client([
        { status: 401, body: JSON.stringify({ error: "bad" }) },
        tokenResponse("t2"),
        { status: 401, body: JSON.stringify({ error: "bad" }) },
      ]);
      await expect(c.discovery()).rejects.toBeInstanceOf(MilkywayAuthError);
    });
  });

  describe("serviceSchema", () => {
    it("requests the schema path and returns the raw schema object", async () => {
      const schema = {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: { pan: { type: "string" } },
        required: ["pan"],
      };
      const { client: c, calls } = client([{ status: 200, body: JSON.stringify(schema) }]);
      const result = await c.serviceSchema("bank-beta", "card-payout");
      expect(calls.at(-1)!.url).toContain("/payments/v1/discovery/bank-beta/card-payout/schema");
      expect(result).toEqual(schema);
    });

    it("url-encodes the path segments", async () => {
      const { client: c, calls } = client([{ status: 200, body: "{}" }]);
      await c.serviceSchema("bank beta/1", "card payout");
      expect(calls.at(-1)!.url).toContain("/payments/v1/discovery/bank%20beta%2F1/card%20payout/schema");
    });

    it("maps a 404 to a not-found error", async () => {
      const { client: c } = client([{ status: 404, body: JSON.stringify({ error: "no such service" }) }]);
      await expect(c.serviceSchema("bank-beta", "nope")).rejects.toBeInstanceOf(
        MilkywayNotFoundError,
      );
    });
  });
});
