# MilkyWay Payments SDK for TypeScript

[![npm](https://img.shields.io/npm/v/@bankplanet9/milkyway-payments.svg?logo=npm)](https://www.npmjs.com/package/@bankplanet9/milkyway-payments)
[![Downloads](https://img.shields.io/npm/dm/@bankplanet9/milkyway-payments.svg?logo=npm)](https://www.npmjs.com/package/@bankplanet9/milkyway-payments)
[![CI](https://github.com/bankplanet9/milkyway-typescript-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/bankplanet9/milkyway-typescript-sdk/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Official TypeScript/JavaScript client for the **MilkyWay Payments API**
(`/payments/v1`) — the partner-facing API that banks use to initiate, quote,
track, and cancel cross-bank payments.

Batteries included:

- **Keycloak client-credentials auth** with in-memory token caching, automatic
  refresh, single-flight acquisition, and a one-shot refresh-and-replay on `401`.
- **Retries**: exponential backoff with full jitter on transient failures
  (5xx, 408, network); deterministic errors (400/401/402/404) are never retried;
  a `pay` without an `Idempotency-Key` is never auto-retried.
- **Exact-decimal money** via [decimal.js](https://github.com/MikeMcl/decimal.js/)
  — monetary fields never round-trip through a lossy float64.
- **Typed models & errors** — status is an `enum`, the payer and beneficiary are
  typed `PartyInfo` objects, and each HTTP error maps to a specific error class
  carrying `statusCode`, the server message and the field at fault.
- **Zero runtime deps beyond `decimal.js`** — uses the built-in `fetch`
  (Node 18+); a custom `fetch` is injectable for testing.
- Ships **ESM + CommonJS + type declarations**. Targets **Node 18+**.

## Install

```bash
npm install @bankplanet9/milkyway-payments
```

## Quick start

```ts
import {
  IdentityDocumentType,
  MilkywayPaymentsClient,
  PartyType,
  TransactionStatus,
  type PartyInfo,
} from "@bankplanet9/milkyway-payments";
import { randomUUID } from "node:crypto";

const client = new MilkywayPaymentsClient({
  baseUrl: "https://milkyway.stage.planet9.ae",
  tokenUrl: "https://keycloak.ac8o.planet9.ae/realms/planet9-stage/protocol/openid-connect/token",
  clientId: "your-client-id", // issued to your institution
  clientSecret: "your-client-secret",
});

// 1. Is the recipient bank's service online?
await client.healthcheck("bank-beta", "card-payout");

// The payer and the beneficiary, in the canonical model. The service's
// `party_profile` from discovery says which fields its recipient bank requires.
const sender: PartyInfo = {
  party_type: PartyType.Natural,
  name: { first: "Ivan", last: "Petrov", full: "Petrov Ivan Sergeevich" },
  date_of_birth: "1990-04-18",
  identity_document_type: IdentityDocumentType.Passport,
  identity_document_number: "AB1234567",
};
const recipient: PartyInfo = { party_type: PartyType.Natural, name: { full: "Karimov Ali" } };

// 2. Quote the payment (FX markup + commission applied here).
const quote = await client.precheck({
  third_party_id_debit: "bank-beta",
  service_id: "card-payout",
  recipient_id: "recipient-9999",
  amount_credit: "100.00", // string | number | Decimal — kept exact
  currency_credit: "USD",
  sender_info: sender,
  recipient_info: recipient,
});
console.log(`Rate ${quote.rate}, debit ${quote.amount_debit} ${quote.currency_debit}, commission ${quote.commission}`);

// 3. Initiate the payment. Pass an idempotencyKey so retries are safe.
const transactionId = await client.pay(
  {
    third_party_id_debit: "bank-beta",
    service_id: "card-payout",
    sender_id: "sender-0001",
    recipient_id: "recipient-9999",
    amount_credit: "100.00",
    currency_credit: "USD",
    sender_info: sender,
    recipient_info: recipient,
  },
  { idempotencyKey: randomUUID() },
);

// 4. Poll until the payment reaches a terminal status.
const result = await client.waitForCompletion(transactionId);
console.log(`Final status: ${TransactionStatus[result.status]}`);
```

`amount_credit`, `amount_debit`, `rate`, and `commission` come back as
[`Decimal`](https://github.com/MikeMcl/decimal.js/) instances (re-exported from
this package as `Decimal`). Use `.toString()`, `.toFixed()`, `.plus()`, etc.;
never coerce them through `Number()` if you care about precision.

## Discovery

Before quoting or paying, discover which destination banks are reachable and
what payout services they expose. Both discovery endpoints are read-only `GET`s.

```ts
// List every reachable destination, or filter by country
// (ISO 3166-1 alpha-2, case-insensitive).
const destinations = await client.discovery("TJ");
for (const d of destinations) {
  console.log(`${d.partner_name ?? d.third_party_id} (${d.country ?? "?"})`);
  for (const s of d.services) {
    console.log(`  ${s.service_id} via ${s.payout_method} → ${s.payout_currencies?.join(", ") ?? "any"}`);
    // Which sender_info / recipient_info fields the recipient bank requires.
    console.log(`  sender needs ${s.party_profile?.sender_info?.required?.join(", ") ?? "nothing"}`);
  }
}

// Fetch the JSON Schema of a service's non-identity `data` extras.
const schema = await client.serviceSchema("bank-beta", "card-payout");
console.log(schema.properties);
```

`discovery()` returns the `Destination[]` directly (the `{ destinations }`
wrapper is unwrapped for you). Each service's `party_profile` says which
`sender_info` / `recipient_info` fields its recipient bank requires and accepts
(see [Payer and beneficiary](#payer-and-beneficiary)). `serviceSchema()` returns
the raw Draft-2020 JSON Schema of the service's non-identity `data` extras as a
`Record<string, unknown>` — most services take none.

## Payer and beneficiary

The identity of your customer (the payer) and of the beneficiary travels in
`sender_info` and `recipient_info` on `precheck` and `pay` — two `PartyInfo`
objects in one canonical model (FATF Travel Rule / ISO 20022 / IVMS101), the
same for every recipient bank and service. You map your customer data to it
once; each bank's connector converts it to that bank's own format. The account,
card or phone stays in `sender_id` / `recipient_id`.

| Field | Format |
| --- | --- |
| `party_type` | `"natural"` (`PartyType.Natural`, required). `"legal"` exists in the model but the API refuses it for now. |
| `name.first`, `name.last`, `name.full` | Text. `full` is the name as in the document, family name first, with a patronymic if any. |
| `date_of_birth` | ISO 8601 date, `YYYY-MM-DD`. |
| `identity_document_type` | `passport`, `national_id`, `driver_license`, `residence_permit`, `tax_id`, `social_security` or `other` (`IdentityDocumentType.*`). Required with `identity_document_number`. |
| `identity_document_number` | Series and number together, as in the document. |
| `identity_document_country`, `country_of_residence` | ISO 3166-1 alpha-2, upper case (`TJ`). |
| `address` | `country` (alpha-2, required when `address` is sent), `city`, `street`, `building`, `postal_code`, and `line` — up to 7 free-text lines. |

Every field except `party_type` is optional. The SDK sends only these keys (the
API refuses any other) and leaves out empty values, including an empty `name` or
`address`. Text values are at most 256 characters.

Which fields a service needs is set by its recipient bank and published as the
service's `party_profile` in `discovery()`: `required` and `accepted` field paths
(`"name.first"`, `"date_of_birth"`, …) for each side, and, when the bank takes
only some document kinds, `identity_document_types`. Send the fields you have;
fields the bank does not use are ignored. A missing required field or an invalid
value is refused with a `MilkywayValidationError` whose `field` names it by its
path (e.g. `sender_info.date_of_birth`).

**Never put identity in `data`** (no sender name, birthday, passport or document
number there) — the API does not read it from `data`. `data` carries only a
service's non-identity extras; `serviceSchema()` lists them. The browsable
registry of banks, services, party profiles and `data` fields is the
[MilkyWay Handbook](https://docs.planet9.ae/site/milkyway-handbook/en/) (section
**Services**).

## Money precision

The Payments API encodes money as JSON **numbers**. `JSON.parse` would coerce
those to IEEE-754 float64 and silently lose precision on large amounts or rates
with many significant digits. This SDK avoids that entirely: it pre-scans the
raw response text for the known money keys, extracts their exact digit strings,
and reconstructs a `Decimal` from the original digits — never from a float
round-trip. On the way out, `Decimal` request amounts are written back as bare
JSON numbers (not strings), so the wire format matches the API contract exactly.

## Cancellation & timeouts

Every method accepts an `AbortSignal` so you can cancel in-flight requests:

```ts
const controller = new AbortController();
const p = client.precheck(req, { signal: controller.signal });
controller.abort(); // rejects p
```

A per-attempt timeout (`requestTimeoutMs`, default 30s) is enforced internally
via its own `AbortSignal`; a timed-out attempt is treated as transient and
retried (subject to the retry rules below).

## Errors

All API errors are subclasses of `MilkywayApiError` (carrying `statusCode`,
the server's message in `.message`, its leading `Err…` code in `.errorCode` —
`ErrValidationFailed` for `"ErrValidationFailed: amount_credit: …"`, absent when
the message starts with no such code — plus the raw `.responseBody`). On a field-level 400, `.field`
names the request field at fault — e.g. `amount_credit`, `currency_credit`,
`recipient_id` (the recipient bank reported it invalid: `ErrRecipientInvalid`),
or a party field by its path such as `sender_info.date_of_birth`:

| HTTP | Error class | Meaning |
| --- | --- | --- |
| 400 | `MilkywayValidationError` | Bad request (invalid amount, missing field, recipient invalid at the bank). |
| 401 | `MilkywayAuthError` | Token missing/invalid (also thrown if token acquisition fails). |
| 402 | `MilkywayExposureBlockedError` | Payment would breach a block-action exposure limit. |
| 404 | `MilkywayNotFoundError` | Transaction not found or not owned by your institution. |
| 422 | `MilkywayPaymentRejectedError` | The recipient bank refused the payment on its merits (`ErrPaymentRejected`). Not retried — repeating it will not change the answer. Nothing was created. |
| 502 | `MilkywayRecipientBankError` | The recipient bank's connector failed in a way MilkyWay could not classify (`ErrRecipientBankError`). Nothing was created. Extends `MilkywayServiceUnavailableError`. |
| 5xx | `MilkywayServiceUnavailableError` | API or downstream recipient unavailable, or the recipient bank quoted no usable FX rate for a cross-currency payment. On a 503 `.serviceId` / `.thirdPartyId` name the failed recipient service. |

Precheck and pay can answer 422 and 502; cancel can answer 502 and 503 (the
payment is unchanged). All 5xx — including 502 — are retried automatically
first (see below); 4xx — including 422 — never are.

```ts
import {
  MilkywayExposureBlockedError,
  MilkywayPaymentRejectedError,
  MilkywayServiceUnavailableError,
} from "@bankplanet9/milkyway-payments";

try {
  await client.pay(req, { idempotencyKey: key });
} catch (err) {
  if (err instanceof MilkywayPaymentRejectedError) {
    // the recipient bank declined — do not resubmit as-is
  } else if (err instanceof MilkywayExposureBlockedError) {
    // handle the exposure block specifically
  } else if (err instanceof MilkywayServiceUnavailableError) {
    // also catches MilkywayRecipientBankError (502); err.serviceId names the service on a 503
  }
  throw err;
}
```

### Failure reasons on a payment

When a payment ends `Failed` (or a cancellation is refused), `postcheck` /
`waitForCompletion` return the recipient bank's reason as a **code** in
`error` — never the bank's own text. Compare it with `StatusReason`; the field
stays a plain `string`, so keep a default branch for codes added later:

```ts
import { StatusReason, TransactionStatus } from "@bankplanet9/milkyway-payments";

const result = await client.waitForCompletion(txId);
if (result.status === TransactionStatus.Failed) {
  switch (result.error) {
    case StatusReason.RecipientNotFound:
    case StatusReason.RecipientInvalid:
      // fix the recipient and submit a new payment
      break;
    case StatusReason.PaymentRejected:
    default:
      // declined by the recipient bank
  }
}
```

| `StatusReason` | Code |
| --- | --- |
| `PaymentRejected` | `ErrPaymentRejected` |
| `RecipientNotFound` | `ErrRecipientNotFound` |
| `RecipientInvalid` | `ErrRecipientInvalid` |
| `ServiceUnavailable` | `ErrServiceUnavailable` |
| `PaymentCannotBeCanceled` | `ErrPaymentCannotBeCanceled` |

## Retries & idempotency

Transient failures (HTTP 5xx, 408, network/timeout) are retried automatically
with exponential backoff + full jitter, tunable via `maxRetries` (default 3) and
`retryBaseDelayMs` (default 500). Deterministic errors (400/401/402/404/422) are
never retried.

**`pay` is only auto-retried when you supply an `idempotencyKey`** — without one,
a retry could create a duplicate payment, so the SDK sends it exactly once. With
a key, the call is safe to retry and the key is forwarded as the
`Idempotency-Key` header.

## Configuration

| Option | Default | Purpose |
| --- | --- | --- |
| `baseUrl` | — (required) | Payments API base URL. |
| `tokenUrl` | — (required) | Keycloak token endpoint. |
| `clientId` / `clientSecret` | — (required) | Your institution's credentials. |
| `scope` | none | Optional OAuth scope. |
| `tokenRefreshSkewMs` | 30000 | Refresh this long before token expiry. |
| `requestTimeoutMs` | 30000 | Per-attempt request timeout. |
| `maxRetries` | 3 | Max transient-failure retries. |
| `retryBaseDelayMs` | 500 | Base delay for exponential backoff. |
| `fetch` | global `fetch` | Injectable fetch implementation (for testing). |

`waitForCompletion` accepts its own `PollOptions`: `initialDelayMs` (1000),
`maxDelayMs` (30000), `backoffMultiplier` (2.0), `timeoutMs` (300000). When the
poll budget is exhausted, the last observed (non-terminal) status is returned.

## Building from source

```bash
npm install
npm run lint
npm run typecheck
npm test
npm run build   # emits dist/ (ESM + CJS + .d.ts)
```

## Releasing

Releases are **fully automated** by
[semantic-release](https://semantic-release.gitbook.io/) on every push to `main`:

1. Conventional commits are analysed (`feat:` → minor, `fix:`/`perf:` → patch,
   `!` / `BREAKING CHANGE` → major). No releasable commits → no release.
2. `@semantic-release/npm` writes the computed version into `package.json`.
3. The package is built and published to **npm with provenance**
   (`npm publish --provenance --access public`) via GitHub OIDC — no long-lived
   token stored.
4. A GitHub release + `vX.Y.Z` tag is created with generated notes.

The publish job is **guarded** behind the repo variable
`PUBLISH_ENABLED == 'true'`, so until the registry side is configured, pushes to
`main` build and test but never fail on a missing publish setup.

### One-time npm setup (maintainers)

1. **Create the org/scope.** On npmjs.com, create the `@bankplanet9` organization
   (the package is scoped `@bankplanet9/milkyway-payments`).
2. **Configure Trusted Publishing (preferred — no token).** On npmjs.com →
   the package's **Settings → Trusted Publisher**, add a GitHub Actions publisher
   for owner `bankplanet9`, repository `milkyway-typescript-sdk`, workflow
   `ci.yml`. The workflow already requests `id-token: write` and publishes with
   `--provenance`, so no secret is needed.
   - *Note:* the first publish of a brand-new package name may need to be done
     once manually (`npm publish --access public`) to create the package before a
     trusted-publisher policy can be attached, depending on npm's current rules.
3. **Or fall back to a token.** If you prefer a classic token, create an
   **Automation** access token on npmjs.com and add it as the repo secret
   `NPM_TOKEN`; the workflow wires it as `NODE_AUTH_TOKEN`.
4. **Enable releases.** Set the repository **variable** `PUBLISH_ENABLED` to
   `true` (Settings → Secrets and variables → Actions → Variables).

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Planet9.
