export class FeeCollectionPendingError extends Error {
  readonly readyAt: bigint;
  readonly observedAt: bigint;

  constructor(readyAt: bigint, observedAt: bigint) {
    super(
      `confidential fee batch is not mature; observedAt=${observedAt}; ` +
        `readyAt=${readyAt}; rerun after readyAt`,
    );
    this.name = "FeeCollectionPendingError";
    this.readyAt = readyAt;
    this.observedAt = observedAt;
  }
}

export function requireFeeCollectionMature(
  observedAt: bigint,
  readyAt: bigint,
): void {
  if (observedAt < 0n || readyAt < 0n) {
    throw new Error("fee collection timestamps must be non-negative");
  }
  if (observedAt < readyAt) {
    throw new FeeCollectionPendingError(readyAt, observedAt);
  }
}
