// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@coti-io/coti-contracts/contracts/utils/mpc/MpcCore.sol";

interface IConfidentialCPMMFactory {
    event PoolCreated(
        address indexed token0,
        address indexed token1,
        uint8 token0Decimals,
        uint8 token1Decimals,
        uint256 feeBps,
        address pool
    );
    event PrivateLPTokenCreated(address indexed pool, address indexed token);
    event BootstrapAdapterConfigured(address indexed adapter);

    function PROTOCOL_VERSION() external view returns (uint256);
    function feeVault() external view returns (address);
    function lpTokenFactory() external view returns (address);
    function bootstrapConfigurator() external view returns (address);
    function bootstrapAdapter() external view returns (address);
    function getPool(bytes32 key) external view returns (address);
    function isPool(address pool) external view returns (bool);
    function isApprovedPrivateTokenCodehash(bytes32 codehash) external view returns (bool);
    function isApprovedPrivateToken(address token) external view returns (bool);
    function approvedPrivateTokenCodehashesLength() external view returns (uint256);
    function approvedPrivateTokenCodehash(uint256 index) external view returns (bytes32);
    function createPool(
        address tokenA,
        address tokenB,
        uint8 decimalsA,
        uint8 decimalsB,
        uint256 feeBps
    ) external returns (address pool);
    function getOrCreatePoolForBootstrap(
        address tokenA,
        address tokenB,
        uint8 decimalsA,
        uint8 decimalsB,
        uint256 feeBps
    ) external returns (address pool);
    function setBootstrapAdapter(address adapter) external;
    function poolKey(
        address token0,
        address token1,
        uint8 decimals0,
        uint8 decimals1,
        uint256 feeBps
    ) external pure returns (bytes32);
    function bootstrapPool(
        address pool,
        address provider,
        uint256 amount0,
        uint256 amount1,
        uint256 minShares,
        uint256 minPriceX18,
        uint256 maxPriceX18
    ) external returns (ctUint256 memory mintedShares);
    function bootstrapPoolWithDisposition(
        address pool,
        address provider,
        uint256 amount0,
        uint256 amount1,
        uint256 minShares,
        uint256 minPriceX18,
        uint256 maxPriceX18,
        uint8 disposition,
        uint64 unlockTime
    ) external returns (ctUint256 memory mintedShares, bytes32 lockId);
    function allPoolsLength() external view returns (uint256);
    function allPools(uint256 index) external view returns (address);
}
