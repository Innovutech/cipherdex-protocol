export declare const PUBLIC_BEST_SWAP_ROUTED_TOPIC: "0x7009b9725b955187a92a567b8370c19c748af195413c573d23c2d0d961e16606";
export declare const PUBLIC_NATIVE_BEST_SWAP_ROUTED_TOPIC: "0x26e0fbd30b77c21be54d88e6334cc4bd48553d421df331aaedd3054e1e4abc89";
export type PublicBestExecutionKind = "token-to-token" | "native-to-token" | "token-to-native";
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
    functionName: "swapBestExactInput" | "swapExactNativeForToken" | "swapExactTokenForNative";
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
/** Builds the gasless read call used to preview the currently best direct pool. */
export declare function buildPublicBestExecutionQuoteCall(input: Readonly<{
    bestExecutionRouter: string;
    wrappedNative: string;
    tokenIn: string;
    tokenOut: string;
    amountIn: bigint;
    candidateBitmap: number;
}>): PublicBestExecutionQuoteCall;
/** Validates the decoded return value from quoteBestExactInput. */
export declare function parsePublicBestExecutionQuoteResult(raw: readonly unknown[] | Readonly<Record<string, unknown>>, candidateBitmap: number): PublicBestExecutionQuoteResult;
/** Builds the confirmed swap; execution reselects the best allowed pool atomically. */
export declare function buildPublicBestExactInputSwapExecution(input: Readonly<{
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
}>): PublicBestExecutionSwap;
/** Authenticates the actual route selected by the confirmed swap transaction. */
export declare function parsePublicBestExecutionSwapResult(expectation: Readonly<{
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
}>, receipt: PublicBestExecutionReceiptEvidence): PublicBestExecutionSwapResult;
