// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IConfidentialCPMMFactory {
    event PoolCreated(
        address indexed token0,
        address indexed token1,
        uint8 token0Decimals,
        uint8 token1Decimals,
        uint256 feeBps,
        address pool
    );

    function PROTOCOL_VERSION() external view returns (uint256);
    function getPool(bytes32 key) external view returns (address);
    function isPool(address pool) external view returns (bool);
    function createPool(
        address tokenA,
        address tokenB,
        uint8 decimalsA,
        uint8 decimalsB,
        uint256 feeBps
    ) external returns (address pool);
    function poolKey(
        address token0,
        address token1,
        uint8 decimals0,
        uint8 decimals1,
        uint256 feeBps
    ) external pure returns (bytes32);
    function allPoolsLength() external view returns (uint256);
    function allPools(uint256 index) external view returns (address);
}
