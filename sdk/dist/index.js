export * from "./tokenApproval.js";
export * from "./operationPlan.js";
export * from "./walletCallBatch.js";
/**
 * Stable, privacy-minimal client surface for CipherDEX.
 *
 * These ABI fragments intentionally contain no balance, reserve, amount or LP
 * position read model. Clients must obtain private values through the official
 * COTI SDK and the caller's AES key.
 */
export const DISCLOSURE_SCHEMA_VERSION = 7;
export const CIPHERDEX_PUBLIC_PROTOCOL_VERSION = 2;
export const CIPHERDEX_CONFIDENTIAL_PROTOCOL_VERSION = 3;
export const CIPHERDEX_PROTOCOL_VERSION = CIPHERDEX_CONFIDENTIAL_PROTOCOL_VERSION;
export const CONFIDENTIAL_BEST_EXECUTION_ROUTER_VERSION = 2;
export const CONFIDENTIAL_LAUNCHPAD_MIGRATOR_VERSION = 4;
export const CONFIDENTIAL_INITIALIZATION_STRATEGY_VERSION = 1;
export const CONFIDENTIAL_INITIALIZATION_STRATEGY_REGISTRY_VERSION = 1;
export const CIPHERDEX_V1_FEE_POLICY = {
    approvedTotalFeeBps: [5, 30, 100],
    protocolFeeShareNumerator: 1,
    protocolFeeShareDenominator: 6,
    lpFeeShareNumerator: 5,
    lpFeeShareDenominator: 6,
    chargedOn: "input",
    extraNativeSwapFee: false,
    confidentialCollection: {
        minimumPoolSwapCount: 8,
        minimumPoolDelaySeconds: 3_600,
        minimumVaultSweepDelaySeconds: 86_400,
        vaultEpochSeconds: 86_400,
        minimumVaultAggregatedSwapCount: 8,
        minimumVaultResidenceEpochs: 2,
    },
};
export const CONFIDENTIAL_QUOTE_TRANSPORT = {
    TRANSACTION_EVENT: "encrypted-transaction-event-v1",
};
export const PRIVACY_MODE = {
    TRANSPARENT: 0,
    AMOUNT_CONFIDENTIAL_PRIVATE_LP: 1,
    UNSUPPORTED_FULLY_CONFIDENTIAL: 2,
};
export const LP_DISPOSITION = {
    CREATOR_HELD: 0,
    TIMED_LOCK: 1,
    PERMANENT_LOCK: 2,
};
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
    "function initializationStrategy() view returns (address)",
    "function lpToken() view returns (address)",
    "function initialized() view returns (bool)",
    "function protectedInitializationCompleted() view returns (bool)",
    "function quoteExactInput(((uint256,uint256),bytes),bool) returns ((uint256,uint256))",
    "function requestQuoteExactInput(((uint256,uint256),bytes),bool,bytes32) returns ((uint256,uint256))",
    "function requestAddLiquidityQuote(((uint256,uint256),bytes),bool,bytes32,uint64) returns ((uint256,uint256),(uint256,uint256),(uint256,uint256))",
    "function swapExactInput(((uint256,uint256),bytes),((uint256,uint256),bytes),bool,uint64) returns ((uint256,uint256))",
    "function addLiquidity(((uint256,uint256),bytes),((uint256,uint256),bytes),((uint256,uint256),bytes),((uint256,uint256),bytes),((uint256,uint256),bytes),bool,uint64) returns ((uint256,uint256))",
    "function bootstrapLiquidity(address,address,uint256,uint256,uint256,uint256,uint256) returns ((uint256,uint256))",
    "function bootstrapLiquidityWithDisposition(address,address,uint256,uint256,uint256,uint256,uint256,uint8,uint64) returns ((uint256,uint256),bytes32)",
    "function removeLiquidity(((uint256,uint256),bytes),((uint256,uint256),bytes),((uint256,uint256),bytes),uint64) returns ((uint256,uint256),(uint256,uint256))",
    "function collectProtocolFees(bool,bool)",
    "function myShares() view returns ((uint256,uint256))",
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
    "event ConfidentialLiquidityQuoteResult(address indexed caller,bytes32 indexed requestId,bool indexed token0Specified,(uint256,uint256) acceptedCiphertext,(uint256,uint256) counterpartCiphertext,(uint256,uint256) lpCiphertext)",
    "event ConfidentialProtocolFeesCollected(address indexed token,address indexed feeVault,uint32 aggregatedSwapCount)",
];
export const CONFIDENTIAL_CPMM_FACTORY_ABI = [
    "function PROTOCOL_VERSION() view returns (uint256)",
    "function PRIVACY_MODE() view returns (uint8)",
    "function PRIVATE_LP_TOKEN_FACTORY_RUNTIME_CODEHASH() view returns (bytes32)",
    "function lpTokenFactory() view returns (address)",
    "function poolDeployer() view returns (address)",
    "function poolDeployerRuntimeCodehash() view returns (bytes32)",
    "function feeVault() view returns (address)",
    "function initializationStrategyRegistry() view returns (address)",
    "function initializationStrategyRegistryRuntimeCodehash() view returns (bytes32)",
    "function initializationStrategyRegistryFinalized() view returns (bool)",
    "function initializationStrategiesLength() view returns (uint256)",
    "function initializationStrategyAt(uint8) view returns (address)",
    "function initializationStrategyClass(address) view returns (uint8)",
    "function initializationStrategyRuntimeCodehash(address) view returns (bytes32)",
    "function initializationStrategyRegistration(address) view returns (bytes32)",
    "function isCompatiblePrivateToken(address) view returns (bool)",
    "function isApprovedFeeTier(uint256) pure returns (bool)",
    "function bootstrapConfigurator() view returns (address)",
    "function bestExecutionRouter() view returns (address)",
    "function BEST_EXECUTION_ROUTER_RUNTIME_CODEHASH() view returns (bytes32)",
    "function getPool(bytes32) view returns (address)",
    "function isPool(address) view returns (bool)",
    "function createPool(address,address,uint8,uint8,uint256) returns (address)",
    "function getOrCreatePoolForCommitment(address,address,uint8,uint8,uint256) returns (address)",
    "function setBestExecutionRouter(address)",
    "function poolKey(address,address,uint8,uint8,uint256,address) pure returns (bytes32)",
    "function allPoolsLength() view returns (uint256)",
    "function allPools(uint256) view returns (address)",
    "function bootstrapPool(address,bytes32,bytes32,address,address,uint256,uint256,uint256,uint256,uint256) returns ((uint256,uint256))",
    "function bootstrapPoolWithDisposition(address,bytes32,bytes32,address,address,uint256,uint256,uint256,uint256,uint256,uint8,uint64) returns ((uint256,uint256),bytes32)",
    "event PoolCreated(address indexed token0,address indexed token1,uint8 token0Decimals,uint8 token1Decimals,uint256 feeBps,address initializationStrategy,address pool)",
    "event PrivateLPTokenCreated(address indexed pool,address indexed token)",
    "event BestExecutionRouterConfigured(address indexed router)",
];
export const PRIVATE_LP_TOKEN_FACTORY_ABI = [
    "function poolByToken(address) view returns (address)",
    "function issuerByToken(address) view returns (address)",
    "function isIssuedToken(address,address,address) view returns (bool)",
    "event PrivateLPTokenIssued(address indexed pool,address indexed token,address indexed issuer)",
];
export const CONFIDENTIAL_BEST_EXECUTION_POOL_ABI = [
    "function quoteExactInputForRouter(uint256,bool) returns (uint256,uint256)",
    "function settleExactInputForRouter(address,uint256,uint256,bool,uint64) returns (uint256)",
];
export const CONFIDENTIAL_BEST_EXECUTION_ROUTER_ABI = [
    "function PROTOCOL_VERSION() view returns (uint256)",
    "function factory() view returns (address)",
    "function MAX_CANDIDATES() view returns (uint8)",
    "function MAX_QUOTE_CANDIDATES() view returns (uint8)",
    "function MAX_POOL_CLASSES() view returns (uint8)",
    "function DEFAULT_STANDARD_CANDIDATE_BITMAP() view returns (uint16)",
    "function usedRequestIds(address,bytes4,bytes32) view returns (bool)",
    "function requestBestQuoteExactInput(address,address,((uint256,uint256),bytes),bytes32,uint64) returns ((uint256,uint256))",
    "function requestBestQuoteExactInputWithCandidates(address,address,((uint256,uint256),bytes),uint16,bytes32,uint64) returns ((uint256,uint256))",
    "function swapBestExactInput(address,address,((uint256,uint256),bytes),((uint256,uint256),bytes),bytes32,uint64) returns ((uint256,uint256))",
    "function swapBestExactInputWithCandidates(address,address,((uint256,uint256),bytes),((uint256,uint256),bytes),uint16,bytes32,uint64) returns ((uint256,uint256))",
    "event ConfidentialBestQuoteResult(address indexed caller,bytes32 indexed requestId,address indexed selectedPool,uint256 selectedFeeBps,address selectedInitializationStrategy,uint16 candidateBitmap,bool zeroForOne,(uint256,uint256) result)",
    "event ConfidentialBestSwapResult(address indexed caller,bytes32 indexed requestId,address indexed selectedPool,uint256 selectedFeeBps,address selectedInitializationStrategy,uint16 candidateBitmap,bool zeroForOne,(uint256,uint256) result)",
];
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
];
export const CONFIDENTIAL_LAUNCHPAD_MIGRATOR_ABI = [
    "function PROTOCOL_VERSION() view returns (uint256)",
    "function factory() view returns (address)",
    "function initializationStrategy() view returns (address)",
    "function migrate((bytes32,address,address,uint8,uint8,uint256,((uint256,uint256),bytes),((uint256,uint256),bytes),((uint256,uint256),bytes),((uint256,uint256),bytes),((uint256,uint256),bytes),uint64,bytes)) returns (address,(uint256,uint256))",
    "function migrateWithDisposition((bytes32,address,address,uint8,uint8,uint256,((uint256,uint256),bytes),((uint256,uint256),bytes),((uint256,uint256),bytes),((uint256,uint256),bytes),((uint256,uint256),bytes),uint64,bytes),uint8,uint64) returns (address,(uint256,uint256),bytes32)",
    "event LaunchpadMigration(bytes32 indexed launchId,address indexed creator,address indexed pool,address initializationStrategy,bytes32 authorizationHash)",
    "event LaunchpadLockDisposition(address indexed creator,address indexed pool,uint8 disposition,bytes32 lockId,uint64 unlockTime)",
];
export const CONFIDENTIAL_INITIALIZATION_STRATEGY_ABI = [
    "function STRATEGY_VERSION() view returns (uint256)",
    "function PROTOCOL_VERSION() view returns (uint256)",
    "function PRIVACY_MODE() view returns (uint8)",
    "function factory() view returns (address)",
    "function strategyRegistry() view returns (address)",
    "function migrator() view returns (address)",
    "function migratorRuntimeCodehash() view returns (bytes32)",
    "function configurationFinalized() view returns (bool)",
    "function factoryRegistration() view returns (bytes32)",
    "function prepareLaunch(bytes32,address,address,address,uint8,uint8,uint256,uint64,bytes32) returns (address pool,bytes32 poolKey)",
    "function getLaunch(bytes32) view returns (bytes32,bytes32,address,address,uint64,uint8)",
    "function activeLaunchForPoolKey(bytes32) view returns (bytes32)",
    "event LaunchPrepared(bytes32 indexed launchId,bytes32 indexed poolKey,address indexed pool,address creator,uint64 migrationDeadline,bytes32 authorizationHash)",
];
export const CONFIDENTIAL_INITIALIZATION_STRATEGY_REGISTRY_ABI = [
    "function REGISTRY_VERSION() view returns (uint256)",
    "function MAX_INITIALIZATION_STRATEGIES() view returns (uint8)",
    "function factory() view returns (address)",
    "function finalized() view returns (bool)",
    "function initializationStrategiesLength() view returns (uint256)",
    "function initializationStrategyAt(uint8) view returns (address)",
    "function initializationStrategyClass(address) view returns (uint8)",
    "function initializationStrategyRuntimeCodehash(address) view returns (bytes32)",
    "function initializationStrategyRegistration(address) view returns (bytes32)",
    "function isRegisteredStrategy(address) view returns (bool)",
];
export const CIPHERDEX_FEE_VAULT_ABI = [
    "function beneficiary() view returns (address)",
    "function deployedAt() view returns (uint64)",
    "function confidentialFactoryConfigurator() view returns (address)",
    "function confidentialFactory() view returns (address)",
    "function publicFactory() view returns (address)",
    "function publicFees(address) view returns (uint256)",
    "function MIN_CONFIDENTIAL_SWEEP_DELAY() view returns (uint64)",
    "function CONFIDENTIAL_EPOCH_SECONDS() view returns (uint64)",
    "function MIN_CONFIDENTIAL_AGGREGATED_SWAPS() view returns (uint64)",
    "function MAX_CONFIDENTIAL_SWEEP_EPOCHS() view returns (uint256)",
    "function confidentialSwapCountByEpoch(address,uint64) view returns (uint64)",
    "function nextConfidentialEpochIndex(address) view returns (uint256)",
    "function confidentialEpochCount(address) view returns (uint256)",
    "function confidentialEpochAt(address,uint256) view returns (uint64)",
    "function nextConfidentialSweepAt(address) view returns (uint64)",
    "function setConfidentialFactory(address)",
    "function setPublicFactory(address)",
    "function depositPublicFees(address,uint256) returns (uint256)",
    "function depositConfidentialFees(address,uint256,uint32)",
    "function sweepPublicToken(address) returns (uint256)",
    "function sweepConfidentialToken(address)",
    "event PublicFeesSwept(address indexed token,address indexed beneficiary,uint256 amount)",
    "event PublicFeesSweepReceipt(address indexed token,address indexed beneficiary,uint256 debitedAmount,uint256 beneficiaryReceived)",
    "event PublicFactoryConfigured(address indexed factory)",
    "event PublicFeesDeposited(address indexed token,address indexed pool,uint256 amount)",
    "event ConfidentialFeesSwept(address indexed token,address indexed beneficiary,uint64 aggregatedSwapCount)",
    "event ConfidentialFactoryConfigured(address indexed factory)",
    "event ConfidentialFeesDeposited(address indexed token,address indexed pool,uint64 indexed epoch,uint32 aggregatedSwapCount)",
];
export const LAUNCHPAD_MIGRATOR_EIP712_DOMAIN = {
    name: "CipherDEX Launchpad Migrator",
    version: "1",
};
export const LAUNCHPAD_MIGRATION_EIP712_TYPES = [
    { name: "launchId", type: "bytes32" },
    { name: "initializationStrategy", type: "address" },
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
];
const MAX_UINT256_DECIMAL_DIGITS = 78;
const MAX_EVIDENCE_CALLDATA_BYTES = 64 * 1024;
const MAX_EVIDENCE_LOG_DATA_BYTES = 64 * 1024;
const MAX_EVIDENCE_RECEIPT_LOGS = 4_096;
const MAX_EVIDENCE_LOG_TOPICS = 8;
const isNonNegativeQuantity = (value) => (typeof value === "bigint" && value >= 0n) ||
    (typeof value === "string" &&
        value.length > 0 &&
        value.length <= MAX_UINT256_DECIMAL_DIGITS &&
        /^\d+$/u.test(value));
const isAddressLike = (value) => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
const isBytes32 = (value) => typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
const isBoundedEvenHex = (value, maximumBytes) => typeof value === "string" &&
    value.length >= 2 &&
    value.length <= 2 + maximumBytes * 2 &&
    value.length % 2 === 0 &&
    /^0x[0-9a-fA-F]*$/u.test(value);
const FEE_POLICY_FIELDS = Object.freeze([
    "totalFeeBps",
    "protocolFeeShareNumerator",
    "protocolFeeShareDenominator",
    "lpFeeShareNumerator",
    "lpFeeShareDenominator",
    "chargedOn",
    "extraNativeSwapFee",
    "confidentialCollection",
]);
const CONFIDENTIAL_COLLECTION_FIELDS = Object.freeze([
    "minimumPoolSwapCount",
    "minimumPoolDelaySeconds",
    "minimumVaultSweepDelaySeconds",
    "vaultEpochSeconds",
    "minimumVaultAggregatedSwapCount",
    "minimumVaultResidenceEpochs",
]);
const CONFIDENTIAL_POOL_DISCOVERY_FIELDS = Object.freeze([
    "disclosureSchemaVersion",
    "protocolVersion",
    "pool",
    "token0",
    "token1",
    "token0Decimals",
    "token1Decimals",
    "feeBps",
    "feeVault",
    "feePolicy",
    "privacyMode",
    "initializationStrategy",
    "strategyClass",
    "poolClass",
    "initialized",
    "poolKind",
    "quoteTransport",
]);
const PUBLIC_POOL_DISCOVERY_FIELDS = Object.freeze([
    "disclosureSchemaVersion",
    "protocolVersion",
    "pool",
    "token0",
    "token1",
    "token0Decimals",
    "token1Decimals",
    "feeBps",
    "feeVault",
    "feePolicy",
    "privacyMode",
    "poolKind",
]);
const CONFIDENTIAL_LOCK_DISCOVERY_FIELDS = Object.freeze([
    "disclosureSchemaVersion",
    "pool",
    "lockId",
    "owner",
    "unlockTime",
    "permanent",
    "released",
]);
const LAUNCHPAD_MIGRATION_METADATA_FIELDS = Object.freeze([
    "disclosureSchemaVersion",
    "launchId",
    "authorizationHash",
    "initializationStrategy",
    "creator",
    "pool",
    "disposition",
    "lockId",
    "unlockTime",
]);
const CONFIDENTIAL_BEST_EXECUTION_ROUTER_POLICY_FIELDS = Object.freeze([
    "expectedChainId",
    "expectedFactory",
    "expectedFactoryRuntimeCodehash",
    "expectedRouter",
    "expectedRouterRuntimeCodehash",
    "expectedFactoryProtocolVersion",
    "expectedRouterProtocolVersion",
]);
const CONFIDENTIAL_BEST_EXECUTION_RESULT_EXPECTATION_FIELDS = Object.freeze([
    "operation",
    "caller",
    "requestId",
    "tokenIn",
    "tokenOut",
    "transactionHash",
    "transactionData",
]);
const CONFIDENTIAL_POOL_POLICY_FIELDS = Object.freeze([
    "expectedChainId",
    "expectedFactory",
    "expectedFeeVault",
    "expectedProtocolVersion",
    "expectedLPTokenFactory",
    "expectedLPTokenFactoryRuntimeCodehash",
]);
const PUBLIC_POOL_POLICY_FIELDS = Object.freeze([
    "expectedChainId",
    "expectedFactory",
    "expectedFeeVault",
    "expectedProtocolVersion",
]);
const LAUNCHPAD_MIGRATION_EXPECTATION_FIELDS = Object.freeze([
    "transactionHash",
    "metadata",
]);
const LAUNCHPAD_MIGRATION_POLICY_FIELDS = Object.freeze([
    "expectedChainId",
    "expectedFactory",
    "expectedFactoryRuntimeCodehash",
    "expectedMigrator",
    "expectedMigratorRuntimeCodehash",
    "expectedInitializationStrategy",
    "expectedInitializationStrategyRuntimeCodehash",
    "expectedFeeVault",
    "expectedFactoryProtocolVersion",
    "expectedPoolProtocolVersion",
    "expectedMigratorProtocolVersion",
]);
/** Returns descriptors only for an exact plain own-data-property schema. */
const exactOwnDataDescriptors = (value, expectedFields) => {
    try {
        if (!value || typeof value !== "object" || Array.isArray(value))
            return undefined;
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null)
            return undefined;
        const keys = Reflect.ownKeys(value);
        const expected = new Set(expectedFields);
        if (keys.length !== expectedFields.length ||
            keys.some((key) => typeof key !== "string" || !expected.has(key)))
            return undefined;
        const descriptors = Object.getOwnPropertyDescriptors(value);
        for (const field of expectedFields) {
            const descriptor = descriptors[field];
            if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
                return undefined;
        }
        return descriptors;
    }
    catch {
        return undefined;
    }
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
    "function addLiquidityFor(address,uint256,uint256,uint256,uint256,uint256,uint64) returns (uint256)",
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
];
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
];
export const PUBLIC_CPMM_QUOTER_ABI = [
    "function PROTOCOL_VERSION() view returns (uint256)",
    "function factory() view returns (address)",
    "function quoteExactInput(address,uint256,bool) view returns (uint256)",
];
export const PUBLIC_CPMM_ROUTER_ABI = [
    "function PROTOCOL_VERSION() view returns (uint256)",
    "function factory() view returns (address)",
    "function swapExactInput(address,uint256,uint256,bool,uint64) returns (uint256)",
    "event SwapRouted(address indexed trader,address indexed pool,address indexed inputToken,address outputToken,uint256 amountIn,uint256 amountOut)",
];
export const PUBLIC_CPMM_LIQUIDITY_ROUTER_ABI = [
    "function PROTOCOL_VERSION() view returns (uint256)",
    "function factory() view returns (address)",
    "function createOrAddLiquidity(address,address,uint8,uint8,uint256,uint256,uint256,uint256,uint256,uint256,uint64) returns (address,uint256,uint256,uint256)",
    "event PublicLiquidityRouted(address indexed provider,address indexed pool,bool indexed poolCreated,uint256 amount0,uint256 amount1,uint256 shares)",
];
export const CONFIDENTIAL_BEST_QUOTE_FUNCTION = "requestBestQuoteExactInput";
export const CONFIDENTIAL_BEST_QUOTE_WITH_CANDIDATES_FUNCTION = "requestBestQuoteExactInputWithCandidates";
export const CONFIDENTIAL_BEST_SWAP_FUNCTION = "swapBestExactInput";
export const CONFIDENTIAL_BEST_SWAP_WITH_CANDIDATES_FUNCTION = "swapBestExactInputWithCandidates";
export const CONFIDENTIAL_BEST_QUOTE_SELECTOR = "0x440bde4a";
export const CONFIDENTIAL_BEST_QUOTE_WITH_CANDIDATES_SELECTOR = "0xc636ee79";
export const CONFIDENTIAL_BEST_SWAP_SELECTOR = "0x310481d3";
export const CONFIDENTIAL_BEST_SWAP_WITH_CANDIDATES_SELECTOR = "0xc55b572d";
export const DEFAULT_STANDARD_CANDIDATE_BITMAP = 0x49;
export const ALL_CONFIDENTIAL_CANDIDATE_BITMAP = 0x1ff;
export const MAX_CONFIDENTIAL_QUOTE_CANDIDATES = 9;
export const MAX_CONFIDENTIAL_ATOMIC_SWAP_CANDIDATES = 3;
/** @deprecated Use the operation-specific quote or atomic-swap limit. */
export const MAX_CONFIDENTIAL_ROUTE_CANDIDATES = 3;
export const CONFIDENTIAL_LIQUIDITY_QUOTE_FUNCTION = "requestAddLiquidityQuote";
export const CONFIDENTIAL_LIQUIDITY_QUOTE_SELECTOR = "0x6ad558a9";
export const CONFIDENTIAL_LIQUIDITY_QUOTE_RESULT_TOPIC = "0x4069fd369ee96a414b638a1f85119a2360ab4a7e05df9b1816582b1baf87a147";
export const CONFIDENTIAL_BEST_QUOTE_RESULT_TOPIC = "0x74d60457cef138a4b1c57bac9346b347c04566dfa22699c3a3eab54267d0fdb7";
export const CONFIDENTIAL_BEST_SWAP_RESULT_TOPIC = "0x4a0ef2bdc006487857271fcf656bebd35d04c28f1fc35b8aa460ded5ca8fc3dc";
export const LAUNCHPAD_MIGRATION_TOPIC = "0x6227c8fb63c7ea6dc2225fbf219a361b834ac2a7bf43da0b32f1ef9f3b779956";
export const LAUNCHPAD_LOCK_DISPOSITION_TOPIC = "0x75e334dcb38a552c1315b5412176e01190962bbb6774c5b3964f221b4a2eb53c";
export const LAUNCHPAD_MIGRATE_SELECTOR = "0x28eec19d";
export const LAUNCHPAD_MIGRATE_WITH_DISPOSITION_SELECTOR = "0x7e75f4d5";
export const CONFIDENTIAL_LIQUIDITY_LOCKED_TOPIC = "0xda0ee1246c7c735db57cd30fc8444456fd8e002c807a94c88bf4495ea01707bd";
const VERIFIED_CONFIDENTIAL_BEST_EXECUTION_ROUTER = Symbol("CipherDEX.VerifiedConfidentialBestExecutionRouter");
const verifiedConfidentialBestExecutionRouters = new WeakSet();
const UINT64_MAX = (1n << 64n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;
function assertConfidentialBestExecutionEnvelope(tokenIn, tokenOut, requestId, deadline) {
    if (!isAddressLike(tokenIn) ||
        !isAddressLike(tokenOut) ||
        tokenIn.toLowerCase() === tokenOut.toLowerCase()) {
        throw new TypeError("Invalid confidential best-execution token pair");
    }
    if (!isBytes32(requestId) || /^0x0{64}$/i.test(requestId)) {
        throw new TypeError("Invalid confidential best-execution request ID");
    }
    if (typeof deadline !== "bigint" || deadline <= 0n || deadline > UINT64_MAX) {
        throw new TypeError("Invalid confidential best-execution deadline");
    }
}
function assertInputText256(value) {
    if (!value ||
        typeof value !== "object" ||
        !value.ciphertext ||
        typeof value.ciphertext.ciphertextHigh !== "bigint" ||
        typeof value.ciphertext.ciphertextLow !== "bigint" ||
        value.ciphertext.ciphertextHigh < 0n ||
        value.ciphertext.ciphertextHigh > UINT256_MAX ||
        value.ciphertext.ciphertextLow < 0n ||
        value.ciphertext.ciphertextLow > UINT256_MAX ||
        !((typeof value.signature === "string" && /^0x(?:[0-9a-fA-F]{2})+$/.test(value.signature)) ||
            (value.signature instanceof Uint8Array && value.signature.byteLength > 0))) {
        throw new TypeError("Invalid caller-bound encrypted uint256 input");
    }
}
function candidateCount(candidateBitmap) {
    return candidateBitmap.toString(2).replaceAll("0", "").length;
}
/** Builds the complete candidate bitmap for the factory's active pool classes. */
export function buildConfidentialCandidateBitmap(poolClassCount) {
    if (!Number.isInteger(poolClassCount) || poolClassCount <= 0 || poolClassCount > 3) {
        throw new TypeError("Invalid confidential pool class count");
    }
    let bitmap = 0;
    for (let feeIndex = 0; feeIndex < 3; feeIndex += 1) {
        for (let classIndex = 0; classIndex < poolClassCount; classIndex += 1) {
            bitmap |= 1 << (feeIndex * 3 + classIndex);
        }
    }
    return bitmap;
}
function assertCandidateBitmap(candidateBitmap, maximumCandidates) {
    if (!Number.isInteger(candidateBitmap) ||
        candidateBitmap <= 0 ||
        candidateBitmap >= 512 ||
        !Number.isInteger(maximumCandidates) ||
        maximumCandidates <= 0 ||
        maximumCandidates > MAX_CONFIDENTIAL_QUOTE_CANDIDATES ||
        candidateCount(candidateBitmap) > maximumCandidates) {
        throw new TypeError("Invalid confidential route candidate bitmap");
    }
}
/**
 * Deterministically partitions the canonical nine-bit namespace for a network
 * that cannot process every quote candidate in one transaction. Each returned
 * bitmap preserves ascending fee/class slot order and requires a fresh caller-
 * bound encrypted input and request ID.
 */
export function partitionConfidentialQuoteCandidateBitmap(candidateBitmap, maximumCandidates = MAX_CONFIDENTIAL_QUOTE_CANDIDATES) {
    assertCandidateBitmap(candidateBitmap, MAX_CONFIDENTIAL_QUOTE_CANDIDATES);
    if (!Number.isInteger(maximumCandidates) ||
        maximumCandidates <= 0 ||
        maximumCandidates > MAX_CONFIDENTIAL_QUOTE_CANDIDATES) {
        throw new TypeError("Invalid confidential quote candidate batch size");
    }
    const batches = [];
    let batch = 0;
    let count = 0;
    for (let bit = 0; bit < MAX_CONFIDENTIAL_QUOTE_CANDIDATES; bit += 1) {
        const mask = 1 << bit;
        if ((candidateBitmap & mask) === 0)
            continue;
        batch |= mask;
        count += 1;
        if (count === maximumCandidates) {
            batches.push(batch);
            batch = 0;
            count = 0;
        }
    }
    if (batch !== 0)
        batches.push(batch);
    return Object.freeze(batches);
}
function snapshotInputText256(value) {
    assertInputText256(value);
    const signature = typeof value.signature === "string"
        ? value.signature
        : `0x${Array.from(value.signature, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    return Object.freeze({
        ciphertext: Object.freeze({
            ciphertextHigh: value.ciphertext.ciphertextHigh,
            ciphertextLow: value.ciphertext.ciphertextLow,
        }),
        signature,
    });
}
function assertCiphertext256(value) {
    if (!value ||
        typeof value !== "object" ||
        typeof value.ciphertextHigh !== "bigint" ||
        typeof value.ciphertextLow !== "bigint" ||
        value.ciphertextHigh < 0n ||
        value.ciphertextHigh > UINT256_MAX ||
        value.ciphertextLow < 0n ||
        value.ciphertextLow > UINT256_MAX) {
        throw new TypeError("Invalid encrypted uint256 result");
    }
}
/**
 * Builds the canonical paid best-quote call after the caller encrypts amountIn
 * for the router address and this function's selector with the COTI SDK.
 */
export function buildConfidentialBestQuoteCall(tokenIn, tokenOut, amountIn, requestId, deadline) {
    assertConfidentialBestExecutionEnvelope(tokenIn, tokenOut, requestId, deadline);
    const immutableAmountIn = snapshotInputText256(amountIn);
    return Object.freeze({
        functionName: CONFIDENTIAL_BEST_QUOTE_FUNCTION,
        args: Object.freeze([
            tokenIn,
            tokenOut,
            immutableAmountIn,
            requestId,
            deadline,
        ]),
    });
}
/**
 * Builds the atomic best-execution call after amountIn and minimumOut are each
 * freshly encrypted for the router address and this function's selector.
 */
export function buildConfidentialBestSwapCall(tokenIn, tokenOut, amountIn, minimumOut, requestId, deadline) {
    assertConfidentialBestExecutionEnvelope(tokenIn, tokenOut, requestId, deadline);
    const immutableAmountIn = snapshotInputText256(amountIn);
    const immutableMinimumOut = snapshotInputText256(minimumOut);
    return Object.freeze({
        functionName: CONFIDENTIAL_BEST_SWAP_FUNCTION,
        args: Object.freeze([
            tokenIn,
            tokenOut,
            immutableAmountIn,
            immutableMinimumOut,
            requestId,
            deadline,
        ]),
    });
}
export function buildConfidentialBestQuoteWithCandidatesCall(tokenIn, tokenOut, amountIn, candidateBitmap, requestId, deadline) {
    assertConfidentialBestExecutionEnvelope(tokenIn, tokenOut, requestId, deadline);
    assertCandidateBitmap(candidateBitmap, MAX_CONFIDENTIAL_QUOTE_CANDIDATES);
    return Object.freeze({
        functionName: CONFIDENTIAL_BEST_QUOTE_WITH_CANDIDATES_FUNCTION,
        args: Object.freeze([
            tokenIn,
            tokenOut,
            snapshotInputText256(amountIn),
            candidateBitmap,
            requestId,
            deadline,
        ]),
    });
}
export function buildConfidentialBestSwapWithCandidatesCall(tokenIn, tokenOut, amountIn, minimumOut, candidateBitmap, requestId, deadline) {
    assertConfidentialBestExecutionEnvelope(tokenIn, tokenOut, requestId, deadline);
    assertCandidateBitmap(candidateBitmap, MAX_CONFIDENTIAL_ATOMIC_SWAP_CANDIDATES);
    return Object.freeze({
        functionName: CONFIDENTIAL_BEST_SWAP_WITH_CANDIDATES_FUNCTION,
        args: Object.freeze([
            tokenIn,
            tokenOut,
            snapshotInputText256(amountIn),
            snapshotInputText256(minimumOut),
            candidateBitmap,
            requestId,
            deadline,
        ]),
    });
}
/**
 * Builds the paid confidential proportional-liquidity preview. The encrypted
 * specified amount must be bound to the target pool and this function selector.
 */
export function buildConfidentialLiquidityQuoteCall(specifiedAmount, amount0Specified, requestId, deadline) {
    if (typeof amount0Specified !== "boolean") {
        throw new TypeError("Invalid confidential liquidity quote side");
    }
    if (!isBytes32(requestId) || /^0x0{64}$/i.test(requestId)) {
        throw new TypeError("Invalid confidential liquidity quote request ID");
    }
    if (typeof deadline !== "bigint" || deadline <= 0n || deadline > UINT64_MAX) {
        throw new TypeError("Invalid confidential liquidity quote deadline");
    }
    return Object.freeze({
        functionName: CONFIDENTIAL_LIQUIDITY_QUOTE_FUNCTION,
        args: Object.freeze([
            snapshotInputText256(specifiedAmount),
            amount0Specified,
            requestId,
            deadline,
        ]),
    });
}
/** Builds the public atomic create-or-add-liquidity periphery call. */
export function buildPublicCreateOrAddLiquidityCall(input) {
    if (!isAddressLike(input.tokenA) ||
        !isAddressLike(input.tokenB) ||
        input.tokenA.toLowerCase() === input.tokenB.toLowerCase() ||
        !Number.isInteger(input.decimalsA) ||
        !Number.isInteger(input.decimalsB) ||
        input.decimalsA < 0 ||
        input.decimalsA > 18 ||
        input.decimalsB < 0 ||
        input.decimalsB > 18) {
        throw new TypeError("Invalid public liquidity token configuration");
    }
    const quantities = [
        input.feeBps,
        input.amountADesired,
        input.amountBDesired,
        input.minShares,
        input.minPriceX18,
        input.maxPriceX18,
        input.deadline,
    ];
    if (quantities.some((value) => typeof value !== "bigint" || value < 0n || value > UINT256_MAX) ||
        input.amountADesired === 0n ||
        input.amountBDesired === 0n ||
        input.deadline === 0n ||
        input.deadline > UINT64_MAX ||
        input.minPriceX18 > input.maxPriceX18 ||
        !CIPHERDEX_V1_FEE_POLICY.approvedTotalFeeBps.includes(Number(input.feeBps))) {
        throw new TypeError("Invalid public liquidity parameters");
    }
    return Object.freeze({
        functionName: "createOrAddLiquidity",
        args: Object.freeze([
            input.tokenA,
            input.tokenB,
            input.decimalsA,
            input.decimalsB,
            input.feeBps,
            input.amountADesired,
            input.amountBDesired,
            input.minShares,
            input.minPriceX18,
            input.maxPriceX18,
            input.deadline,
        ]),
    });
}
/**
 * Returns the exact router/function binding required by COTI encryptValue256.
 * Quote inputs and swap inputs are not interchangeable because the function
 * selector is part of authenticated ciphertext validation.
 */
export function getConfidentialBestExecutionEncryptionBinding(router, operation) {
    if (!verifiedConfidentialBestExecutionRouters.has(router)) {
        throw new TypeError("Unverified confidential best-execution router");
    }
    return Object.freeze({
        chainId: router.chainId,
        contractAddress: router.router,
        functionName: operation === "quote"
            ? CONFIDENTIAL_BEST_QUOTE_FUNCTION
            : operation === "quote-with-candidates"
                ? CONFIDENTIAL_BEST_QUOTE_WITH_CANDIDATES_FUNCTION
                : operation === "swap"
                    ? CONFIDENTIAL_BEST_SWAP_FUNCTION
                    : CONFIDENTIAL_BEST_SWAP_WITH_CANDIDATES_FUNCTION,
        functionSelector: operation === "quote"
            ? CONFIDENTIAL_BEST_QUOTE_SELECTOR
            : operation === "quote-with-candidates"
                ? CONFIDENTIAL_BEST_QUOTE_WITH_CANDIDATES_SELECTOR
                : operation === "swap"
                    ? CONFIDENTIAL_BEST_SWAP_SELECTOR
                    : CONFIDENTIAL_BEST_SWAP_WITH_CANDIDATES_SELECTOR,
    });
}
export function buildVerifiedConfidentialBestQuoteTransaction(router, tokenIn, tokenOut, amountIn, requestId, deadline) {
    if (!verifiedConfidentialBestExecutionRouters.has(router)) {
        throw new TypeError("Unverified confidential best-execution router");
    }
    return Object.freeze({
        chainId: router.chainId,
        to: router.router,
        ...buildConfidentialBestQuoteCall(tokenIn, tokenOut, amountIn, requestId, deadline),
    });
}
export function buildVerifiedConfidentialBestSwapTransaction(router, tokenIn, tokenOut, amountIn, minimumOut, requestId, deadline) {
    if (!verifiedConfidentialBestExecutionRouters.has(router)) {
        throw new TypeError("Unverified confidential best-execution router");
    }
    return Object.freeze({
        chainId: router.chainId,
        to: router.router,
        ...buildConfidentialBestSwapCall(tokenIn, tokenOut, amountIn, minimumOut, requestId, deadline),
    });
}
export function buildVerifiedConfidentialBestQuoteWithCandidatesTransaction(router, tokenIn, tokenOut, amountIn, candidateBitmap, requestId, deadline) {
    if (!verifiedConfidentialBestExecutionRouters.has(router)) {
        throw new TypeError("Unverified confidential best-execution router");
    }
    return Object.freeze({
        chainId: router.chainId,
        to: router.router,
        ...buildConfidentialBestQuoteWithCandidatesCall(tokenIn, tokenOut, amountIn, candidateBitmap, requestId, deadline),
    });
}
export function buildVerifiedConfidentialBestSwapWithCandidatesTransaction(router, tokenIn, tokenOut, amountIn, minimumOut, candidateBitmap, requestId, deadline) {
    if (!verifiedConfidentialBestExecutionRouters.has(router)) {
        throw new TypeError("Unverified confidential best-execution router");
    }
    return Object.freeze({
        chainId: router.chainId,
        to: router.router,
        ...buildConfidentialBestSwapWithCandidatesCall(tokenIn, tokenOut, amountIn, minimumOut, candidateBitmap, requestId, deadline),
    });
}
export function getCipherDEXV1FeePolicy(totalFeeBps) {
    if (!Number.isInteger(totalFeeBps) ||
        !CIPHERDEX_V1_FEE_POLICY.approvedTotalFeeBps.includes(totalFeeBps)) {
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
export function calculateCipherDEXV1FeeBreakdown(amountIn, totalFeeBps) {
    getCipherDEXV1FeePolicy(totalFeeBps);
    if (amountIn <= 0n)
        throw new RangeError("amountIn must be positive");
    const netAmountIn = amountIn * BigInt(10_000 - totalFeeBps) / 10000n;
    const totalFee = amountIn - netAmountIn;
    const protocolFee = totalFee / BigInt(CIPHERDEX_V1_FEE_POLICY.protocolFeeShareDenominator);
    return {
        amountIn,
        netAmountIn,
        totalFee,
        lpFee: totalFee - protocolFee,
        protocolFee,
    };
}
export function minimumCipherDEXV1ConfidentialInput(totalFeeBps) {
    const policy = getCipherDEXV1FeePolicy(totalFeeBps);
    const protocolShareNumerator = BigInt(policy.protocolFeeShareNumerator);
    const protocolShareDenominator = BigInt(policy.protocolFeeShareDenominator);
    const minimumTotalFee = protocolShareDenominator / protocolShareNumerator +
        (protocolShareDenominator % protocolShareNumerator === 0n ? 0n : 1n);
    return ((minimumTotalFee - 1n) * 10000n) / BigInt(totalFeeBps) + 1n;
}
const VERIFIED_CONFIDENTIAL_POOL_DISCOVERY = Symbol("CipherDEX.VerifiedConfidentialPoolDiscovery");
const verifiedConfidentialPoolDiscoveries = new WeakSet();
const VERIFIED_PUBLIC_POOL_DISCOVERY = Symbol("CipherDEX.VerifiedPublicPoolDiscovery");
const verifiedPublicPoolDiscoveries = new WeakSet();
const VERIFIED_LAUNCHPAD_MIGRATION_METADATA = Symbol("CipherDEX.VerifiedLaunchpadMigrationMetadata");
const verifiedLaunchpadMigrationMetadata = new WeakSet();
function isCipherDEXV1FeePolicy(value, totalFeeBps) {
    if (typeof totalFeeBps !== "number")
        return false;
    const descriptors = exactOwnDataDescriptors(value, FEE_POLICY_FIELDS);
    if (!descriptors)
        return false;
    const collectionDescriptors = exactOwnDataDescriptors(ownDataValue(descriptors, "confidentialCollection"), CONFIDENTIAL_COLLECTION_FIELDS);
    if (!collectionDescriptors)
        return false;
    return (CIPHERDEX_V1_FEE_POLICY.approvedTotalFeeBps.includes(totalFeeBps) &&
        ownDataValue(descriptors, "totalFeeBps") === totalFeeBps &&
        ownDataValue(descriptors, "protocolFeeShareNumerator") ===
            CIPHERDEX_V1_FEE_POLICY.protocolFeeShareNumerator &&
        ownDataValue(descriptors, "protocolFeeShareDenominator") ===
            CIPHERDEX_V1_FEE_POLICY.protocolFeeShareDenominator &&
        ownDataValue(descriptors, "lpFeeShareNumerator") ===
            CIPHERDEX_V1_FEE_POLICY.lpFeeShareNumerator &&
        ownDataValue(descriptors, "lpFeeShareDenominator") ===
            CIPHERDEX_V1_FEE_POLICY.lpFeeShareDenominator &&
        ownDataValue(descriptors, "chargedOn") === CIPHERDEX_V1_FEE_POLICY.chargedOn &&
        ownDataValue(descriptors, "extraNativeSwapFee") ===
            CIPHERDEX_V1_FEE_POLICY.extraNativeSwapFee &&
        ownDataValue(collectionDescriptors, "minimumPoolSwapCount") ===
            CIPHERDEX_V1_FEE_POLICY.confidentialCollection.minimumPoolSwapCount &&
        ownDataValue(collectionDescriptors, "minimumPoolDelaySeconds") ===
            CIPHERDEX_V1_FEE_POLICY.confidentialCollection.minimumPoolDelaySeconds &&
        ownDataValue(collectionDescriptors, "minimumVaultSweepDelaySeconds") ===
            CIPHERDEX_V1_FEE_POLICY.confidentialCollection.minimumVaultSweepDelaySeconds &&
        ownDataValue(collectionDescriptors, "vaultEpochSeconds") ===
            CIPHERDEX_V1_FEE_POLICY.confidentialCollection.vaultEpochSeconds &&
        ownDataValue(collectionDescriptors, "minimumVaultAggregatedSwapCount") ===
            CIPHERDEX_V1_FEE_POLICY.confidentialCollection.minimumVaultAggregatedSwapCount &&
        ownDataValue(collectionDescriptors, "minimumVaultResidenceEpochs") ===
            CIPHERDEX_V1_FEE_POLICY.confidentialCollection.minimumVaultResidenceEpochs);
}
export function isConfidentialPoolDiscovery(value) {
    const descriptors = exactOwnDataDescriptors(value, CONFIDENTIAL_POOL_DISCOVERY_FIELDS);
    if (!descriptors)
        return false;
    const candidate = Object.fromEntries(CONFIDENTIAL_POOL_DISCOVERY_FIELDS.map((field) => [field, ownDataValue(descriptors, field)]));
    return (candidate.disclosureSchemaVersion === DISCLOSURE_SCHEMA_VERSION &&
        candidate.protocolVersion === CIPHERDEX_CONFIDENTIAL_PROTOCOL_VERSION &&
        candidate.poolKind === "private-erc20-cpmm-v3" &&
        isAddressLike(candidate.pool) &&
        isAddressLike(candidate.token0) &&
        isAddressLike(candidate.token1) &&
        candidate.token0.toLowerCase() < candidate.token1.toLowerCase() &&
        Number.isInteger(candidate.protocolVersion) &&
        candidate.protocolVersion > 0 &&
        Number.isInteger(candidate.token0Decimals) &&
        candidate.token0Decimals >= 0 &&
        candidate.token0Decimals <= 18 &&
        Number.isInteger(candidate.token1Decimals) &&
        candidate.token1Decimals >= 0 &&
        candidate.token1Decimals <= 18 &&
        Number.isInteger(candidate.feeBps) &&
        candidate.feeBps >= 0 &&
        isAddressLike(candidate.feeVault) &&
        isCipherDEXV1FeePolicy(candidate.feePolicy, candidate.feeBps) &&
        candidate.privacyMode === PRIVACY_MODE.AMOUNT_CONFIDENTIAL_PRIVATE_LP &&
        isAddressLike(candidate.initializationStrategy) &&
        Number.isInteger(candidate.strategyClass) &&
        candidate.strategyClass >= 0 &&
        candidate.strategyClass <= 2 &&
        ((candidate.poolClass === "standard" &&
            candidate.initializationStrategy.toLowerCase() === ZERO_ADDRESS &&
            candidate.strategyClass === 0) ||
            (candidate.poolClass === "launch-protected" &&
                candidate.initializationStrategy.toLowerCase() !== ZERO_ADDRESS &&
                candidate.strategyClass > 0)) &&
        typeof candidate.initialized === "boolean" &&
        candidate.quoteTransport === CONFIDENTIAL_QUOTE_TRANSPORT.TRANSACTION_EVENT);
}
// Explicit alias for callers that only need untrusted JSON shape validation.
export const isConfidentialPoolDiscoveryShape = isConfidentialPoolDiscovery;
const ownDataValue = (descriptors, key) => {
    const descriptor = descriptors[key];
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
};
const snapshotExactOwnRecord = (value, fields) => {
    const descriptors = exactOwnDataDescriptors(value, fields);
    if (!descriptors)
        return undefined;
    return Object.freeze(Object.fromEntries(fields.map((field) => [field, ownDataValue(descriptors, field)])));
};
const snapshotFeePolicy = (value) => {
    const descriptors = exactOwnDataDescriptors(value, FEE_POLICY_FIELDS);
    if (!descriptors)
        return undefined;
    const collection = ownDataValue(descriptors, "confidentialCollection");
    const collectionDescriptors = exactOwnDataDescriptors(collection, CONFIDENTIAL_COLLECTION_FIELDS);
    if (!collectionDescriptors)
        return undefined;
    const confidentialCollection = {
        minimumPoolSwapCount: ownDataValue(collectionDescriptors, "minimumPoolSwapCount"),
        minimumPoolDelaySeconds: ownDataValue(collectionDescriptors, "minimumPoolDelaySeconds"),
        minimumVaultSweepDelaySeconds: ownDataValue(collectionDescriptors, "minimumVaultSweepDelaySeconds"),
        vaultEpochSeconds: ownDataValue(collectionDescriptors, "vaultEpochSeconds"),
        minimumVaultAggregatedSwapCount: ownDataValue(collectionDescriptors, "minimumVaultAggregatedSwapCount"),
        minimumVaultResidenceEpochs: ownDataValue(collectionDescriptors, "minimumVaultResidenceEpochs"),
    };
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
const snapshotConfidentialPoolDiscovery = (value) => {
    try {
        const descriptors = exactOwnDataDescriptors(value, CONFIDENTIAL_POOL_DISCOVERY_FIELDS);
        if (!descriptors)
            return undefined;
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
            initializationStrategy: ownDataValue(descriptors, "initializationStrategy"),
            strategyClass: ownDataValue(descriptors, "strategyClass"),
            poolClass: ownDataValue(descriptors, "poolClass"),
            initialized: ownDataValue(descriptors, "initialized"),
            poolKind: ownDataValue(descriptors, "poolKind"),
            quoteTransport: ownDataValue(descriptors, "quoteTransport"),
        };
    }
    catch {
        return undefined;
    }
};
const snapshotPublicPoolDiscovery = (value) => {
    try {
        const descriptors = exactOwnDataDescriptors(value, PUBLIC_POOL_DISCOVERY_FIELDS);
        if (!descriptors)
            return undefined;
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
    }
    catch {
        return undefined;
    }
};
const toSafeChainNumber = (value) => {
    if (typeof value === "number")
        return Number.isSafeInteger(value) ? value : undefined;
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
        return undefined;
    return Number(value);
};
const sameAddress = (left, right) => isAddressLike(left) && isAddressLike(right) && left.toLowerCase() === right.toLowerCase();
const hasDeployedCode = (code) => /^0x[0-9a-fA-F]+$/.test(code) && !/^0x0*$/.test(code);
const isTransactionHash = (value) => isBytes32(value) && !/^0x0{64}$/i.test(value);
const abiWord = (hexWithoutPrefix, index) => {
    const start = index * 64;
    const word = hexWithoutPrefix.slice(start, start + 64);
    return word.length === 64 ? word : undefined;
};
const addressFromAbiWord = (word) => {
    if (!word || !/^0{24}[0-9a-fA-F]{40}$/.test(word))
        return undefined;
    return `0x${word.slice(24)}`;
};
const quantityFromAbiWord = (word) => {
    if (!word || !/^[0-9a-fA-F]{64}$/.test(word))
        return undefined;
    return BigInt(`0x${word}`);
};
function ownArrayValues(value, maximumLength) {
    try {
        if (!Array.isArray(value))
            return undefined;
        const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
        const length = lengthDescriptor && "value" in lengthDescriptor
            ? lengthDescriptor.value
            : undefined;
        if (!Number.isSafeInteger(length) || length < 0 || length > maximumLength)
            return undefined;
        const snapshot = [];
        for (let index = 0; index < length; index += 1) {
            const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
            if (!descriptor || !("value" in descriptor))
                return undefined;
            snapshot.push(descriptor.value);
        }
        return Object.freeze(snapshot);
    }
    catch {
        return undefined;
    }
}
function snapshotBoundedEvidenceLogs(value) {
    const entries = ownArrayValues(value, MAX_EVIDENCE_RECEIPT_LOGS);
    if (!entries)
        return undefined;
    const logs = [];
    try {
        for (const entry of entries) {
            if (!entry || typeof entry !== "object")
                return undefined;
            const addressDescriptor = Object.getOwnPropertyDescriptor(entry, "address");
            const topicsDescriptor = Object.getOwnPropertyDescriptor(entry, "topics");
            const dataDescriptor = Object.getOwnPropertyDescriptor(entry, "data");
            if (!addressDescriptor || !("value" in addressDescriptor) ||
                !topicsDescriptor || !("value" in topicsDescriptor) ||
                !dataDescriptor || !("value" in dataDescriptor) ||
                !isAddressLike(addressDescriptor.value) ||
                !isBoundedEvenHex(dataDescriptor.value, MAX_EVIDENCE_LOG_DATA_BYTES))
                return undefined;
            const topicValues = ownArrayValues(topicsDescriptor.value, MAX_EVIDENCE_LOG_TOPICS);
            if (!topicValues || topicValues.some((topic) => !isBytes32(topic)))
                return undefined;
            logs.push(Object.freeze({
                address: addressDescriptor.value,
                topics: Object.freeze(topicValues),
                data: dataDescriptor.value,
            }));
        }
    }
    catch {
        return undefined;
    }
    return Object.freeze(logs);
}
function decodeConfidentialBestExecutionResultEvidence(router, expectation, transaction, receipt) {
    if (!isAddressLike(expectation.caller) ||
        !isBytes32(expectation.requestId) ||
        !isAddressLike(expectation.tokenIn) ||
        !isAddressLike(expectation.tokenOut) ||
        sameAddress(expectation.tokenIn, expectation.tokenOut) ||
        !isTransactionHash(expectation.transactionHash) ||
        !isBoundedEvenHex(expectation.transactionData, MAX_EVIDENCE_CALLDATA_BYTES) ||
        expectation.transactionData.length === 2 ||
        !(expectation.operation === "quote" ||
            expectation.operation === "quote-with-candidates" ||
            expectation.operation === "swap" ||
            expectation.operation === "swap-with-candidates") ||
        !transaction ||
        !receipt ||
        !isTransactionHash(transaction.hash) ||
        !isTransactionHash(receipt.transactionHash) ||
        transaction.hash.toLowerCase() !== expectation.transactionHash.toLowerCase() ||
        receipt.transactionHash.toLowerCase() !== expectation.transactionHash.toLowerCase() ||
        !sameAddress(transaction.from, expectation.caller) ||
        !sameAddress(transaction.to, router.router) ||
        !Array.isArray(receipt.logs) ||
        receipt.logs.length > MAX_EVIDENCE_RECEIPT_LOGS ||
        !((typeof receipt.status === "number" && receipt.status === 1) ||
            (typeof receipt.status === "bigint" && receipt.status === 1n))) {
        throw new TypeError("Invalid confidential best-execution transaction evidence");
    }
    const transactionChainId = toSafeChainNumber(transaction.chainId);
    const isQuote = expectation.operation === "quote" ||
        expectation.operation === "quote-with-candidates";
    const hasCandidateBitmap = expectation.operation === "quote-with-candidates" ||
        expectation.operation === "swap-with-candidates";
    const maximumEvidenceCandidates = isQuote
        ? MAX_CONFIDENTIAL_QUOTE_CANDIDATES
        : MAX_CONFIDENTIAL_ATOMIC_SWAP_CANDIDATES;
    const expectedSelector = expectation.operation === "quote"
        ? CONFIDENTIAL_BEST_QUOTE_SELECTOR
        : expectation.operation === "quote-with-candidates"
            ? CONFIDENTIAL_BEST_QUOTE_WITH_CANDIDATES_SELECTOR
            : expectation.operation === "swap"
                ? CONFIDENTIAL_BEST_SWAP_SELECTOR
                : CONFIDENTIAL_BEST_SWAP_WITH_CANDIDATES_SELECTOR;
    const candidateBitmapWordIndex = hasCandidateBitmap
        ? (isQuote ? 3 : 4)
        : undefined;
    const requestWordIndex = isQuote
        ? (hasCandidateBitmap ? 4 : 3)
        : (hasCandidateBitmap ? 5 : 4);
    if (transactionChainId !== router.chainId ||
        !isBoundedEvenHex(transaction.data, MAX_EVIDENCE_CALLDATA_BYTES) ||
        transaction.data.length === 2 ||
        transaction.data.slice(0, 10).toLowerCase() !== expectedSelector ||
        transaction.data.toLowerCase() !== expectation.transactionData.toLowerCase()) {
        throw new TypeError("Invalid confidential best-execution transaction binding");
    }
    const callWords = transaction.data.slice(10);
    const transactionTokenIn = addressFromAbiWord(abiWord(callWords, 0));
    const transactionTokenOut = addressFromAbiWord(abiWord(callWords, 1));
    const transactionRequestIdWord = abiWord(callWords, requestWordIndex);
    const transactionCandidateBitmap = candidateBitmapWordIndex === undefined
        ? BigInt(DEFAULT_STANDARD_CANDIDATE_BITMAP)
        : quantityFromAbiWord(abiWord(callWords, candidateBitmapWordIndex));
    if (!transactionTokenIn ||
        !transactionTokenOut ||
        !sameAddress(transactionTokenIn, expectation.tokenIn) ||
        !sameAddress(transactionTokenOut, expectation.tokenOut) ||
        !transactionRequestIdWord ||
        transactionCandidateBitmap === undefined ||
        `0x${transactionRequestIdWord}`.toLowerCase() !== expectation.requestId.toLowerCase()) {
        throw new TypeError("Invalid confidential best-execution calldata binding");
    }
    const expectedTopic = isQuote
        ? CONFIDENTIAL_BEST_QUOTE_RESULT_TOPIC
        : CONFIDENTIAL_BEST_SWAP_RESULT_TOPIC;
    const boundedLogs = snapshotBoundedEvidenceLogs(receipt.logs);
    if (!boundedLogs) {
        throw new TypeError("Confidential best-execution receipt logs exceed evidence bounds");
    }
    const matchingLogs = boundedLogs.filter((log) => log &&
        sameAddress(log.address, router.router) &&
        Array.isArray(log.topics) &&
        log.topics.length === 4 &&
        typeof log.topics[0] === "string" &&
        log.topics[0].toLowerCase() === expectedTopic);
    if (matchingLogs.length !== 1) {
        throw new TypeError("Confidential best-execution result log is missing or ambiguous");
    }
    const log = matchingLogs[0];
    const indexedCaller = addressFromAbiWord(log.topics[1]?.slice(2));
    const indexedRequestId = log.topics[2];
    const selectedPool = addressFromAbiWord(log.topics[3]?.slice(2));
    if (!indexedCaller ||
        !selectedPool ||
        !sameAddress(indexedCaller, expectation.caller) ||
        !isBytes32(indexedRequestId) ||
        indexedRequestId.toLowerCase() !== expectation.requestId.toLowerCase() ||
        typeof log.data !== "string" ||
        !/^0x[0-9a-fA-F]{384}$/.test(log.data)) {
        throw new TypeError("Invalid confidential best-execution result log");
    }
    const eventWords = log.data.slice(2);
    const feeBpsValue = quantityFromAbiWord(abiWord(eventWords, 0));
    const selectedInitializationStrategy = addressFromAbiWord(abiWord(eventWords, 1));
    const candidateBitmapValue = quantityFromAbiWord(abiWord(eventWords, 2));
    const zeroForOneValue = quantityFromAbiWord(abiWord(eventWords, 3));
    const ciphertextHigh = quantityFromAbiWord(abiWord(eventWords, 4));
    const ciphertextLow = quantityFromAbiWord(abiWord(eventWords, 5));
    if (feeBpsValue === undefined ||
        feeBpsValue > BigInt(Number.MAX_SAFE_INTEGER) ||
        !selectedInitializationStrategy ||
        candidateBitmapValue === undefined ||
        candidateBitmapValue === 0n ||
        candidateBitmapValue >= 512n ||
        candidateBitmapValue !== transactionCandidateBitmap ||
        candidateBitmapValue
            .toString(2)
            .replaceAll("0", "").length > maximumEvidenceCandidates ||
        (zeroForOneValue !== 0n && zeroForOneValue !== 1n) ||
        ciphertextHigh === undefined ||
        ciphertextLow === undefined) {
        throw new TypeError("Invalid confidential best-execution result encoding");
    }
    const selectedFeeBps = Number(feeBpsValue);
    const candidateBitmap = Number(candidateBitmapValue);
    const zeroForOne = zeroForOneValue === 1n;
    const expectedDirection = expectation.tokenIn.toLowerCase() < expectation.tokenOut.toLowerCase();
    if (!CIPHERDEX_V1_FEE_POLICY.approvedTotalFeeBps.includes(selectedFeeBps) ||
        zeroForOne !== expectedDirection) {
        throw new TypeError("Invalid confidential best-execution result selection");
    }
    const result = { ciphertextHigh, ciphertextLow };
    assertCiphertext256(result);
    return Object.freeze({
        selectedPool,
        selectedFeeBps,
        selectedInitializationStrategy,
        candidateBitmap,
        zeroForOne,
        result,
    });
}
/**
 * Binds a router address to deployed code, the expected protocol versions and
 * the confidential factory's one-time canonical router configuration.
 */
export async function verifyConfidentialBestExecutionRouter(router, policy, adapter) {
    const policySnapshot = snapshotExactOwnRecord(policy, CONFIDENTIAL_BEST_EXECUTION_ROUTER_POLICY_FIELDS);
    if (!policySnapshot ||
        !isAddressLike(router) ||
        !Number.isSafeInteger(policySnapshot.expectedChainId) ||
        policySnapshot.expectedChainId <= 0 ||
        !isAddressLike(policySnapshot.expectedFactory) ||
        !isBytes32(policySnapshot.expectedFactoryRuntimeCodehash) ||
        !isAddressLike(policySnapshot.expectedRouter) ||
        !sameAddress(router, policySnapshot.expectedRouter) ||
        !isBytes32(policySnapshot.expectedRouterRuntimeCodehash) ||
        !Number.isSafeInteger(policySnapshot.expectedFactoryProtocolVersion) ||
        policySnapshot.expectedFactoryProtocolVersion <= 0 ||
        !Number.isSafeInteger(policySnapshot.expectedRouterProtocolVersion) ||
        policySnapshot.expectedRouterProtocolVersion <= 0) {
        throw new TypeError("Invalid confidential best-execution verification policy");
    }
    let chainIdValue;
    let routerCode;
    let factoryCode;
    let factoryProtocolVersionValue;
    let configuredRouter;
    let routerProtocolVersionValue;
    let routerFactory;
    let routerRuntimeCodehash;
    let factoryRuntimeCodehash;
    try {
        [
            chainIdValue,
            routerCode,
            factoryCode,
            factoryProtocolVersionValue,
            configuredRouter,
            routerProtocolVersionValue,
            routerFactory,
        ] = await Promise.all([
            adapter.readChainId(),
            adapter.getCode(router),
            adapter.getCode(policySnapshot.expectedFactory),
            adapter.readFactoryProtocolVersion(policySnapshot.expectedFactory),
            adapter.readFactoryBestExecutionRouter(policySnapshot.expectedFactory),
            adapter.readRouterProtocolVersion(router),
            adapter.readRouterFactory(router),
        ]);
        routerRuntimeCodehash = adapter.hashRuntimeCode(routerCode);
        factoryRuntimeCodehash = adapter.hashRuntimeCode(factoryCode);
    }
    catch (error) {
        throw new TypeError("Unable to verify confidential best-execution router", {
            cause: error,
        });
    }
    const chainId = toSafeChainNumber(chainIdValue);
    const factoryProtocolVersion = toSafeChainNumber(factoryProtocolVersionValue);
    const routerProtocolVersion = toSafeChainNumber(routerProtocolVersionValue);
    if (chainId !== policySnapshot.expectedChainId ||
        !hasDeployedCode(routerCode) ||
        !hasDeployedCode(factoryCode) ||
        !isBytes32(routerRuntimeCodehash) ||
        !isBytes32(factoryRuntimeCodehash) ||
        routerRuntimeCodehash.toLowerCase() !==
            policySnapshot.expectedRouterRuntimeCodehash.toLowerCase() ||
        factoryRuntimeCodehash.toLowerCase() !==
            policySnapshot.expectedFactoryRuntimeCodehash.toLowerCase() ||
        factoryProtocolVersion !== policySnapshot.expectedFactoryProtocolVersion ||
        routerProtocolVersion !== policySnapshot.expectedRouterProtocolVersion ||
        !sameAddress(configuredRouter, router) ||
        !sameAddress(routerFactory, policySnapshot.expectedFactory)) {
        throw new TypeError("Confidential best-execution router verification failed");
    }
    const verified = Object.freeze({
        chainId,
        router,
        routerRuntimeCodehash,
        factory: policySnapshot.expectedFactory,
        factoryRuntimeCodehash,
        factoryProtocolVersion,
        routerProtocolVersion,
    });
    verifiedConfidentialBestExecutionRouters.add(verified);
    return verified;
}
/**
 * Decrypts one caller-encrypted result only after authenticating the submitted
 * transaction, successful receipt, exact router event and canonical pool.
 */
export async function decryptConfidentialBestExecutionResult(router, expectation, adapter) {
    if (!verifiedConfidentialBestExecutionRouters.has(router)) {
        throw new TypeError("Unverified confidential best-execution router");
    }
    const expectationSnapshot = snapshotExactOwnRecord(expectation, CONFIDENTIAL_BEST_EXECUTION_RESULT_EXPECTATION_FIELDS);
    if (!expectationSnapshot) {
        throw new TypeError("Invalid confidential best-execution result expectation");
    }
    let transaction;
    let receipt;
    try {
        [transaction, receipt] = await Promise.all([
            adapter.getTransaction(expectationSnapshot.transactionHash),
            adapter.getTransactionReceipt(expectationSnapshot.transactionHash),
        ]);
    }
    catch (error) {
        throw new TypeError("Unable to fetch confidential best-execution transaction evidence", {
            cause: error,
        });
    }
    if (!transaction || !receipt) {
        throw new TypeError("Confidential best-execution transaction evidence is unavailable");
    }
    const decoded = decodeConfidentialBestExecutionResultEvidence(router, expectationSnapshot, transaction, receipt);
    let activeChainIdValue;
    let canonicalPool;
    try {
        [activeChainIdValue, canonicalPool] = await Promise.all([
            adapter.readChainId(),
            adapter.getCanonicalPool(router.factory, expectationSnapshot.tokenIn, expectationSnapshot.tokenOut, decoded.selectedFeeBps, decoded.selectedInitializationStrategy),
        ]);
    }
    catch (error) {
        throw new TypeError("Unable to verify confidential best-execution result provenance", {
            cause: error,
        });
    }
    if (toSafeChainNumber(activeChainIdValue) !== router.chainId ||
        !sameAddress(canonicalPool, decoded.selectedPool)) {
        throw new TypeError("Confidential best-execution result provenance verification failed");
    }
    const amountOut = await adapter.decryptValue256(decoded.result);
    if (typeof amountOut !== "bigint" || amountOut <= 0n) {
        throw new TypeError("Invalid decrypted confidential best-execution result");
    }
    return amountOut;
}
/**
 * Converts untrusted discovery metadata into a process-local verified value.
 * Verification binds the candidate to an expected deployed factory, its
 * canonical key, immutable pool metadata, fee vault, and protocol version.
 */
export async function verifyConfidentialPoolDiscovery(value, policy, adapter) {
    const discoverySnapshot = snapshotConfidentialPoolDiscovery(value);
    const policySnapshot = snapshotExactOwnRecord(policy, CONFIDENTIAL_POOL_POLICY_FIELDS);
    if (!isConfidentialPoolDiscovery(discoverySnapshot)) {
        throw new TypeError("Invalid confidential pool discovery shape");
    }
    const discovery = discoverySnapshot;
    if (!policySnapshot ||
        !Number.isSafeInteger(policySnapshot.expectedChainId) ||
        policySnapshot.expectedChainId <= 0 ||
        !isAddressLike(policySnapshot.expectedFactory) ||
        !isAddressLike(policySnapshot.expectedFeeVault) ||
        !isAddressLike(policySnapshot.expectedLPTokenFactory) ||
        !/^0x[0-9a-f]{64}$/iu.test(policySnapshot.expectedLPTokenFactoryRuntimeCodehash) ||
        !Number.isSafeInteger(policySnapshot.expectedProtocolVersion) ||
        policySnapshot.expectedProtocolVersion <= 0 ||
        discovery.protocolVersion !== policySnapshot.expectedProtocolVersion ||
        !sameAddress(discovery.feeVault, policySnapshot.expectedFeeVault)) {
        throw new TypeError("Confidential pool discovery violates verification policy");
    }
    let chainIdValue;
    let factoryCode;
    let poolCode;
    let factoryVersionValue;
    let factoryLPTokenFactory;
    let factoryLPTokenFactoryRuntimeCodehash;
    let lpTokenFactoryCode;
    let token0Compatible;
    let token1Compatible;
    let factoryRecognizesPool;
    let factoryStrategyClassValue;
    let factoryStrategyRuntimeCodehash;
    let strategyCode;
    let canonicalPool;
    let poolState;
    let lpTokenCode;
    let lpTokenIssued;
    try {
        [
            chainIdValue,
            factoryCode,
            poolCode,
            factoryVersionValue,
            factoryLPTokenFactory,
            factoryLPTokenFactoryRuntimeCodehash,
            lpTokenFactoryCode,
            token0Compatible,
            token1Compatible,
            factoryRecognizesPool,
            factoryStrategyClassValue,
            factoryStrategyRuntimeCodehash,
            strategyCode,
            canonicalPool,
            poolState,
        ] = await Promise.all([
            adapter.readChainId(),
            adapter.getCode(policySnapshot.expectedFactory),
            adapter.getCode(discovery.pool),
            adapter.readFactoryProtocolVersion(policySnapshot.expectedFactory),
            adapter.readFactoryLPTokenFactory(policySnapshot.expectedFactory),
            adapter.readFactoryLPTokenFactoryRuntimeCodehash(policySnapshot.expectedFactory),
            adapter.getCode(policySnapshot.expectedLPTokenFactory),
            adapter.isFactoryPrivateTokenCompatible(policySnapshot.expectedFactory, discovery.token0),
            adapter.isFactoryPrivateTokenCompatible(policySnapshot.expectedFactory, discovery.token1),
            adapter.isFactoryPool(policySnapshot.expectedFactory, discovery.pool),
            adapter.readFactoryInitializationStrategyClass(policySnapshot.expectedFactory, discovery.initializationStrategy),
            adapter.readFactoryInitializationStrategyRuntimeCodehash(policySnapshot.expectedFactory, discovery.initializationStrategy),
            discovery.poolClass === "standard"
                ? Promise.resolve("0x")
                : adapter.getCode(discovery.initializationStrategy),
            adapter.getCanonicalPool(policySnapshot.expectedFactory, discovery),
            adapter.readPoolState(discovery.pool),
        ]);
        [lpTokenCode, lpTokenIssued] = await Promise.all([
            adapter.getCode(poolState.lpToken),
            adapter.isLPTokenIssued(policySnapshot.expectedLPTokenFactory, discovery.pool, poolState.lpToken, policySnapshot.expectedFactory),
        ]);
    }
    catch (error) {
        throw new TypeError("Unable to verify confidential pool provenance", { cause: error });
    }
    const chainId = toSafeChainNumber(chainIdValue);
    const factoryVersion = toSafeChainNumber(factoryVersionValue);
    const poolVersion = toSafeChainNumber(poolState.protocolVersion);
    const privacyMode = toSafeChainNumber(poolState.privacyMode);
    const token0Decimals = toSafeChainNumber(poolState.token0Decimals);
    const token1Decimals = toSafeChainNumber(poolState.token1Decimals);
    const feeBps = toSafeChainNumber(poolState.feeBps);
    const factoryStrategyClass = toSafeChainNumber(factoryStrategyClassValue);
    const strategyProvenanceValid = discovery.poolClass === "standard"
        ? (discovery.initializationStrategy.toLowerCase() === ZERO_ADDRESS &&
            factoryStrategyClass === 0 &&
            factoryStrategyRuntimeCodehash.toLowerCase() === ZERO_BYTES32 &&
            strategyCode === "0x")
        : (factoryStrategyClass === discovery.strategyClass &&
            hasDeployedCode(strategyCode) &&
            isBytes32(factoryStrategyRuntimeCodehash) &&
            adapter.hashRuntimeCode(strategyCode).toLowerCase() ===
                factoryStrategyRuntimeCodehash.toLowerCase());
    if (chainId !== policySnapshot.expectedChainId ||
        !hasDeployedCode(factoryCode) ||
        !hasDeployedCode(poolCode) ||
        !sameAddress(factoryLPTokenFactory, policySnapshot.expectedLPTokenFactory) ||
        factoryLPTokenFactoryRuntimeCodehash.toLowerCase() !==
            policySnapshot.expectedLPTokenFactoryRuntimeCodehash.toLowerCase() ||
        !hasDeployedCode(lpTokenFactoryCode) ||
        adapter.hashRuntimeCode(lpTokenFactoryCode).toLowerCase() !==
            policySnapshot.expectedLPTokenFactoryRuntimeCodehash.toLowerCase() ||
        !token0Compatible ||
        !token1Compatible ||
        !factoryRecognizesPool ||
        !strategyProvenanceValid ||
        factoryVersion !== policySnapshot.expectedProtocolVersion ||
        poolVersion !== discovery.protocolVersion ||
        privacyMode !== discovery.privacyMode ||
        !sameAddress(canonicalPool, discovery.pool) ||
        !sameAddress(poolState.token0, discovery.token0) ||
        !sameAddress(poolState.token1, discovery.token1) ||
        token0Decimals !== discovery.token0Decimals ||
        token1Decimals !== discovery.token1Decimals ||
        feeBps !== discovery.feeBps ||
        !sameAddress(poolState.feeVault, discovery.feeVault) ||
        !sameAddress(poolState.feeVault, policySnapshot.expectedFeeVault) ||
        !sameAddress(poolState.initializationStrategy, discovery.initializationStrategy) ||
        poolState.initialized !== discovery.initialized ||
        !isAddressLike(poolState.lpToken) ||
        !hasDeployedCode(lpTokenCode) ||
        !lpTokenIssued) {
        throw new TypeError("Confidential pool provenance verification failed");
    }
    const verified = Object.freeze({
        chainId,
        disclosureSchemaVersion: discovery.disclosureSchemaVersion,
        protocolVersion: discovery.protocolVersion,
        factory: policySnapshot.expectedFactory,
        pool: discovery.pool,
        token0: discovery.token0,
        token1: discovery.token1,
        token0Decimals: discovery.token0Decimals,
        token1Decimals: discovery.token1Decimals,
        feeBps: discovery.feeBps,
        feeVault: discovery.feeVault,
        feePolicy: Object.freeze(getCipherDEXV1FeePolicy(discovery.feeBps)),
        privacyMode: discovery.privacyMode,
        initializationStrategy: discovery.initializationStrategy,
        strategyClass: discovery.strategyClass,
        poolClass: discovery.poolClass,
        initialized: discovery.initialized,
        poolKind: discovery.poolKind,
        quoteTransport: discovery.quoteTransport,
    });
    verifiedConfidentialPoolDiscoveries.add(verified);
    return verified;
}
export function isPublicPoolDiscovery(value) {
    const descriptors = exactOwnDataDescriptors(value, PUBLIC_POOL_DISCOVERY_FIELDS);
    if (!descriptors)
        return false;
    const candidate = Object.fromEntries(PUBLIC_POOL_DISCOVERY_FIELDS.map((field) => [field, ownDataValue(descriptors, field)]));
    return (candidate.disclosureSchemaVersion === DISCLOSURE_SCHEMA_VERSION &&
        candidate.protocolVersion === CIPHERDEX_PUBLIC_PROTOCOL_VERSION &&
        candidate.poolKind === "public-erc20-cpmm-v2" &&
        isAddressLike(candidate.pool) &&
        isAddressLike(candidate.token0) &&
        isAddressLike(candidate.token1) &&
        candidate.token0.toLowerCase() < candidate.token1.toLowerCase() &&
        Number.isInteger(candidate.protocolVersion) &&
        candidate.protocolVersion > 0 &&
        Number.isInteger(candidate.token0Decimals) &&
        candidate.token0Decimals >= 0 &&
        candidate.token0Decimals <= 18 &&
        Number.isInteger(candidate.token1Decimals) &&
        candidate.token1Decimals >= 0 &&
        candidate.token1Decimals <= 18 &&
        Number.isInteger(candidate.feeBps) &&
        candidate.feeBps >= 0 &&
        isAddressLike(candidate.feeVault) &&
        isCipherDEXV1FeePolicy(candidate.feePolicy, candidate.feeBps) &&
        candidate.privacyMode === PRIVACY_MODE.TRANSPARENT);
}
export const isPublicPoolDiscoveryShape = isPublicPoolDiscovery;
/**
 * Converts untrusted public-market metadata into a process-local value bound
 * to the expected canonical factory, fee vault, protocol and immutable pool
 * state. Shape validation alone is not provenance validation.
 */
export async function verifyPublicPoolDiscovery(value, policy, adapter) {
    const discoverySnapshot = snapshotPublicPoolDiscovery(value);
    const policySnapshot = snapshotExactOwnRecord(policy, PUBLIC_POOL_POLICY_FIELDS);
    if (!isPublicPoolDiscovery(discoverySnapshot)) {
        throw new TypeError("Invalid public pool discovery shape");
    }
    const discovery = discoverySnapshot;
    if (!policySnapshot ||
        !Number.isSafeInteger(policySnapshot.expectedChainId) ||
        policySnapshot.expectedChainId <= 0 ||
        !isAddressLike(policySnapshot.expectedFactory) ||
        !isAddressLike(policySnapshot.expectedFeeVault) ||
        !Number.isSafeInteger(policySnapshot.expectedProtocolVersion) ||
        policySnapshot.expectedProtocolVersion <= 0 ||
        discovery.protocolVersion !== policySnapshot.expectedProtocolVersion ||
        !sameAddress(discovery.feeVault, policySnapshot.expectedFeeVault)) {
        throw new TypeError("Public pool discovery violates verification policy");
    }
    let chainIdValue;
    let factoryCode;
    let poolCode;
    let factoryVersionValue;
    let factoryRecognizesPool;
    let canonicalPool;
    let poolState;
    try {
        [
            chainIdValue,
            factoryCode,
            poolCode,
            factoryVersionValue,
            factoryRecognizesPool,
            canonicalPool,
            poolState,
        ] = await Promise.all([
            adapter.readChainId(),
            adapter.getCode(policySnapshot.expectedFactory),
            adapter.getCode(discovery.pool),
            adapter.readFactoryProtocolVersion(policySnapshot.expectedFactory),
            adapter.isFactoryPool(policySnapshot.expectedFactory, discovery.pool),
            adapter.getCanonicalPool(policySnapshot.expectedFactory, discovery),
            adapter.readPoolState(discovery.pool),
        ]);
    }
    catch (error) {
        throw new TypeError("Unable to verify public pool provenance", { cause: error });
    }
    const chainId = toSafeChainNumber(chainIdValue);
    const factoryVersion = toSafeChainNumber(factoryVersionValue);
    const poolVersion = toSafeChainNumber(poolState.protocolVersion);
    const privacyMode = toSafeChainNumber(poolState.privacyMode);
    const token0Decimals = toSafeChainNumber(poolState.token0Decimals);
    const token1Decimals = toSafeChainNumber(poolState.token1Decimals);
    const feeBps = toSafeChainNumber(poolState.feeBps);
    if (chainId !== policySnapshot.expectedChainId ||
        !hasDeployedCode(factoryCode) ||
        !hasDeployedCode(poolCode) ||
        !factoryRecognizesPool ||
        factoryVersion !== policySnapshot.expectedProtocolVersion ||
        poolVersion !== discovery.protocolVersion ||
        privacyMode !== discovery.privacyMode ||
        !sameAddress(canonicalPool, discovery.pool) ||
        !sameAddress(poolState.token0, discovery.token0) ||
        !sameAddress(poolState.token1, discovery.token1) ||
        token0Decimals !== discovery.token0Decimals ||
        token1Decimals !== discovery.token1Decimals ||
        feeBps !== discovery.feeBps ||
        !sameAddress(poolState.feeVault, discovery.feeVault) ||
        !sameAddress(poolState.feeVault, policySnapshot.expectedFeeVault)) {
        throw new TypeError("Public pool provenance verification failed");
    }
    const verified = Object.freeze({
        chainId,
        disclosureSchemaVersion: discovery.disclosureSchemaVersion,
        protocolVersion: discovery.protocolVersion,
        factory: policySnapshot.expectedFactory,
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
    });
    verifiedPublicPoolDiscoveries.add(verified);
    return verified;
}
export function isConfidentialLockDiscoveryShape(value) {
    const candidate = snapshotConfidentialLockDiscovery(value);
    return candidate !== undefined && isConfidentialLockDiscoverySnapshot(candidate);
}
function snapshotConfidentialLockDiscovery(value) {
    const descriptors = exactOwnDataDescriptors(value, CONFIDENTIAL_LOCK_DISCOVERY_FIELDS);
    if (!descriptors)
        return undefined;
    return Object.freeze(Object.fromEntries(CONFIDENTIAL_LOCK_DISCOVERY_FIELDS.map((field) => [field, ownDataValue(descriptors, field)])));
}
function isConfidentialLockDiscoverySnapshot(candidate) {
    return (candidate.disclosureSchemaVersion === DISCLOSURE_SCHEMA_VERSION &&
        isAddressLike(candidate.pool) &&
        isBytes32(candidate.lockId) &&
        isAddressLike(candidate.owner) &&
        isNonNegativeQuantity(candidate.unlockTime) &&
        typeof candidate.permanent === "boolean" &&
        typeof candidate.released === "boolean");
}
function quantityAsBigInt(value) {
    if (!isNonNegativeQuantity(value))
        throw new TypeError("Invalid bounded chain quantity");
    return typeof value === "bigint" ? value : BigInt(value);
}
const ZERO_BYTES32 = `0x${"00".repeat(32)}`;
const ZERO_ADDRESS = `0x${"00".repeat(20)}`;
export function isConfidentialLockDiscovery(value) {
    const candidate = snapshotConfidentialLockDiscovery(value);
    if (!candidate || !isConfidentialLockDiscoverySnapshot(candidate))
        return false;
    const unlockTime = quantityAsBigInt(candidate.unlockTime);
    return (!sameAddress(candidate.pool, ZERO_ADDRESS) &&
        !sameAddress(candidate.owner, ZERO_ADDRESS) &&
        candidate.lockId.toLowerCase() !== ZERO_BYTES32 &&
        (candidate.permanent ? unlockTime === 0n && !candidate.released : unlockTime > 0n));
}
// Backward-compatible semantic guard for callers that used the original name.
export const isConfidentialLockMetadata = isConfidentialLockDiscovery;
const snapshotLaunchpadMigrationMetadata = (value) => {
    try {
        const descriptors = exactOwnDataDescriptors(value, LAUNCHPAD_MIGRATION_METADATA_FIELDS);
        if (!descriptors)
            return undefined;
        return Object.freeze({
            disclosureSchemaVersion: ownDataValue(descriptors, "disclosureSchemaVersion"),
            launchId: ownDataValue(descriptors, "launchId"),
            authorizationHash: ownDataValue(descriptors, "authorizationHash"),
            initializationStrategy: ownDataValue(descriptors, "initializationStrategy"),
            creator: ownDataValue(descriptors, "creator"),
            pool: ownDataValue(descriptors, "pool"),
            disposition: ownDataValue(descriptors, "disposition"),
            lockId: ownDataValue(descriptors, "lockId"),
            unlockTime: ownDataValue(descriptors, "unlockTime"),
        });
    }
    catch {
        return undefined;
    }
};
export function isLaunchpadMigrationMetadataShape(value) {
    const candidate = snapshotLaunchpadMigrationMetadata(value);
    if (!candidate)
        return false;
    return (candidate.disclosureSchemaVersion === DISCLOSURE_SCHEMA_VERSION &&
        isBytes32(candidate.launchId) &&
        !/^0x0{64}$/i.test(candidate.launchId) &&
        isBytes32(candidate.authorizationHash) &&
        !/^0x0{64}$/i.test(candidate.authorizationHash) &&
        isAddressLike(candidate.initializationStrategy) &&
        isAddressLike(candidate.creator) &&
        isAddressLike(candidate.pool) &&
        (candidate.disposition === LP_DISPOSITION.CREATOR_HELD ||
            candidate.disposition === LP_DISPOSITION.TIMED_LOCK ||
            candidate.disposition === LP_DISPOSITION.PERMANENT_LOCK) &&
        isBytes32(candidate.lockId) &&
        isNonNegativeQuantity(candidate.unlockTime));
}
export function isLaunchpadMigrationMetadata(value) {
    const candidate = snapshotLaunchpadMigrationMetadata(value);
    if (!isLaunchpadMigrationMetadataShape(candidate))
        return false;
    if (sameAddress(candidate.initializationStrategy, ZERO_ADDRESS) ||
        sameAddress(candidate.creator, ZERO_ADDRESS) ||
        sameAddress(candidate.pool, ZERO_ADDRESS)) {
        return false;
    }
    const unlockTime = quantityAsBigInt(candidate.unlockTime);
    const zeroLock = candidate.lockId.toLowerCase() === ZERO_BYTES32;
    if (candidate.disposition === LP_DISPOSITION.CREATOR_HELD) {
        return zeroLock && unlockTime === 0n;
    }
    if (candidate.disposition === LP_DISPOSITION.TIMED_LOCK) {
        return !zeroLock && unlockTime > 0n;
    }
    return !zeroLock && unlockTime === 0n;
}
function topicAddress(topic) {
    if (!isBytes32(topic))
        return undefined;
    return `0x${topic.slice(-40)}`;
}
function splitEventData(data, words) {
    if (typeof data !== "string" || !new RegExp(`^0x[0-9a-fA-F]{${words * 64}}$`).test(data)) {
        return undefined;
    }
    return Object.freeze(Array.from({ length: words }, (_, index) => `0x${data.slice(2 + index * 64, 2 + (index + 1) * 64)}`));
}
function decodedWord(value) {
    if (!isBytes32(value))
        return undefined;
    try {
        return BigInt(value);
    }
    catch {
        return undefined;
    }
}
function matchingLogs(logs, emitter, topic) {
    return logs.filter((log) => sameAddress(log.address, emitter) &&
        log.topics.length > 0 &&
        typeof log.topics[0] === "string" &&
        log.topics[0].toLowerCase() === topic);
}
/**
 * Authenticates launchpad migration metadata against one successful RPC receipt,
 * the configured factory/migrator binding, the canonical pool and current lock
 * state. The adapter is the explicit chain-data trust boundary.
 */
export async function verifyLaunchpadMigrationMetadata(expectation, policy, adapter) {
    const expectationSnapshot = snapshotExactOwnRecord(expectation, LAUNCHPAD_MIGRATION_EXPECTATION_FIELDS);
    const policySnapshot = snapshotExactOwnRecord(policy, LAUNCHPAD_MIGRATION_POLICY_FIELDS);
    const transactionHash = expectationSnapshot?.transactionHash;
    const metadataSnapshot = expectationSnapshot
        ? snapshotLaunchpadMigrationMetadata(expectationSnapshot.metadata)
        : undefined;
    if (!isBytes32(transactionHash) ||
        !isLaunchpadMigrationMetadata(metadataSnapshot) ||
        !policySnapshot ||
        !Number.isSafeInteger(policySnapshot.expectedChainId) ||
        policySnapshot.expectedChainId <= 0 ||
        !isAddressLike(policySnapshot.expectedFactory) ||
        !isBytes32(policySnapshot.expectedFactoryRuntimeCodehash) ||
        !isAddressLike(policySnapshot.expectedMigrator) ||
        !isBytes32(policySnapshot.expectedMigratorRuntimeCodehash) ||
        !isAddressLike(policySnapshot.expectedInitializationStrategy) ||
        sameAddress(policySnapshot.expectedInitializationStrategy, ZERO_ADDRESS) ||
        !isBytes32(policySnapshot.expectedInitializationStrategyRuntimeCodehash) ||
        !sameAddress(metadataSnapshot.initializationStrategy, policySnapshot.expectedInitializationStrategy) ||
        !isAddressLike(policySnapshot.expectedFeeVault) ||
        !Number.isSafeInteger(policySnapshot.expectedFactoryProtocolVersion) ||
        policySnapshot.expectedFactoryProtocolVersion <= 0 ||
        !Number.isSafeInteger(policySnapshot.expectedPoolProtocolVersion) ||
        policySnapshot.expectedPoolProtocolVersion <= 0 ||
        !Number.isSafeInteger(policySnapshot.expectedMigratorProtocolVersion) ||
        policySnapshot.expectedMigratorProtocolVersion <= 0) {
        throw new TypeError("Invalid launchpad migration verification input");
    }
    const metadata = metadataSnapshot;
    let chainIdValue;
    let transaction;
    let receipt;
    let factoryCode;
    let migratorCode;
    let factoryVersionValue;
    let strategyMigrator;
    let strategyMigratorRuntimeCodehash;
    let factoryRecognizesPool;
    let migratorVersionValue;
    let migratorFactory;
    let migratorInitializationStrategy;
    let initializationStrategyCode;
    let factoryStrategyClassValue;
    let factoryStrategyRuntimeCodehash;
    let poolState;
    let factoryRuntimeCodehash;
    let migratorRuntimeCodehash;
    try {
        [
            chainIdValue,
            transaction,
            receipt,
            factoryCode,
            migratorCode,
            factoryVersionValue,
            strategyMigrator,
            strategyMigratorRuntimeCodehash,
            factoryRecognizesPool,
            migratorVersionValue,
            migratorFactory,
            migratorInitializationStrategy,
            initializationStrategyCode,
            factoryStrategyClassValue,
            factoryStrategyRuntimeCodehash,
            poolState,
        ] = await Promise.all([
            adapter.readChainId(),
            adapter.getTransaction(transactionHash),
            adapter.getTransactionReceipt(transactionHash),
            adapter.getCode(policySnapshot.expectedFactory),
            adapter.getCode(policySnapshot.expectedMigrator),
            adapter.readFactoryProtocolVersion(policySnapshot.expectedFactory),
            adapter.readInitializationStrategyMigrator(policySnapshot.expectedInitializationStrategy),
            adapter.readInitializationStrategyMigratorRuntimeCodehash(policySnapshot.expectedInitializationStrategy),
            adapter.isFactoryPool(policySnapshot.expectedFactory, metadata.pool),
            adapter.readMigratorProtocolVersion(policySnapshot.expectedMigrator),
            adapter.readMigratorFactory(policySnapshot.expectedMigrator),
            adapter.readMigratorInitializationStrategy(policySnapshot.expectedMigrator),
            adapter.getCode(policySnapshot.expectedInitializationStrategy),
            adapter.readFactoryInitializationStrategyClass(policySnapshot.expectedFactory, policySnapshot.expectedInitializationStrategy),
            adapter.readFactoryInitializationStrategyRuntimeCodehash(policySnapshot.expectedFactory, policySnapshot.expectedInitializationStrategy),
            adapter.readPoolState(metadata.pool),
        ]);
        factoryRuntimeCodehash = adapter.hashRuntimeCode(factoryCode);
        migratorRuntimeCodehash = adapter.hashRuntimeCode(migratorCode);
    }
    catch (error) {
        throw new TypeError("Unable to fetch launchpad migration evidence", { cause: error });
    }
    if (!transaction || !receipt) {
        throw new TypeError("Launchpad migration transaction evidence is unavailable");
    }
    const receiptLogs = snapshotBoundedEvidenceLogs(receipt.logs);
    if (!receiptLogs) {
        throw new TypeError("Launchpad migration receipt logs exceed evidence bounds");
    }
    const chainId = toSafeChainNumber(chainIdValue);
    const transactionChainId = toSafeChainNumber(transaction.chainId);
    const factoryVersion = toSafeChainNumber(factoryVersionValue);
    const migratorVersion = toSafeChainNumber(migratorVersionValue);
    const poolVersion = toSafeChainNumber(poolState.protocolVersion);
    const privacyMode = toSafeChainNumber(poolState.privacyMode);
    const token0Decimals = toSafeChainNumber(poolState.token0Decimals);
    const token1Decimals = toSafeChainNumber(poolState.token1Decimals);
    const feeBps = toSafeChainNumber(poolState.feeBps);
    const factoryStrategyClass = toSafeChainNumber(factoryStrategyClassValue);
    if (chainId !== policySnapshot.expectedChainId ||
        transactionChainId !== policySnapshot.expectedChainId ||
        !hasDeployedCode(factoryCode) ||
        !hasDeployedCode(migratorCode) ||
        factoryRuntimeCodehash.toLowerCase() !== policySnapshot.expectedFactoryRuntimeCodehash.toLowerCase() ||
        migratorRuntimeCodehash.toLowerCase() !== policySnapshot.expectedMigratorRuntimeCodehash.toLowerCase() ||
        factoryVersion !== policySnapshot.expectedFactoryProtocolVersion ||
        migratorVersion !== policySnapshot.expectedMigratorProtocolVersion ||
        poolVersion !== policySnapshot.expectedPoolProtocolVersion ||
        privacyMode !== PRIVACY_MODE.AMOUNT_CONFIDENTIAL_PRIVATE_LP ||
        !sameAddress(strategyMigrator, policySnapshot.expectedMigrator) ||
        strategyMigratorRuntimeCodehash.toLowerCase() !==
            policySnapshot.expectedMigratorRuntimeCodehash.toLowerCase() ||
        !sameAddress(migratorFactory, policySnapshot.expectedFactory) ||
        !sameAddress(migratorInitializationStrategy, policySnapshot.expectedInitializationStrategy) ||
        !hasDeployedCode(initializationStrategyCode) ||
        adapter.hashRuntimeCode(initializationStrategyCode).toLowerCase() !==
            policySnapshot.expectedInitializationStrategyRuntimeCodehash.toLowerCase() ||
        factoryStrategyClass === undefined ||
        factoryStrategyClass <= 0 ||
        factoryStrategyRuntimeCodehash.toLowerCase() !==
            policySnapshot.expectedInitializationStrategyRuntimeCodehash.toLowerCase() ||
        !factoryRecognizesPool ||
        !sameAddress(poolState.feeVault, policySnapshot.expectedFeeVault) ||
        !sameAddress(poolState.initializationStrategy, policySnapshot.expectedInitializationStrategy) ||
        !poolState.initialized ||
        token0Decimals === undefined ||
        token1Decimals === undefined ||
        feeBps === undefined ||
        !isBytes32(transaction.hash) ||
        transaction.hash.toLowerCase() !== transactionHash.toLowerCase() ||
        !isBytes32(receipt.transactionHash) ||
        receipt.transactionHash.toLowerCase() !== transactionHash.toLowerCase() ||
        toSafeChainNumber(receipt.status) !== 1) {
        throw new TypeError("Launchpad migration provenance verification failed");
    }
    let canonicalPool;
    try {
        canonicalPool = await adapter.getCanonicalPool(policySnapshot.expectedFactory, poolState.token0, poolState.token1, token0Decimals, token1Decimals, feeBps, policySnapshot.expectedInitializationStrategy);
    }
    catch (error) {
        throw new TypeError("Unable to resolve canonical launchpad pool", { cause: error });
    }
    if (!sameAddress(canonicalPool, metadata.pool)) {
        throw new TypeError("Launchpad migration does not reference the canonical pool");
    }
    const migrationLogs = matchingLogs(receiptLogs, policySnapshot.expectedMigrator, LAUNCHPAD_MIGRATION_TOPIC);
    if (migrationLogs.length !== 1) {
        throw new TypeError("Launchpad migration receipt has invalid migration evidence");
    }
    const migrationLog = migrationLogs[0];
    if (migrationLog.topics.length !== 4 ||
        migrationLog.topics[1].toLowerCase() !== metadata.launchId.toLowerCase() ||
        !sameAddress(topicAddress(migrationLog.topics[2]) ?? ZERO_ADDRESS, metadata.creator) ||
        !sameAddress(topicAddress(migrationLog.topics[3]) ?? ZERO_ADDRESS, metadata.pool)) {
        throw new TypeError("Launchpad migration event does not match metadata");
    }
    const migrationData = splitEventData(migrationLog.data, 2);
    if (!migrationData ||
        !sameAddress(addressFromAbiWord(migrationData[0].slice(2)) ?? ZERO_ADDRESS, metadata.initializationStrategy) ||
        migrationData[1].toLowerCase() !==
            metadata.authorizationHash.toLowerCase()) {
        throw new TypeError("Launchpad migration event does not match authorization");
    }
    const dispositionLogs = matchingLogs(receiptLogs, policySnapshot.expectedMigrator, LAUNCHPAD_LOCK_DISPOSITION_TOPIC);
    const usesDisposition = dispositionLogs.length === 1;
    if (dispositionLogs.length > 1 ||
        (!usesDisposition &&
            (metadata.disposition !== LP_DISPOSITION.CREATOR_HELD ||
                metadata.lockId.toLowerCase() !== ZERO_BYTES32 ||
                quantityAsBigInt(metadata.unlockTime) !== 0n))) {
        throw new TypeError("Launchpad migration receipt has invalid disposition evidence");
    }
    if (usesDisposition) {
        const dispositionLog = dispositionLogs[0];
        const dispositionData = splitEventData(dispositionLog.data, 3);
        if (dispositionLog.topics.length !== 3 ||
            !dispositionData ||
            !sameAddress(topicAddress(dispositionLog.topics[1]) ?? ZERO_ADDRESS, metadata.creator) ||
            !sameAddress(topicAddress(dispositionLog.topics[2]) ?? ZERO_ADDRESS, metadata.pool) ||
            decodedWord(dispositionData[0]) !== BigInt(metadata.disposition) ||
            dispositionData[1].toLowerCase() !== metadata.lockId.toLowerCase() ||
            decodedWord(dispositionData[2]) !== quantityAsBigInt(metadata.unlockTime)) {
            throw new TypeError("Launchpad disposition event does not match metadata");
        }
    }
    const liquidityLogs = matchingLogs(receiptLogs, metadata.pool, CONFIDENTIAL_LIQUIDITY_LOCKED_TOPIC);
    if (metadata.disposition === LP_DISPOSITION.CREATOR_HELD) {
        if (liquidityLogs.length !== 0) {
            throw new TypeError("Creator-held launchpad migration unexpectedly created a lock");
        }
    }
    else {
        if (liquidityLogs.length !== 1) {
            throw new TypeError("Locked launchpad migration has invalid pool lock evidence");
        }
        const liquidityLog = liquidityLogs[0];
        const liquidityData = splitEventData(liquidityLog.data, 2);
        if (liquidityLog.topics.length !== 3 ||
            !liquidityData ||
            liquidityLog.topics[1].toLowerCase() !== metadata.lockId.toLowerCase() ||
            !sameAddress(topicAddress(liquidityLog.topics[2]) ?? ZERO_ADDRESS, metadata.creator) ||
            decodedWord(liquidityData[0]) !== quantityAsBigInt(metadata.unlockTime) ||
            decodedWord(liquidityData[1]) !==
                BigInt(metadata.disposition === LP_DISPOSITION.PERMANENT_LOCK ? 1 : 0)) {
            throw new TypeError("Pool lock event does not match launchpad metadata");
        }
        let lockInfo;
        try {
            lockInfo = await adapter.readLockInfo(metadata.pool, metadata.lockId);
        }
        catch (error) {
            throw new TypeError("Unable to read launchpad lock state", { cause: error });
        }
        if (!sameAddress(lockInfo.owner, metadata.creator) ||
            toSafeChainNumber(lockInfo.unlockTime) !== Number(quantityAsBigInt(metadata.unlockTime)) ||
            lockInfo.permanent !== (metadata.disposition === LP_DISPOSITION.PERMANENT_LOCK) ||
            lockInfo.released) {
            throw new TypeError("Launchpad lock state does not match migration evidence");
        }
    }
    const verified = Object.freeze({
        ...metadata,
        chainId,
        transactionHash,
        factory: policySnapshot.expectedFactory,
        migrator: policySnapshot.expectedMigrator,
    });
    verifiedLaunchpadMigrationMetadata.add(verified);
    return verified;
}
export function isVerifiedLaunchpadMigrationMetadata(value) {
    return typeof value === "object" && value !== null &&
        verifiedLaunchpadMigrationMetadata.has(value);
}
