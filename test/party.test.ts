import { describe, expect, it } from "vitest";
import {
  IdentityDocumentType,
  MilkywayPaymentsClient,
  MilkywayValidationError,
  PartyType,
  type PartyInfo,
} from "../src/index.js";
import { stubFetch, tokenResponse, baseOptions, type StubResponse } from "./support.js";

function client(responses: StubResponse[]) {
  const f = stubFetch([tokenResponse(), ...responses]);
  return { client: new MilkywayPaymentsClient(baseOptions(f.fetch)), calls: f.calls };
}

const precheckReq = {
  third_party_id_debit: "bank-beta",
  service_id: "card",
  recipient_id: "r-1",
  amount_credit: 100,
  currency_credit: "USD",
};

const payReq = { ...precheckReq, sender_id: "s-1" };

const fullSender: PartyInfo = {
  party_type: PartyType.Natural,
  name: { first: "Ivan", last: "Petrov", full: "Petrov Ivan Sergeevich" },
  date_of_birth: "1990-04-18",
  identity_document_type: IdentityDocumentType.Passport,
  identity_document_number: "AB1234567",
  identity_document_country: "TJ",
  country_of_residence: "AE",
  address: {
    country: "AE",
    city: "Dubai",
    street: "Sheikh Zayed Rd",
    building: "12",
    postal_code: "00000",
    line: ["Office 4"],
  },
};

const fullSenderWire =
  '{"party_type":"natural","name":{"first":"Ivan","last":"Petrov","full":"Petrov Ivan Sergeevich"},' +
  '"date_of_birth":"1990-04-18","identity_document_type":"passport","identity_document_number":"AB1234567",' +
  '"identity_document_country":"TJ","country_of_residence":"AE",' +
  '"address":{"country":"AE","city":"Dubai","street":"Sheikh Zayed Rd","building":"12","postal_code":"00000","line":["Office 4"]}}';

/** The raw JSON text of one top-level key of a recorded request body. */
function rawParty(body: string | undefined, key: "sender_info" | "recipient_info"): string {
  const parsed = JSON.parse(body ?? "{}") as Record<string, unknown>;
  return JSON.stringify(parsed[key]);
}

describe("sender_info / recipient_info", () => {
  it("precheck serializes both parties with the exact canonical keys", async () => {
    const { client: c, calls } = client([{ status: 200, body: "{}" }]);
    await c.precheck({
      ...precheckReq,
      sender_info: fullSender,
      recipient_info: { party_type: "natural", name: { full: "Karimov Ali" } },
    });
    const body = calls.at(-1)!.body;
    expect(rawParty(body, "sender_info")).toBe(fullSenderWire);
    expect(rawParty(body, "recipient_info")).toBe('{"party_type":"natural","name":{"full":"Karimov Ali"}}');
    expect(body).not.toContain('"data"');
  });

  it("pay serializes both parties", async () => {
    const { client: c, calls } = client([{ status: 200, body: JSON.stringify({ transaction_id: 1 }) }]);
    await c.pay(
      {
        ...payReq,
        sender_info: {
          party_type: "natural",
          identity_document_type: "national_id",
          identity_document_number: "123",
        },
        recipient_info: { party_type: "natural", country_of_residence: "TJ" },
      },
      { idempotencyKey: "k" },
    );
    const body = calls.at(-1)!.body;
    expect(rawParty(body, "sender_info")).toBe(
      '{"party_type":"natural","identity_document_type":"national_id","identity_document_number":"123"}',
    );
    expect(rawParty(body, "recipient_info")).toBe('{"party_type":"natural","country_of_residence":"TJ"}');
  });

  it("omits empty fields and empty name/address objects", async () => {
    const { client: c, calls } = client([{ status: 200, body: "{}" }]);
    await c.precheck({
      ...precheckReq,
      sender_info: {
        party_type: "natural",
        name: { first: "", last: undefined },
        date_of_birth: "",
        address: { country: "", line: [] },
      },
      recipient_info: { party_type: "natural", name: { last: "Petrov" }, address: { country: "TJ" } },
    });
    const body = calls.at(-1)!.body;
    expect(rawParty(body, "sender_info")).toBe('{"party_type":"natural"}');
    expect(rawParty(body, "recipient_info")).toBe(
      '{"party_type":"natural","name":{"last":"Petrov"},"address":{"country":"TJ"}}',
    );
  });

  it("never serializes keys outside the party model", async () => {
    const { client: c, calls } = client([{ status: 200, body: "{}" }]);
    const withExtras = {
      party_type: "natural",
      passport_number: "AB1",
      name: { first: "Ivan", middle: "S" },
      address: { country: "TJ", region: "Sughd" },
    } as unknown as PartyInfo;
    await c.precheck({ ...precheckReq, sender_info: withExtras });
    expect(rawParty(calls.at(-1)!.body, "sender_info")).toBe(
      '{"party_type":"natural","name":{"first":"Ivan"},"address":{"country":"TJ"}}',
    );
  });

  it("leaves the parties off the wire when not supplied", async () => {
    const { client: c, calls } = client([{ status: 200, body: "{}" }]);
    await c.precheck(precheckReq);
    const body = calls.at(-1)!.body!;
    expect(body).not.toContain("sender_info");
    expect(body).not.toContain("recipient_info");
  });

  it("does not mutate the caller's request", async () => {
    const { client: c } = client([{ status: 200, body: "{}" }]);
    const sender: PartyInfo = { party_type: "natural", name: { first: "" } };
    await c.precheck({ ...precheckReq, sender_info: sender });
    expect(sender).toEqual({ party_type: "natural", name: { first: "" } });
  });

  it("exposes the field a 400 names", async () => {
    const { client: c } = client([
      {
        status: 400,
        body: JSON.stringify({
          error: "sender_info.date_of_birth: is required by the receiving bank for this service",
          field: "sender_info.date_of_birth",
        }),
      },
    ]);
    const err = await c.precheck(precheckReq).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MilkywayValidationError);
    expect((err as MilkywayValidationError).field).toBe("sender_info.date_of_birth");
  });
});

describe("discovery party_profile", () => {
  it("decodes the party profile of a service", async () => {
    const body = JSON.stringify({
      destinations: [
        {
          third_party_id: "bank-beta",
          services: [
            {
              service_id: "card",
              payout_method: "card",
              party_profile: {
                sender_info: {
                  required: [
                    "name.first",
                    "name.last",
                    "date_of_birth",
                    "identity_document_type",
                    "identity_document_number",
                  ],
                  accepted: ["name.full"],
                  identity_document_types: ["passport"],
                },
                recipient_info: { accepted: ["address.line"] },
              },
            },
            { service_id: "wallet", payout_method: "wallet" },
          ],
        },
      ],
    });
    const { client: c } = client([{ status: 200, body }]);
    const [dest] = await c.discovery();
    const [card, wallet] = dest!.services;
    expect(card!.party_profile).toEqual({
      sender_info: {
        required: [
          "name.first",
          "name.last",
          "date_of_birth",
          "identity_document_type",
          "identity_document_number",
        ],
        accepted: ["name.full"],
        identity_document_types: [IdentityDocumentType.Passport],
      },
      recipient_info: { accepted: ["address.line"] },
    });
    expect(wallet!.party_profile).toBeUndefined();
  });
});
