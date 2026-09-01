export declare const PUBLIC_ROUTE_CANDIDATE: Readonly<{
    readonly LOW_5_BPS: 1;
    readonly STANDARD_30_BPS: 2;
    readonly HIGH_100_BPS: 4;
    readonly ALL: 7;
}>;
export declare const PUBLIC_LIMIT_ORDER_CREATED_TOPIC: "0xb54b6759bc638a44ecc0c4ae0fc28a63db98c74f3b53505bf76776cce27d868d";
export declare const PUBLIC_LIMIT_ORDER_AMENDED_TOPIC: "0xc8f1bf6a229ab9ac9ade2efc79c6f64ae0cc4eff57455c69f45a4f56f06e0106";
export declare const PUBLIC_LIMIT_ORDER_FILLED_TOPIC: "0x8b3001790d58ea1454f7416c054d85615e21a0fcceeac2a45fbdcf96cc0c7def";
export declare const PUBLIC_LIMIT_ORDER_CANCELLED_TOPIC: "0xeb72ace299a35d4e17b4e9a192803c5d21779feacb2e8de865e8a1efede01dbc";
export declare const PUBLIC_LIMIT_ORDER_SETTLEMENT: Readonly<{
    readonly TOKEN: 0;
    readonly NATIVE_INPUT: 1;
    readonly NATIVE_OUTPUT: 2;
}>;
export type PublicLimitOrderSettlement = "token" | "native-input" | "native-output";
export type PublicLimitOrderCreateParams = Readonly<{
    tokenIn: string;
    tokenOut: string;
    amountIn: bigint;
    minAmountOut: bigint;
    recipient: string;
    expiry: bigint;
    candidateBitmap: number;
    allowPartialFills: boolean;
    minimumFillAmount: bigint;
}>;
export type PublicLimitOrderAmendment = Readonly<{
    recipient: string;
    minAmountOutForRemaining: bigint;
    expiry: bigint;
    candidateBitmap: number;
    allowPartialFills: boolean;
    minimumFillAmount: bigint;
}>;
export type PublicLimitOrderContractCreateParams = Readonly<PublicLimitOrderCreateParams & {
    settlementMode: number;
}>;
export type PublicLimitOrderCreateOptions = Readonly<{
    wrappedNative: string;
    executionBounty?: bigint;
}>;
export type PublicLimitOrderCreateCall = Readonly<{
    functionName: "createOrder";
    args: readonly [PublicLimitOrderContractCreateParams];
    value: bigint;
}>;
export type PublicLimitOrderPermitCall = Readonly<{
    functionName: "createOrderWithPermit";
    args: readonly [
        PublicLimitOrderContractCreateParams,
        bigint,
        number,
        string,
        string
    ];
    value: bigint;
}>;
export type PublicLimitOrderAmendCall = Readonly<{
    functionName: "amendOrder";
    args: readonly [bigint, PublicLimitOrderAmendment];
}>;
export type PublicLimitOrderFillCall = Readonly<{
    functionName: "fillOrder";
    args: readonly [bigint, bigint];
}>;
export declare function buildPublicLimitOrderCreateCall(params: PublicLimitOrderCreateParams, options: PublicLimitOrderCreateOptions): PublicLimitOrderCreateCall;
export declare function buildPublicLimitOrderPermitCall(params: PublicLimitOrderCreateParams, permit: Readonly<{
    deadline: bigint;
    v: number;
    r: string;
    s: string;
}>, options: PublicLimitOrderCreateOptions): PublicLimitOrderPermitCall;
export declare function buildPublicLimitOrderAmendCall(orderId: bigint, amendment: PublicLimitOrderAmendment, remainingAmountIn: bigint, wrappedNative: string): PublicLimitOrderAmendCall;
export declare function buildPublicLimitOrderFillCall(orderId: bigint, amountInToFill: bigint): PublicLimitOrderFillCall;
/** Mirrors the order book's full-precision ceiling price calculation. */
export declare function publicLimitOrderMinimumOutput(input: Readonly<{
    amountInToFill: bigint;
    priceNumerator: bigint;
    priceDenominator: bigint;
}>): bigint;
/** Mirrors proportional floor payout, including the final-fill remainder rule. */
export declare function publicLimitOrderBountyForFill(input: Readonly<{
    remainingBounty: bigint;
    amountInToFill: bigint;
    remainingAmountIn: bigint;
}>): bigint;
export type PublicLimitOrderLogEvidence = Readonly<{
    address: string;
    topics: readonly string[];
    data: string;
}>;
export type PublicLimitOrderReceiptEvidence = Readonly<{
    transactionHash: string;
    status: number | bigint;
    logs: readonly PublicLimitOrderLogEvidence[];
}>;
export type PublicLimitOrderCreatedResult = Readonly<{
    transactionHash: string;
    orderId: bigint;
    maker: string;
    tokenIn: string;
    tokenOut: string;
    recipient: string;
    amountIn: bigint;
    minAmountOut: bigint;
    expiry: bigint;
    candidateBitmap: number;
    allowPartialFills: boolean;
    minimumFillAmount: bigint;
    executionBounty: bigint;
    settlement: PublicLimitOrderSettlement;
}>;
export declare function parsePublicLimitOrderCreatedResult(expectation: Readonly<{
    transactionHash: string;
    orderBook: string;
    maker: string;
    tokenIn: string;
}>, receipt: PublicLimitOrderReceiptEvidence): PublicLimitOrderCreatedResult;
export type PublicLimitOrderAmendedResult = Readonly<{
    transactionHash: string;
    orderId: bigint;
    maker: string;
    revision: bigint;
    recipient: string;
    minAmountOutForRemaining: bigint;
    expiry: bigint;
    candidateBitmap: number;
    allowPartialFills: boolean;
    minimumFillAmount: bigint;
}>;
export declare function parsePublicLimitOrderAmendedResult(expectation: Readonly<{
    transactionHash: string;
    orderBook: string;
    orderId: bigint;
    maker: string;
}>, receipt: PublicLimitOrderReceiptEvidence): PublicLimitOrderAmendedResult;
export type PublicLimitOrderFilledResult = Readonly<{
    transactionHash: string;
    orderId: bigint;
    maker: string;
    filler: string;
    recipient: string;
    selectedPool: string;
    selectedFeeBps: bigint;
    amountIn: bigint;
    amountOut: bigint;
    minimumAmountOut: bigint;
    remainingAmountIn: bigint;
    executionBounty: bigint;
    settlement: PublicLimitOrderSettlement;
}>;
export declare function parsePublicLimitOrderFilledResult(expectation: Readonly<{
    transactionHash: string;
    orderBook: string;
    orderId: bigint;
    maker: string;
}>, receipt: PublicLimitOrderReceiptEvidence): PublicLimitOrderFilledResult;
export type PublicLimitOrderCancelledResult = Readonly<{
    transactionHash: string;
    orderId: bigint;
    maker: string;
    returnedAmountIn: bigint;
    returnedExecutionBounty: bigint;
    settlement: PublicLimitOrderSettlement;
}>;
export declare function parsePublicLimitOrderCancelledResult(expectation: Readonly<{
    transactionHash: string;
    orderBook: string;
    orderId: bigint;
    maker: string;
}>, receipt: PublicLimitOrderReceiptEvidence): PublicLimitOrderCancelledResult;
