import type { Decimal } from "decimal.js";
import type { TransactionStatus } from "./status.js";

/** Accepts a JS number, a string, or a {@link Decimal} for money inputs. */
export type DecimalInput = Decimal | number | string;

/**
 * The kind of payment party in a {@link PartyInfo}. Use `natural` (a person):
 * `legal` is part of the model, but the API refuses it (400) for now.
 */
export const PartyType = {
  Natural: "natural",
  Legal: "legal",
} as const;
export type PartyType = (typeof PartyType)[keyof typeof PartyType];

/**
 * The kind of identity document in a {@link PartyInfo}. The vocabulary is
 * closed and maps one-to-one to IVMS101 `nationalIdentifierType`: passport
 * (CCPT), national_id (IDCD), driver_license (DRLC), residence_permit (ARNU),
 * tax_id (TXID), social_security (SOCS), other (MISC).
 */
export const IdentityDocumentType = {
  Passport: "passport",
  NationalId: "national_id",
  DriverLicense: "driver_license",
  ResidencePermit: "residence_permit",
  TaxId: "tax_id",
  SocialSecurity: "social_security",
  Other: "other",
} as const;
export type IdentityDocumentType = (typeof IdentityDocumentType)[keyof typeof IdentityDocumentType];

/** A field of a {@link PartyInfo}, as listed in {@link PartyRequirements}. */
export type PartyFieldPath =
  | "name.first"
  | "name.last"
  | "name.full"
  | "date_of_birth"
  | "identity_document_type"
  | "identity_document_number"
  | "identity_document_country"
  | "country_of_residence"
  | "address.country"
  | "address.city"
  | "address.street"
  | "address.building"
  | "address.postal_code"
  | "address.line";

/** The name of a payment party. */
export interface PartyName {
  /** Given name. */
  first?: string;
  /** Family name. */
  last?: string;
  /**
   * The name as written in the identity document: family name first, with a
   * patronymic if any (e.g. `Petrov Ivan Sergeevich`).
   */
  full?: string;
}

/** The address of a payment party. `country` is required when an address is sent. */
export interface PartyAddress {
  /** ISO 3166-1 alpha-2, upper case (e.g. `AE`). */
  country: string;
  city?: string;
  street?: string;
  building?: string;
  postal_code?: string;
  /** An address kept as free text, one line per element (at most 7). */
  line?: string[];
}

/**
 * The canonical identity of a payment party — the payer (`sender_info`) or the
 * beneficiary (`recipient_info`). The model is IVMS101-anchored and the same for
 * every recipient bank and service; each bank's connector converts it to the
 * bank's own format. The account, card or phone stays in `sender_id` /
 * `recipient_id`.
 *
 * Only `party_type` is required. The SDK sends only the keys below and leaves
 * out empty values, including an empty `name` or `address`. Which fields a
 * service needs is published in its {@link ServiceCapability.party_profile}; a
 * missing required field or an invalid value is refused with a
 * `MilkywayValidationError` whose `field` names it (e.g.
 * `sender_info.date_of_birth`). Text values are at most 256 characters.
 */
export interface PartyInfo {
  /** The kind of party. Use `natural`. */
  party_type: PartyType;
  name?: PartyName;
  /** ISO 8601 date, `YYYY-MM-DD` (e.g. `1990-04-18`). */
  date_of_birth?: string;
  /** The kind of identity document. Required with `identity_document_number`. */
  identity_document_type?: IdentityDocumentType;
  /** Series and number together, as written in the document. */
  identity_document_number?: string;
  /** Issuing country, ISO 3166-1 alpha-2, upper case (e.g. `TJ`). */
  identity_document_country?: string;
  /** ISO 3166-1 alpha-2, upper case (e.g. `AE`). */
  country_of_residence?: string;
  address?: PartyAddress;
}

/**
 * The field paths a recipient bank uses within one party object. A field in
 * neither list is not used by the bank.
 */
export interface PartyRequirements {
  /** Fields a precheck or pay must carry; a missing one is refused with 400 naming it. */
  required?: PartyFieldPath[];
  /** Fields the bank uses when present. */
  accepted?: PartyFieldPath[];
  /**
   * The document kinds the bank takes. Absent means any; another kind is refused
   * with 400 naming `identity_document_type`.
   */
  identity_document_types?: IdentityDocumentType[];
}

/**
 * Which {@link PartyInfo} fields a service's recipient bank requires and
 * accepts — the same profile the bank enforces at precheck and pay. A side that
 * is absent needs no fields.
 */
export interface PartyProfile {
  /** Requirements for `sender_info`. */
  sender_info?: PartyRequirements;
  /** Requirements for `recipient_info`. */
  recipient_info?: PartyRequirements;
}

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
   * Your customer, the payer. The fields the service requires are in its
   * discovery `party_profile`.
   */
  sender_info?: PartyInfo;
  /**
   * The beneficiary. The fields the service requires are in its discovery
   * `party_profile`.
   */
  recipient_info?: PartyInfo;
  /**
   * A service's non-identity extras, validated by the recipient bank against
   * the service's JSON Schema (see `serviceSchema`). Most services take none.
   * Never put the payer's or beneficiary's identity here — use `sender_info` /
   * `recipient_info`. Omitted from the wire when undefined.
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
  /**
   * Your customer, the payer. The fields the service requires are in its
   * discovery `party_profile`.
   */
  sender_info?: PartyInfo;
  /**
   * The beneficiary. The fields the service requires are in its discovery
   * `party_profile`.
   */
  recipient_info?: PartyInfo;
  /**
   * A service's non-identity extras, forwarded to the recipient bank (see
   * `serviceSchema`). Most services take none. Never put the payer's or
   * beneficiary's identity here — use `sender_info` / `recipient_info`.
   * Omitted from the wire when undefined.
   */
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
  /**
   * The code of the recipient bank's reason for a terminal outcome, when it gave
   * one — one of `StatusReason` (e.g. `ErrPaymentRejected`), never the
   * bank's own text. Typed `string` so codes added later still arrive. Absent
   * when no reason was given.
   */
  error?: string;
}

/** Result of a cancellation request: the resulting transaction status. */
export interface CancelResult {
  status: TransactionStatus;
}

/**
 * A payout capability a destination bank offers under one of its services, as
 * returned by the discovery catalog. The JSON Schema of the service's
 * non-identity `data` extras is not included here — fetch it with
 * {@link MilkywayPaymentsClient.serviceSchema}.
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
  /**
   * Which `sender_info` / `recipient_info` fields the recipient bank requires
   * and accepts for this service. Absent when the bank has published none.
   */
  party_profile?: PartyProfile;
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
