import { Decimal } from "decimal.js";
import { MilkywayApiError, toApiError } from "./errors.js";
import { HttpTransport } from "./http.js";
import { parseJson, stringifyJson } from "./json.js";
import type {
  CancelResult,
  DecimalInput,
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
    const body = stringifyJson(normalizeMoneyRequest(request));
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
    const body = stringifyJson(normalizeMoneyRequest(request));
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

/** Coerces money inputs (number/string) into {@link Decimal} for exact wire encoding. */
function normalizeMoneyRequest<T extends { amount_credit: DecimalInput }>(
  request: T,
): T & { amount_credit: Decimal } {
  return { ...request, amount_credit: toDecimal(request.amount_credit) };
}

function toDecimal(value: DecimalInput): Decimal {
  return value instanceof Decimal ? value : new Decimal(value);
}

export { TransactionStatus };
