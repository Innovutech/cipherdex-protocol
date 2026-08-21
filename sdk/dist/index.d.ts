/**
 * Stable, privacy-minimal client surface for CipherDEX.
 *
 * These ABI fragments intentionally contain no balance, reserve, amount or LP
 * position read model. Clients must obtain private values through the official
 * COTI SDK and the caller's AES key.
 */
export declare const DISCLOSURE_SCHEMA_VERSION: 6;
export declare const CIPHERDEX_PUBLIC_PROTOCOL_VERSION: 2;
export declare const CIPHERDEX_CONFIDENTIAL_PROTOCOL_VERSION: 3;
export declare const CIPHERDEX_PROTOCOL_VERSION: 3;
export declare const CONFIDENTIAL_BEST_EXECUTION_ROUTER_VERSION: 2;
export declare const CONFIDENTIAL_LAUNCHPAD_MIGRATOR_VERSION: 4;
export declare const CONFIDENTIAL_INITIALIZATION_STRATEGY_VERSION: 1;
export declare const CONFIDENTIAL_INITIALIZATION_STRATEGY_REGISTRY_VERSION: 1;
export declare const CIPHERDEX_V1_FEE_POLICY: {
    readonly approvedTotalFeeBps: readonly [5, 30, 100];
    readonly protocolFeeShareNumerator: 1;
    readonly protocolFeeShareDenominator: 6;
    readonly lpFeeShareNumerator: 5;
    readonly lpFeeShareDenominator: 6;
    readonly chargedOn: "input";
    readonly extraNativeSwapFee: false;
    readonly confidentialCollection: {
        readonly minimumPoolSwapCount: 8;
        readonly minimumPoolDelaySeconds: 3600;
        readonly minimumVaultSweepDelaySeconds: 86400;
        readonly vaultEpochSeconds: 86400;
        readonly minimumVaultAggregatedSwapCount: 8;
        readonly minimumVaultResidenceEpochs: 2;
    };
};
export declare const CONFIDENTIAL_QUOTE_TRANSPORT: {
    readonly TRANSACTION_EVENT: "encrypted-transaction-event-v1";
};
export declare const PRIVACY_MODE: {
    readonly TRANSPARENT: 0;
    readonly AMOUNT_CONFIDENTIAL_PRIVATE_LP: 1;
    readonly UNSUPPORTED_FULLY_CONFIDENTIAL: 2;
};
export declare const LP_DISPOSITION: {
    readonly CREATOR_HELD: 0;
    readonly TIMED_LOCK: 1;
    readonly PERMANENT_LOCK: 2;
};
export declare const CONFIDENTIAL_CPMM_ABI: readonly ["function PROTOCOL_VERSION() view returns (uint256)", "function PRIVACY_MODE() view returns (uint8)", "function LP_DISPOSITION_CREATOR_HELD() view returns (uint8)", "function LP_DISPOSITION_TIMED_LOCK() view returns (uint8)", "function LP_DISPOSITION_PERMANENT_LOCK() view returns (uint8)", "function token0() view returns (address)", "function token1() view returns (address)", "function token0Decimals() view returns (uint8)", "function token1Decimals() view returns (uint8)", "function scale0() view returns (uint256)", "function scale1() view returns (uint256)", "function feeBps() view returns (uint256)", "function feeVault() view returns (address)", "function PROTOCOL_FEE_SHARE_NUMERATOR() view returns (uint256)", "function PROTOCOL_FEE_SHARE_DENOMINATOR() view returns (uint256)", "function MIN_CONFIDENTIAL_COLLECTION_SWAPS() view returns (uint32)", "function MIN_CONFIDENTIAL_COLLECTION_DELAY() view returns (uint64)", "function protocolFeeSwapCount0() view returns (uint32)", "function protocolFeeSwapCount1() view returns (uint32)", "function protocolFeeWindowStart0() view returns (uint64)", "function protocolFeeWindowStart1() view returns (uint64)", "function bootstrapper() view returns (address)", "function initializationStrategy() view returns (address)", "function lpToken() view returns (address)", "function initialized() view returns (bool)", "function protectedInitializationCompleted() view returns (bool)", "function quoteExactInput(((uint256,uint256),bytes),bool) returns ((uint256,uint256))", "function requestQuoteExactInput(((uint256,uint256),bytes),bool,bytes32) returns ((uint256,uint256))", "function swapExactInput(((uint256,uint256),bytes),((uint256,uint256),bytes),bool,uint64) returns ((uint256,uint256))", "function addLiquidity(((uint256,uint256),bytes),((uint256,uint256),bytes),((uint256,uint256),bytes),((uint256,uint256),bytes),((uint256,uint256),bytes),bool,uint64) returns ((uint256,uint256))", "function bootstrapLiquidity(address,address,uint256,uint256,uint256,uint256,uint256) returns ((uint256,uint256))", "function bootstrapLiquidityWithDisposition(address,address,uint256,uint256,uint256,uint256,uint256,uint8,uint64) returns ((uint256,uint256),bytes32)", "function removeLiquidity(((uint256,uint256),bytes),((uint256,uint256),bytes),((uint256,uint256),bytes),uint64) returns ((uint256,uint256),(uint256,uint256))", "function collectProtocolFees(bool,bool)", "function myShares() view returns ((uint256,uint256))", "function lockInfo(bytes32) view returns (address,uint64,bool,bool)", "function lockShares(((uint256,uint256),bytes),uint64,bool,uint64) returns (bytes32)", "function unlockShares(bytes32)", "event SwapExecuted(address indexed trader,bool indexed zeroForOne)", "event LiquidityAdded(address indexed provider)", "event PoolBootstrapped(address indexed provider)", "event LiquidityRemoved(address indexed provider)", "event LiquidityLocked(bytes32 indexed lockId,address indexed owner,uint64 unlockTime,bool permanent)", "event LiquidityUnlocked(bytes32 indexed lockId,address indexed owner)", "event ConfidentialQuoteResult(address indexed caller,bytes32 indexed requestId,bool indexed zeroForOne,(uint256,uint256) result)", "event ConfidentialProtocolFeesCollected(address indexed token,address indexed feeVault,uint32 aggregatedSwapCount)"];
export declare const CONFIDENTIAL_CPMM_FACTORY_ABI: readonly ["function PROTOCOL_VERSION() view returns (uint256)", "function PRIVACY_MODE() view returns (uint8)", "function PRIVATE_LP_TOKEN_FACTORY_RUNTIME_CODEHASH() view returns (bytes32)", "function lpTokenFactory() view returns (address)", "function poolDeployer() view returns (address)", "function poolDeployerRuntimeCodehash() view returns (bytes32)", "function feeVault() view returns (address)", "function initializationStrategyRegistry() view returns (address)", "function initializationStrategyRegistryRuntimeCodehash() view returns (bytes32)", "function initializationStrategyRegistryFinalized() view returns (bool)", "function initializationStrategiesLength() view returns (uint256)", "function initializationStrategyAt(uint8) view returns (address)", "function initializationStrategyClass(address) view returns (uint8)", "function initializationStrategyRuntimeCodehash(address) view returns (bytes32)", "function initializationStrategyRegistration(address) view returns (bytes32)", "function isCompatiblePrivateToken(address) view returns (bool)", "function isApprovedFeeTier(uint256) pure returns (bool)", "function bootstrapConfigurator() view returns (address)", "function bestExecutionRouter() view returns (address)", "function BEST_EXECUTION_ROUTER_RUNTIME_CODEHASH() view returns (bytes32)", "function getPool(bytes32) view returns (address)", "function isPool(address) view returns (bool)", "function createPool(address,address,uint8,uint8,uint256) returns (address)", "function getOrCreatePoolForCommitment(address,address,uint8,uint8,uint256) returns (address)", "function setBestExecutionRouter(address)", "function poolKey(address,address,uint8,uint8,uint256,address) pure returns (bytes32)", "function allPoolsLength() view returns (uint256)", "function allPools(uint256) view returns (address)", "function bootstrapPool(address,bytes32,bytes32,address,address,uint256,uint256,uint256,uint256,uint256) returns ((uint256,uint256))", "function bootstrapPoolWithDisposition(address,bytes32,bytes32,address,address,uint256,uint256,uint256,uint256,uint256,uint8,uint64) returns ((uint256,uint256),bytes32)", "event PoolCreated(address indexed token0,address indexed token1,uint8 token0Decimals,uint8 token1Decimals,uint256 feeBps,address initializationStrategy,address pool)", "event PrivateLPTokenCreated(address indexed pool,address indexed token)", "event BestExecutionRouterConfigured(address indexed router)"];
export declare const PRIVATE_LP_TOKEN_FACTORY_ABI: readonly ["function poolByToken(address) view returns (address)", "function issuerByToken(address) view returns (address)", "function isIssuedToken(address,address,address) view returns (bool)", "event PrivateLPTokenIssued(address indexed pool,address indexed token,address indexed issuer)"];
export declare const CONFIDENTIAL_BEST_EXECUTION_POOL_ABI: readonly ["function quoteExactInputForRouter(uint256,bool) returns (uint256,uint256)", "function settleExactInputForRouter(address,uint256,uint256,bool,uint64) returns (uint256)"];
export declare const CONFIDENTIAL_BEST_EXECUTION_ROUTER_ABI: readonly ["function PROTOCOL_VERSION() view returns (uint256)", "function factory() view returns (address)", "function MAX_CANDIDATES() view returns (uint8)", "function MAX_POOL_CLASSES() view returns (uint8)", "function DEFAULT_STANDARD_CANDIDATE_BITMAP() view returns (uint16)", "function usedRequestIds(address,bytes4,bytes32) view returns (bool)", "function requestBestQuoteExactInput(address,address,((uint256,uint256),bytes),bytes32,uint64) returns ((uint256,uint256))", "function requestBestQuoteExactInputWithCandidates(address,address,((uint256,uint256),bytes),uint16,bytes32,uint64) returns ((uint256,uint256))", "function swapBestExactInput(address,address,((uint256,uint256),bytes),((uint256,uint256),bytes),bytes32,uint64) returns ((uint256,uint256))", "function swapBestExactInputWithCandidates(address,address,((uint256,uint256),bytes),((uint256,uint256),bytes),uint16,bytes32,uint64) returns ((uint256,uint256))", "event ConfidentialBestQuoteResult(address indexed caller,bytes32 indexed requestId,address indexed selectedPool,uint256 selectedFeeBps,address selectedInitializationStrategy,uint16 candidateBitmap,bool zeroForOne,(uint256,uint256) result)", "event ConfidentialBestSwapResult(address indexed caller,bytes32 indexed requestId,address indexed selectedPool,uint256 selectedFeeBps,address selectedInitializationStrategy,uint16 candidateBitmap,bool zeroForOne,(uint256,uint256) result)"];
export declare const PRIVATE_LP_TOKEN_ABI: readonly ["function pool() view returns (address)", "function name() view returns (string)", "function symbol() view returns (string)", "function decimals() view returns (uint8)", "function publicAmountsEnabled() view returns (bool)", "function balanceOf() returns (uint256)", "function transfer(address,((uint256,uint256),bytes))", "function approve(address,((uint256,uint256),bytes))", "event Transfer(address indexed from,address indexed to,(uint256,uint256),(uint256,uint256))", "event Approval(address indexed owner,address indexed spender,(uint256,uint256),(uint256,uint256))", "event AllowanceReencrypted(address indexed owner,address indexed spender,bool isSpender)"];
export declare const CONFIDENTIAL_LAUNCHPAD_MIGRATOR_ABI: readonly ["function PROTOCOL_VERSION() view returns (uint256)", "function factory() view returns (address)", "function initializationStrategy() view returns (address)", "function migrate((bytes32,bytes32,address,address,uint8,uint8,uint256,((uint256,uint256),bytes),((uint256,uint256),bytes),((uint256,uint256),bytes),((uint256,uint256),bytes),((uint256,uint256),bytes),uint64,bytes)) returns (address,(uint256,uint256))", "function migrateWithDisposition((bytes32,bytes32,address,address,uint8,uint8,uint256,((uint256,uint256),bytes),((uint256,uint256),bytes),((uint256,uint256),bytes),((uint256,uint256),bytes),((uint256,uint256),bytes),uint64,bytes),uint8,uint64) returns (address,(uint256,uint256),bytes32)", "event LaunchpadMigration(bytes32 indexed launchId,address indexed creator,address indexed pool,address initializationStrategy,bytes32 launchCommitmentHash)", "event LaunchpadLockDisposition(address indexed creator,address indexed pool,uint8 disposition,bytes32 lockId,uint64 unlockTime)"];
export declare const CONFIDENTIAL_INITIALIZATION_STRATEGY_ABI: readonly ["function STRATEGY_VERSION() view returns (uint256)", "function PROTOCOL_VERSION() view returns (uint256)", "function PRIVACY_MODE() view returns (uint8)", "function factory() view returns (address)", "function strategyRegistry() view returns (address)", "function migrator() view returns (address)", "function migratorRuntimeCodehash() view returns (bytes32)", "function launchAuthority() view returns (address)", "function configurationFinalized() view returns (bool)", "function factoryRegistration() view returns (bytes32)", "function launchCommitmentDigest((bytes32 launchId,address creator,address token0,address token1,uint8 decimals0,uint8 decimals1,uint256 feeBps,uint8 privacyMode,uint256 poolVersion,address factory,address migrator,address initializationStrategy,address launchAuthority,uint256 chainId,uint64 authorizationDeadline,uint64 migrationDeadline) commitment) view returns (bytes32)", "function commitLaunch((bytes32 launchId,address creator,address token0,address token1,uint8 decimals0,uint8 decimals1,uint256 feeBps,uint8 privacyMode,uint256 poolVersion,address factory,address migrator,address initializationStrategy,address launchAuthority,uint256 chainId,uint64 authorizationDeadline,uint64 migrationDeadline) commitment,bytes creatorAuthorization,bytes authorityAuthorization) returns (address pool,bytes32 commitmentHash)", "function cancelLaunch(bytes32)", "function expireLaunch(bytes32)", "function getLaunch(bytes32) view returns (bytes32,bytes32,address,address,uint64,uint8)", "function activeLaunchForPoolKey(bytes32) view returns (bytes32)", "event LaunchCommitted(bytes32 indexed launchId,bytes32 indexed poolKey,address indexed pool,address creator,uint64 migrationDeadline,bytes32 commitmentHash)", "event LaunchCanceled(bytes32 indexed launchId,bytes32 indexed poolKey)", "event LaunchExpired(bytes32 indexed launchId,bytes32 indexed poolKey)"];
export declare const CONFIDENTIAL_INITIALIZATION_STRATEGY_REGISTRY_ABI: readonly ["function REGISTRY_VERSION() view returns (uint256)", "function MAX_INITIALIZATION_STRATEGIES() view returns (uint8)", "function factory() view returns (address)", "function finalized() view returns (bool)", "function initializationStrategiesLength() view returns (uint256)", "function initializationStrategyAt(uint8) view returns (address)", "function initializationStrategyClass(address) view returns (uint8)", "function initializationStrategyRuntimeCodehash(address) view returns (bytes32)", "function initializationStrategyRegistration(address) view returns (bytes32)", "function isRegisteredStrategy(address) view returns (bool)"];
export declare const CIPHERDEX_FEE_VAULT_ABI: readonly ["function beneficiary() view returns (address)", "function deployedAt() view returns (uint64)", "function confidentialFactoryConfigurator() view returns (address)", "function confidentialFactory() view returns (address)", "function publicFactory() view returns (address)", "function publicFees(address) view returns (uint256)", "function MIN_CONFIDENTIAL_SWEEP_DELAY() view returns (uint64)", "function CONFIDENTIAL_EPOCH_SECONDS() view returns (uint64)", "function MIN_CONFIDENTIAL_AGGREGATED_SWAPS() view returns (uint64)", "function MAX_CONFIDENTIAL_SWEEP_EPOCHS() view returns (uint256)", "function confidentialSwapCountByEpoch(address,uint64) view returns (uint64)", "function nextConfidentialEpochIndex(address) view returns (uint256)", "function confidentialEpochCount(address) view returns (uint256)", "function confidentialEpochAt(address,uint256) view returns (uint64)", "function nextConfidentialSweepAt(address) view returns (uint64)", "function setConfidentialFactory(address)", "function setPublicFactory(address)", "function depositPublicFees(address,uint256) returns (uint256)", "function depositConfidentialFees(address,uint256,uint32)", "function sweepPublicToken(address) returns (uint256)", "function sweepConfidentialToken(address)", "event PublicFeesSwept(address indexed token,address indexed beneficiary,uint256 amount)", "event PublicFeesSweepReceipt(address indexed token,address indexed beneficiary,uint256 debitedAmount,uint256 beneficiaryReceived)", "event PublicFactoryConfigured(address indexed factory)", "event PublicFeesDeposited(address indexed token,address indexed pool,uint256 amount)", "event ConfidentialFeesSwept(address indexed token,address indexed beneficiary,uint64 aggregatedSwapCount)", "event ConfidentialFactoryConfigured(address indexed factory)", "event ConfidentialFeesDeposited(address indexed token,address indexed pool,uint64 indexed epoch,uint32 aggregatedSwapCount)"];
export declare const LAUNCHPAD_MIGRATOR_EIP712_DOMAIN: {
    readonly name: "CipherDEX Launchpad Migrator";
    readonly version: "1";
};
export declare const LAUNCHPAD_MIGRATION_EIP712_TYPES: readonly [{
    readonly name: "launchId";
    readonly type: "bytes32";
}, {
    readonly name: "launchCommitmentHash";
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
export declare const LAUNCH_INITIALIZATION_EIP712_DOMAIN: {
    readonly name: "CipherDEX Launch Initialization";
    readonly version: "1";
};
export declare const LAUNCH_COMMITMENT_EIP712_TYPES: readonly [{
    readonly name: "launchId";
    readonly type: "bytes32";
}, {
    readonly name: "creator";
    readonly type: "address";
}, {
    readonly name: "token0";
    readonly type: "address";
}, {
    readonly name: "token1";
    readonly type: "address";
}, {
    readonly name: "decimals0";
    readonly type: "uint8";
}, {
    readonly name: "decimals1";
    readonly type: "uint8";
}, {
    readonly name: "feeBps";
    readonly type: "uint256";
}, {
    readonly name: "privacyMode";
    readonly type: "uint8";
}, {
    readonly name: "poolVersion";
    readonly type: "uint256";
}, {
    readonly name: "factory";
    readonly type: "address";
}, {
    readonly name: "migrator";
    readonly type: "address";
}, {
    readonly name: "initializationStrategy";
    readonly type: "address";
}, {
    readonly name: "launchAuthority";
    readonly type: "address";
}, {
    readonly name: "chainId";
    readonly type: "uint256";
}, {
    readonly name: "authorizationDeadline";
    readonly type: "uint64";
}, {
    readonly name: "migrationDeadline";
    readonly type: "uint64";
}];
export type ConfidentialLaunchCommitmentInput = Readonly<{
    launchId: string;
    creator: string;
    tokenA: string;
    tokenB: string;
    decimalsA: number;
    decimalsB: number;
    feeBps: number;
    factory: string;
    migrator: string;
    initializationStrategy: string;
    launchAuthority: string;
    chainId: bigint;
    authorizationDeadline: bigint;
    migrationDeadline: bigint;
}>;
export type ConfidentialLaunchCommitment = Readonly<{
    launchId: string;
    creator: string;
    token0: string;
    token1: string;
    decimals0: number;
    decimals1: number;
    feeBps: number;
    privacyMode: typeof PRIVACY_MODE.AMOUNT_CONFIDENTIAL_PRIVATE_LP;
    poolVersion: typeof CIPHERDEX_CONFIDENTIAL_PROTOCOL_VERSION;
    factory: string;
    migrator: string;
    initializationStrategy: string;
    launchAuthority: string;
    chainId: bigint;
    authorizationDeadline: bigint;
    migrationDeadline: bigint;
}>;
export type ConfidentialLaunchCommitCall = Readonly<{
    functionName: "commitLaunch";
    args: readonly [ConfidentialLaunchCommitment, string, string];
}>;
/**
 * Canonicalizes the complete protected-pool commitment before EIP-712 signing.
 * The caller still signs with its chosen reviewed signing implementation.
 */
export declare function buildConfidentialLaunchCommitment(input: ConfidentialLaunchCommitmentInput): ConfidentialLaunchCommitment;
export declare function buildConfidentialLaunchCommitCall(commitment: ConfidentialLaunchCommitment, creatorAuthorization: string | Uint8Array, authorityAuthorization: string | Uint8Array): ConfidentialLaunchCommitCall;
export declare const PUBLIC_CPMM_ABI: readonly ["function PROTOCOL_VERSION() view returns (uint256)", "function PRIVACY_MODE() view returns (uint8)", "function token0() view returns (address)", "function token1() view returns (address)", "function token0Decimals() view returns (uint8)", "function token1Decimals() view returns (uint8)", "function scale0() view returns (uint256)", "function scale1() view returns (uint256)", "function feeBps() view returns (uint256)", "function feeVault() view returns (address)", "function PROTOCOL_FEE_SHARE_NUMERATOR() view returns (uint256)", "function PROTOCOL_FEE_SHARE_DENOMINATOR() view returns (uint256)", "function protocolFees0() view returns (uint256)", "function protocolFees1() view returns (uint256)", "function initialized() view returns (bool)", "function totalShares() view returns (uint256)", "function shares(address) view returns (uint256)", "function quoteExactInput(uint256,bool) view returns (uint256)", "function swapExactInput(uint256,uint256,bool,uint64) returns (uint256)", "function addLiquidity(uint256,uint256,uint256,uint256,uint256,uint64) returns (uint256)", "function removeLiquidity(uint256,uint256,uint256,uint64) returns (uint256,uint256)", "function collectProtocolFees(bool,bool) returns (uint256,uint256)", "function effectiveReserves() view returns (uint256,uint256)", "function lockShares(uint256,uint64,bool,uint64) returns (bytes32)", "function unlockShares(bytes32)", "function lockInfo(bytes32) view returns (address,uint64,bool,bool,uint256)", "event SwapExecuted(address indexed trader,bool indexed zeroForOne,uint256 amountIn,uint256 amountOut)", "event LiquidityAdded(address indexed provider,uint256 amount0,uint256 amount1,uint256 shares)", "event LiquidityRemoved(address indexed provider,uint256 amount0,uint256 amount1,uint256 shares)", "event LiquidityLocked(bytes32 indexed lockId,address indexed owner,uint64 unlockTime,bool permanent,uint256 shares)", "event LiquidityUnlocked(bytes32 indexed lockId,address indexed owner,uint256 shares)", "event ProtocolFeeAccrued(address indexed token,uint256 amount)", "event ProtocolFeeCollected(address indexed token,address indexed feeVault,uint256 debitedAmount,uint256 receivedAmount)", "event UnmanagedBalanceSwept(address indexed token,address indexed feeVault,uint256 debitedAmount,uint256 receivedAmount)", "event ProtocolFeeLossReconciled(address indexed token,uint256 previousClaim,uint256 remainingClaim,uint256 loss)"];
export declare const PUBLIC_CPMM_FACTORY_ABI: readonly ["function PROTOCOL_VERSION() view returns (uint256)", "function PRIVACY_MODE() view returns (uint8)", "function feeVault() view returns (address)", "function isApprovedFeeTier(uint256) pure returns (bool)", "function getPool(bytes32) view returns (address)", "function isPool(address) view returns (bool)", "function createPool(address,address,uint8,uint8,uint256) returns (address)", "function poolKey(address,address,uint8,uint8,uint256) pure returns (bytes32)", "function allPoolsLength() view returns (uint256)", "function allPools(uint256) view returns (address)", "event PoolCreated(address indexed token0,address indexed token1,uint8 token0Decimals,uint8 token1Decimals,uint256 feeBps,address pool)"];
export declare const PUBLIC_CPMM_QUOTER_ABI: readonly ["function PROTOCOL_VERSION() view returns (uint256)", "function factory() view returns (address)", "function quoteExactInput(address,uint256,bool) view returns (uint256)"];
export declare const PUBLIC_CPMM_ROUTER_ABI: readonly ["function PROTOCOL_VERSION() view returns (uint256)", "function factory() view returns (address)", "function swapExactInput(address,uint256,uint256,bool,uint64) returns (uint256)", "event SwapRouted(address indexed trader,address indexed pool,address indexed inputToken,address outputToken,uint256 amountIn,uint256 amountOut)"];
export type Ciphertext256 = {
    ciphertextHigh: bigint;
    ciphertextLow: bigint;
};
export type InputText256 = {
    ciphertext: Ciphertext256;
    signature: string | Uint8Array;
};
export declare const CONFIDENTIAL_BEST_QUOTE_FUNCTION: "requestBestQuoteExactInput";
export declare const CONFIDENTIAL_BEST_QUOTE_WITH_CANDIDATES_FUNCTION: "requestBestQuoteExactInputWithCandidates";
export declare const CONFIDENTIAL_BEST_SWAP_FUNCTION: "swapBestExactInput";
export declare const CONFIDENTIAL_BEST_SWAP_WITH_CANDIDATES_FUNCTION: "swapBestExactInputWithCandidates";
export declare const CONFIDENTIAL_BEST_QUOTE_SELECTOR: "0x440bde4a";
export declare const CONFIDENTIAL_BEST_QUOTE_WITH_CANDIDATES_SELECTOR: "0xc636ee79";
export declare const CONFIDENTIAL_BEST_SWAP_SELECTOR: "0x310481d3";
export declare const CONFIDENTIAL_BEST_SWAP_WITH_CANDIDATES_SELECTOR: "0xc55b572d";
export declare const DEFAULT_STANDARD_CANDIDATE_BITMAP: 73;
export declare const MAX_CONFIDENTIAL_ROUTE_CANDIDATES: 3;
export declare const CONFIDENTIAL_BEST_QUOTE_RESULT_TOPIC: "0x74d60457cef138a4b1c57bac9346b347c04566dfa22699c3a3eab54267d0fdb7";
export declare const CONFIDENTIAL_BEST_SWAP_RESULT_TOPIC: "0x4a0ef2bdc006487857271fcf656bebd35d04c28f1fc35b8aa460ded5ca8fc3dc";
export declare const LAUNCHPAD_MIGRATION_TOPIC: "0x6227c8fb63c7ea6dc2225fbf219a361b834ac2a7bf43da0b32f1ef9f3b779956";
export declare const LAUNCHPAD_LOCK_DISPOSITION_TOPIC: "0x75e334dcb38a552c1315b5412176e01190962bbb6774c5b3964f221b4a2eb53c";
export declare const LAUNCHPAD_MIGRATE_SELECTOR: "0xb3f48f47";
export declare const LAUNCHPAD_MIGRATE_WITH_DISPOSITION_SELECTOR: "0xf1134089";
export declare const CONFIDENTIAL_LIQUIDITY_LOCKED_TOPIC: "0xda0ee1246c7c735db57cd30fc8444456fd8e002c807a94c88bf4495ea01707bd";
export type ConfidentialBestQuoteCall = Readonly<{
    functionName: typeof CONFIDENTIAL_BEST_QUOTE_FUNCTION;
    args: readonly [string, string, InputText256, string, bigint];
}>;
export type ConfidentialBestSwapCall = Readonly<{
    functionName: typeof CONFIDENTIAL_BEST_SWAP_FUNCTION;
    args: readonly [string, string, InputText256, InputText256, string, bigint];
}>;
export type ConfidentialBestQuoteWithCandidatesCall = Readonly<{
    functionName: typeof CONFIDENTIAL_BEST_QUOTE_WITH_CANDIDATES_FUNCTION;
    args: readonly [string, string, InputText256, number, string, bigint];
}>;
export type ConfidentialBestSwapWithCandidatesCall = Readonly<{
    functionName: typeof CONFIDENTIAL_BEST_SWAP_WITH_CANDIDATES_FUNCTION;
    args: readonly [
        string,
        string,
        InputText256,
        InputText256,
        number,
        string,
        bigint
    ];
}>;
export type ConfidentialBestExecutionRouterVerificationPolicy = Readonly<{
    expectedChainId: number;
    expectedFactory: string;
    expectedFactoryRuntimeCodehash: string;
    expectedRouter: string;
    expectedRouterRuntimeCodehash: string;
    expectedFactoryProtocolVersion: number;
    expectedRouterProtocolVersion: number;
}>;
export interface ConfidentialBestExecutionRouterVerificationAdapter {
    readChainId(): Promise<number | bigint>;
    getCode(address: string): Promise<string>;
    hashRuntimeCode(code: string): string;
    readFactoryProtocolVersion(factory: string): Promise<number | bigint>;
    readFactoryBestExecutionRouter(factory: string): Promise<string>;
    readRouterProtocolVersion(router: string): Promise<number | bigint>;
    readRouterFactory(router: string): Promise<string>;
}
declare const VERIFIED_CONFIDENTIAL_BEST_EXECUTION_ROUTER: unique symbol;
export type VerifiedConfidentialBestExecutionRouter = Readonly<{
    chainId: number;
    router: string;
    routerRuntimeCodehash: string;
    factory: string;
    factoryRuntimeCodehash: string;
    factoryProtocolVersion: number;
    routerProtocolVersion: number;
    readonly [VERIFIED_CONFIDENTIAL_BEST_EXECUTION_ROUTER]: true;
}>;
export type ConfidentialBestQuoteTransaction = ConfidentialBestQuoteCall & Readonly<{
    chainId: number;
    to: string;
}>;
export type ConfidentialBestSwapTransaction = ConfidentialBestSwapCall & Readonly<{
    chainId: number;
    to: string;
}>;
export type ConfidentialBestQuoteWithCandidatesTransaction = ConfidentialBestQuoteWithCandidatesCall & Readonly<{
    chainId: number;
    to: string;
}>;
export type ConfidentialBestSwapWithCandidatesTransaction = ConfidentialBestSwapWithCandidatesCall & Readonly<{
    chainId: number;
    to: string;
}>;
export type ConfidentialBestExecutionEncryptionBinding = Readonly<{
    chainId: number;
    contractAddress: string;
    functionName: typeof CONFIDENTIAL_BEST_QUOTE_FUNCTION | typeof CONFIDENTIAL_BEST_QUOTE_WITH_CANDIDATES_FUNCTION | typeof CONFIDENTIAL_BEST_SWAP_FUNCTION | typeof CONFIDENTIAL_BEST_SWAP_WITH_CANDIDATES_FUNCTION;
    functionSelector: typeof CONFIDENTIAL_BEST_QUOTE_SELECTOR | typeof CONFIDENTIAL_BEST_QUOTE_WITH_CANDIDATES_SELECTOR | typeof CONFIDENTIAL_BEST_SWAP_SELECTOR | typeof CONFIDENTIAL_BEST_SWAP_WITH_CANDIDATES_SELECTOR;
}>;
export type ConfidentialBestExecutionOperation = "quote" | "quote-with-candidates" | "swap" | "swap-with-candidates";
export type ConfidentialBestExecutionResultExpectation = Readonly<{
    operation: ConfidentialBestExecutionOperation;
    caller: string;
    requestId: string;
    tokenIn: string;
    tokenOut: string;
    transactionHash: string;
    transactionData: string;
}>;
export type ConfidentialBestExecutionTransactionEvidence = Readonly<{
    chainId: number | bigint;
    hash: string;
    from: string;
    to: string;
    data: string;
}>;
export type ConfidentialBestExecutionLogEvidence = Readonly<{
    address: string;
    topics: readonly string[];
    data: string;
}>;
export type ConfidentialBestExecutionReceiptEvidence = Readonly<{
    transactionHash: string;
    status: number | bigint;
    logs: readonly ConfidentialBestExecutionLogEvidence[];
}>;
export interface ConfidentialBestExecutionDecryptionAdapter {
    readChainId(): Promise<number | bigint>;
    getTransaction(transactionHash: string): Promise<ConfidentialBestExecutionTransactionEvidence | null>;
    getTransactionReceipt(transactionHash: string): Promise<ConfidentialBestExecutionReceiptEvidence | null>;
    getCanonicalPool(factory: string, tokenIn: string, tokenOut: string, feeBps: number, initializationStrategy: string): Promise<string>;
    decryptValue256(value: Ciphertext256): Promise<bigint>;
}
/**
 * Builds the canonical paid best-quote call after the caller encrypts amountIn
 * for the router address and this function's selector with the COTI SDK.
 */
export declare function buildConfidentialBestQuoteCall(tokenIn: string, tokenOut: string, amountIn: InputText256, requestId: string, deadline: bigint): ConfidentialBestQuoteCall;
/**
 * Builds the atomic best-execution call after amountIn and minimumOut are each
 * freshly encrypted for the router address and this function's selector.
 */
export declare function buildConfidentialBestSwapCall(tokenIn: string, tokenOut: string, amountIn: InputText256, minimumOut: InputText256, requestId: string, deadline: bigint): ConfidentialBestSwapCall;
export declare function buildConfidentialBestQuoteWithCandidatesCall(tokenIn: string, tokenOut: string, amountIn: InputText256, candidateBitmap: number, requestId: string, deadline: bigint): ConfidentialBestQuoteWithCandidatesCall;
export declare function buildConfidentialBestSwapWithCandidatesCall(tokenIn: string, tokenOut: string, amountIn: InputText256, minimumOut: InputText256, candidateBitmap: number, requestId: string, deadline: bigint): ConfidentialBestSwapWithCandidatesCall;
/**
 * Returns the exact router/function binding required by COTI encryptValue256.
 * Quote inputs and swap inputs are not interchangeable because the function
 * selector is part of authenticated ciphertext validation.
 */
export declare function getConfidentialBestExecutionEncryptionBinding(router: VerifiedConfidentialBestExecutionRouter, operation: ConfidentialBestExecutionOperation): ConfidentialBestExecutionEncryptionBinding;
export declare function buildVerifiedConfidentialBestQuoteTransaction(router: VerifiedConfidentialBestExecutionRouter, tokenIn: string, tokenOut: string, amountIn: InputText256, requestId: string, deadline: bigint): ConfidentialBestQuoteTransaction;
export declare function buildVerifiedConfidentialBestSwapTransaction(router: VerifiedConfidentialBestExecutionRouter, tokenIn: string, tokenOut: string, amountIn: InputText256, minimumOut: InputText256, requestId: string, deadline: bigint): ConfidentialBestSwapTransaction;
export declare function buildVerifiedConfidentialBestQuoteWithCandidatesTransaction(router: VerifiedConfidentialBestExecutionRouter, tokenIn: string, tokenOut: string, amountIn: InputText256, candidateBitmap: number, requestId: string, deadline: bigint): ConfidentialBestQuoteWithCandidatesTransaction;
export declare function buildVerifiedConfidentialBestSwapWithCandidatesTransaction(router: VerifiedConfidentialBestExecutionRouter, tokenIn: string, tokenOut: string, amountIn: InputText256, minimumOut: InputText256, candidateBitmap: number, requestId: string, deadline: bigint): ConfidentialBestSwapWithCandidatesTransaction;
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
export declare function getCipherDEXV1FeePolicy(totalFeeBps: number): CipherDEXV1FeePolicy;
export declare function calculateCipherDEXV1FeeBreakdown(amountIn: bigint, totalFeeBps: number): CipherDEXFeeBreakdown;
export declare function minimumCipherDEXV1ConfidentialInput(totalFeeBps: number): bigint;
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
    initializationStrategy: string;
    strategyClass: number;
    poolClass: "standard" | "launch-protected";
    initialized: boolean;
    poolKind: "private-erc20-cpmm-v3";
    quoteTransport: typeof CONFIDENTIAL_QUOTE_TRANSPORT.TRANSACTION_EVENT;
};
declare const VERIFIED_CONFIDENTIAL_POOL_DISCOVERY: unique symbol;
export type VerifiedConfidentialPoolDiscovery = Readonly<ConfidentialPoolDiscovery & {
    chainId: number;
    factory: string;
    readonly [VERIFIED_CONFIDENTIAL_POOL_DISCOVERY]: true;
}>;
export type ConfidentialPoolOnchainState = {
    protocolVersion: number | bigint;
    privacyMode: number | bigint;
    token0: string;
    token1: string;
    token0Decimals: number | bigint;
    token1Decimals: number | bigint;
    feeBps: number | bigint;
    feeVault: string;
    lpToken: string;
    initializationStrategy: string;
    initialized: boolean;
};
/**
 * Minimal dependency-free RPC boundary required to prove pool provenance.
 * Implementations should issue ordinary read-only calls through ethers, viem,
 * or another reviewed client.
 */
export interface ConfidentialPoolVerificationAdapter {
    readChainId(): Promise<number | bigint>;
    getCode(address: string): Promise<string>;
    readFactoryProtocolVersion(factory: string): Promise<number | bigint>;
    readFactoryLPTokenFactory(factory: string): Promise<string>;
    readFactoryLPTokenFactoryRuntimeCodehash(factory: string): Promise<string>;
    hashRuntimeCode(code: string): string;
    isLPTokenIssued(lpTokenFactory: string, pool: string, lpToken: string, issuer: string): Promise<boolean>;
    isFactoryPrivateTokenCompatible(factory: string, token: string): Promise<boolean>;
    isFactoryPool(factory: string, pool: string): Promise<boolean>;
    readFactoryInitializationStrategyClass(factory: string, strategy: string): Promise<number | bigint>;
    readFactoryInitializationStrategyRuntimeCodehash(factory: string, strategy: string): Promise<string>;
    getCanonicalPool(factory: string, discovery: ConfidentialPoolDiscovery): Promise<string>;
    readPoolState(pool: string): Promise<ConfidentialPoolOnchainState>;
}
export type ConfidentialPoolVerificationPolicy = {
    expectedChainId: number;
    expectedFactory: string;
    expectedFeeVault: string;
    expectedProtocolVersion: number;
    expectedLPTokenFactory: string;
    expectedLPTokenFactoryRuntimeCodehash: string;
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
declare const VERIFIED_PUBLIC_POOL_DISCOVERY: unique symbol;
export type VerifiedPublicPoolDiscovery = Readonly<PublicPoolDiscovery & {
    chainId: number;
    factory: string;
    readonly [VERIFIED_PUBLIC_POOL_DISCOVERY]: true;
}>;
export type PublicPoolOnchainState = Omit<ConfidentialPoolOnchainState, "lpToken" | "initializationStrategy" | "initialized">;
export interface PublicPoolVerificationAdapter {
    readChainId(): Promise<number | bigint>;
    getCode(address: string): Promise<string>;
    readFactoryProtocolVersion(factory: string): Promise<number | bigint>;
    isFactoryPool(factory: string, pool: string): Promise<boolean>;
    getCanonicalPool(factory: string, discovery: PublicPoolDiscovery): Promise<string>;
    readPoolState(pool: string): Promise<PublicPoolOnchainState>;
}
export type PublicPoolVerificationPolicy = {
    expectedChainId: number;
    expectedFactory: string;
    expectedFeeVault: string;
    expectedProtocolVersion: number;
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
    launchId: string;
    launchCommitmentHash: string;
    initializationStrategy: string;
    creator: string;
    pool: string;
    disposition: typeof LP_DISPOSITION[keyof typeof LP_DISPOSITION];
    lockId: string;
    unlockTime: bigint | string;
};
export type ConfidentialLockOnchainState = Readonly<{
    owner: string;
    unlockTime: number | bigint;
    permanent: boolean;
    released: boolean;
}>;
export type LaunchpadMigrationVerificationPolicy = Readonly<{
    expectedChainId: number;
    expectedFactory: string;
    expectedFactoryRuntimeCodehash: string;
    expectedMigrator: string;
    expectedMigratorRuntimeCodehash: string;
    expectedInitializationStrategy: string;
    expectedInitializationStrategyRuntimeCodehash: string;
    expectedFeeVault: string;
    expectedFactoryProtocolVersion: number;
    expectedPoolProtocolVersion: number;
    expectedMigratorProtocolVersion: number;
}>;
export type LaunchpadMigrationEvidenceExpectation = Readonly<{
    transactionHash: string;
    metadata: LaunchpadMigrationMetadata;
}>;
export interface LaunchpadMigrationVerificationAdapter {
    readChainId(): Promise<number | bigint>;
    getCode(address: string): Promise<string>;
    hashRuntimeCode(code: string): string;
    getTransaction(transactionHash: string): Promise<ConfidentialBestExecutionTransactionEvidence | null>;
    getTransactionReceipt(transactionHash: string): Promise<ConfidentialBestExecutionReceiptEvidence | null>;
    readFactoryProtocolVersion(factory: string): Promise<number | bigint>;
    readInitializationStrategyMigrator(strategy: string): Promise<string>;
    readInitializationStrategyMigratorRuntimeCodehash(strategy: string): Promise<string>;
    isFactoryPool(factory: string, pool: string): Promise<boolean>;
    readMigratorProtocolVersion(migrator: string): Promise<number | bigint>;
    readMigratorFactory(migrator: string): Promise<string>;
    readMigratorInitializationStrategy(migrator: string): Promise<string>;
    readFactoryInitializationStrategyClass(factory: string, strategy: string): Promise<number | bigint>;
    readFactoryInitializationStrategyRuntimeCodehash(factory: string, strategy: string): Promise<string>;
    readPoolState(pool: string): Promise<ConfidentialPoolOnchainState>;
    getCanonicalPool(factory: string, token0: string, token1: string, token0Decimals: number, token1Decimals: number, feeBps: number, initializationStrategy: string): Promise<string>;
    readLockInfo(pool: string, lockId: string): Promise<ConfidentialLockOnchainState>;
}
declare const VERIFIED_LAUNCHPAD_MIGRATION_METADATA: unique symbol;
export type VerifiedLaunchpadMigrationMetadata = Readonly<LaunchpadMigrationMetadata & {
    chainId: number;
    transactionHash: string;
    factory: string;
    migrator: string;
    readonly [VERIFIED_LAUNCHPAD_MIGRATION_METADATA]: true;
}>;
export declare function isConfidentialPoolDiscovery(value: unknown): value is ConfidentialPoolDiscovery;
export declare const isConfidentialPoolDiscoveryShape: typeof isConfidentialPoolDiscovery;
/**
 * Binds a router address to deployed code, the expected protocol versions and
 * the confidential factory's one-time canonical router configuration.
 */
export declare function verifyConfidentialBestExecutionRouter(router: string, policy: ConfidentialBestExecutionRouterVerificationPolicy, adapter: ConfidentialBestExecutionRouterVerificationAdapter): Promise<VerifiedConfidentialBestExecutionRouter>;
/**
 * Decrypts one caller-encrypted result only after authenticating the submitted
 * transaction, successful receipt, exact router event and canonical pool.
 */
export declare function decryptConfidentialBestExecutionResult(router: VerifiedConfidentialBestExecutionRouter, expectation: ConfidentialBestExecutionResultExpectation, adapter: ConfidentialBestExecutionDecryptionAdapter): Promise<bigint>;
/**
 * Converts untrusted discovery metadata into a process-local verified value.
 * Verification binds the candidate to an expected deployed factory, its
 * canonical key, immutable pool metadata, fee vault, and protocol version.
 */
export declare function verifyConfidentialPoolDiscovery(value: unknown, policy: ConfidentialPoolVerificationPolicy, adapter: ConfidentialPoolVerificationAdapter): Promise<VerifiedConfidentialPoolDiscovery>;
export declare function isPublicPoolDiscovery(value: unknown): value is PublicPoolDiscovery;
export declare const isPublicPoolDiscoveryShape: typeof isPublicPoolDiscovery;
/**
 * Converts untrusted public-market metadata into a process-local value bound
 * to the expected canonical factory, fee vault, protocol and immutable pool
 * state. Shape validation alone is not provenance validation.
 */
export declare function verifyPublicPoolDiscovery(value: unknown, policy: PublicPoolVerificationPolicy, adapter: PublicPoolVerificationAdapter): Promise<VerifiedPublicPoolDiscovery>;
export declare function isConfidentialLockDiscoveryShape(value: unknown): value is ConfidentialLockDiscovery;
export declare function isConfidentialLockDiscovery(value: unknown): value is ConfidentialLockDiscovery;
export declare const isConfidentialLockMetadata: typeof isConfidentialLockDiscovery;
export declare function isLaunchpadMigrationMetadataShape(value: unknown): value is LaunchpadMigrationMetadata;
export declare function isLaunchpadMigrationMetadata(value: unknown): value is LaunchpadMigrationMetadata;
/**
 * Authenticates launchpad migration metadata against one successful RPC receipt,
 * the configured factory/migrator binding, the canonical pool and current lock
 * state. The adapter is the explicit chain-data trust boundary.
 */
export declare function verifyLaunchpadMigrationMetadata(expectation: LaunchpadMigrationEvidenceExpectation, policy: LaunchpadMigrationVerificationPolicy, adapter: LaunchpadMigrationVerificationAdapter): Promise<VerifiedLaunchpadMigrationMetadata>;
export declare function isVerifiedLaunchpadMigrationMetadata(value: unknown): value is VerifiedLaunchpadMigrationMetadata;
export {};
