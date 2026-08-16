/**
 * Stable, privacy-minimal client surface for CipherDEX protocol v2.
 *
 * These ABI fragments intentionally contain no balance, reserve, amount or LP
 * position read model. Clients must obtain private values through the official
 * COTI SDK and the caller's AES key.
 */

export const DISCLOSURE_SCHEMA_VERSION = 5 as const;
export const CIPHERDEX_PROTOCOL_VERSION = 2 as const;

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
  "function addLiquidity(((uint256,uint256),bytes),((uint256,uint256),bytes),((uint256,uint256),bytes),((uint256,uint256),bytes),((uint256,uint256),bytes),bool,uint64) returns ((uint256,uint256))",
  "function bootstrapLiquidity(address,address,uint256,uint256,uint256,uint256,uint256) returns ((uint256,uint256))",
  "function bootstrapLiquidityWithDisposition(address,address,uint256,uint256,uint256,uint256,uint256,uint8,uint64) returns ((uint256,uint256),bytes32)",
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
  "function isApprovedPrivateTokenCodehash(bytes32) view returns (bool)",
  "function isApprovedPrivateToken(address) view returns (bool)",
  "function approvedPrivateTokenCodehashesLength() view returns (uint256)",
  "function approvedPrivateTokenCodehash(uint256) view returns (bytes32)",
  "function isApprovedFeeTier(uint256) pure returns (bool)",
  "function bootstrapConfigurator() view returns (address)",
  "function bootstrapAdapter() view returns (address)",
  "function getPool(bytes32) view returns (address)",
  "function isPool(address) view returns (bool)",
  "function createPool(address,address,uint8,uint8,uint256) returns (address)",
  "function getOrCreatePoolForBootstrap(address,address,uint8,uint8,uint256) returns (address)",
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

const MAX_DISCLOSURE_DEPTH = 32;
const MAX_DISCLOSURE_NODES = 1_024;
const MAX_DISCLOSURE_PROPERTIES = 4_096;

/**
 * Rejects private fields and structurally hostile metadata without invoking
 * caller-provided accessors. Validation is deliberately bounded and fails
 * closed when an object graph cannot be inspected safely.
 */
const containsSensitiveDisclosure = (root: unknown): boolean => {
  if (!root || typeof root !== "object") return false;

  const seen = new Set<object>();
  const pending: Array<{ value: object; depth: number }> = [{ value: root, depth: 0 }];
  let inspectedNodes = 0;
  let inspectedProperties = 0;

  try {
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (seen.has(current.value)) continue;
      if (current.depth > MAX_DISCLOSURE_DEPTH) return true;
      inspectedNodes += 1;
      if (inspectedNodes > MAX_DISCLOSURE_NODES) return true;
      seen.add(current.value);

      const prototype = Object.getPrototypeOf(current.value);
      if (
        prototype !== Object.prototype &&
        prototype !== null &&
        !(Array.isArray(current.value) && prototype === Array.prototype)
      ) {
        return true;
      }

      const keys = Reflect.ownKeys(current.value);
      inspectedProperties += keys.length;
      if (inspectedProperties > MAX_DISCLOSURE_PROPERTIES) return true;
      for (const key of keys) {
        if (typeof key === "string" && SENSITIVE_DISCLOSURE_FIELDS.has(key)) return true;
        const descriptor = Object.getOwnPropertyDescriptor(current.value, key);
        if (!descriptor || descriptor.get || descriptor.set) return true;
        const nestedValue = descriptor.value;
        if (nestedValue && typeof nestedValue === "object") {
          pending.push({ value: nestedValue, depth: current.depth + 1 });
        }
      }
    }
  } catch {
    return true;
  }

  return false;
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
  "function addLiquidity(uint256,uint256,uint256,uint256,uint256,uint64) returns (uint256)",
  "function removeLiquidity(uint256,uint256,uint256,uint64) returns (uint256,uint256)",
  "function collectProtocolFees(bool,bool) returns (uint256,uint256)",
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
  "event ProtocolFeeCollected(address indexed token,address indexed feeVault,uint256 debitedAmount,uint256 receivedAmount)",
  "event UnmanagedBalanceSwept(address indexed token,address indexed feeVault,uint256 debitedAmount,uint256 receivedAmount)",
  "event ProtocolFeeLossReconciled(address indexed token,uint256 previousClaim,uint256 remainingClaim,uint256 loss)",
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

export function minimumCipherDEXV1ConfidentialInput(totalFeeBps: number): bigint {
  const policy = getCipherDEXV1FeePolicy(totalFeeBps);
  const protocolShareNumerator = BigInt(policy.protocolFeeShareNumerator);
  const protocolShareDenominator = BigInt(policy.protocolFeeShareDenominator);
  const minimumTotalFee =
    protocolShareDenominator / protocolShareNumerator +
    (protocolShareDenominator % protocolShareNumerator === 0n ? 0n : 1n);

  return ((minimumTotalFee - 1n) * 10_000n) / BigInt(totalFeeBps) + 1n;
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
  poolKind: "private-erc20-cpmm-v2";
  quoteTransport: typeof CONFIDENTIAL_QUOTE_TRANSPORT.TRANSACTION_EVENT;
};

const VERIFIED_CONFIDENTIAL_POOL_DISCOVERY: unique symbol = Symbol(
  "CipherDEX.VerifiedConfidentialPoolDiscovery",
);
const verifiedConfidentialPoolDiscoveries = new WeakSet<object>();

export type VerifiedConfidentialPoolDiscovery = Readonly<
  ConfidentialPoolDiscovery & {
    factory: string;
    readonly [VERIFIED_CONFIDENTIAL_POOL_DISCOVERY]: true;
  }
>;

/**
 * A decrypted result held only inside a quote service process. The current
 * COTI testnet transport is a paid encrypted result transaction; callers must
 * not persist or publish these values as market data.
 */
export type ConfidentialQuoteEvaluation = {
  discovery: VerifiedConfidentialPoolDiscovery;
  requestId: string;
  amountIn: bigint;
  zeroForOne: boolean;
  decryptedAmountOut: bigint;
};

export type ConfidentialPoolOnchainState = {
  protocolVersion: number | bigint;
  privacyMode: number | bigint;
  token0: string;
  token1: string;
  token0Decimals: number | bigint;
  token1Decimals: number | bigint;
  feeBps: number | bigint;
  feeVault: string;
};

/**
 * Minimal dependency-free RPC boundary required to prove pool provenance.
 * Implementations should issue ordinary read-only calls through ethers, viem,
 * or another reviewed client.
 */
export interface ConfidentialPoolVerificationAdapter {
  getCode(address: string): Promise<string>;
  readFactoryProtocolVersion(factory: string): Promise<number | bigint>;
  isFactoryPrivateTokenApproved(factory: string, token: string): Promise<boolean>;
  isFactoryPool(factory: string, pool: string): Promise<boolean>;
  getCanonicalPool(
    factory: string,
    discovery: ConfidentialPoolDiscovery,
  ): Promise<string>;
  readPoolState(pool: string): Promise<ConfidentialPoolOnchainState>;
}

export type ConfidentialPoolVerificationPolicy = {
  expectedFactory: string;
  expectedFeeVault: string;
  expectedProtocolVersion: number;
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
  poolKind: "public-erc20-cpmm-v2";
};

const VERIFIED_PUBLIC_POOL_DISCOVERY: unique symbol = Symbol(
  "CipherDEX.VerifiedPublicPoolDiscovery",
);
const verifiedPublicPoolDiscoveries = new WeakSet<object>();

export type VerifiedPublicPoolDiscovery = Readonly<
  PublicPoolDiscovery & {
    factory: string;
    readonly [VERIFIED_PUBLIC_POOL_DISCOVERY]: true;
  }
>;

export type PublicPoolOnchainState = ConfidentialPoolOnchainState;

export interface PublicPoolVerificationAdapter {
  getCode(address: string): Promise<string>;
  readFactoryProtocolVersion(factory: string): Promise<number | bigint>;
  isFactoryPool(factory: string, pool: string): Promise<boolean>;
  getCanonicalPool(
    factory: string,
    discovery: PublicPoolDiscovery,
  ): Promise<string>;
  readPoolState(pool: string): Promise<PublicPoolOnchainState>;
}

export type PublicPoolVerificationPolicy = ConfidentialPoolVerificationPolicy;

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
    candidate.protocolVersion === CIPHERDEX_PROTOCOL_VERSION &&
    candidate.poolKind === "private-erc20-cpmm-v2" &&
    isAddressLike(candidate.pool) &&
    isAddressLike(candidate.token0) &&
    isAddressLike(candidate.token1) &&
    candidate.token0!.toLowerCase() < candidate.token1!.toLowerCase() &&
    Number.isInteger(candidate.protocolVersion) &&
    candidate.protocolVersion! > 0 &&
    Number.isInteger(candidate.token0Decimals) &&
    candidate.token0Decimals! >= 0 &&
    candidate.token0Decimals! <= 18 &&
    Number.isInteger(candidate.token1Decimals) &&
    candidate.token1Decimals! >= 0 &&
    candidate.token1Decimals! <= 18 &&
    Number.isInteger(candidate.feeBps) &&
    candidate.feeBps! >= 0 &&
    isAddressLike(candidate.feeVault) &&
    isCipherDEXV1FeePolicy(candidate.feePolicy, candidate.feeBps) &&
    candidate.privacyMode === PRIVACY_MODE.AMOUNT_CONFIDENTIAL_PRIVATE_LP &&
    candidate.quoteTransport === CONFIDENTIAL_QUOTE_TRANSPORT.TRANSACTION_EVENT
  );
}

// Explicit alias for callers that only need untrusted JSON shape validation.
export const isConfidentialPoolDiscoveryShape = isConfidentialPoolDiscovery;

const ownDataValue = (
  descriptors: PropertyDescriptorMap,
  key: string,
): unknown => {
  const descriptor = descriptors[key];
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
};

const snapshotFeePolicy = (value: unknown): unknown => {
  if (!value || typeof value !== "object") return value;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const collection = ownDataValue(descriptors, "confidentialCollection");
  let confidentialCollection: unknown = collection;
  if (collection && typeof collection === "object") {
    const collectionDescriptors = Object.getOwnPropertyDescriptors(collection);
    confidentialCollection = {
      minimumPoolSwapCount: ownDataValue(collectionDescriptors, "minimumPoolSwapCount"),
      minimumPoolDelaySeconds: ownDataValue(collectionDescriptors, "minimumPoolDelaySeconds"),
      minimumVaultSweepDelaySeconds: ownDataValue(
        collectionDescriptors,
        "minimumVaultSweepDelaySeconds",
      ),
    };
  }
  return {
    totalFeeBps: ownDataValue(descriptors, "totalFeeBps"),
    protocolFeeShareNumerator: ownDataValue(descriptors, "protocolFeeShareNumerator"),
    protocolFeeShareDenominator: ownDataValue(descriptors, "protocolFeeShareDenominator"),
    lpFeeShareNumerator: ownDataValue(descriptors, "lpFeeShareNumerator"),
    lpFeeShareDenominator: ownDataValue(descriptors, "lpFeeShareDenominator"),
    chargedOn: ownDataValue(descriptors, "chargedOn"),
    extraNativeSwapFee: ownDataValue(descriptors, "extraNativeSwapFee"),
    confidentialCollection,
  };
};

const snapshotConfidentialPoolDiscovery = (value: unknown): unknown => {
  if (!value || typeof value !== "object") return value;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return {
      disclosureSchemaVersion: ownDataValue(descriptors, "disclosureSchemaVersion"),
      protocolVersion: ownDataValue(descriptors, "protocolVersion"),
      pool: ownDataValue(descriptors, "pool"),
      token0: ownDataValue(descriptors, "token0"),
      token1: ownDataValue(descriptors, "token1"),
      token0Decimals: ownDataValue(descriptors, "token0Decimals"),
      token1Decimals: ownDataValue(descriptors, "token1Decimals"),
      feeBps: ownDataValue(descriptors, "feeBps"),
      feeVault: ownDataValue(descriptors, "feeVault"),
      feePolicy: snapshotFeePolicy(ownDataValue(descriptors, "feePolicy")),
      privacyMode: ownDataValue(descriptors, "privacyMode"),
      poolKind: ownDataValue(descriptors, "poolKind"),
      quoteTransport: ownDataValue(descriptors, "quoteTransport"),
    };
  } catch {
    return undefined;
  }
};

const snapshotPublicPoolDiscovery = (value: unknown): unknown => {
  if (!value || typeof value !== "object") return value;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return {
      disclosureSchemaVersion: ownDataValue(descriptors, "disclosureSchemaVersion"),
      protocolVersion: ownDataValue(descriptors, "protocolVersion"),
      pool: ownDataValue(descriptors, "pool"),
      token0: ownDataValue(descriptors, "token0"),
      token1: ownDataValue(descriptors, "token1"),
      token0Decimals: ownDataValue(descriptors, "token0Decimals"),
      token1Decimals: ownDataValue(descriptors, "token1Decimals"),
      feeBps: ownDataValue(descriptors, "feeBps"),
      feeVault: ownDataValue(descriptors, "feeVault"),
      feePolicy: snapshotFeePolicy(ownDataValue(descriptors, "feePolicy")),
      privacyMode: ownDataValue(descriptors, "privacyMode"),
      poolKind: ownDataValue(descriptors, "poolKind"),
    };
  } catch {
    return undefined;
  }
};

const toSafeChainNumber = (value: number | bigint): number | undefined => {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : undefined;
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  return Number(value);
};

const sameAddress = (left: string, right: string): boolean =>
  isAddressLike(left) && isAddressLike(right) && left.toLowerCase() === right.toLowerCase();

const hasDeployedCode = (code: string): boolean =>
  /^0x[0-9a-fA-F]+$/.test(code) && !/^0x0*$/.test(code);

/**
 * Converts untrusted discovery metadata into a process-local verified value.
 * Verification binds the candidate to an expected deployed factory, its
 * canonical key, immutable pool metadata, fee vault, and protocol version.
 */
export async function verifyConfidentialPoolDiscovery(
  value: unknown,
  policy: ConfidentialPoolVerificationPolicy,
  adapter: ConfidentialPoolVerificationAdapter,
): Promise<VerifiedConfidentialPoolDiscovery> {
  if (containsSensitiveDisclosure(value)) {
    throw new TypeError("Invalid confidential pool discovery shape");
  }
  const discoverySnapshot = snapshotConfidentialPoolDiscovery(value);
  if (!isConfidentialPoolDiscovery(discoverySnapshot)) {
    throw new TypeError("Invalid confidential pool discovery shape");
  }
  const discovery = discoverySnapshot;
  if (
    !isAddressLike(policy.expectedFactory) ||
    !isAddressLike(policy.expectedFeeVault) ||
    !Number.isSafeInteger(policy.expectedProtocolVersion) ||
    policy.expectedProtocolVersion <= 0 ||
    discovery.protocolVersion !== policy.expectedProtocolVersion ||
    !sameAddress(discovery.feeVault, policy.expectedFeeVault)
  ) {
    throw new TypeError("Confidential pool discovery violates verification policy");
  }

  let factoryCode: string;
  let poolCode: string;
  let factoryVersionValue: number | bigint;
  let token0Approved: boolean;
  let token1Approved: boolean;
  let factoryRecognizesPool: boolean;
  let canonicalPool: string;
  let poolState: ConfidentialPoolOnchainState;
  try {
    [
      factoryCode,
      poolCode,
      factoryVersionValue,
      token0Approved,
      token1Approved,
      factoryRecognizesPool,
      canonicalPool,
      poolState,
    ] = await Promise.all([
      adapter.getCode(policy.expectedFactory),
      adapter.getCode(discovery.pool),
      adapter.readFactoryProtocolVersion(policy.expectedFactory),
      adapter.isFactoryPrivateTokenApproved(policy.expectedFactory, discovery.token0),
      adapter.isFactoryPrivateTokenApproved(policy.expectedFactory, discovery.token1),
      adapter.isFactoryPool(policy.expectedFactory, discovery.pool),
      adapter.getCanonicalPool(policy.expectedFactory, discovery),
      adapter.readPoolState(discovery.pool),
    ]);
  } catch (error) {
    throw new TypeError("Unable to verify confidential pool provenance", { cause: error });
  }

  const factoryVersion = toSafeChainNumber(factoryVersionValue);
  const poolVersion = toSafeChainNumber(poolState.protocolVersion);
  const privacyMode = toSafeChainNumber(poolState.privacyMode);
  const token0Decimals = toSafeChainNumber(poolState.token0Decimals);
  const token1Decimals = toSafeChainNumber(poolState.token1Decimals);
  const feeBps = toSafeChainNumber(poolState.feeBps);

  if (
    !hasDeployedCode(factoryCode) ||
    !hasDeployedCode(poolCode) ||
    !token0Approved ||
    !token1Approved ||
    !factoryRecognizesPool ||
    factoryVersion !== policy.expectedProtocolVersion ||
    poolVersion !== discovery.protocolVersion ||
    privacyMode !== discovery.privacyMode ||
    !sameAddress(canonicalPool, discovery.pool) ||
    !sameAddress(poolState.token0, discovery.token0) ||
    !sameAddress(poolState.token1, discovery.token1) ||
    token0Decimals !== discovery.token0Decimals ||
    token1Decimals !== discovery.token1Decimals ||
    feeBps !== discovery.feeBps ||
    !sameAddress(poolState.feeVault, discovery.feeVault) ||
    !sameAddress(poolState.feeVault, policy.expectedFeeVault)
  ) {
    throw new TypeError("Confidential pool provenance verification failed");
  }

  const verified = Object.freeze({
    disclosureSchemaVersion: discovery.disclosureSchemaVersion,
    protocolVersion: discovery.protocolVersion,
    factory: policy.expectedFactory,
    pool: discovery.pool,
    token0: discovery.token0,
    token1: discovery.token1,
    token0Decimals: discovery.token0Decimals,
    token1Decimals: discovery.token1Decimals,
    feeBps: discovery.feeBps,
    feeVault: discovery.feeVault,
    feePolicy: Object.freeze(getCipherDEXV1FeePolicy(discovery.feeBps)),
    privacyMode: discovery.privacyMode,
    poolKind: discovery.poolKind,
    quoteTransport: discovery.quoteTransport,
  }) as VerifiedConfidentialPoolDiscovery;
  verifiedConfidentialPoolDiscoveries.add(verified);
  return verified;
}

/**
 * Selects the largest output among factory-proven canonical fee-tier pools.
 * Each evaluation must represent the same logical request and direction. The
 * service creates a fresh pool-bound encrypted input for every transaction.
 */
export function selectBestConfidentialPoolQuote(
  evaluations: readonly ConfidentialQuoteEvaluation[],
): ConfidentialQuoteEvaluation | undefined {
  if (evaluations.length === 0) return undefined;

  const first = evaluations[0];
  if (
    first.requestId.length === 0 ||
    first.amountIn <= 0n ||
    first.decryptedAmountOut <= 0n ||
    !verifiedConfidentialPoolDiscoveries.has(first.discovery)
  ) {
    throw new TypeError("Invalid confidential quote evaluation");
  }

  const token0 = first.discovery.token0.toLowerCase();
  const token1 = first.discovery.token1.toLowerCase();
  const factory = first.discovery.factory.toLowerCase();
  const feeVault = first.discovery.feeVault.toLowerCase();
  const seenPools = new Set<string>();
  let best = first;

  for (const evaluation of evaluations) {
    const pool = evaluation.discovery.pool.toLowerCase();
    if (
      evaluation.requestId !== first.requestId ||
      evaluation.amountIn !== first.amountIn ||
      evaluation.zeroForOne !== first.zeroForOne ||
      evaluation.decryptedAmountOut <= 0n ||
      !verifiedConfidentialPoolDiscoveries.has(evaluation.discovery) ||
      evaluation.discovery.token0.toLowerCase() !== token0 ||
      evaluation.discovery.token1.toLowerCase() !== token1 ||
      evaluation.discovery.factory.toLowerCase() !== factory ||
      evaluation.discovery.feeVault.toLowerCase() !== feeVault ||
      evaluation.discovery.protocolVersion !== first.discovery.protocolVersion ||
      evaluation.discovery.privacyMode !== first.discovery.privacyMode ||
      evaluation.discovery.poolKind !== first.discovery.poolKind ||
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
    candidate.protocolVersion === CIPHERDEX_PROTOCOL_VERSION &&
    candidate.poolKind === "public-erc20-cpmm-v2" &&
    isAddressLike(candidate.pool) &&
    isAddressLike(candidate.token0) &&
    isAddressLike(candidate.token1) &&
    candidate.token0!.toLowerCase() < candidate.token1!.toLowerCase() &&
    Number.isInteger(candidate.protocolVersion) &&
    candidate.protocolVersion! > 0 &&
    Number.isInteger(candidate.token0Decimals) &&
    candidate.token0Decimals! >= 0 &&
    candidate.token0Decimals! <= 18 &&
    Number.isInteger(candidate.token1Decimals) &&
    candidate.token1Decimals! >= 0 &&
    candidate.token1Decimals! <= 18 &&
    Number.isInteger(candidate.feeBps) &&
    candidate.feeBps! >= 0 &&
    isAddressLike(candidate.feeVault) &&
    isCipherDEXV1FeePolicy(candidate.feePolicy, candidate.feeBps) &&
    candidate.privacyMode === PRIVACY_MODE.TRANSPARENT
  );
}

export const isPublicPoolDiscoveryShape = isPublicPoolDiscovery;

/**
 * Converts untrusted public-market metadata into a process-local value bound
 * to the expected canonical factory, fee vault, protocol and immutable pool
 * state. Shape validation alone is not provenance validation.
 */
export async function verifyPublicPoolDiscovery(
  value: unknown,
  policy: PublicPoolVerificationPolicy,
  adapter: PublicPoolVerificationAdapter,
): Promise<VerifiedPublicPoolDiscovery> {
  if (containsSensitiveDisclosure(value)) {
    throw new TypeError("Invalid public pool discovery shape");
  }
  const discoverySnapshot = snapshotPublicPoolDiscovery(value);
  if (!isPublicPoolDiscovery(discoverySnapshot)) {
    throw new TypeError("Invalid public pool discovery shape");
  }
  const discovery = discoverySnapshot;
  if (
    !isAddressLike(policy.expectedFactory) ||
    !isAddressLike(policy.expectedFeeVault) ||
    !Number.isSafeInteger(policy.expectedProtocolVersion) ||
    policy.expectedProtocolVersion <= 0 ||
    discovery.protocolVersion !== policy.expectedProtocolVersion ||
    !sameAddress(discovery.feeVault, policy.expectedFeeVault)
  ) {
    throw new TypeError("Public pool discovery violates verification policy");
  }

  let factoryCode: string;
  let poolCode: string;
  let factoryVersionValue: number | bigint;
  let factoryRecognizesPool: boolean;
  let canonicalPool: string;
  let poolState: PublicPoolOnchainState;
  try {
    [
      factoryCode,
      poolCode,
      factoryVersionValue,
      factoryRecognizesPool,
      canonicalPool,
      poolState,
    ] = await Promise.all([
      adapter.getCode(policy.expectedFactory),
      adapter.getCode(discovery.pool),
      adapter.readFactoryProtocolVersion(policy.expectedFactory),
      adapter.isFactoryPool(policy.expectedFactory, discovery.pool),
      adapter.getCanonicalPool(policy.expectedFactory, discovery),
      adapter.readPoolState(discovery.pool),
    ]);
  } catch (error) {
    throw new TypeError("Unable to verify public pool provenance", { cause: error });
  }

  const factoryVersion = toSafeChainNumber(factoryVersionValue);
  const poolVersion = toSafeChainNumber(poolState.protocolVersion);
  const privacyMode = toSafeChainNumber(poolState.privacyMode);
  const token0Decimals = toSafeChainNumber(poolState.token0Decimals);
  const token1Decimals = toSafeChainNumber(poolState.token1Decimals);
  const feeBps = toSafeChainNumber(poolState.feeBps);

  if (
    !hasDeployedCode(factoryCode) ||
    !hasDeployedCode(poolCode) ||
    !factoryRecognizesPool ||
    factoryVersion !== policy.expectedProtocolVersion ||
    poolVersion !== discovery.protocolVersion ||
    privacyMode !== discovery.privacyMode ||
    !sameAddress(canonicalPool, discovery.pool) ||
    !sameAddress(poolState.token0, discovery.token0) ||
    !sameAddress(poolState.token1, discovery.token1) ||
    token0Decimals !== discovery.token0Decimals ||
    token1Decimals !== discovery.token1Decimals ||
    feeBps !== discovery.feeBps ||
    !sameAddress(poolState.feeVault, discovery.feeVault) ||
    !sameAddress(poolState.feeVault, policy.expectedFeeVault)
  ) {
    throw new TypeError("Public pool provenance verification failed");
  }

  const verified = Object.freeze({
    disclosureSchemaVersion: discovery.disclosureSchemaVersion,
    protocolVersion: discovery.protocolVersion,
    factory: policy.expectedFactory,
    pool: discovery.pool,
    token0: discovery.token0,
    token1: discovery.token1,
    token0Decimals: discovery.token0Decimals,
    token1Decimals: discovery.token1Decimals,
    feeBps: discovery.feeBps,
    feeVault: discovery.feeVault,
    feePolicy: Object.freeze(getCipherDEXV1FeePolicy(discovery.feeBps)),
    privacyMode: discovery.privacyMode,
    poolKind: discovery.poolKind,
  }) as VerifiedPublicPoolDiscovery;
  verifiedPublicPoolDiscoveries.add(verified);
  return verified;
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
