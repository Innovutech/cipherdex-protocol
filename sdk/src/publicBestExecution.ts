import {
  EVM_NATIVE_ASSET_ADDRESS,
  isEvmNativeAssetAddress,
} from "./nativeAsset.js";

export const PUBLIC_BEST_SWAP_ROUTED_TOPIC =
  "0x7009b9725b955187a92a567b8370c19c748af195413c573d23c2d0d961e16606" as const;
export const PUBLIC_NATIVE_BEST_SWAP_ROUTED_TOPIC =
  "0x26e0fbd30b77c21be54d88e6334cc4bd48553d421df331aaedd3054e1e4abc89" as const;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = /^0x0{40}$/i;
const TRANSACTION_HASH = /^0x[0-9a-fA-F]{64}$/;
const UINT64_MAX = (1n << 64n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;
const ALL_CANDIDATE_BITMAP = 7;
const MAX_RECEIPT_LOGS = 256;

export type PublicBestExecutionKind =
  | "token-to-token"
  | "native-to-token"
  | "token-to-native";

export type PublicBestExecutionQuoteCall = Readonly<{
  to: string;
  functionName: "quoteBestExactInput";
  args: readonly [string, string, bigint, number];
  value: 0n;
  resolvedTokenIn: string;
  resolvedTokenOut: string;
}>;

export type PublicBestExecutionQuoteResult = Readonly<{
  selectedPool: string;
  selectedFeeBps: bigint;
  zeroForOne: boolean;
  amountOut: bigint;
}>;

export type PublicBestExecutionSwap = Readonly<{
  kind: PublicBestExecutionKind;
  to: string;
  functionName:
    | "swapBestExactInput"
    | "swapExactNativeForToken"
    | "swapExactTokenForNative";
  args: readonly unknown[];
  value: bigint;
  approvalSpender: string | null;
  resolvedTokenIn: string;
  resolvedTokenOut: string;
  candidateBitmap: number;
}>;

export type PublicBestExecutionLogEvidence = Readonly<{
  address: string;
  topics: readonly string[];
  data: string;
}>;

export type PublicBestExecutionReceiptEvidence = Readonly<{
  transactionHash: string;
  status: number | bigint | string;
  logs: readonly PublicBestExecutionLogEvidence[];
}>;

export type PublicBestExecutionSwapResult = Readonly<{
  transactionHash: string;
  kind: PublicBestExecutionKind;
  trader: string;
  recipient: string;
  selectedPool: string;
  selectedFeeBps: bigint;
  candidateBitmap: number;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  amountOut: bigint;
}>;

function assertAddress(value: string, label: string): void {
  if (!ADDRESS.test(value) || ZERO_ADDRESS.test(value)) {
    throw new TypeError(`Invalid ${label} address`);
  }
}

function assertUint256(value: bigint, label: string, allowZero = false): void {
  if (
    typeof value !== "bigint" ||
    value < (allowZero ? 0n : 1n) ||
    value > UINT256_MAX
  ) throw new TypeError(`Invalid ${label}`);
}

function assertCandidateBitmap(value: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    (value & ~ALL_CANDIDATE_BITMAP) !== 0
  ) throw new TypeError("Invalid public best-execution candidate bitmap");
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function resolveUserAsset(token: string, wrappedNative: string): Readonly<{
  native: boolean;
  resolved: string;
}> {
  const native = isEvmNativeAssetAddress(token);
  if (native) return Object.freeze({ native, resolved: wrappedNative });
  assertAddress(token, "public best-execution token");
  if (sameAddress(token, wrappedNative)) {
    throw new TypeError("Wrapped native token is internal to public best execution");
  }
  return Object.freeze({ native, resolved: token });
}

function resolvedPair(input: Readonly<{
  tokenIn: string;
  tokenOut: string;
  wrappedNative: string;
}>): Readonly<{
  kind: PublicBestExecutionKind;
  resolvedTokenIn: string;
  resolvedTokenOut: string;
}> {
  assertAddress(input.wrappedNative, "wrapped native token");
  const tokenIn = resolveUserAsset(input.tokenIn, input.wrappedNative);
  const tokenOut = resolveUserAsset(input.tokenOut, input.wrappedNative);
  if (tokenIn.native && tokenOut.native) {
    throw new TypeError("Native-to-native public swaps are not supported");
  }
  if (sameAddress(tokenIn.resolved, tokenOut.resolved)) {
    throw new TypeError("Public best-execution tokens must differ");
  }
  return Object.freeze({
    kind: tokenIn.native
      ? "native-to-token"
      : tokenOut.native
        ? "token-to-native"
        : "token-to-token",
    resolvedTokenIn: tokenIn.resolved,
    resolvedTokenOut: tokenOut.resolved,
  });
}

/** Builds the gasless read call used to preview the currently best direct pool. */
export function buildPublicBestExecutionQuoteCall(input: Readonly<{
  bestExecutionRouter: string;
  wrappedNative: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  candidateBitmap: number;
}>): PublicBestExecutionQuoteCall {
  assertAddress(input.bestExecutionRouter, "public best-execution router");
  assertUint256(input.amountIn, "public best-execution quote amount");
  assertCandidateBitmap(input.candidateBitmap);
  const pair = resolvedPair(input);
  return Object.freeze({
    to: input.bestExecutionRouter,
    functionName: "quoteBestExactInput" as const,
    args: Object.freeze([
      pair.resolvedTokenIn,
      pair.resolvedTokenOut,
      input.amountIn,
      input.candidateBitmap,
    ] as const),
    value: 0n as const,
    resolvedTokenIn: pair.resolvedTokenIn,
    resolvedTokenOut: pair.resolvedTokenOut,
  });
}

/** Validates the decoded return value from quoteBestExactInput. */
export function parsePublicBestExecutionQuoteResult(
  raw: readonly unknown[] | Readonly<Record<string, unknown>>,
  candidateBitmap: number,
): PublicBestExecutionQuoteResult {
  assertCandidateBitmap(candidateBitmap);
  const record = raw as Readonly<Record<string, unknown>>;
  const list = raw as readonly unknown[];
  const selectedPool = record.selectedPool ?? list[0];
  const selectedFeeBps = record.selectedFeeBps ?? list[1];
  const zeroForOne = record.zeroForOne ?? list[2];
  const amountOut = record.amountOut ?? list[3];
  if (
    typeof selectedPool !== "string" ||
    typeof selectedFeeBps !== "bigint" ||
    typeof zeroForOne !== "boolean" ||
    typeof amountOut !== "bigint"
  ) throw new TypeError("Invalid public best-execution quote result");
  assertAddress(selectedPool, "selected public pool");
  assertUint256(amountOut, "public best-execution quote output");
  const requiredCandidate = selectedFeeBps === 5n
    ? 1
    : selectedFeeBps === 30n
      ? 2
      : selectedFeeBps === 100n
        ? 4
        : 0;
  if (requiredCandidate === 0 || (candidateBitmap & requiredCandidate) === 0) {
    throw new TypeError("Public best-execution quote selected an unauthorized fee tier");
  }
  return Object.freeze({ selectedPool, selectedFeeBps, zeroForOne, amountOut });
}

/** Builds the confirmed swap; execution reselects the best allowed pool atomically. */
export function buildPublicBestExactInputSwapExecution(input: Readonly<{
  bestExecutionRouter: string;
  nativeBestExecutionRouter?: string;
  wrappedNative: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  minAmountOut: bigint;
  candidateBitmap: number;
  recipient: string;
  deadline: bigint;
}>): PublicBestExecutionSwap {
  assertAddress(input.bestExecutionRouter, "public best-execution router");
  assertAddress(input.recipient, "public best-execution recipient");
  assertUint256(input.amountIn, "public best-execution swap amount");
  assertUint256(input.minAmountOut, "public best-execution minimum output", true);
  assertCandidateBitmap(input.candidateBitmap);
  if (
    typeof input.deadline !== "bigint" ||
    input.deadline <= 0n ||
    input.deadline > UINT64_MAX
  ) throw new TypeError("Invalid public best-execution deadline");
  const pair = resolvedPair(input);
  const nativeRouter = input.nativeBestExecutionRouter;
  if (pair.kind !== "token-to-token") {
    if (!nativeRouter) {
      throw new TypeError("Public native best-execution router is required");
    }
    assertAddress(nativeRouter, "public native best-execution router");
  }
  for (const forbidden of [
    input.bestExecutionRouter,
    input.wrappedNative,
    ...(nativeRouter ? [nativeRouter] : []),
  ]) {
    if (sameAddress(input.recipient, forbidden)) {
      throw new TypeError("Invalid public best-execution recipient address");
    }
  }

  if (pair.kind === "native-to-token") {
    return Object.freeze({
      kind: pair.kind,
      to: nativeRouter!,
      functionName: "swapExactNativeForToken" as const,
      args: Object.freeze([
        pair.resolvedTokenOut,
        input.minAmountOut,
        input.candidateBitmap,
        input.recipient,
        input.deadline,
      ] as const),
      value: input.amountIn,
      approvalSpender: null,
      resolvedTokenIn: pair.resolvedTokenIn,
      resolvedTokenOut: pair.resolvedTokenOut,
      candidateBitmap: input.candidateBitmap,
    });
  }
  if (pair.kind === "token-to-native") {
    return Object.freeze({
      kind: pair.kind,
      to: nativeRouter!,
      functionName: "swapExactTokenForNative" as const,
      args: Object.freeze([
        pair.resolvedTokenIn,
        input.amountIn,
        input.minAmountOut,
        input.candidateBitmap,
        input.recipient,
        input.deadline,
      ] as const),
      value: 0n,
      approvalSpender: nativeRouter!,
      resolvedTokenIn: pair.resolvedTokenIn,
      resolvedTokenOut: pair.resolvedTokenOut,
      candidateBitmap: input.candidateBitmap,
    });
  }
  return Object.freeze({
    kind: pair.kind,
    to: input.bestExecutionRouter,
    functionName: "swapBestExactInput" as const,
    args: Object.freeze([
      pair.resolvedTokenIn,
      pair.resolvedTokenOut,
      input.amountIn,
      input.minAmountOut,
      input.candidateBitmap,
      input.recipient,
      input.deadline,
    ] as const),
    value: 0n,
    approvalSpender: input.bestExecutionRouter,
    resolvedTokenIn: pair.resolvedTokenIn,
    resolvedTokenOut: pair.resolvedTokenOut,
    candidateBitmap: input.candidateBitmap,
  });
}

function receiptSucceeded(status: number | bigint | string): boolean {
  return status === 1 || status === 1n || status === "0x1" || status === "1";
}

function topicAddress(value: string | undefined): string | undefined {
  if (!value || !/^0x0{24}[0-9a-fA-F]{40}$/.test(value)) return undefined;
  const address = `0x${value.slice(26)}`;
  return ZERO_ADDRESS.test(address) ? undefined : address;
}

function dataWords(data: string): readonly string[] | undefined {
  if (!/^0x[0-9a-fA-F]{384}$/.test(data)) return undefined;
  return Object.freeze(Array.from({ length: 6 }, (_, index) =>
    data.slice(2 + index * 64, 2 + (index + 1) * 64)));
}

function wordAddress(value: string | undefined, allowZero: boolean): string | undefined {
  if (!value || !/^0{24}[0-9a-fA-F]{40}$/.test(value)) return undefined;
  const address = `0x${value.slice(24)}`;
  return !allowZero && ZERO_ADDRESS.test(address) ? undefined : address;
}

function wordUint(value: string | undefined): bigint | undefined {
  return value && /^[0-9a-fA-F]{64}$/.test(value)
    ? BigInt(`0x${value}`)
    : undefined;
}

function uniqueLog(
  logs: readonly PublicBestExecutionLogEvidence[],
  emitter: string,
  topic: string,
): PublicBestExecutionLogEvidence {
  const matches = logs.filter((log) =>
    sameAddress(log.address, emitter) && log.topics[0]?.toLowerCase() === topic);
  if (matches.length !== 1) {
    throw new TypeError("Expected one authenticated public best-execution result event");
  }
  return matches[0]!;
}

function decodeSwapLog(
  log: PublicBestExecutionLogEvidence,
  allowNativeToken: boolean,
): Readonly<{
  trader: string;
  selectedPool: string;
  recipient: string;
  inputToken: string;
  outputToken: string;
  selectedFeeBps: bigint;
  candidateBitmap: number;
  amountIn: bigint;
  amountOut: bigint;
}> {
  const trader = topicAddress(log.topics[1]);
  const selectedPool = topicAddress(log.topics[2]);
  const recipient = topicAddress(log.topics[3]);
  const words = dataWords(log.data);
  const inputToken = wordAddress(words?.[0], allowNativeToken);
  const outputToken = wordAddress(words?.[1], allowNativeToken);
  const selectedFeeBps = wordUint(words?.[2]);
  const candidateBitmap = wordUint(words?.[3]);
  const amountIn = wordUint(words?.[4]);
  const amountOut = wordUint(words?.[5]);
  if (
    log.topics.length !== 4 ||
    !trader || !selectedPool || !recipient ||
    inputToken === undefined || outputToken === undefined ||
    selectedFeeBps === undefined ||
    candidateBitmap === undefined || candidateBitmap > 255n ||
    amountIn === undefined || amountIn === 0n ||
    amountOut === undefined || amountOut === 0n
  ) throw new TypeError("Invalid public best-execution result event encoding");
  return Object.freeze({
    trader,
    selectedPool,
    recipient,
    inputToken,
    outputToken,
    selectedFeeBps,
    candidateBitmap: Number(candidateBitmap),
    amountIn,
    amountOut,
  });
}

/** Authenticates the actual route selected by the confirmed swap transaction. */
export function parsePublicBestExecutionSwapResult(
  expectation: Readonly<{
    transactionHash: string;
    bestExecutionRouter: string;
    nativeBestExecutionRouter?: string;
    wrappedNative: string;
    trader: string;
    recipient: string;
    tokenIn: string;
    tokenOut: string;
    amountIn: bigint;
    minAmountOut: bigint;
    candidateBitmap: number;
  }>,
  receipt: PublicBestExecutionReceiptEvidence,
): PublicBestExecutionSwapResult {
  if (!TRANSACTION_HASH.test(expectation.transactionHash)) {
    throw new TypeError("Invalid public best-execution transaction hash");
  }
  if (
    !sameAddress(receipt.transactionHash, expectation.transactionHash) ||
    !receiptSucceeded(receipt.status) ||
    receipt.logs.length > MAX_RECEIPT_LOGS
  ) throw new TypeError("Invalid public best-execution receipt");
  assertAddress(expectation.bestExecutionRouter, "public best-execution router");
  assertAddress(expectation.wrappedNative, "wrapped native token");
  assertAddress(expectation.trader, "public best-execution trader");
  assertAddress(expectation.recipient, "public best-execution recipient");
  assertUint256(expectation.amountIn, "public best-execution swap amount");
  assertUint256(expectation.minAmountOut, "public best-execution minimum output", true);
  assertCandidateBitmap(expectation.candidateBitmap);
  const pair = resolvedPair(expectation);
  const nativeRouter = expectation.nativeBestExecutionRouter;
  if (pair.kind !== "token-to-token") {
    if (!nativeRouter) {
      throw new TypeError("Public native best-execution router is required");
    }
    assertAddress(nativeRouter, "public native best-execution router");
  }

  const best = decodeSwapLog(uniqueLog(
    receipt.logs,
    expectation.bestExecutionRouter,
    PUBLIC_BEST_SWAP_ROUTED_TOPIC,
  ), false);
  let result = best;
  if (pair.kind !== "token-to-token") {
    const native = decodeSwapLog(uniqueLog(
      receipt.logs,
      nativeRouter!,
      PUBLIC_NATIVE_BEST_SWAP_ROUTED_TOPIC,
    ), true);
    const nativeInput = pair.kind === "native-to-token";
    if (
      !sameAddress(native.trader, expectation.trader) ||
      !sameAddress(native.recipient, expectation.recipient) ||
      !sameAddress(native.selectedPool, best.selectedPool) ||
      native.selectedFeeBps !== best.selectedFeeBps ||
      native.candidateBitmap !== best.candidateBitmap ||
      native.amountIn !== best.amountIn ||
      native.amountOut !== best.amountOut ||
      (nativeInput
        ? !ZERO_ADDRESS.test(native.inputToken) ||
          !sameAddress(native.outputToken, pair.resolvedTokenOut) ||
          !sameAddress(best.trader, nativeRouter!) ||
          !sameAddress(best.recipient, expectation.recipient)
        : !sameAddress(native.inputToken, pair.resolvedTokenIn) ||
          !ZERO_ADDRESS.test(native.outputToken) ||
          !sameAddress(best.trader, nativeRouter!) ||
          !sameAddress(best.recipient, nativeRouter!))
    ) throw new TypeError("Native and underlying public route evidence disagree");
    result = native;
  } else if (
    !sameAddress(best.trader, expectation.trader) ||
    !sameAddress(best.recipient, expectation.recipient)
  ) throw new TypeError("Public route evidence violates the reviewed swap request");

  if (
    !sameAddress(best.inputToken, pair.resolvedTokenIn) ||
    !sameAddress(best.outputToken, pair.resolvedTokenOut) ||
    result.candidateBitmap !== expectation.candidateBitmap ||
    result.amountIn !== expectation.amountIn ||
    result.amountOut < expectation.minAmountOut
  ) throw new TypeError("Public route evidence violates the reviewed swap request");
  parsePublicBestExecutionQuoteResult([
    result.selectedPool,
    result.selectedFeeBps,
    true,
    result.amountOut,
  ], expectation.candidateBitmap);

  return Object.freeze({
    transactionHash: expectation.transactionHash,
    kind: pair.kind,
    trader: expectation.trader,
    recipient: expectation.recipient,
    selectedPool: result.selectedPool,
    selectedFeeBps: result.selectedFeeBps,
    candidateBitmap: result.candidateBitmap,
    tokenIn: pair.kind === "native-to-token"
      ? EVM_NATIVE_ASSET_ADDRESS
      : pair.resolvedTokenIn,
    tokenOut: pair.kind === "token-to-native"
      ? EVM_NATIVE_ASSET_ADDRESS
      : pair.resolvedTokenOut,
    amountIn: result.amountIn,
    amountOut: result.amountOut,
  });
}
