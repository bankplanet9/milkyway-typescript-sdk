/**
 * Lifecycle status of a payment transaction, mirroring the integer codes
 * returned by the Payments API (`postcheck` / `cancel`).
 */
export enum TransactionStatus {
  /** Accepted, not yet completed. Keep polling. */
  Pending = 0,
  /** Completed successfully (terminal). */
  Done = 1,
  /** Cancelled (terminal). */
  Cancelled = 2,
  /** Failed (terminal). Inspect the accompanying error message. */
  Failed = 3,
  /** Cancellation requested, awaiting confirmation. */
  CancelPending = 4,
  /** Timed out / stuck (terminal); requires operator attention. */
  Stuck = 5,
}

/**
 * True when the status will not change without external action — `Done`,
 * `Cancelled`, `Failed`, or `Stuck`. Polling should stop once a terminal
 * status is reached.
 */
export function isTerminal(status: TransactionStatus): boolean {
  switch (status) {
    case TransactionStatus.Done:
    case TransactionStatus.Cancelled:
    case TransactionStatus.Failed:
    case TransactionStatus.Stuck:
      return true;
    default:
      return false;
  }
}

/**
 * Codes the API reports in `PostcheckResult.error` for a terminal
 * outcome — the recipient bank's reason, never its own text. Compare against
 * these, but keep a default branch: the field is a plain `string` so a code
 * added later still arrives.
 */
export const StatusReason = {
  /** The recipient bank declined the payment (also any reason it gave without a code). */
  PaymentRejected: "ErrPaymentRejected",
  /** The recipient does not exist at the recipient bank. */
  RecipientNotFound: "ErrRecipientNotFound",
  /** The recipient identifier is not valid at the recipient bank. */
  RecipientInvalid: "ErrRecipientInvalid",
  /** The recipient bank's service was unavailable. */
  ServiceUnavailable: "ErrServiceUnavailable",
  /** The recipient bank refused the cancellation. */
  PaymentCannotBeCanceled: "ErrPaymentCannotBeCanceled",
} as const;

/** One of the {@link StatusReason} codes. */
export type StatusReason = (typeof StatusReason)[keyof typeof StatusReason];
