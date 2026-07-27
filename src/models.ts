import type { Decimal } from "decimal.js";
import type { TransactionStatus } from "./status.js";

/** Accepts a JS number, a string, or a {@link Decimal} for money inputs. */
export type DecimalInput = Decimal | number | string;

/**
 * Request for a payment quote (rate + commission) without creating a payment.
 * The credit party (your institution) is resolved from the access token's
 * `azp` claim and must not be sent here.
 */
export interface PrecheckRequest {
  /** Recipient bank id. */
  third_party_id_debit: string;
  /** Service id (e.g. `card-payout`). */
  service_id: string;
  /** Recipient identifier within the chosen service. */
  recipient_id: string;
  /** Amount in the credit currency (must be > 0). */
  amount_credit: DecimalInput;
  /** Credit currency (ISO-4217), e.g. `USD`. */
  currency_credit: string;
  /**
   * Service-specific payload, validated server-side against the service's JSON
   * Schema. Omitted from the wire when undefined.
   */
  data?: Record<string, unknown>;
}

/**
 * Request to initiate a cross-bank payment. The credit party (your institution)
 * is resolved from the access token's `azp` claim — do not send
 * `third_party_id_credit`.
 */
export interface PayRequest {
  /** Recipient bank id. */
  third_party_id_debit: string;
  /** Service id (e.g. `card-payout`). */
  service_id: string;
  /** Sender identifier within the chosen service. */
  sender_id: string;
  /** Recipient identifier within the chosen service. */
  recipient_id: string;
  /** Amount in the credit currency (must be > 0). */
  amount_credit: DecimalInput;
  /** Credit currency (ISO-4217), e.g. `USD`. */
  currency_credit: string;
  /** Service-specific payload. Omitted from the wire when undefined. */
  data?: Record<string, unknown>;
}

/**
 * Quote for a prospective payment. The FX markup is already applied and is
 * locked onto the transaction if you proceed to `pay`. Money fields are exact
 * {@link Decimal} values.
 */
export interface PrecheckResult {
  third_party_id?: string;
  service_id?: string;
  recipient_id?: string;
  amount_credit: Decimal;
  currency_credit?: string;
  /** Amount the recipient bank is debited, in the debit currency. */
  amount_debit: Decimal;
  currency_debit?: string;
  /** Quoted exchange rate: `1 CREDIT = rate DEBIT`. */
  rate: Decimal;
  /** Commission charged, in the credit currency. */
  commission: Decimal;
}

/** Current status of a payment transaction. */
export interface PostcheckResult {
  transaction_id: number;
  /** Lifecycle status of the transaction. */
  status: TransactionStatus;
  /** Failure detail; present only when the payment failed. */
  error?: string;
}

/** Result of a cancellation request: the resulting transaction status. */
export interface CancelResult {
  status: TransactionStatus;
}

/**
 * A payout capability a destination bank offers under one of its services, as
 * returned by the discovery catalog. The service's JSON Schema is not included
 * here — fetch it with {@link MilkywayPaymentsClient.serviceSchema}.
 */
export interface ServiceCapability {
  /** Service id (e.g. `card-payout`). */
  service_id: string;
  /** How the recipient is paid out (e.g. `card`, `account`, `wallet`). */
  payout_method: string;
  /** Recipient identifier kind the service expects, when advertised. */
  recipient?: string;
  /** Currencies the service can pay out in (ISO-4217), when advertised. */
  payout_currencies?: string[];
}

/**
 * A reachable destination bank in the discovery catalog, together with the
 * services it exposes for payouts.
 */
export interface Destination {
  /** Destination (recipient) bank id. */
  third_party_id: string;
  /** Human-readable partner name, when advertised. */
  partner_name?: string;
  /** Destination country (ISO 3166-1 alpha-2), when advertised. */
  country?: string;
  /** Payout capabilities the destination offers. */
  services: ServiceCapability[];
}

/** Controls {@link MilkywayPaymentsClient.waitForCompletion} polling. */
export interface PollOptions {
  /** Delay before the first poll, in ms. Default 1000. */
  initialDelayMs?: number;
  /** Maximum delay between polls (backoff is capped here), in ms. Default 30000. */
  maxDelayMs?: number;
  /** Multiplier applied to the delay after each poll. Default 2.0. */
  backoffMultiplier?: number;
  /**
   * Overall budget for polling, in ms. When exceeded, the last observed status
   * is returned even if non-terminal. Default 300000 (5 min).
   */
  timeoutMs?: number;
}
