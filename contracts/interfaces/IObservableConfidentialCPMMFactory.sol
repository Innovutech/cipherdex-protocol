// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@coti-io/coti-contracts/contracts/utils/mpc/MpcCore.sol";

interface IObservableConfidentialCPMMFactory {
    event PoolCreated(
        address indexed token0,
        address indexed token1,
        uint8 token0Decimals,
        uint8 token1Decimals,
        uint256 feeBps,
        address initializationStrategy,
        address pool
    );
    event PrivateLPTokenCreated(address indexed pool, address indexed token);
    event BestExecutionRouterConfigured(address indexed router);

    function PROTOCOL_VERSION() external view returns (uint256);
    function PRIVACY_MODE() external view returns (uint8);
    function feeVault() external view returns (address);
    function lpTokenFactory() external view returns (address);
    function poolDeployer() external view returns (address);
    function poolDeployerRuntimeCodehash() external view returns (bytes32);
    function bootstrapConfigurator() external view returns (address);
    function bestExecutionRouter() external view returns (address);
    function BEST_EXECUTION_ROUTER_RUNTIME_CODEHASH() external view returns (bytes32);
    function initializationStrategyRegistry() external view returns (address);
    function initializationStrategyRegistryRuntimeCodehash() external view returns (bytes32);
    function initializationStrategyRegistryFinalized() external view returns (bool);
    function initializationStrategiesLength() external view returns (uint256);
    function initializationStrategyAt(uint8 classIndex) external view returns (address);
    function initializationStrategyClass(address strategy) external view returns (uint8);
    function initializationStrategyRuntimeCodehash(address strategy) external view returns (bytes32);
    function initializationStrategyRegistration(address strategy) external view returns (bytes32);
    function getPool(bytes32 key) external view returns (address);
    function isPool(address pool) external view returns (bool);
    function isCompatiblePrivateToken(address token) external view returns (bool);
    function createPool(
        address tokenA,
        address tokenB,
        uint8 decimalsA,
        uint8 decimalsB,
        uint256 feeBps
    ) external returns (address pool);
    function getOrCreatePoolForCommitment(
        address tokenA,
        address tokenB,
        uint8 decimalsA,
        uint8 decimalsB,
        uint256 feeBps
    ) external returns (address pool);
    function setBestExecutionRouter(address router) external;
    function poolKey(
        address token0,
        address token1,
        uint8 decimals0,
        uint8 decimals1,
        uint256 feeBps,
        address initializationStrategy
    ) external pure returns (bytes32);
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
    ) external returns (ctUint256 memory mintedShares);
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
    ) external returns (ctUint256 memory mintedShares, bytes32 lockId);
    function allPoolsLength() external view returns (uint256);
    function allPools(uint256 index) external view returns (address);
}
