/**
 * Stable, privacy-minimal client surface for CipherDEX protocol v1.
 *
 * These ABI fragments intentionally contain no balance, reserve, amount or LP
 * position read model. Clients must obtain private values through the official
 * COTI SDK and the caller's AES key.
 */

export const DISCLOSURE_SCHEMA_VERSION = 5 as const;

export const CIPHERDEX_V1_FEE_POLICY = {
  approvedTotalFeeBps: [5, 30, 100] as const,
  protocolFeeShareNumerator: 1,
  protocolFeeShareDenominator: 6,
  lpFeeShareNumerator: 5,
  lpFeeShareDenominator: 6,
  chargedOn: "input" as const,
  extraNativeSwapFee: false,
  confidentialCollection: {
    minimumPoolSwapCount: 8,
    minimumPoolDelaySeconds: 3_600,
    minimumVaultSweepDelaySeconds: 86_400,
  } as const,
} as const;

export const CONFIDENTIAL_QUOTE_TRANSPORT = {
  TRANSACTION_EVENT: "encrypted-transaction-event-v1",
} as const;

export const PRIVACY_MODE = {
  TRANSPARENT: 0,
  AMOUNT_CONFIDENTIAL_PRIVATE_LP: 1,
  UNSUPPORTED_FULLY_CONFIDENTIAL: 2,
} as const;

export const LP_DISPOSITION = {
  CREATOR_HELD: 0,
  TIMED_LOCK: 1,
  PERMANENT_LOCK: 2,
} as const;

export const CONFIDENTIAL_CPMM_ABI = [
  "function PROTOCOL_VERSION() view returns (uint256)",
  "function PRIVACY_MODE() view returns (uint8)",
  "function LP_DISPOSITION_CREATOR_HELD() view returns (uint8)",
  "function LP_DISPOSITION_TIMED_LOCK() view returns (uint8)",
  "function LP_DISPOSITION_PERMANENT_LOCK() view returns (uint8)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function token0Decimals() view returns (uint8)",
  "function token1Decimals() view returns (uint8)",
  "function scale0() view returns (uint256)",
  "function scale1() view returns (uint256)",
  "function feeBps() view returns (uint256)",
  "function feeVault() view returns (address)",
  "function PROTOCOL_FEE_SHARE_NUMERATOR() view returns (uint256)",
  "function PROTOCOL_FEE_SHARE_DENOMINATOR() view returns (uint256)",
  "function MIN_CONFIDENTIAL_COLLECTION_SWAPS() view returns (uint32)",
  "function MIN_CONFIDENTIAL_COLLECTION_DELAY() view returns (uint64)",
  "function protocolFeeSwapCount0() view returns (uint32)",
  "function protocolFeeSwapCount1() view returns (uint32)",
  "function protocolFeeWindowStart0() view returns (uint64)",
  "function protocolFeeWindowStart1() view returns (uint64)",
  "function bootstrapper() view returns (address)",
  "function lpToken() view returns (address)",
  "function initialized() view returns (bool)",
  "function quoteExactInput(((uint256,uint256),bytes),bool) returns ((uint256,uint256))",
  "function requestQuoteExactInput(((uint256,uint256),bytes),bool,bytes32) returns ((uint256,uint256))",
  "function swapExactInput(((uint256,uint256),bytes),((uint256,uint256),bytes),bool,uint64) returns ((uint256,uint256))",
  "function addLiquidity(((uint256,uint256),bytes),((uint256,uint256),bytes),((uint256,uint256),bytes),uint64) returns ((uint256,uint256))",
  "function bootstrapLiquidity(address,uint256,uint256,uint256,uint256,uint256) returns ((uint256,uint256))",
  "function bootstrapLiquidityWithDisposition(address,uint256,uint256,uint256,uint256,uint256,uint8,uint64) returns ((uint256,uint256),bytes32)",
  "function removeLiquidity(((uint256,uint256),bytes),((uint256,uint256),bytes),((uint256,uint256),bytes),uint64) returns ((uint256,uint256),(uint256,uint256))",
  "function collectProtocolFees(bool,bool)",
  "function myShares() returns ((uint256,uint256))",
  "function lockInfo(bytes32) view returns (address,uint64,bool,bool)",
  "function lockShares(((uint256,uint256),bytes),uint64,bool,uint64) returns (bytes32)",
  "function unlockShares(bytes32)",
  "event SwapExecuted(address indexed trader,bool indexed zeroForOne)",
  "event LiquidityAdded(address indexed provider)",
  "event PoolBootstrapped(address indexed provider)",
  "event LiquidityRemoved(address indexed provider)",
  "event LiquidityLocked(bytes32 indexed lockId,address indexed owner,uint64 unlockTime,bool permanent)",
  "event LiquidityUnlocked(bytes32 indexed lockId,address indexed owner)",
  "event ConfidentialQuoteResult(address indexed caller,bytes32 indexed requestId,bool indexed zeroForOne,(uint256,uint256) result)",
  "event ConfidentialProtocolFeesCollected(address indexed token,address indexed feeVault,uint32 aggregatedSwapCount)",
] as const;

export const CONFIDENTIAL_CPMM_FACTORY_ABI = [
  "function PROTOCOL_VERSION() view returns (uint256)",
  "function PRIVACY_MODE() view returns (uint8)",
  "function lpTokenFactory() view returns (address)",
  "function feeVault() view returns (address)",
  "function isApprovedFeeTier(uint256) pure returns (bool)",
  "function bootstrapConfigurator() view returns (address)",
  "function bootstrapAdapter() view returns (address)",
  "function getPool(bytes32) view returns (address)",
  "function isPool(address) view returns (bool)",
  "function createPool(address,address,uint8,uint8,uint256) returns (address)",
  "function setBootstrapAdapter(address)",
  "function poolKey(address,address,uint8,uint8,uint256) pure returns (bytes32)",
  "function allPoolsLength() view returns (uint256)",
  "function allPools(uint256) view returns (address)",
  "function bootstrapPool(address,address,uint256,uint256,uint256,uint256,uint256) returns ((uint256,uint256))",
  "function bootstrapPoolWithDisposition(address,address,uint256,uint256,uint256,uint256,uint256,uint8,uint64) returns ((uint256,uint256),bytes32)",
  "event PoolCreated(address indexed token0,address indexed token1,uint8 token0Decimals,uint8 token1Decimals,uint256 feeBps,address pool)",
  "event PrivateLPTokenCreated(address indexed pool,address indexed token)",
  "event BootstrapAdapterConfigured(address indexed adapter)",
] as const;

export const PRIVATE_LP_TOKEN_ABI = [
  "function pool() view returns (address)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function publicAmountsEnabled() view returns (bool)",
  "function balanceOf() returns (uint256)",
  "function transfer(address,((uint256,uint256),bytes))",
  "function approve(address,((uint256,uint256),bytes))",
  "event Transfer(address indexed from,address indexed to,(uint256,uint256),(uint256,uint256))",
  "event Approval(address indexed owner,address indexed spender,(uint256,uint256),(uint256,uint256))",
  "event AllowanceReencrypted(address indexed owner,address indexed spender,bool isSpender)",
] as const;

export const CONFIDENTIAL_LAUNCHPAD_MIGRATOR_ABI = [
  "function PROTOCOL_VERSION() view returns (uint256)",
  "function factory() view returns (address)",
  "function migrate((address,address,uint8,uint8,uint256,((uint256,uint256),bytes),((uint256,uint256),bytes),((uint256,uint256),bytes),((uint256,uint256),bytes),((uint256,uint256),bytes),uint64,bytes)) returns (address,(uint256,uint256))",
  "function migrateWithDisposition((address,address,uint8,uint8,uint256,((uint256,uint256),bytes),((uint256,uint256),bytes),((uint256,uint256),bytes),((uint256,uint256),bytes),((uint256,uint256),bytes),uint64,bytes),uint8,uint64) returns (address,(uint256,uint256),bytes32)",
  "event LaunchpadMigration(address indexed creator,address indexed pool)",
  "event LaunchpadLockDisposition(address indexed creator,address indexed pool,uint8 disposition,bytes32 lockId,uint64 unlockTime)",
] as const;

export const CIPHERDEX_FEE_VAULT_ABI = [
  "function beneficiary() view returns (address)",
  "function deployedAt() view returns (uint64)",
  "function MIN_CONFIDENTIAL_SWEEP_DELAY() view returns (uint64)",
  "function nextConfidentialSweepAt(address) view returns (uint64)",
  "function sweepPublicToken(address) returns (uint256)",
  "function sweepConfidentialToken(address)",
  "event PublicFeesSwept(address indexed token,address indexed beneficiary,uint256 amount)",
  "event ConfidentialFeesSwept(address indexed token,address indexed beneficiary)",
] as const;

export const LAUNCHPAD_MIGRATOR_EIP712_DOMAIN = {
  name: "CipherDEX Launchpad Migrator",
  version: "1",
} as const;

export const LAUNCHPAD_MIGRATION_EIP712_TYPES = [
  { name: "creator", type: "address" },
  { name: "tokenA", type: "address" },
  { name: "tokenB", type: "address" },
  { name: "decimalsA", type: "uint8" },
  { name: "decimalsB", type: "uint8" },
  { name: "feeBps", type: "uint256" },
  { name: "encryptedInputsHash", type: "bytes32" },
  { name: "deadline", type: "uint64" },
  { name: "withDisposition", type: "bool" },
  { name: "disposition", type: "uint8" },
  { name: "unlockTime", type: "uint64" },
] as const;

const isNonNegativeQuantity = (value: unknown): value is bigint | string =>
  (typeof value === "bigint" && value >= 0n) ||
  (typeof value === "string" && /^\d+$/.test(value));

const isAddressLike = (value: unknown): value is string =>
  typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);

const isBytes32 = (value: unknown): value is string =>
  typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);

const SENSITIVE_DISCLOSURE_FIELDS = new Set([
  "reserve0",
  "reserve1",
  "reserves",
  "totalShares",
  "shares",
  "balance",
  "balanceOf",
  "amountIn",
  "amountOut",
  "minAmountOut",
  "minShares",
  "ciphertext",
  "signature",
  "aesKey",
  "privateKey",
  "encryptedInput",
  "encryptedInputs",
]);

const containsSensitiveDisclosure = (
  value: unknown,
  seen = new Set<object>(),
): boolean => {
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);

  return Object.entries(value).some(
    ([key, nestedValue]) =>
      SENSITIVE_DISCLOSURE_FIELDS.has(key) ||
      containsSensitiveDisclosure(nestedValue, seen),
  );
};

export const PUBLIC_CPMM_ABI = [
  "function PROTOCOL_VERSION() view returns (uint256)",
  "function PRIVACY_MODE() view returns (uint8)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function token0Decimals() view returns (uint8)",
  "function token1Decimals() view returns (uint8)",
  "function scale0() view returns (uint256)",
  "function scale1() view returns (uint256)",
  "function feeBps() view returns (uint256)",
  "function feeVault() view returns (address)",
  "function PROTOCOL_FEE_SHARE_NUMERATOR() view returns (uint256)",
  "function PROTOCOL_FEE_SHARE_DENOMINATOR() view returns (uint256)",
  "function protocolFees0() view returns (uint256)",
  "function protocolFees1() view returns (uint256)",
  "function initialized() view returns (bool)",
  "function totalShares() view returns (uint256)",
  "function shares(address) view returns (uint256)",
  "function quoteExactInput(uint256,bool) view returns (uint256)",
  "function swapExactInput(uint256,uint256,bool,uint64) returns (uint256)",
  "function addLiquidity(uint256,uint256,uint256,uint64) returns (uint256)",
  "function removeLiquidity(uint256,uint256,uint256,uint64) returns (uint256,uint256)",
  "function collectProtocolFees() returns (uint256,uint256)",
  "function effectiveReserves() view returns (uint256,uint256)",
  "function lockShares(uint256,uint64,bool,uint64) returns (bytes32)",
  "function unlockShares(bytes32)",
  "function lockInfo(bytes32) view returns (address,uint64,bool,bool,uint256)",
  "event SwapExecuted(address indexed trader,bool indexed zeroForOne,uint256 amountIn,uint256 amountOut)",
  "event LiquidityAdded(address indexed provider,uint256 amount0,uint256 amount1,uint256 shares)",
  "event LiquidityRemoved(address indexed provider,uint256 amount0,uint256 amount1,uint256 shares)",
  "event LiquidityLocked(bytes32 indexed lockId,address indexed owner,uint64 unlockTime,bool permanent,uint256 shares)",
  "event LiquidityUnlocked(bytes32 indexed lockId,address indexed owner,uint256 shares)",
  "event ProtocolFeeAccrued(address indexed token,uint256 amount)",
  "event ProtocolFeesCollected(address indexed feeVault,uint256 token0Amount,uint256 token1Amount)",
] as const;

export const PUBLIC_CPMM_FACTORY_ABI = [
  "function PROTOCOL_VERSION() view returns (uint256)",
  "function PRIVACY_MODE() view returns (uint8)",
  "function feeVault() view returns (address)",
  "function isApprovedFeeTier(uint256) pure returns (bool)",
  "function getPool(bytes32) view returns (address)",
  "function isPool(address) view returns (bool)",
  "function createPool(address,address,uint8,uint8,uint256) returns (address)",
  "function poolKey(address,address,uint8,uint8,uint256) pure returns (bytes32)",
  "function allPoolsLength() view returns (uint256)",
  "function allPools(uint256) view returns (address)",
  "event PoolCreated(address indexed token0,address indexed token1,uint8 token0Decimals,uint8 token1Decimals,uint256 feeBps,address pool)",
] as const;

export const PUBLIC_CPMM_QUOTER_ABI = [
  "function PROTOCOL_VERSION() view returns (uint256)",
  "function factory() view returns (address)",
  "function quoteExactInput(address,uint256,bool) view returns (uint256)",
] as const;

export const PUBLIC_CPMM_ROUTER_ABI = [
  "function PROTOCOL_VERSION() view returns (uint256)",
  "function factory() view returns (address)",
  "function swapExactInput(address,uint256,uint256,bool,uint64) returns (uint256)",
  "event SwapRouted(address indexed trader,address indexed pool,address indexed inputToken,address outputToken,uint256 amountIn,uint256 amountOut)",
] as const;

export type Ciphertext256 = {
  ciphertextHigh: bigint;
  ciphertextLow: bigint;
};

export type InputText256 = {
  ciphertext: Ciphertext256;
  signature: string | Uint8Array;
};

export type CipherDEXV1FeePolicy = {
  totalFeeBps: number;
  protocolFeeShareNumerator: typeof CIPHERDEX_V1_FEE_POLICY.protocolFeeShareNumerator;
  protocolFeeShareDenominator: typeof CIPHERDEX_V1_FEE_POLICY.protocolFeeShareDenominator;
  lpFeeShareNumerator: typeof CIPHERDEX_V1_FEE_POLICY.lpFeeShareNumerator;
  lpFeeShareDenominator: typeof CIPHERDEX_V1_FEE_POLICY.lpFeeShareDenominator;
  chargedOn: typeof CIPHERDEX_V1_FEE_POLICY.chargedOn;
  extraNativeSwapFee: typeof CIPHERDEX_V1_FEE_POLICY.extraNativeSwapFee;
  confidentialCollection: typeof CIPHERDEX_V1_FEE_POLICY.confidentialCollection;
};

export type CipherDEXFeeBreakdown = {
  amountIn: bigint;
  netAmountIn: bigint;
  totalFee: bigint;
  lpFee: bigint;
  protocolFee: bigint;
};

export function getCipherDEXV1FeePolicy(totalFeeBps: number): CipherDEXV1FeePolicy {
  if (
    !Number.isInteger(totalFeeBps) ||
    !(CIPHERDEX_V1_FEE_POLICY.approvedTotalFeeBps as readonly number[]).includes(totalFeeBps)
  ) {
    throw new RangeError("Unsupported CipherDEX v1 fee tier");
  }
  return {
    totalFeeBps,
    protocolFeeShareNumerator: CIPHERDEX_V1_FEE_POLICY.protocolFeeShareNumerator,
    protocolFeeShareDenominator: CIPHERDEX_V1_FEE_POLICY.protocolFeeShareDenominator,
    lpFeeShareNumerator: CIPHERDEX_V1_FEE_POLICY.lpFeeShareNumerator,
    lpFeeShareDenominator: CIPHERDEX_V1_FEE_POLICY.lpFeeShareDenominator,
    chargedOn: CIPHERDEX_V1_FEE_POLICY.chargedOn,
    extraNativeSwapFee: CIPHERDEX_V1_FEE_POLICY.extraNativeSwapFee,
    confidentialCollection: CIPHERDEX_V1_FEE_POLICY.confidentialCollection,
  };
}

export function calculateCipherDEXV1FeeBreakdown(
  amountIn: bigint,
  totalFeeBps: number,
): CipherDEXFeeBreakdown {
  getCipherDEXV1FeePolicy(totalFeeBps);
  if (amountIn <= 0n) throw new RangeError("amountIn must be positive");
  const netAmountIn = amountIn * BigInt(10_000 - totalFeeBps) / 10_000n;
  const totalFee = amountIn - netAmountIn;
  const protocolFee = totalFee / BigInt(
    CIPHERDEX_V1_FEE_POLICY.protocolFeeShareDenominator,
  );
  return {
    amountIn,
    netAmountIn,
    totalFee,
    lpFee: totalFee - protocolFee,
    protocolFee,
  };
}

export type ConfidentialPoolDiscovery = {
  disclosureSchemaVersion: typeof DISCLOSURE_SCHEMA_VERSION;
  protocolVersion: number;
  pool: string;
  token0: string;
  token1: string;
  token0Decimals: number;
  token1Decimals: number;
  feeBps: number;
  feeVault: string;
  feePolicy: CipherDEXV1FeePolicy;
  privacyMode: typeof PRIVACY_MODE.AMOUNT_CONFIDENTIAL_PRIVATE_LP;
  poolKind: "private-erc20-cpmm-v1";
  quoteTransport: typeof CONFIDENTIAL_QUOTE_TRANSPORT.TRANSACTION_EVENT;
};

/**
 * A decrypted quote held only inside a quote service's process. This is not a
 * discovery or API response shape: callers must not persist or publish it.
 * `requestId` is an opaque local correlation value proving that all compared
 * outputs came from the same logical input and direction.
 */
export type ConfidentialQuoteEvaluation = {
  discovery: ConfidentialPoolDiscovery;
  requestId: string;
  zeroForOne: boolean;
  decryptedAmountOut: bigint;
};

export type PublicPoolDiscovery = {
  disclosureSchemaVersion: typeof DISCLOSURE_SCHEMA_VERSION;
  protocolVersion: number;
  pool: string;
  token0: string;
  token1: string;
  token0Decimals: number;
  token1Decimals: number;
  feeBps: number;
  feeVault: string;
  feePolicy: CipherDEXV1FeePolicy;
  privacyMode: typeof PRIVACY_MODE.TRANSPARENT;
  poolKind: "public-erc20-cpmm-v1";
};

export type ConfidentialLockMetadata = {
  lockId: string;
  owner: string;
  unlockTime: number;
  permanent: boolean;
  released: boolean;
};

export type ConfidentialLockDiscovery = {
  disclosureSchemaVersion: typeof DISCLOSURE_SCHEMA_VERSION;
  pool: string;
  lockId: string;
  owner: string;
  unlockTime: bigint | string;
  permanent: boolean;
  released: boolean;
};

export type LaunchpadMigrationMetadata = {
  disclosureSchemaVersion: typeof DISCLOSURE_SCHEMA_VERSION;
  creator: string;
  pool: string;
  disposition: typeof LP_DISPOSITION[keyof typeof LP_DISPOSITION];
  lockId: string;
  unlockTime: bigint | string;
};

function isCipherDEXV1FeePolicy(
  value: unknown,
  totalFeeBps: unknown,
): value is CipherDEXV1FeePolicy {
  if (!value || typeof value !== "object" || typeof totalFeeBps !== "number") return false;
  const candidate = value as Partial<CipherDEXV1FeePolicy>;
  return (
    (CIPHERDEX_V1_FEE_POLICY.approvedTotalFeeBps as readonly number[]).includes(totalFeeBps) &&
    candidate.totalFeeBps === totalFeeBps &&
    candidate.protocolFeeShareNumerator === CIPHERDEX_V1_FEE_POLICY.protocolFeeShareNumerator &&
    candidate.protocolFeeShareDenominator === CIPHERDEX_V1_FEE_POLICY.protocolFeeShareDenominator &&
    candidate.lpFeeShareNumerator === CIPHERDEX_V1_FEE_POLICY.lpFeeShareNumerator &&
    candidate.lpFeeShareDenominator === CIPHERDEX_V1_FEE_POLICY.lpFeeShareDenominator &&
    candidate.chargedOn === CIPHERDEX_V1_FEE_POLICY.chargedOn &&
    candidate.extraNativeSwapFee === CIPHERDEX_V1_FEE_POLICY.extraNativeSwapFee &&
    candidate.confidentialCollection?.minimumPoolSwapCount ===
      CIPHERDEX_V1_FEE_POLICY.confidentialCollection.minimumPoolSwapCount &&
    candidate.confidentialCollection?.minimumPoolDelaySeconds ===
      CIPHERDEX_V1_FEE_POLICY.confidentialCollection.minimumPoolDelaySeconds &&
    candidate.confidentialCollection?.minimumVaultSweepDelaySeconds ===
      CIPHERDEX_V1_FEE_POLICY.confidentialCollection.minimumVaultSweepDelaySeconds
  );
}

export function isConfidentialPoolDiscovery(
  value: unknown,
): value is ConfidentialPoolDiscovery {
  if (!value || typeof value !== "object") return false;
  if (containsSensitiveDisclosure(value)) return false;
  const candidate = value as Partial<ConfidentialPoolDiscovery>;
  return (
    candidate.disclosureSchemaVersion === DISCLOSURE_SCHEMA_VERSION &&
    candidate.poolKind === "private-erc20-cpmm-v1" &&
    typeof candidate.pool === "string" &&
    typeof candidate.token0 === "string" &&
    typeof candidate.token1 === "string" &&
    typeof candidate.protocolVersion === "number" &&
    typeof candidate.token0Decimals === "number" &&
    typeof candidate.token1Decimals === "number" &&
    Number.isInteger(candidate.feeBps) &&
    candidate.feeBps! >= 0 &&
    isAddressLike(candidate.feeVault) &&
    isCipherDEXV1FeePolicy(candidate.feePolicy, candidate.feeBps) &&
    candidate.privacyMode === PRIVACY_MODE.AMOUNT_CONFIDENTIAL_PRIVATE_LP &&
    candidate.quoteTransport === CONFIDENTIAL_QUOTE_TRANSPORT.TRANSACTION_EVENT
  );
}

/**
 * Deterministically selects the largest decrypted output among candidate
 * confidential pools. The service must create fresh authenticated quote inputs
 * per pool, decrypt each result with its own dedicated quote identity, and pass
 * only evaluations for one request into this function.
 */
export function selectBestConfidentialPoolQuote(
  evaluations: readonly ConfidentialQuoteEvaluation[],
): ConfidentialQuoteEvaluation | undefined {
  if (evaluations.length === 0) return undefined;

  const first = evaluations[0];
  if (
    first.requestId.length === 0 ||
    first.decryptedAmountOut <= 0n ||
    !isConfidentialPoolDiscovery(first.discovery)
  ) {
    throw new TypeError("Invalid confidential quote evaluation");
  }

  const token0 = first.discovery.token0.toLowerCase();
  const token1 = first.discovery.token1.toLowerCase();
  const seenPools = new Set<string>();
  let best = first;

  for (const evaluation of evaluations) {
    const pool = evaluation.discovery.pool.toLowerCase();
    if (
      evaluation.requestId !== first.requestId ||
      evaluation.zeroForOne !== first.zeroForOne ||
      evaluation.decryptedAmountOut <= 0n ||
      !isConfidentialPoolDiscovery(evaluation.discovery) ||
      evaluation.discovery.token0.toLowerCase() !== token0 ||
      evaluation.discovery.token1.toLowerCase() !== token1 ||
      seenPools.has(pool)
    ) {
      throw new TypeError("Incomparable confidential quote evaluations");
    }
    seenPools.add(pool);

    if (
      evaluation.decryptedAmountOut > best.decryptedAmountOut ||
      (evaluation.decryptedAmountOut === best.decryptedAmountOut &&
        (evaluation.discovery.feeBps < best.discovery.feeBps ||
          (evaluation.discovery.feeBps === best.discovery.feeBps &&
            pool < best.discovery.pool.toLowerCase())))
    ) {
      best = evaluation;
    }
  }

  return best;
}

export function isPublicPoolDiscovery(value: unknown): value is PublicPoolDiscovery {
  if (!value || typeof value !== "object") return false;
  if (containsSensitiveDisclosure(value)) return false;
  const candidate = value as Partial<PublicPoolDiscovery>;
  return (
    candidate.disclosureSchemaVersion === DISCLOSURE_SCHEMA_VERSION &&
    candidate.poolKind === "public-erc20-cpmm-v1" &&
    typeof candidate.pool === "string" &&
    typeof candidate.token0 === "string" &&
    typeof candidate.token1 === "string" &&
    typeof candidate.protocolVersion === "number" &&
    typeof candidate.token0Decimals === "number" &&
    typeof candidate.token1Decimals === "number" &&
    typeof candidate.feeBps === "number" &&
    isAddressLike(candidate.feeVault) &&
    isCipherDEXV1FeePolicy(candidate.feePolicy, candidate.feeBps) &&
    candidate.privacyMode === PRIVACY_MODE.TRANSPARENT
  );
}

export function isConfidentialLockDiscovery(
  value: unknown,
): value is ConfidentialLockDiscovery {
  if (!value || typeof value !== "object") return false;
  if (containsSensitiveDisclosure(value)) return false;
  const candidate = value as Partial<ConfidentialLockDiscovery>;
  return (
    candidate.disclosureSchemaVersion === DISCLOSURE_SCHEMA_VERSION &&
    isAddressLike(candidate.pool) &&
    isBytes32(candidate.lockId) &&
    isAddressLike(candidate.owner) &&
    isNonNegativeQuantity(candidate.unlockTime) &&
    typeof candidate.permanent === "boolean" &&
    typeof candidate.released === "boolean"
  );
}

// Backward-compatible alias for callers that used the original metadata name.
export const isConfidentialLockMetadata = isConfidentialLockDiscovery;

export function isLaunchpadMigrationMetadata(
  value: unknown,
): value is LaunchpadMigrationMetadata {
  if (!value || typeof value !== "object") return false;
  if (containsSensitiveDisclosure(value)) return false;
  const candidate = value as Partial<LaunchpadMigrationMetadata>;
  return (
    candidate.disclosureSchemaVersion === DISCLOSURE_SCHEMA_VERSION &&
    isAddressLike(candidate.creator) &&
    isAddressLike(candidate.pool) &&
    (candidate.disposition === LP_DISPOSITION.CREATOR_HELD ||
      candidate.disposition === LP_DISPOSITION.TIMED_LOCK ||
      candidate.disposition === LP_DISPOSITION.PERMANENT_LOCK) &&
    isBytes32(candidate.lockId) &&
    isNonNegativeQuantity(candidate.unlockTime)
  );
}
