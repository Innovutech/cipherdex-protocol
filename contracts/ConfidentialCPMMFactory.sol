// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./CipherDEXFeePolicy.sol";
import "./interfaces/IConfidentialCPMM.sol";
import "./interfaces/IConfidentialCPMMDeployer.sol";
import "./interfaces/IConfidentialCPMMFactory.sol";
import "./interfaces/IConfidentialBestExecution.sol";
import "./interfaces/IConfidentialInitializationStrategy.sol";
import "./interfaces/IConfidentialInitializationStrategyRegistry.sol";
import "./interfaces/IPrivateLPTokenFactory.sol";
import "./interfaces/IConfidentialFeeVault.sol";

/**
 * @title ConfidentialCPMMFactory
 * @notice Deterministic factory whose canonical key includes initialization policy.
 */
contract ConfidentialCPMMFactory is IConfidentialCPMMFactory, CipherDEXFeePolicy {
    uint256 public constant PROTOCOL_VERSION = 3;
    uint8 public constant PRIVACY_MODE = 1;
    bytes32 public constant PRIVATE_LP_TOKEN_FACTORY_RUNTIME_CODEHASH =
        hex"9c796ceca64fdb8f1b780ed50588dfce7d75b5674ef5faa06bc1d5d4f063a0de";
    bytes32 public constant BEST_EXECUTION_ROUTER_RUNTIME_CODEHASH =
        hex"f8f712e62c5d0dd59498ab1f09891ac023b25f9295ccbc3750ea1eccab8e5ac9";

    mapping(bytes32 => address) public getPool;
    mapping(address => bool) public isPool;
    mapping(bytes32 => bool) public isApprovedPrivateTokenCodehash;
    bytes32[] private approvedPrivateTokenCodehashes;
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
    error InvalidPrivateTokenCodehash();
    error InvalidInitializationStrategyRegistry();
    error UnsupportedPrivateTokenImplementation();
    error PoolAlreadyExists();
    error UnknownPool();
    error BestExecutionRouterUnauthorized();
    error BestExecutionRouterAlreadyConfigured();
    error InvalidBestExecutionRouter();
    error PoolAlreadyInitialized();
    error InitializationStrategyRegistryNotFinalized();
    error InitializationStrategyUnauthorized();
    error InvalidCanonicalPool();

    constructor(
        address feeVault_,
        address lpTokenFactory_,
        address poolDeployer_,
        bytes32 poolDeployerCodehash_,
        bytes32[] memory privateTokenCodehashes_,
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
            IConfidentialCPMMDeployer(poolDeployer_).DEPLOYER_VERSION() != 1
        ) revert InvalidPoolDeployer();
        if (privateTokenCodehashes_.length == 0) {
            revert InvalidPrivateTokenCodehash();
        }
        if (
            initializationStrategyRegistry_.code.length == 0 ||
            initializationStrategyRegistryCodehash_ == bytes32(0) ||
            initializationStrategyRegistry_.codehash !=
                initializationStrategyRegistryCodehash_ ||
            IConfidentialInitializationStrategyRegistry(
                initializationStrategyRegistry_
            ).REGISTRY_VERSION() != 1
        ) revert InvalidInitializationStrategyRegistry();
        for (uint256 index = 0; index < privateTokenCodehashes_.length; index++) {
            bytes32 codehash = privateTokenCodehashes_[index];
            if (codehash == bytes32(0)) revert InvalidPrivateTokenCodehash();
            if (!isApprovedPrivateTokenCodehash[codehash]) {
                isApprovedPrivateTokenCodehash[codehash] = true;
                approvedPrivateTokenCodehashes.push(codehash);
            }
        }
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
            IConfidentialBestExecutionRouter(router).PROTOCOL_VERSION() != 2
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
            if (IConfidentialCPMM(pool).initialized()) {
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
            !isApprovedPrivateTokenCodehash[tokenA.codehash] ||
            !isApprovedPrivateTokenCodehash[tokenB.codehash]
        ) revert UnsupportedPrivateTokenImplementation();
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
            IConfidentialCPMMDeployer(poolDeployer).factory() != address(this)
        ) revert InvalidPoolDeployer();
        pool = IConfidentialCPMMDeployer(poolDeployer).deployPool(
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
        IConfidentialCPMM(pool).initializeLPToken(lpTokenAddress);
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
        bytes32 launchCommitmentHash,
        address pool,
        address provider,
        uint256 amount0,
        uint256 amount1,
        uint256 minShares,
        uint256 minPriceX18,
        uint256 maxPriceX18
    ) external returns (ctUint256 memory mintedShares) {
        _authorizeProtectedBootstrap(
            initializationStrategy,
            launchId,
            launchCommitmentHash,
            pool,
            provider
        );
        return IConfidentialCPMM(pool).bootstrapLiquidity(
            provider,
            msg.sender,
            amount0,
            amount1,
            minShares,
            minPriceX18,
            maxPriceX18
        );
    }

    function bootstrapPoolWithDisposition(
        address initializationStrategy,
        bytes32 launchId,
        bytes32 launchCommitmentHash,
        address pool,
        address provider,
        uint256 amount0,
        uint256 amount1,
        uint256 minShares,
        uint256 minPriceX18,
        uint256 maxPriceX18,
        uint8 disposition,
        uint64 unlockTime
    ) external returns (ctUint256 memory mintedShares, bytes32 lockId) {
        _authorizeProtectedBootstrap(
            initializationStrategy,
            launchId,
            launchCommitmentHash,
            pool,
            provider
        );
        return IConfidentialCPMM(pool).bootstrapLiquidityWithDisposition(
            provider,
            msg.sender,
            amount0,
            amount1,
            minShares,
            minPriceX18,
            maxPriceX18,
            disposition,
            unlockTime
        );
    }

    function _authorizeProtectedBootstrap(
        address initializationStrategy,
        bytes32 launchId,
        bytes32 launchCommitmentHash,
        address pool,
        address provider
    ) internal {
        _requireRegisteredStrategy(initializationStrategy);
        IConfidentialInitializationStrategy strategy =
            IConfidentialInitializationStrategy(initializationStrategy);
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
            launchCommitmentHash
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
        IConfidentialCPMM candidate = IConfidentialCPMM(pool);
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
        IConfidentialCPMM candidate = IConfidentialCPMM(pool);
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
        returns (IConfidentialInitializationStrategyRegistry registry)
    {
        if (
            initializationStrategyRegistry.codehash !=
            initializationStrategyRegistryRuntimeCodehash
        ) revert InvalidInitializationStrategyRegistry();
        registry = IConfidentialInitializationStrategyRegistry(
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

    function approvedPrivateTokenCodehashesLength() external view returns (uint256) {
        return approvedPrivateTokenCodehashes.length;
    }

    function approvedPrivateTokenCodehash(uint256 index) external view returns (bytes32) {
        return approvedPrivateTokenCodehashes[index];
    }

    function isApprovedPrivateToken(address token) external view returns (bool) {
        return
            token.code.length != 0 &&
            isApprovedPrivateTokenCodehash[token.codehash];
    }
}
