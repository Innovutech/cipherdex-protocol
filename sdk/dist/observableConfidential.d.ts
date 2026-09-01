export declare const OBSERVABLE_CONFIDENTIAL_PRIVACY_MODE: 2;
export declare const OBSERVABLE_CONFIDENTIAL_PROTOCOL_VERSION: 1;
export declare const OBSERVATION_BUCKET_BPS: 50;
export declare const MIN_OBSERVATION_SWAPS: 3;
export declare const MIN_OBSERVATION_INTERVAL_SECONDS: 120;
export declare const PUBLIC_PRICE_OBSERVATION_TOPIC: "0x51d2f10b0f987bba79c5f16a2cc4351099ce4c0ef967cf98938e543fa6032ce2";
export declare const OBSERVABLE_CONFIDENTIAL_CPMM_ABI: readonly ["function PROTOCOL_VERSION() view returns (uint256)", "function PRIVACY_MODE() view returns (uint8)", "function token0() view returns (address)", "function token1() view returns (address)", "function token0Decimals() view returns (uint8)", "function token1Decimals() view returns (uint8)", "function feeBps() view returns (uint256)", "function feeVault() view returns (address)", "function initializationStrategy() view returns (address)", "function lpToken() view returns (address)", "function initialized() view returns (bool)", "function initialPriceReferenceX18() view returns (uint256)", "function initializeLiquidity(((uint256,uint256),bytes),((uint256,uint256),bytes),((uint256,uint256),bytes),((uint256,uint256),bytes),((uint256,uint256),bytes),uint256,uint64) returns ((uint256,uint256))", "function publicPriceBucketX18() view returns (uint256)", "function publicPriceQuantumX18() view returns (uint256)", "function publicObservationSequence() view returns (uint64)", "function publicObservationAt() view returns (uint64)", "function publicObservationPublishedAt() view returns (uint64)", "function publicObservationActivityCount() view returns (uint32)", "function swapsSinceObservationClose() view returns (uint32)", "function lastObservationClosedAt() view returns (uint64)", "function hasPendingObservation() view returns (bool)", "function pendingObservationAt() view returns (uint64)", "function pendingObservationActivityCount() view returns (uint32)", "function observationDueForNextSwap() view returns (bool)", "event PublicPriceObservation(uint64 indexed sequence,uint256 priceBucketX18,uint64 observedAt,uint64 publishedAt,uint32 activityCount,uint256 quantumX18,bool initial)"];
export declare const OBSERVABLE_CONFIDENTIAL_FACTORY_ABI: readonly ["function PROTOCOL_VERSION() view returns (uint256)", "function PRIVACY_MODE() view returns (uint8)", "function lpTokenFactory() view returns (address)", "function feeVault() view returns (address)", "function bestExecutionRouter() view returns (address)", "function getPool(bytes32) view returns (address)", "function isPool(address) view returns (bool)", "function createPool(address,address,uint8,uint8,uint256) returns (address)", "function poolKey(address,address,uint8,uint8,uint256,address) pure returns (bytes32)", "function allPoolsLength() view returns (uint256)", "function allPools(uint256) view returns (address)", "event PoolCreated(address indexed token0,address indexed token1,uint8 token0Decimals,uint8 token1Decimals,uint256 feeBps,address initializationStrategy,address pool)"];
export declare const OBSERVABLE_CONFIDENTIAL_FEE_VAULT_ABI: readonly ["function PRIVACY_MODE() view returns (uint8)", "function beneficiary() view returns (address)", "function confidentialFactory() view returns (address)", "function nextConfidentialSweepAt(address) view returns (uint64)", "function confidentialEpochCount(address) view returns (uint256)", "function confidentialEpochAt(address,uint256) view returns (uint64)", "function sweepConfidentialToken(address)"];
export declare const OBSERVABLE_LAUNCHPAD_MIGRATOR_EIP712_DOMAIN: {
    readonly name: "CipherDEX Observable Launchpad Migrator";
    readonly version: "1";
};
export declare const OBSERVABLE_LAUNCHPAD_MIGRATION_EIP712_TYPES: readonly [{
    readonly name: "launchId";
    readonly type: "bytes32";
}, {
    readonly name: "initializationStrategy";
    readonly type: "address";
}, {
    readonly name: "creator";
    readonly type: "address";
}, {
    readonly name: "tokenA";
    readonly type: "address";
}, {
    readonly name: "tokenB";
    readonly type: "address";
}, {
    readonly name: "decimalsA";
    readonly type: "uint8";
}, {
    readonly name: "decimalsB";
    readonly type: "uint8";
}, {
    readonly name: "feeBps";
    readonly type: "uint256";
}, {
    readonly name: "initialPriceReferenceX18";
    readonly type: "uint256";
}, {
    readonly name: "encryptedInputsHash";
    readonly type: "bytes32";
}, {
    readonly name: "deadline";
    readonly type: "uint64";
}, {
    readonly name: "withDisposition";
    readonly type: "bool";
}, {
    readonly name: "disposition";
    readonly type: "uint8";
}, {
    readonly name: "unlockTime";
    readonly type: "uint64";
}];
export type ObservablePriceLog = Readonly<{
    address: string;
    topics: readonly string[];
    data: string;
}>;
export type ObservablePriceObservation = Readonly<{
    pool: string;
    sequence: bigint;
    priceBucketX18: bigint;
    observedAt: bigint;
    publishedAt: bigint;
    activityCount: bigint;
    quantumX18: bigint;
    initial: boolean;
}>;
export type ObservablePriceState = Readonly<{
    initialized: boolean;
    priceBucketX18: bigint;
    quantumX18: bigint;
    sequence: bigint;
    observedAt: bigint;
    publishedAt: bigint;
    activityCount: bigint;
    hasPendingObservation: boolean;
}>;
export type ObservablePriceFreshness = "unavailable" | "current" | "stale";
export type IndicativeSwapEstimate = Readonly<{
    amountOut: bigint;
    feeAdjustedAmountIn: bigint;
    priceBucketX18: bigint;
    authoritative: false;
    excludesPriceImpact: true;
}>;
export declare function parseObservablePriceObservation(log: ObservablePriceLog, expectedPool: string): ObservablePriceObservation;
export declare function classifyObservablePriceFreshness(state: ObservablePriceState, nowSeconds: bigint, maximumAgeSeconds: bigint): ObservablePriceFreshness;
/**
 * Fee-adjusted marginal estimate from the public bucket. It deliberately omits
 * confidential pool depth and therefore must never be used as authoritative minOut.
 */
export declare function estimateObservableSwapOutput(input: Readonly<{
    amountIn: bigint;
    zeroForOne: boolean;
    token0Decimals: number;
    token1Decimals: number;
    feeBps: bigint;
    priceBucketX18: bigint;
}>): IndicativeSwapEstimate;
