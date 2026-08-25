export type LiquiditySide = "token0" | "token1";
export declare const PUBLIC_LIQUIDITY_ROUTED_TOPIC: "0xf57701d662488466310aef8303deec83f9fbfa81b6327d4577152fbc12634d4b";
export declare const NATIVE_LIQUIDITY_ADDED_TOPIC: "0x6241df93d44bd96caf1d9efe1ba8da46b54ba15df7beea93efec7c360f756e0e";
export declare const CONFIDENTIAL_LIQUIDITY_QUOTE_RESULT_TOPIC: "0x4069fd369ee96a414b638a1f85119a2360ab4a7e05df9b1816582b1baf87a147";
export type LiquidityCiphertext256 = Readonly<{
    ciphertextHigh: bigint;
    ciphertextLow: bigint;
}>;
export type LiquidityLogEvidence = Readonly<{
    address: string;
    topics: readonly string[];
    data: string;
}>;
export type LiquidityReceiptEvidence = Readonly<{
    transactionHash: string;
    status: number | bigint;
    logs: readonly LiquidityLogEvidence[];
}>;
/** Converts the SDK's explicit side into the protocol's token0-side boolean. */
export declare function liquiditySideToContractBoolean(side: LiquiditySide): boolean;
export type PublicProportionalLiquidityPreview = Readonly<{
    acceptedAmount0: bigint;
    acceptedAmount1: bigint;
    expectedLpShares: bigint;
}>;
/**
 * Mirrors PublicCPMM's existing-pool liquidity rounding in raw token units:
 * shares round down, then both accepted amounts round up.
 */
export declare function previewPublicProportionalLiquidity(input: Readonly<{
    reserve0: bigint;
    reserve1: bigint;
    totalLpShares: bigint;
    specifiedSide: LiquiditySide;
    specifiedAmount: bigint;
}>): PublicProportionalLiquidityPreview;
export type PublicLiquidityRoutedResult = Readonly<{
    transactionHash: string;
    provider: string;
    pool: string;
    poolCreated: boolean;
    amount0Used: bigint;
    amount1Used: bigint;
    mintedLpShares: bigint;
    amount0Refunded: bigint;
    amount1Refunded: bigint;
}>;
/** Authenticates the unique liquidity-router result in a successful receipt. */
export declare function parsePublicLiquidityRoutedResult(expectation: Readonly<{
    transactionHash: string;
    liquidityRouter: string;
    provider: string;
    maximumAmount0: bigint;
    maximumAmount1: bigint;
}>, receipt: LiquidityReceiptEvidence): PublicLiquidityRoutedResult;
export type NativeLiquidityAddedResult = Readonly<{
    transactionHash: string;
    provider: string;
    recipient: string;
    pool: string;
    poolCreated: boolean;
    pairedToken: string;
    nativeAmountUsed: bigint;
    tokenAmountUsed: bigint;
    mintedLpShares: bigint;
    nativeAmountRefunded: bigint;
    tokenAmountRefunded: bigint;
}>;
/**
 * Authenticates NativeLiquidityAdded and its nested PublicLiquidityRouted event,
 * including the canonical WCOTI/token ordering used to derive pool creation.
 */
export declare function parseNativeLiquidityAddedResult(expectation: Readonly<{
    transactionHash: string;
    nativeRouter: string;
    liquidityRouter: string;
    wrappedNative: string;
    provider: string;
    recipient: string;
    pairedToken: string;
    maximumNativeAmount: bigint;
    maximumTokenAmount: bigint;
}>, receipt: LiquidityReceiptEvidence): NativeLiquidityAddedResult;
export type ConfidentialAddLiquidityQuoteResult = Readonly<{
    transactionHash: string;
    pool: string;
    caller: string;
    requestId: string;
    specifiedSide: LiquiditySide;
    acceptedAmount0: LiquidityCiphertext256;
    acceptedAmount1: LiquidityCiphertext256;
    expectedLpShares: LiquidityCiphertext256;
}>;
/**
 * Authenticates and parses one confidential preview event without decrypting it.
 * Ciphertext decryption remains the connected wallet's responsibility.
 */
export declare function parseConfidentialAddLiquidityQuoteResult(expectation: Readonly<{
    transactionHash: string;
    pool: string;
    caller: string;
    requestId: string;
    specifiedSide: LiquiditySide;
}>, receipt: LiquidityReceiptEvidence): ConfidentialAddLiquidityQuoteResult;
