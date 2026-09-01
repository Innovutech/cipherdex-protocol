export declare const PUBLIC_ROUTE_CANDIDATE: Readonly<{
    readonly LOW_5_BPS: 1;
    readonly STANDARD_30_BPS: 2;
    readonly HIGH_100_BPS: 4;
    readonly ALL: 7;
}>;
export declare const PUBLIC_LIMIT_ORDER_CREATED_TOPIC: "0x1ab8aeda179c2038ab835a8f7689b6016641946b9b9a3f129a893ab02a3bc78b";
export declare const PUBLIC_LIMIT_ORDER_AMENDED_TOPIC: "0xc8f1bf6a229ab9ac9ade2efc79c6f64ae0cc4eff57455c69f45a4f56f06e0106";
export declare const PUBLIC_LIMIT_ORDER_FILLED_TOPIC: "0x4eccc8a2abb5a0810b0765d135c8829316e4cd9bd2c00dc7362e4be54e54f0fc";
export declare const PUBLIC_LIMIT_ORDER_CANCELLED_TOPIC: "0x8cd7e382eb42bcc84841dacd15adda3bdd77aefce75edd49238bd47995b1f968";
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
export type PublicLimitOrderCreateCall = Readonly<{
    functionName: "createOrder";
    args: readonly [PublicLimitOrderCreateParams];
    value: bigint;
}>;
export type PublicLimitOrderPermitCall = Readonly<{
    functionName: "createOrderWithPermit";
    args: readonly [
        PublicLimitOrderCreateParams,
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
export declare function buildPublicLimitOrderCreateCall(params: PublicLimitOrderCreateParams, executionBounty?: bigint): PublicLimitOrderCreateCall;
export declare function buildPublicLimitOrderPermitCall(params: PublicLimitOrderCreateParams, permit: Readonly<{
    deadline: bigint;
    v: number;
    r: string;
    s: string;
}>, executionBounty?: bigint): PublicLimitOrderPermitCall;
export declare function buildPublicLimitOrderAmendCall(orderId: bigint, amendment: PublicLimitOrderAmendment, remainingAmountIn: bigint): PublicLimitOrderAmendCall;
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
}>;
export declare function parsePublicLimitOrderCancelledResult(expectation: Readonly<{
    transactionHash: string;
    orderBook: string;
    orderId: bigint;
    maker: string;
}>, receipt: PublicLimitOrderReceiptEvidence): PublicLimitOrderCancelledResult;
