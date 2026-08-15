/**
 * Stable, privacy-minimal client surface for CipherDEX protocol v1.
 *
 * These ABI fragments intentionally contain no balance, reserve, amount or LP
 * position read model. Clients must obtain private values through the official
 * COTI SDK and the caller's AES key.
 */

export const DISCLOSURE_SCHEMA_VERSION = 2 as const;

export const PRIVACY_MODE = {
  TRANSPARENT: 0,
  AMOUNT_CONFIDENTIAL_PRIVATE_LP: 1,
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
  "function bootstrapper() view returns (address)",
  "function lpToken() view returns (address)",
  "function initialized() view returns (bool)",
  "function quoteExactInput(((uint256,uint256),bytes),bool) returns ((uint256,uint256))",
  "function swapExactInput(((uint256,uint256),bytes),((uint256,uint256),bytes),bool,uint64) returns ((uint256,uint256))",
  "function addLiquidity(((uint256,uint256),bytes),((uint256,uint256),bytes),((uint256,uint256),bytes),uint64) returns ((uint256,uint256))",
  "function bootstrapLiquidity(address,uint256,uint256,uint256,uint256,uint256) returns ((uint256,uint256))",
  "function bootstrapLiquidityWithDisposition(address,uint256,uint256,uint256,uint256,uint256,uint8,uint64) returns ((uint256,uint256),bytes32)",
  "function removeLiquidity(((uint256,uint256),bytes),((uint256,uint256),bytes),((uint256,uint256),bytes),uint64) returns ((uint256,uint256),(uint256,uint256))",
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
] as const;

export const CONFIDENTIAL_CPMM_FACTORY_ABI = [
  "function PROTOCOL_VERSION() view returns (uint256)",
  "function lpTokenFactory() view returns (address)",
  "function getPool(bytes32) view returns (address)",
  "function isPool(address) view returns (bool)",
  "function createPool(address,address,uint8,uint8,uint256) returns (address)",
  "function poolKey(address,address,uint8,uint8,uint256) pure returns (bytes32)",
  "function allPoolsLength() view returns (uint256)",
  "function allPools(uint256) view returns (address)",
  "function bootstrapPool(address,address,uint256,uint256,uint256,uint256,uint256) returns ((uint256,uint256))",
  "function bootstrapPoolWithDisposition(address,address,uint256,uint256,uint256,uint256,uint256,uint8,uint64) returns ((uint256,uint256),bytes32)",
  "event PoolCreated(address indexed token0,address indexed token1,uint8 token0Decimals,uint8 token1Decimals,uint256 feeBps,address pool)",
  "event PrivateLPTokenCreated(address indexed pool,address indexed token)",
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
  "function migrate(address,address,uint8,uint8,uint256,((uint256,uint256),bytes),((uint256,uint256),bytes),((uint256,uint256),bytes),((uint256,uint256),bytes),((uint256,uint256),bytes),uint64) returns (address,(uint256,uint256))",
  "function migrateWithDisposition(address,address,uint8,uint8,uint256,((uint256,uint256),bytes),((uint256,uint256),bytes),((uint256,uint256),bytes),((uint256,uint256),bytes),((uint256,uint256),bytes),uint64,uint8,uint64) returns (address,(uint256,uint256),bytes32)",
  "event LaunchpadMigration(address indexed creator,address indexed pool)",
  "event LaunchpadLockDisposition(address indexed creator,address indexed pool,uint8 disposition,bytes32 lockId,uint64 unlockTime)",
] as const;

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
  "function initialized() view returns (bool)",
  "function totalShares() view returns (uint256)",
  "function shares(address) view returns (uint256)",
  "function quoteExactInput(uint256,bool) view returns (uint256)",
  "function swapExactInput(uint256,uint256,bool,uint64) returns (uint256)",
  "function addLiquidity(uint256,uint256,uint256,uint64) returns (uint256)",
  "function removeLiquidity(uint256,uint256,uint256,uint64) returns (uint256,uint256)",
  "function lockShares(uint256,uint64,bool,uint64) returns (bytes32)",
  "function unlockShares(bytes32)",
  "function lockInfo(bytes32) view returns (address,uint64,bool,bool,uint256)",
  "event SwapExecuted(address indexed trader,bool indexed zeroForOne,uint256 amountIn,uint256 amountOut)",
  "event LiquidityAdded(address indexed provider,uint256 amount0,uint256 amount1,uint256 shares)",
  "event LiquidityRemoved(address indexed provider,uint256 amount0,uint256 amount1,uint256 shares)",
  "event LiquidityLocked(bytes32 indexed lockId,address indexed owner,uint64 unlockTime,bool permanent,uint256 shares)",
  "event LiquidityUnlocked(bytes32 indexed lockId,address indexed owner,uint256 shares)",
] as const;

export const PUBLIC_CPMM_FACTORY_ABI = [
  "function PROTOCOL_VERSION() view returns (uint256)",
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

export type ConfidentialPoolDiscovery = {
  disclosureSchemaVersion: typeof DISCLOSURE_SCHEMA_VERSION;
  protocolVersion: number;
  pool: string;
  token0: string;
  token1: string;
  token0Decimals: number;
  token1Decimals: number;
  feeBps: number;
  privacyMode: typeof PRIVACY_MODE.AMOUNT_CONFIDENTIAL_PRIVATE_LP;
  poolKind: "private-erc20-cpmm-v1";
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

export function isConfidentialPoolDiscovery(
  value: unknown,
): value is ConfidentialPoolDiscovery {
  if (!value || typeof value !== "object") return false;
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
    typeof candidate.feeBps === "number" &&
    candidate.privacyMode === PRIVACY_MODE.AMOUNT_CONFIDENTIAL_PRIVATE_LP
  );
}

export function isPublicPoolDiscovery(value: unknown): value is PublicPoolDiscovery {
  if (!value || typeof value !== "object") return false;
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
    candidate.privacyMode === PRIVACY_MODE.TRANSPARENT
  );
}
