// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./CipherDEXFeePolicy.sol";
import "./interfaces/IObservableConfidentialCPMM.sol";
import "./interfaces/IObservableConfidentialCPMMDeployer.sol";
import "./interfaces/IObservableConfidentialCPMMFactory.sol";
import "./interfaces/IConfidentialBestExecution.sol";
import "./interfaces/IObservableConfidentialInitializationStrategy.sol";
import "./interfaces/IObservableConfidentialInitializationStrategyRegistry.sol";
import "./interfaces/IPrivateLPTokenFactory.sol";
import "./interfaces/IConfidentialFeeVault.sol";
import "./libraries/PrivateTokenCompatibility.sol";

/**
 * @title ObservableConfidentialCPMMFactory
 * @notice Deterministic factory for delayed-price confidential pools.
 */
contract ObservableConfidentialCPMMFactory is
    IObservableConfidentialCPMMFactory,
    CipherDEXFeePolicy
{
    uint256 public constant PROTOCOL_VERSION = 1;
    uint8 public constant PRIVACY_MODE = 2;
    bytes32 public constant PRIVATE_LP_TOKEN_FACTORY_RUNTIME_CODEHASH =
        hex"9c796ceca64fdb8f1b780ed50588dfce7d75b5674ef5faa06bc1d5d4f063a0de";
    bytes32 public constant BEST_EXECUTION_ROUTER_RUNTIME_CODEHASH =
        hex"edc7d19bbe720d6e1265e935ee9a30f3dc68b07f94821ea12b715fba43b9e46e";

    mapping(bytes32 => address) public getPool;
    mapping(address => bool) public isPool;
    address[] private pools;

    address public immutable lpTokenFactory;
    address public immutable poolDeployer;
    bytes32 public immutable poolDeployerRuntimeCodehash;
    address public immutable feeVault;
    address public immutable initializationStrategyRegistry;
    bytes32 public immutable initializationStrategyRegistryRuntimeCodehash;
    address public immutable bootstrapConfigurator;
    address public bestExecutionRouter;

    error InvalidTokenPair();
    error InvalidFee();
    error InvalidFeeVault();
    error InvalidLPTokenFactory();
    error InvalidPoolDeployer();
    error InvalidInitializationStrategyRegistry();
    error UnsupportedPrivateToken();
    error InvalidTokenDecimals();
    error PoolAlreadyExists();
    error UnknownPool();
    error BestExecutionRouterUnauthorized();
    error BestExecutionRouterAlreadyConfigured();
    error InvalidBestExecutionRouter();
    error PoolAlreadyInitialized();
    error InitializationStrategyRegistryNotFinalized();
    error InitializationStrategyUnauthorized();
    error InvalidCanonicalPool();
    error InvalidInitialPriceReference();

    constructor(
        address feeVault_,
        address lpTokenFactory_,
        address poolDeployer_,
        bytes32 poolDeployerCodehash_,
        address initializationStrategyRegistry_,
        bytes32 initializationStrategyRegistryCodehash_
    ) {
        if (feeVault_.code.length == 0) revert InvalidFeeVault();
        if (lpTokenFactory_.codehash != PRIVATE_LP_TOKEN_FACTORY_RUNTIME_CODEHASH) {
            revert InvalidLPTokenFactory();
        }
        if (
            poolDeployer_.code.length == 0 ||
            poolDeployerCodehash_ == bytes32(0) ||
            poolDeployer_.codehash != poolDeployerCodehash_ ||
            IObservableConfidentialCPMMDeployer(poolDeployer_)
                .DEPLOYER_VERSION() != 1
        ) revert InvalidPoolDeployer();
        if (
            initializationStrategyRegistry_.code.length == 0 ||
            initializationStrategyRegistryCodehash_ == bytes32(0) ||
            initializationStrategyRegistry_.codehash !=
                initializationStrategyRegistryCodehash_ ||
            IObservableConfidentialInitializationStrategyRegistry(
                initializationStrategyRegistry_
            ).REGISTRY_VERSION() != 1
        ) revert InvalidInitializationStrategyRegistry();
        bootstrapConfigurator = msg.sender;
        lpTokenFactory = lpTokenFactory_;
        poolDeployer = poolDeployer_;
        poolDeployerRuntimeCodehash = poolDeployerCodehash_;
        feeVault = feeVault_;
        initializationStrategyRegistry = initializationStrategyRegistry_;
        initializationStrategyRegistryRuntimeCodehash =
            initializationStrategyRegistryCodehash_;
    }

    function setBestExecutionRouter(address router) external {
        if (msg.sender != bootstrapConfigurator) {
            revert BestExecutionRouterUnauthorized();
        }
        if (!initializationStrategyRegistryFinalized()) {
            revert InitializationStrategyRegistryNotFinalized();
        }
        if (bestExecutionRouter != address(0)) {
            revert BestExecutionRouterAlreadyConfigured();
        }
        if (
            router.codehash != BEST_EXECUTION_ROUTER_RUNTIME_CODEHASH ||
            IConfidentialBestExecutionRouter(router).factory() != address(this) ||
            IConfidentialBestExecutionRouter(router).PROTOCOL_VERSION() != 1
        ) revert InvalidBestExecutionRouter();
        bestExecutionRouter = router;
        emit BestExecutionRouterConfigured(router);
    }

    function createPool(
        address tokenA,
        address tokenB,
        uint8 decimalsA,
        uint8 decimalsB,
        uint256 feeBps
    ) external returns (address pool) {
        (address token0, address token1, uint8 decimals0, uint8 decimals1) =
            _validateAndSortPool(tokenA, tokenB, decimalsA, decimalsB, feeBps);
        bytes32 key = poolKey(
            token0,
            token1,
            decimals0,
            decimals1,
            feeBps,
            address(0)
        );
        if (getPool[key] != address(0)) revert PoolAlreadyExists();
        pool = _deployPool(
            key,
            token0,
            token1,
            decimals0,
            decimals1,
            feeBps,
            address(0)
        );
        getPool[key] = pool;
    }

    function getOrCreatePoolForCommitment(
        address tokenA,
        address tokenB,
        uint8 decimalsA,
        uint8 decimalsB,
        uint256 feeBps
    ) external returns (address pool) {
        _requireRegisteredStrategy(msg.sender);
        (address token0, address token1, uint8 decimals0, uint8 decimals1) =
            _validateAndSortPool(tokenA, tokenB, decimalsA, decimalsB, feeBps);
        bytes32 key = poolKey(
            token0,
            token1,
            decimals0,
            decimals1,
            feeBps,
            msg.sender
        );
        pool = getPool[key];
        if (pool == address(0)) {
            pool = _deployPool(
                key,
                token0,
                token1,
                decimals0,
                decimals1,
                feeBps,
                msg.sender
            );
            getPool[key] = pool;
        } else {
            _requireCanonicalPoolMetadata(
                pool,
                key,
                token0,
                token1,
                decimals0,
                decimals1,
                feeBps,
                msg.sender
            );
            if (IObservableConfidentialCPMM(pool).initialized()) {
                revert PoolAlreadyInitialized();
            }
        }
    }

    function _validateAndSortPool(
        address tokenA,
        address tokenB,
        uint8 decimalsA,
        uint8 decimalsB,
        uint256 feeBps
    ) internal view returns (
        address token0,
        address token1,
        uint8 decimals0,
        uint8 decimals1
    ) {
        if (tokenA == address(0) || tokenB == address(0) || tokenA == tokenB) {
            revert InvalidTokenPair();
        }
        if (!isApprovedFeeTier(feeBps)) revert InvalidFee();
        if (
            !PrivateTokenCompatibility.supportsPrivateToken(tokenA) ||
            !PrivateTokenCompatibility.supportsPrivateToken(tokenB)
        ) revert UnsupportedPrivateToken();
        (bool validDecimalsA, uint8 actualDecimalsA) =
            PrivateTokenCompatibility.tryReadDecimals(tokenA);
        (bool validDecimalsB, uint8 actualDecimalsB) =
            PrivateTokenCompatibility.tryReadDecimals(tokenB);
        if (
            !validDecimalsA ||
            !validDecimalsB ||
            actualDecimalsA != decimalsA ||
            actualDecimalsB != decimalsB
        ) revert InvalidTokenDecimals();
        return tokenA < tokenB
            ? (tokenA, tokenB, decimalsA, decimalsB)
            : (tokenB, tokenA, decimalsB, decimalsA);
    }

    function _deployPool(
        bytes32 key,
        address token0,
        address token1,
        uint8 decimals0,
        uint8 decimals1,
        uint256 feeBps,
        address initializationStrategy
    ) internal returns (address pool) {
        if (IConfidentialFeeVault(feeVault).confidentialFactory() != address(this)) {
            revert InvalidFeeVault();
        }
        if (
            poolDeployer.codehash != poolDeployerRuntimeCodehash ||
            IObservableConfidentialCPMMDeployer(poolDeployer).factory() !=
                address(this)
        ) revert InvalidPoolDeployer();
        pool = IObservableConfidentialCPMMDeployer(poolDeployer).deployPool(
            key,
            token0,
            token1,
            decimals0,
            decimals1,
            feeBps,
            feeVault,
            initializationStrategy
        );
        isPool[pool] = true;
        address lpTokenAddress = IPrivateLPTokenFactory(lpTokenFactory).create(pool);
        IObservableConfidentialCPMM(pool).initializeLPToken(lpTokenAddress);
        pools.push(pool);
        emit PoolCreated(
            token0,
            token1,
            decimals0,
            decimals1,
            feeBps,
            initializationStrategy,
            pool
        );
        emit PrivateLPTokenCreated(pool, lpTokenAddress);
    }

    function poolKey(
        address token0,
        address token1,
        uint8,
        uint8,
        uint256 feeBps,
        address initializationStrategy
    ) public pure returns (bytes32) {
        (address first, address second) = token0 < token1
            ? (token0, token1)
            : (token1, token0);
        return keccak256(
            abi.encode(
                first,
                second,
                feeBps,
                PRIVACY_MODE,
                PROTOCOL_VERSION,
                initializationStrategy
            )
        );
    }

    function bootstrapPool(
        address initializationStrategy,
        bytes32 launchId,
        bytes32 authorizationHash,
        address pool,
        address provider,
        uint256 amount0,
        uint256 amount1,
        uint256 minShares,
        uint256 minPriceX18,
        uint256 maxPriceX18,
        uint256 initialPriceReferenceX18
    ) external returns (ctUint256 memory mintedShares) {
        if (initialPriceReferenceX18 == 0) revert InvalidInitialPriceReference();
        _authorizeProtectedBootstrap(
            initializationStrategy,
            launchId,
            authorizationHash,
            pool,
            provider,
            initialPriceReferenceX18
        );
        return IObservableConfidentialCPMM(pool).bootstrapLiquidity(
            provider,
            msg.sender,
            amount0,
            amount1,
            minShares,
            minPriceX18,
            maxPriceX18,
            initialPriceReferenceX18
        );
    }

    function bootstrapPoolWithDisposition(
        address initializationStrategy,
        bytes32 launchId,
        bytes32 authorizationHash,
        address pool,
        address provider,
        uint256 amount0,
        uint256 amount1,
        uint256 minShares,
        uint256 minPriceX18,
        uint256 maxPriceX18,
        uint256 initialPriceReferenceX18,
        uint8 disposition,
        uint64 unlockTime
    ) external returns (ctUint256 memory mintedShares, bytes32 lockId) {
        if (initialPriceReferenceX18 == 0) revert InvalidInitialPriceReference();
        _authorizeProtectedBootstrap(
            initializationStrategy,
            launchId,
            authorizationHash,
            pool,
            provider,
            initialPriceReferenceX18
        );
        return IObservableConfidentialCPMM(pool).bootstrapLiquidityWithDisposition(
            provider,
            msg.sender,
            amount0,
            amount1,
            minShares,
            minPriceX18,
            maxPriceX18,
            initialPriceReferenceX18,
            disposition,
            unlockTime
        );
    }

    function _authorizeProtectedBootstrap(
        address initializationStrategy,
        bytes32 launchId,
        bytes32 authorizationHash,
        address pool,
        address provider,
        uint256 initialPriceReferenceX18
    ) internal {
        _requireRegisteredStrategy(initializationStrategy);
        IObservableConfidentialInitializationStrategy strategy =
            IObservableConfidentialInitializationStrategy(initializationStrategy);
        if (
            strategy.migrator() != msg.sender ||
            strategy.migratorRuntimeCodehash() == bytes32(0) ||
            msg.sender.codehash != strategy.migratorRuntimeCodehash()
        ) {
            revert InitializationStrategyUnauthorized();
        }
        bytes32 expectedKey = strategy.authorizeInitialization(
            launchId,
            msg.sender,
            pool,
            provider,
            authorizationHash,
            initialPriceReferenceX18
        );
        _requireCanonicalProtectedPool(pool, initializationStrategy, expectedKey);
    }

    function _requireCanonicalPoolMetadata(
        address pool,
        bytes32 expectedKey,
        address token0,
        address token1,
        uint8 decimals0,
        uint8 decimals1,
        uint256 feeBps,
        address initializationStrategy
    ) internal view {
        if (!isPool[pool] || pool.code.length == 0 || getPool[expectedKey] != pool) {
            revert InvalidCanonicalPool();
        }
        IObservableConfidentialCPMM candidate =
            IObservableConfidentialCPMM(pool);
        if (
            candidate.PROTOCOL_VERSION() != PROTOCOL_VERSION ||
            candidate.PRIVACY_MODE() != PRIVACY_MODE ||
            candidate.token0() != token0 ||
            candidate.token1() != token1 ||
            candidate.token0Decimals() != decimals0 ||
            candidate.token1Decimals() != decimals1 ||
            candidate.feeBps() != feeBps ||
            candidate.initializationStrategy() != initializationStrategy
        ) revert InvalidCanonicalPool();
    }

    function _requireCanonicalProtectedPool(
        address pool,
        address initializationStrategy,
        bytes32 expectedKey
    ) internal view {
        if (!isPool[pool] || pool.code.length == 0) revert UnknownPool();
        IObservableConfidentialCPMM candidate =
            IObservableConfidentialCPMM(pool);
        bytes32 actualKey = poolKey(
            candidate.token0(),
            candidate.token1(),
            candidate.token0Decimals(),
            candidate.token1Decimals(),
            candidate.feeBps(),
            initializationStrategy
        );
        if (
            expectedKey != actualKey ||
            getPool[actualKey] != pool ||
            candidate.PROTOCOL_VERSION() != PROTOCOL_VERSION ||
            candidate.PRIVACY_MODE() != PRIVACY_MODE ||
            candidate.initializationStrategy() != initializationStrategy ||
            candidate.initialized()
        ) revert InvalidCanonicalPool();
    }

    function _registry()
        internal
        view
        returns (IObservableConfidentialInitializationStrategyRegistry registry)
    {
        if (
            initializationStrategyRegistry.codehash !=
            initializationStrategyRegistryRuntimeCodehash
        ) revert InvalidInitializationStrategyRegistry();
        registry = IObservableConfidentialInitializationStrategyRegistry(
            initializationStrategyRegistry
        );
        if (registry.factory() != address(this)) {
            revert InvalidInitializationStrategyRegistry();
        }
    }

    function _requireRegisteredStrategy(address strategy) internal view {
        if (!_registry().isRegisteredStrategy(strategy)) {
            revert InitializationStrategyUnauthorized();
        }
    }

    function initializationStrategyRegistryFinalized()
        public
        view
        returns (bool)
    {
        return _registry().finalized();
    }

    function initializationStrategiesLength() external view returns (uint256) {
        return _registry().initializationStrategiesLength();
    }

    function initializationStrategyAt(
        uint8 classIndex
    ) external view returns (address) {
        return _registry().initializationStrategyAt(classIndex);
    }

    function initializationStrategyClass(
        address strategy
    ) external view returns (uint8) {
        return _registry().initializationStrategyClass(strategy);
    }

    function initializationStrategyRuntimeCodehash(
        address strategy
    ) external view returns (bytes32) {
        return _registry().initializationStrategyRuntimeCodehash(strategy);
    }

    function initializationStrategyRegistration(
        address strategy
    ) external view returns (bytes32) {
        return _registry().initializationStrategyRegistration(strategy);
    }

    function allPoolsLength() external view returns (uint256) {
        return pools.length;
    }

    function allPools(uint256 index) external view returns (address) {
        return pools[index];
    }

    function isCompatiblePrivateToken(address token) external view returns (bool) {
        return PrivateTokenCompatibility.isCompatible(token);
    }
}
