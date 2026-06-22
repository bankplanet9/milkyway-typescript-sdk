# MilkyWay Payments SDK for TypeScript

[![npm](https://img.shields.io/npm/v/@bankplanet9/milkyway-payments.svg?logo=npm)](https://www.npmjs.com/package/@bankplanet9/milkyway-payments)
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
- **Typed models & errors** — status is an `enum`, and each HTTP error maps to a
  specific error class carrying `statusCode` + the server message.
- **Zero runtime deps beyond `decimal.js`** — uses the built-in `fetch`
  (Node 18+); a custom `fetch` is injectable for testing.
- Ships **ESM + CommonJS + type declarations**. Targets **Node 18+**.

## Install

```bash
npm install @bankplanet9/milkyway-payments
```

## Quick start

```ts
import { MilkywayPaymentsClient, TransactionStatus } from "@bankplanet9/milkyway-payments";
import { randomUUID } from "node:crypto";

const client = new MilkywayPaymentsClient({
  baseUrl: "https://milkyway.stage.planet9.ae",
  tokenUrl: "https://keycloak.ac8o.planet9.ae/realms/planet9-stage/protocol/openid-connect/token",
  clientId: "your-client-id", // issued to your institution
  clientSecret: "your-client-secret",
});

// 1. Is the recipient bank's service online?
await client.healthcheck("bank-beta", "card-payout");

// 2. Quote the payment (FX markup + commission applied here).
const quote = await client.precheck({
  third_party_id_debit: "bank-beta",
  service_id: "card-payout",
  recipient_id: "recipient-9999",
  amount_credit: "100.00", // string | number | Decimal — kept exact
  currency_credit: "USD",
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
    data: { passport: "AA1234567" },
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

All API errors are subclasses of `MilkywayApiError` (carrying `statusCode` and
the server's message in `.message`, plus the raw `.responseBody`):

| HTTP | Error class | Meaning |
| --- | --- | --- |
| 400 | `MilkywayValidationError` | Bad request (invalid amount, missing field, unresolvable FX rate). |
| 401 | `MilkywayAuthError` | Token missing/invalid (also thrown if token acquisition fails). |
| 402 | `MilkywayExposureBlockedError` | Payment would breach a block-action exposure limit. |
| 404 | `MilkywayNotFoundError` | Transaction not found or not owned by your institution. |
| 5xx | `MilkywayServiceUnavailableError` | API or downstream recipient unavailable (retried automatically first). |

```ts
import { MilkywayExposureBlockedError } from "@bankplanet9/milkyway-payments";

try {
  await client.pay(req, { idempotencyKey: key });
} catch (err) {
  if (err instanceof MilkywayExposureBlockedError) {
    // handle the exposure block specifically
  }
  throw err;
}
```

## Retries & idempotency

Transient failures (HTTP 5xx, 408, network/timeout) are retried automatically
with exponential backoff + full jitter, tunable via `maxRetries` (default 3) and
`retryBaseDelayMs` (default 500). Deterministic errors (400/401/402/404) are
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
