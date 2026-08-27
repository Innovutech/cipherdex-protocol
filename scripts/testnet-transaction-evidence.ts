import { FundedOperationIdentityError } from "./funded-recovery-journal";

const TRANSACTION_HASH = /^0x[0-9a-fA-F]{64}$/;
const ERROR_SELECTOR = /^0x[0-9a-fA-F]{8}$/;
const UINT64_MAX = (1n << 64n) - 1n;

type ReceiptLike = Readonly<{ hash: string; status: number | null }>;
type TransactionLike<TReceipt extends ReceiptLike> = Readonly<{
  hash: string;
  wait(): Promise<TReceipt | null>;
}>;

type ReplayableTransaction = Readonly<{
  hash: string;
  from: string;
  to: string | null;
  data: string;
  value: bigint;
}>;

export class UnknownBroadcastOutcomeError extends Error {
  readonly transactionHash: string | undefined;

  constructor(label: string, transactionHash: string | undefined, cause?: unknown) {
    super(
      transactionHash
        ? `${label} broadcast outcome is unknown; transactionHash=${transactionHash}; do not retry automatically`
        : `${label} broadcast outcome is unknown; transaction hash unavailable; do not retry automatically`,
      { cause },
    );
    this.name = "UnknownBroadcastOutcomeError";
    this.transactionHash = transactionHash;
  }
}

export class MinedTransactionStatusError extends Error {
  readonly transactionHash: string;
  readonly expectedStatus: 0 | 1;
  readonly actualStatus: 0 | 1;

  constructor(
    label: string,
    transactionHash: string,
    expectedStatus: 0 | 1,
    actualStatus: 0 | 1,
  ) {
    super(
      `${label} mined with status ${actualStatus}; expected ${expectedStatus}; ` +
        `transactionHash=${transactionHash}`,
    );
    this.name = "MinedTransactionStatusError";
    this.transactionHash = transactionHash;
    this.expectedStatus = expectedStatus;
    this.actualStatus = actualStatus;
  }
}

export class MinedFailureReasonError extends Error {
  readonly transactionHash: string;
  readonly expectedSelector: string;
  readonly actualSelector: string | undefined;

  constructor(
    label: string,
    transactionHash: string,
    expectedSelector: string,
    actualSelector: string | undefined,
  ) {
    super(
      `${label} mined with an unexpected revert reason; expectedSelector=${expectedSelector}; ` +
        `actualSelector=${actualSelector ?? "unavailable"}; transactionHash=${transactionHash}`,
    );
    this.name = "MinedFailureReasonError";
    this.transactionHash = transactionHash;
    this.expectedSelector = expectedSelector;
    this.actualSelector = actualSelector;
  }
}

export function transactionHashFromError(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const queue: object[] = [error];
  const visited = new WeakSet<object>();
  let cursor = 0;
  while (cursor < queue.length) {
    const current = queue[cursor];
    cursor += 1;
    if (!current || visited.has(current)) continue;
    visited.add(current);

    let keys: readonly PropertyKey[];
    try {
      keys = Reflect.ownKeys(current);
    } catch {
      continue;
    }
    for (const key of keys) {
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = Object.getOwnPropertyDescriptor(current, key);
      } catch {
        continue;
      }
      if (!descriptor || !("value" in descriptor)) continue;
      const value = descriptor.value as unknown;
      if (
        key === "transactionHash" &&
        typeof value === "string" &&
        TRANSACTION_HASH.test(value)
      ) return value;
      if (value && typeof value === "object" && !visited.has(value)) queue.push(value);
    }
  }
  return undefined;
}

export function publicTransactionHashSuffix(error: unknown): string {
  const transactionHash = transactionHashFromError(error);
  return transactionHash ? ` transactionHash=${transactionHash}` : "";
}

function ownDataProperty(record: object, key: PropertyKey): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function nestedOwnDataProperty(record: object, keys: readonly PropertyKey[]): unknown {
  let current: unknown = record;
  for (const key of keys) {
    if (!current || typeof current !== "object") return undefined;
    current = ownDataProperty(current, key);
  }
  return current;
}

function revertDataCandidate(value: unknown): string | undefined {
  if (
    typeof value === "string" &&
    /^0x(?:[0-9a-fA-F]{2}){4,}$/.test(value)
  ) return value;
  if (!value || typeof value !== "object") return undefined;
  const nested = ownDataProperty(value, "data");
  return typeof nested === "string" && /^0x(?:[0-9a-fA-F]{2}){4,}$/.test(nested)
    ? nested
    : undefined;
}

function revertDataFromCallError(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  for (const candidate of [
    ownDataProperty(error, "data"),
    nestedOwnDataProperty(error, ["info", "error", "data"]),
    nestedOwnDataProperty(error, ["error", "data"]),
    nestedOwnDataProperty(error, ["cause", "data"]),
    nestedOwnDataProperty(error, ["cause", "info", "error", "data"]),
  ]) {
    const data = revertDataCandidate(candidate);
    if (data) return data;
  }
  return undefined;
}

export function futureChainDeadline(
  latestBlockTimestamp: number | bigint,
  validityWindowSeconds: number | bigint,
): bigint {
  if (
    (typeof latestBlockTimestamp === "number" && !Number.isSafeInteger(latestBlockTimestamp)) ||
    (typeof validityWindowSeconds === "number" && !Number.isSafeInteger(validityWindowSeconds))
  ) throw new Error("chain deadline inputs must be safe integers");
  const timestamp = BigInt(latestBlockTimestamp);
  const validityWindow = BigInt(validityWindowSeconds);
  if (timestamp < 0n || validityWindow <= 0n) {
    throw new Error("chain deadline inputs must be positive");
  }
  const deadline = timestamp + validityWindow;
  if (deadline > UINT64_MAX) throw new Error("chain deadline exceeds uint64");
  return deadline;
}

export async function requireMinedFailureSelector(
  label: string,
  transactionHash: string,
  receiptBlockNumber: number,
  expectedSelector: string,
  getTransaction: (hash: string) => Promise<ReplayableTransaction | null>,
  replay: (transaction: ReplayableTransaction, blockTag: number) => Promise<unknown>,
  options: Readonly<{ allowUnavailable?: boolean }> = {},
): Promise<"matched" | "rpc-unavailable"> {
  const normalizedExpectedSelector = expectedSelector.toLowerCase();
  if (
    !TRANSACTION_HASH.test(transactionHash) ||
    !Number.isSafeInteger(receiptBlockNumber) ||
    receiptBlockNumber <= 0 ||
    !ERROR_SELECTOR.test(expectedSelector)
  ) throw new Error(`${label} expected-revert evidence is invalid`);

  const transaction = await getTransaction(transactionHash);
  if (
    !transaction ||
    !TRANSACTION_HASH.test(transaction.hash) ||
    transaction.hash.toLowerCase() !== transactionHash.toLowerCase() ||
    transaction.to === null
  ) {
    throw new MinedFailureReasonError(
      label,
      transactionHash,
      normalizedExpectedSelector,
      undefined,
    );
  }

  let replayError: unknown;
  try {
    await replay(transaction, receiptBlockNumber - 1);
  } catch (error) {
    replayError = error;
  }
  const revertData = revertDataFromCallError(replayError);
  const actualSelector = revertData?.slice(0, 10).toLowerCase();
  if (actualSelector === undefined && options.allowUnavailable === true) {
    return "rpc-unavailable";
  }
  if (actualSelector !== normalizedExpectedSelector) {
    throw new MinedFailureReasonError(
      label,
      transactionHash,
      normalizedExpectedSelector,
      actualSelector,
    );
  }
  return "matched";
}

function safeDiagnosticText(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value
    .replace(/0x[0-9a-fA-F]{16,}/g, "[redacted-hex]")
    .replace(/\b[A-Za-z0-9+/_=-]{32,}\b/g, "[redacted-secret]")
    .replace(/\b\d+\b/g, "[redacted-decimal]")
    .replace(/\s+/g, " ")
    .slice(0, 240);
}

export function safeTestnetErrorSummary(error: unknown, depth = 0): string {
  if (!error || typeof error !== "object") return "name=Error code=unknown";
  const name = safeDiagnosticText(ownDataProperty(error, "name")) ?? "Error";
  const code = safeDiagnosticText(ownDataProperty(error, "code")) ?? "unknown";
  const action = safeDiagnosticText(ownDataProperty(error, "action"));
  const detail = [
    ownDataProperty(error, "shortMessage"),
    nestedOwnDataProperty(error, ["info", "error", "message"]),
    ownDataProperty(error, "message"),
  ].map(safeDiagnosticText).find((candidate) => candidate !== undefined);
  const cause = ownDataProperty(error, "cause");
  const aggregate = ownDataProperty(error, "errors");
  const aggregateLength = Array.isArray(aggregate)
    ? ownDataProperty(aggregate, "length")
    : undefined;
  const aggregateErrors = depth === 0 &&
      Array.isArray(aggregate) &&
      Number.isSafeInteger(aggregateLength) &&
      Number(aggregateLength) >= 0
    ? Array.from({ length: Math.min(Number(aggregateLength), 4) }, (_, index) =>
      ownDataProperty(aggregate, index)
    ).filter((candidate) => candidate !== undefined)
    : [];
  const actionSummary = action ? ` action=${action}` : "";
  const detailSummary = detail ? ` detail=${detail}` : "";
  const causeSummary = depth === 0 && cause
    ? ` cause=(${safeTestnetErrorSummary(cause, depth + 1)})`
    : "";
  const aggregateSummary = aggregateErrors.length > 0
    ? ` errors=[${aggregateErrors.map((candidate) =>
      safeTestnetErrorSummary(candidate, depth + 1)
    ).join("; ")}]`
    : "";
  return `name=${name} code=${code}${actionSummary}${detailSummary}${causeSummary}` +
    aggregateSummary +
    publicTransactionHashSuffix(error);
}

export async function requireMinedReceipt<TReceipt extends ReceiptLike>(
  label: string,
  operation: () => Promise<TransactionLike<TReceipt>>,
  getReceipt: (transactionHash: string) => Promise<TReceipt | null>,
  onBroadcast?: (transactionHash: string) => void | Promise<void>,
  onSubmission?: () => void | Promise<void>,
): Promise<Readonly<{ transactionHash: string; receipt: TReceipt }>> {
  const validate = (
    transactionHash: string,
    receipt: TReceipt | null,
    cause?: unknown,
  ): Readonly<{ transactionHash: string; receipt: TReceipt }> => {
    if (
      !TRANSACTION_HASH.test(transactionHash) ||
      (receipt && (
        !TRANSACTION_HASH.test(receipt.hash) ||
        receipt.hash.toLowerCase() !== transactionHash.toLowerCase()
      ))
    ) {
      throw new UnknownBroadcastOutcomeError(
        label,
        TRANSACTION_HASH.test(transactionHash) ? transactionHash : undefined,
        cause,
      );
    }
    if (receipt?.status === 0 || receipt?.status === 1) {
      return Object.freeze({ transactionHash, receipt });
    }
    throw new UnknownBroadcastOutcomeError(label, transactionHash, cause);
  };

  let transaction: TransactionLike<TReceipt>;
  await onSubmission?.();
  try {
    transaction = await operation();
  } catch (error) {
    if (error instanceof FundedOperationIdentityError) throw error;
    const possibleHash = transactionHashFromError(error);
    if (possibleHash && onBroadcast) {
      try {
        await onBroadcast(possibleHash);
      } catch (journalError) {
        throw new UnknownBroadcastOutcomeError(
          label,
          possibleHash,
          new AggregateError(
            [error, journalError],
            "broadcast failed before its known transaction hash could be journaled",
          ),
        );
      }
    }
    throw new UnknownBroadcastOutcomeError(label, possibleHash, error);
  }

  if (!TRANSACTION_HASH.test(transaction.hash)) {
    throw new UnknownBroadcastOutcomeError(label, undefined);
  }
  try {
    await onBroadcast?.(transaction.hash);
  } catch (error) {
    throw new UnknownBroadcastOutcomeError(label, transaction.hash, error);
  }

  let receipt: TReceipt | null = null;
  let waitError: unknown;
  try {
    receipt = await transaction.wait();
  } catch (error) {
    waitError = error;
  }
  if (!receipt) {
    try {
      receipt = await getReceipt(transaction.hash);
    } catch (error) {
      waitError = error;
    }
  }
  return validate(transaction.hash, receipt, waitError);
}

async function requireMinedStatus<TReceipt extends ReceiptLike>(
  label: string,
  expectedStatus: 0 | 1,
  operation: () => Promise<TransactionLike<TReceipt>>,
  getReceipt: (transactionHash: string) => Promise<TReceipt | null>,
  onBroadcast?: (transactionHash: string) => void | Promise<void>,
  onSubmission?: () => void | Promise<void>,
): Promise<Readonly<{ transactionHash: string; receipt: TReceipt }>> {
  const evidence = await requireMinedReceipt(
    label,
    operation,
    getReceipt,
    onBroadcast,
    onSubmission,
  );
  if (evidence.receipt.status === expectedStatus) return evidence;
  throw new MinedTransactionStatusError(
    label,
    evidence.transactionHash,
    expectedStatus,
    evidence.receipt.status as 0 | 1,
  );
}

export async function requireMinedSuccess<TReceipt extends ReceiptLike>(
  label: string,
  operation: () => Promise<TransactionLike<TReceipt>>,
  getReceipt: (transactionHash: string) => Promise<TReceipt | null>,
  onBroadcast?: (transactionHash: string) => void | Promise<void>,
  onSubmission?: () => void | Promise<void>,
): Promise<Readonly<{ transactionHash: string; receipt: TReceipt }>> {
  return requireMinedStatus(label, 1, operation, getReceipt, onBroadcast, onSubmission);
}

export async function requireMinedFailure<TReceipt extends ReceiptLike>(
  label: string,
  operation: () => Promise<TransactionLike<TReceipt>>,
  getReceipt: (transactionHash: string) => Promise<TReceipt | null>,
  onBroadcast?: (transactionHash: string) => void | Promise<void>,
  onSubmission?: () => void | Promise<void>,
): Promise<Readonly<{ transactionHash: string; receipt: TReceipt }>> {
  return requireMinedStatus(label, 0, operation, getReceipt, onBroadcast, onSubmission);
}
