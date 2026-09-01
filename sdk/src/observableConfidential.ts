export const OBSERVABLE_CONFIDENTIAL_PRIVACY_MODE = 2 as const;
export const OBSERVABLE_CONFIDENTIAL_PROTOCOL_VERSION = 1 as const;
export const OBSERVATION_BUCKET_BPS = 50 as const;
export const MIN_OBSERVATION_SWAPS = 3 as const;
export const MIN_OBSERVATION_INTERVAL_SECONDS = 120 as const;
export const PUBLIC_PRICE_OBSERVATION_TOPIC =
  "0x51d2f10b0f987bba79c5f16a2cc4351099ce4c0ef967cf98938e543fa6032ce2" as const;

export const OBSERVABLE_CONFIDENTIAL_CPMM_ABI = [
  "function PROTOCOL_VERSION() view returns (uint256)",
  "function PRIVACY_MODE() view returns (uint8)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function token0Decimals() view returns (uint8)",
  "function token1Decimals() view returns (uint8)",
  "function feeBps() view returns (uint256)",
  "function feeVault() view returns (address)",
  "function initializationStrategy() view returns (address)",
  "function lpToken() view returns (address)",
  "function initialized() view returns (bool)",
  "function initialPriceReferenceX18() view returns (uint256)",
  "function initializeLiquidity(((uint256,uint256),bytes),((uint256,uint256),bytes),((uint256,uint256),bytes),((uint256,uint256),bytes),((uint256,uint256),bytes),uint256,uint64) returns ((uint256,uint256))",
  "function publicPriceBucketX18() view returns (uint256)",
  "function publicPriceQuantumX18() view returns (uint256)",
  "function publicObservationSequence() view returns (uint64)",
  "function publicObservationAt() view returns (uint64)",
  "function publicObservationPublishedAt() view returns (uint64)",
  "function publicObservationActivityCount() view returns (uint32)",
  "function swapsSinceObservationClose() view returns (uint32)",
  "function lastObservationClosedAt() view returns (uint64)",
  "function hasPendingObservation() view returns (bool)",
  "function pendingObservationAt() view returns (uint64)",
  "function pendingObservationActivityCount() view returns (uint32)",
  "function observationDueForNextSwap() view returns (bool)",
  "event PublicPriceObservation(uint64 indexed sequence,uint256 priceBucketX18,uint64 observedAt,uint64 publishedAt,uint32 activityCount,uint256 quantumX18,bool initial)",
] as const;

export const OBSERVABLE_CONFIDENTIAL_FACTORY_ABI = [
  "function PROTOCOL_VERSION() view returns (uint256)",
  "function PRIVACY_MODE() view returns (uint8)",
  "function lpTokenFactory() view returns (address)",
  "function feeVault() view returns (address)",
  "function bestExecutionRouter() view returns (address)",
  "function getPool(bytes32) view returns (address)",
  "function isPool(address) view returns (bool)",
  "function createPool(address,address,uint8,uint8,uint256) returns (address)",
  "function poolKey(address,address,uint8,uint8,uint256,address) pure returns (bytes32)",
  "function allPoolsLength() view returns (uint256)",
  "function allPools(uint256) view returns (address)",
  "event PoolCreated(address indexed token0,address indexed token1,uint8 token0Decimals,uint8 token1Decimals,uint256 feeBps,address initializationStrategy,address pool)",
] as const;

export const OBSERVABLE_CONFIDENTIAL_FEE_VAULT_ABI = [
  "function PRIVACY_MODE() view returns (uint8)",
  "function beneficiary() view returns (address)",
  "function confidentialFactory() view returns (address)",
  "function nextConfidentialSweepAt(address) view returns (uint64)",
  "function confidentialEpochCount(address) view returns (uint256)",
  "function confidentialEpochAt(address,uint256) view returns (uint64)",
  "function sweepConfidentialToken(address)",
] as const;

export const OBSERVABLE_LAUNCHPAD_MIGRATOR_EIP712_DOMAIN = {
  name: "CipherDEX Observable Launchpad Migrator",
  version: "1",
} as const;

export const OBSERVABLE_LAUNCHPAD_MIGRATION_EIP712_TYPES = [
  { name: "launchId", type: "bytes32" },
  { name: "initializationStrategy", type: "address" },
  { name: "creator", type: "address" },
  { name: "tokenA", type: "address" },
  { name: "tokenB", type: "address" },
  { name: "decimalsA", type: "uint8" },
  { name: "decimalsB", type: "uint8" },
  { name: "feeBps", type: "uint256" },
  { name: "initialPriceReferenceX18", type: "uint256" },
  { name: "encryptedInputsHash", type: "bytes32" },
  { name: "deadline", type: "uint64" },
  { name: "withDisposition", type: "bool" },
  { name: "disposition", type: "uint8" },
  { name: "unlockTime", type: "uint64" },
] as const;

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/u;
const WORD_PATTERN = /^0x[0-9a-fA-F]{64}$/u;
const UINT64_MAX = (1n << 64n) - 1n;
const UINT32_MAX = (1n << 32n) - 1n;
const PRICE_SCALE = 10n ** 18n;
const FEE_DENOMINATOR = 10_000n;

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

function requireNonNegative(value: bigint, name: string): void {
  if (typeof value !== "bigint" || value < 0n) {
    throw new TypeError(`${name} must be a non-negative bigint`);
  }
}

function requireDecimals(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 18) {
    throw new TypeError(`${name} must be an integer from 0 through 18`);
  }
}

function words(data: string, count: number): readonly bigint[] {
  if (typeof data !== "string" || data.length !== 2 + count * 64 || !/^0x[0-9a-fA-F]+$/u.test(data)) {
    throw new TypeError("Invalid observable-price event data");
  }
  return Object.freeze(Array.from({ length: count }, (_, index) =>
    BigInt(`0x${data.slice(2 + index * 64, 2 + (index + 1) * 64)}`)
  ));
}

export function parseObservablePriceObservation(
  log: ObservablePriceLog,
  expectedPool: string,
): ObservablePriceObservation {
  if (
    !ADDRESS_PATTERN.test(expectedPool) ||
    !ADDRESS_PATTERN.test(log.address) ||
    log.address.toLowerCase() !== expectedPool.toLowerCase() ||
    !Array.isArray(log.topics) ||
    log.topics.length !== 2 ||
    log.topics[0]?.toLowerCase() !== PUBLIC_PRICE_OBSERVATION_TOPIC ||
    !WORD_PATTERN.test(log.topics[1] ?? "")
  ) throw new TypeError("Unauthenticated observable-price event");

  const sequence = BigInt(log.topics[1]!);
  const [priceBucketX18, observedAt, publishedAt, activityCount, quantumX18, initialWord] =
    words(log.data, 6);
  if (
    sequence === 0n || sequence > UINT64_MAX ||
    priceBucketX18 === 0n || quantumX18 === 0n ||
    observedAt === 0n || observedAt > UINT64_MAX ||
    publishedAt < observedAt || publishedAt > UINT64_MAX ||
    activityCount > UINT32_MAX ||
    initialWord > 1n ||
    (initialWord === 1n && activityCount !== 0n)
  ) throw new TypeError("Invalid observable-price event values");

  return Object.freeze({
    pool: expectedPool,
    sequence,
    priceBucketX18,
    observedAt,
    publishedAt,
    activityCount,
    quantumX18,
    initial: initialWord === 1n,
  });
}

export function classifyObservablePriceFreshness(
  state: ObservablePriceState,
  nowSeconds: bigint,
  maximumAgeSeconds: bigint,
): ObservablePriceFreshness {
  requireNonNegative(nowSeconds, "nowSeconds");
  requireNonNegative(maximumAgeSeconds, "maximumAgeSeconds");
  if (
    !state.initialized ||
    state.priceBucketX18 <= 0n ||
    state.quantumX18 <= 0n ||
    state.sequence <= 0n ||
    state.observedAt <= 0n ||
    state.publishedAt < state.observedAt
  ) return "unavailable";
  if (nowSeconds < state.observedAt) {
    throw new TypeError("Current time precedes the observation");
  }
  return nowSeconds - state.observedAt <= maximumAgeSeconds ? "current" : "stale";
}

/**
 * Fee-adjusted marginal estimate from the public bucket. It deliberately omits
 * confidential pool depth and therefore must never be used as authoritative minOut.
 */
export function estimateObservableSwapOutput(input: Readonly<{
  amountIn: bigint;
  zeroForOne: boolean;
  token0Decimals: number;
  token1Decimals: number;
  feeBps: bigint;
  priceBucketX18: bigint;
}>): IndicativeSwapEstimate {
  requireNonNegative(input.amountIn, "amountIn");
  requireNonNegative(input.feeBps, "feeBps");
  requireNonNegative(input.priceBucketX18, "priceBucketX18");
  requireDecimals(input.token0Decimals, "token0Decimals");
  requireDecimals(input.token1Decimals, "token1Decimals");
  if (input.amountIn === 0n || input.priceBucketX18 === 0n) {
    throw new TypeError("Indicative quote inputs must be positive");
  }
  if (input.feeBps >= FEE_DENOMINATOR) {
    throw new TypeError("feeBps must be below 10000");
  }

  const feeAdjustedAmountIn =
    (input.amountIn * (FEE_DENOMINATOR - input.feeBps)) / FEE_DENOMINATOR;
  const scale0 = 10n ** BigInt(18 - input.token0Decimals);
  const scale1 = 10n ** BigInt(18 - input.token1Decimals);
  const amountOut = input.zeroForOne
    ? (feeAdjustedAmountIn * scale0 * input.priceBucketX18) /
      PRICE_SCALE /
      scale1
    : (feeAdjustedAmountIn * scale1 * PRICE_SCALE) /
      input.priceBucketX18 /
      scale0;
  return Object.freeze({
    amountOut,
    feeAdjustedAmountIn,
    priceBucketX18: input.priceBucketX18,
    authoritative: false,
    excludesPriceImpact: true,
  });
}
