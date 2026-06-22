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
