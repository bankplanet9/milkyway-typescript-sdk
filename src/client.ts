import { Decimal } from "decimal.js";
import { MilkywayApiError, toApiError } from "./errors.js";
import { HttpTransport } from "./http.js";
import { parseJson, stringifyJson } from "./json.js";
import type {
  CancelResult,
  DecimalInput,
  Destination,
  PartyInfo,
  PayRequest,
  PollOptions,
  PostcheckResult,
  PrecheckRequest,
  PrecheckResult,
} from "./models.js";
import { resolveOptions, type MilkywayOptions, type ResolvedOptions } from "./options.js";
import { isTerminal, TransactionStatus } from "./status.js";

const PAYMENTS_PATH = "payments/v1";

/** Per-call options shared by all client methods. */
export interface RequestOptions {
  /** Cancellation signal propagated to the underlying fetch. */
  signal?: AbortSignal;
}

const POLL_DEFAULTS: Required<PollOptions> = {
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
  backoffMultiplier: 2.0,
  timeoutMs: 300_000,
};

/**
 * Client for the MilkyWay Payments API. Construct with {@link MilkywayOptions};
 * it builds the Keycloak token provider and the resilient HTTP transport
 * internally.
 */
export class MilkywayPaymentsClient {
  private readonly transport: HttpTransport;
  private readonly resolved: ResolvedOptions;

  constructor(options: MilkywayOptions) {
    this.resolved = resolveOptions(options);
    this.transport = new HttpTransport(this.resolved);
  }

  /** Exposed for tests/advanced wiring — the resilient transport. */
  get http(): HttpTransport {
    return this.transport;
  }

  /**
   * Checks whether a recipient bank's service is online. Returns the raw
   * status string from the API.
   */
  async healthcheck(
    thirdPartyId: string,
    serviceId: string,
    options: RequestOptions = {},
  ): Promise<string> {
    requireArg(thirdPartyId, "thirdPartyId");
    requireArg(serviceId, "serviceId");
    const path =
      `${PAYMENTS_PATH}/healthcheck?third_party_id=${encodeURIComponent(thirdPartyId)}` +
      `&service_id=${encodeURIComponent(serviceId)}`;
    const result = await this.transport.send({ method: "GET", path, signal: options.signal });
    if (result.status < 200 || result.status >= 300) throw toApiError(result.status, result.body);
    return result.body;
  }

  /** Quotes a prospective payment (rate + commission), without creating one. */
  async precheck(request: PrecheckRequest, options: RequestOptions = {}): Promise<PrecheckResult> {
    const body = stringifyJson(toWireRequest(request));
    return this.sendForJson<PrecheckResult>({
      method: "POST",
      path: `${PAYMENTS_PATH}/precheck`,
      jsonBody: body,
      signal: options.signal,
    });
  }

  /**
   * Initiates a cross-bank payment, returning the new transaction id.
   *
   * Supply `idempotencyKey` to make the call safe to auto-retry on transient
   * failures. Without one, the SDK sends the request exactly once (no retries)
   * to avoid duplicate payments.
   */
  async pay(
    request: PayRequest,
    options: RequestOptions & { idempotencyKey?: string } = {},
  ): Promise<number> {
    const body = stringifyJson(toWireRequest(request));
    const headers: Record<string, string> = {};
    const hasKey = !!options.idempotencyKey && options.idempotencyKey.length > 0;
    if (hasKey) headers["Idempotency-Key"] = options.idempotencyKey as string;

    const result = await this.sendForJson<{ transaction_id: number }>({
      method: "POST",
      path: PAYMENTS_PATH,
      jsonBody: body,
      headers,
      signal: options.signal,
      suppressRetry: !hasKey,
    });
    return result.transaction_id;
  }

  /** Fetches the current status of a transaction. */
  async postcheck(transactionId: number, options: RequestOptions = {}): Promise<PostcheckResult> {
    return this.sendForJson<PostcheckResult>({
      method: "GET",
      path: `${PAYMENTS_PATH}/postcheck?transaction_id=${transactionId}`,
      signal: options.signal,
    });
  }

  /** Requests cancellation of a transaction, returning the resulting status. */
  async cancel(transactionId: number, options: RequestOptions = {}): Promise<CancelResult> {
    const body = stringifyJson({ transaction_id: transactionId });
    return this.sendForJson<CancelResult>({
      method: "POST",
      path: `${PAYMENTS_PATH}/cancel`,
      jsonBody: body,
      signal: options.signal,
    });
  }

  /**
   * Lists reachable destination banks and the payout services they expose.
   * Pass `country` (ISO 3166-1 alpha-2, case-insensitive) to filter the catalog
   * to a single country; omit it to list every destination.
   */
  async discovery(country?: string, options: RequestOptions = {}): Promise<Destination[]> {
    const hasCountry = !!country && country.trim().length > 0;
    const path = hasCountry
      ? `${PAYMENTS_PATH}/discovery?country=${encodeURIComponent(country as string)}`
      : `${PAYMENTS_PATH}/discovery`;
    const result = await this.sendForJson<{ destinations?: Destination[] }>({
      method: "GET",
      path,
      signal: options.signal,
    });
    return result.destinations ?? [];
  }

  /**
   * Fetches the raw Draft-2020 JSON Schema for a destination's service — the
   * schema the service-specific `data` payload is validated against.
   */
  async serviceSchema(
    thirdPartyId: string,
    serviceId: string,
    options: RequestOptions = {},
  ): Promise<Record<string, unknown>> {
    requireArg(thirdPartyId, "thirdPartyId");
    requireArg(serviceId, "serviceId");
    const path =
      `${PAYMENTS_PATH}/discovery/${encodeURIComponent(thirdPartyId)}` +
      `/${encodeURIComponent(serviceId)}/schema`;
    return this.sendForJson<Record<string, unknown>>({
      method: "GET",
      path,
      signal: options.signal,
    });
  }

  /**
   * Polls `postcheck` with exponential backoff until the transaction reaches a
   * terminal status or the poll-timeout budget is exhausted (in which case the
   * last observed status is returned).
   */
  async waitForCompletion(
    transactionId: number,
    pollOptions: PollOptions = {},
    options: RequestOptions = {},
  ): Promise<PostcheckResult> {
    const opts = { ...POLL_DEFAULTS, ...pollOptions };
    const start = Date.now();
    let delay = opts.initialDelayMs;

    let result = await this.postcheck(transactionId, options);
    while (!isTerminal(result.status)) {
      if (Date.now() - start + delay > opts.timeoutMs) return result;
      await this.sleep(delay, options.signal);
      delay = Math.min(delay * opts.backoffMultiplier, opts.maxDelayMs);
      result = await this.postcheck(transactionId, options);
    }
    return result;
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async sendForJson<T>(spec: Parameters<HttpTransport["send"]>[0]): Promise<T> {
    const result = await this.transport.send(spec);
    if (result.status < 200 || result.status >= 300) throw toApiError(result.status, result.body);
    try {
      return parseJson(result.body) as T;
    } catch (err) {
      throw new MilkywayApiError(result.status, "Failed to parse the API response.", {
        responseBody: result.body,
        cause: err,
      });
    }
  }
}

function requireArg(value: string, name: string): void {
  if (!value || value.trim().length === 0) throw new TypeError(`${name} is required.`);
}

/**
 * Prepares a precheck/pay request for the wire: coerces money inputs
 * (number/string) into {@link Decimal} for exact encoding, and reduces the
 * party objects to their canonical keys.
 */
function toWireRequest<
  T extends { amount_credit: DecimalInput; sender_info?: PartyInfo; recipient_info?: PartyInfo },
>(request: T): Record<string, unknown> {
  const wire: Record<string, unknown> = { ...request, amount_credit: toDecimal(request.amount_credit) };
  if (request.sender_info) wire.sender_info = toWireParty(request.sender_info);
  if (request.recipient_info) wire.recipient_info = toWireParty(request.recipient_info);
  return wire;
}

const PARTY_KEYS = [
  "party_type",
  "name",
  "date_of_birth",
  "identity_document_type",
  "identity_document_number",
  "identity_document_country",
  "country_of_residence",
  "address",
] as const;
const PARTY_NESTED_KEYS: Partial<Record<string, readonly string[]>> = {
  name: ["first", "last", "full"],
  address: ["country", "city", "street", "building", "postal_code", "line"],
};

/**
 * The API refuses keys outside the party model, so only the canonical keys are
 * copied, and empty values (including an empty `name` or `address`) are left
 * out.
 */
function toWireParty(party: PartyInfo): Record<string, unknown> {
  return pickNonEmpty(party, PARTY_KEYS, PARTY_NESTED_KEYS);
}

function pickNonEmpty(
  source: object,
  keys: readonly string[],
  nestedKeys: Partial<Record<string, readonly string[]>> = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    let value = (source as Record<string, unknown>)[key];
    const subKeys = nestedKeys[key];
    if (subKeys && value && typeof value === "object") value = pickNonEmpty(value, subKeys);
    if (!isEmpty(value)) out[key] = value;
  }
  return out;
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === "object" && Object.keys(value).length === 0;
}

function toDecimal(value: DecimalInput): Decimal {
  return value instanceof Decimal ? value : new Decimal(value);
}

export { TransactionStatus };
