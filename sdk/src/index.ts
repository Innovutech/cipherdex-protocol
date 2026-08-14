/**
 * Stable, privacy-minimal client surface for CipherDEX protocol v1.
 *
 * These ABI fragments intentionally contain no balance, reserve, amount or LP
 * position read model. Clients must obtain private values through the official
 * COTI SDK and the caller's AES key.
 */

export const DISCLOSURE_SCHEMA_VERSION = 1 as const;

export const CONFIDENTIAL_CPMM_ABI = [
  "function PROTOCOL_VERSION() view returns (uint256)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function token0Decimals() view returns (uint8)",
  "function token1Decimals() view returns (uint8)",
  "function scale0() view returns (uint256)",
  "function scale1() view returns (uint256)",
  "function feeBps() view returns (uint256)",
  "function bootstrapper() view returns (address)",
  "function initialized() view returns (bool)",
  "function quoteExactInput(((uint256,uint256),bytes),bool) returns ((uint256,uint256))",
  "function swapExactInput(((uint256,uint256),bytes),((uint256,uint256),bytes),bool,uint64) returns ((uint256,uint256))",
  "function addLiquidity(((uint256,uint256),bytes),((uint256,uint256),bytes),((uint256,uint256),bytes),uint64) returns ((uint256,uint256))",
  "function bootstrapLiquidity(address,uint256,uint256,uint256,uint256,uint256) returns ((uint256,uint256))",
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
  "function getPool(bytes32) view returns (address)",
  "function isPool(address) view returns (bool)",
  "function createPool(address,address,uint8,uint8,uint256) returns (address)",
  "function poolKey(address,address,uint8,uint8,uint256) pure returns (bytes32)",
  "function allPoolsLength() view returns (uint256)",
  "function allPools(uint256) view returns (address)",
  "function bootstrapPool(address,address,uint256,uint256,uint256,uint256,uint256) returns ((uint256,uint256))",
  "event PoolCreated(address indexed token0,address indexed token1,uint8 token0Decimals,uint8 token1Decimals,uint256 feeBps,address pool)",
] as const;

export const CONFIDENTIAL_LAUNCHPAD_MIGRATOR_ABI = [
  "function PROTOCOL_VERSION() view returns (uint256)",
  "function factory() view returns (address)",
  "function migrate(address,address,uint8,uint8,uint256,((uint256,uint256),bytes),((uint256,uint256),bytes),((uint256,uint256),bytes),((uint256,uint256),bytes),((uint256,uint256),bytes),uint64) returns (address,(uint256,uint256))",
  "event LaunchpadMigration(address indexed creator,address indexed pool)",
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
  poolKind: "private-erc20-cpmm-v1";
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
    typeof candidate.feeBps === "number"
  );
}
