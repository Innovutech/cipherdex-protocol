export const CIPHERDEX_TRANSFER_AMOUNT_MISMATCH_SELECTOR = "0xb0a6ea29" as const;

export const CIPHERDEX_EXECUTION_ISSUE_CODE = Object.freeze({
  TOKEN_TRANSFER_AMOUNT_MISMATCH: "token-transfer-amount-mismatch",
} as const);

export type CipherDexExecutionOperation =
  | "public-swap"
  | "public-create-or-add-liquidity"
  | "public-remove-liquidity"
  | "public-native-swap"
  | "public-native-create-or-add-liquidity"
  | "public-native-remove-liquidity"
  | "public-protocol-fee-collection";

export type CipherDexExecutionStage = "preflight" | "execution";

export type CipherDexExecutionContext = Readonly<{
  operation: CipherDexExecutionOperation;
  tokenAddress?: string;
  stage?: CipherDexExecutionStage;
}>;

export type CipherDexExecutionIssue = Readonly<{
  code: typeof CIPHERDEX_EXECUTION_ISSUE_CODE.TOKEN_TRANSFER_AMOUNT_MISMATCH;
  kind: "token-transfer-semantics";
  selector: typeof CIPHERDEX_TRANSFER_AMOUNT_MISMATCH_SELECTOR;
  operation: CipherDexExecutionOperation;
  stage: CipherDexExecutionStage;
  tokenAddress?: string;
  retryableWithSameState: false;
  compatibilityMayChange: true;
}>;

export type CipherDexPreflightTransaction = Readonly<{
  from: string;
  to: string;
  data: string;
  value?: bigint;
  gasLimit?: bigint;
}>;

export interface CipherDexPreflightAdapter {
  estimateGas(transaction: CipherDexPreflightTransaction): Promise<bigint>;
}

export type CipherDexPreflightResult =
  | Readonly<{
    ok: true;
    gasEstimate: bigint;
  }>
  | Readonly<{
    ok: false;
    issue: CipherDexExecutionIssue;
  }>;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = /^0x0{40}$/i;
const BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;
const REVERT_DATA = /^0x(?:[0-9a-fA-F]{2}){4,}$/;
const UINT256_LIMIT = 1n << 256n;
const ERROR_LINK_KEYS = Object.freeze([
  "data",
  "error",
  "cause",
  "info",
  "revert",
  "result",
  "originalError",
] as const);
const MAX_ERROR_NODES = 32;

function ownDataProperty(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function revertSelector(value: unknown): string | undefined {
  const queue: unknown[] = [value];
  const seen = new Set<object>();
  let visited = 0;
  while (queue.length > 0 && visited < MAX_ERROR_NODES) {
    const candidate = queue.shift();
    visited += 1;
    if (typeof candidate === "string") {
      if (REVERT_DATA.test(candidate)) return candidate.slice(0, 10).toLowerCase();
      continue;
    }
    if (!candidate || typeof candidate !== "object" || seen.has(candidate)) continue;
    seen.add(candidate);
    for (const key of ERROR_LINK_KEYS) {
      const nested = ownDataProperty(candidate, key);
      if (nested !== undefined) queue.push(nested);
    }
  }
  return undefined;
}

function assertAddress(value: string, label: string): void {
  if (!ADDRESS.test(value) || ZERO_ADDRESS.test(value)) {
    throw new TypeError(`Invalid CipherDEX ${label}`);
  }
}

function assertQuantity(value: bigint | undefined, label: string, allowZero: boolean): void {
  if (
    value !== undefined &&
    (
      typeof value !== "bigint" ||
      value < (allowZero ? 0n : 1n) ||
      value >= UINT256_LIMIT
    )
  ) {
    throw new TypeError(`Invalid CipherDEX ${label}`);
  }
}

function normalizedContext(context: CipherDexExecutionContext): Readonly<{
  operation: CipherDexExecutionOperation;
  stage: CipherDexExecutionStage;
  tokenAddress?: string;
}> {
  if (
    context.operation !== "public-swap" &&
    context.operation !== "public-create-or-add-liquidity" &&
    context.operation !== "public-remove-liquidity" &&
    context.operation !== "public-native-swap" &&
    context.operation !== "public-native-create-or-add-liquidity" &&
    context.operation !== "public-native-remove-liquidity" &&
    context.operation !== "public-protocol-fee-collection"
  ) {
    throw new TypeError("Invalid CipherDEX execution operation");
  }
  const stage = context.stage ?? "execution";
  if (stage !== "preflight" && stage !== "execution") {
    throw new TypeError("Invalid CipherDEX execution stage");
  }
  if (context.tokenAddress !== undefined) {
    assertAddress(context.tokenAddress, "execution token address");
  }
  return Object.freeze({
    operation: context.operation,
    stage,
    ...(context.tokenAddress ? { tokenAddress: context.tokenAddress } : {}),
  });
}

export function classifyCipherDexExecutionError(
  error: unknown,
  context: CipherDexExecutionContext,
): CipherDexExecutionIssue | null {
  const normalized = normalizedContext(context);
  if (revertSelector(error) !== CIPHERDEX_TRANSFER_AMOUNT_MISMATCH_SELECTOR) {
    return null;
  }
  return Object.freeze({
    code: CIPHERDEX_EXECUTION_ISSUE_CODE.TOKEN_TRANSFER_AMOUNT_MISMATCH,
    kind: "token-transfer-semantics" as const,
    selector: CIPHERDEX_TRANSFER_AMOUNT_MISMATCH_SELECTOR,
    operation: normalized.operation,
    stage: normalized.stage,
    ...(normalized.tokenAddress ? { tokenAddress: normalized.tokenAddress } : {}),
    retryableWithSameState: false as const,
    compatibilityMayChange: true as const,
  });
}

export async function preflightCipherDexTransaction(input: Readonly<{
  adapter: CipherDexPreflightAdapter;
  transaction: CipherDexPreflightTransaction;
  context: Omit<CipherDexExecutionContext, "stage">;
}>): Promise<CipherDexPreflightResult> {
  if (!input.adapter || typeof input.adapter.estimateGas !== "function") {
    throw new TypeError("Invalid CipherDEX preflight adapter");
  }
  assertAddress(input.transaction.from, "preflight sender");
  assertAddress(input.transaction.to, "preflight target");
  if (!BYTES.test(input.transaction.data)) {
    throw new TypeError("Invalid CipherDEX preflight data");
  }
  assertQuantity(input.transaction.value, "preflight value", true);
  assertQuantity(input.transaction.gasLimit, "preflight gas limit", false);
  const transaction = Object.freeze({ ...input.transaction });
  let gasEstimate: bigint;
  try {
    gasEstimate = await input.adapter.estimateGas(transaction);
  } catch (error) {
    const issue = classifyCipherDexExecutionError(error, {
      ...input.context,
      stage: "preflight",
    });
    if (issue) return Object.freeze({ ok: false as const, issue });
    throw new TypeError("Unable to preflight CipherDEX transaction", { cause: error });
  }
  assertQuantity(gasEstimate, "preflight gas estimate", false);
  return Object.freeze({ ok: true as const, gasEstimate });
}
