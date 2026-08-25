// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IPublicCPMMFactory {
    event PoolCreated(
        address indexed token0,
        address indexed token1,
        uint8 token0Decimals,
        uint8 token1Decimals,
        uint256 feeBps,
        address lpToken,
        address pool
    );

    function PROTOCOL_VERSION() external view returns (uint256);
    function feeVault() external view returns (address);
    function lpTokenFactory() external view returns (address);
    function isApprovedFeeTier(uint256) external pure returns (bool);
    function getPool(bytes32) external view returns (address);
    function isPool(address) external view returns (bool);
    function createPool(address,address,uint8,uint8,uint256) external returns (address);
    function poolKey(address,address,uint8,uint8,uint256) external pure returns (bytes32);
    function allPoolsLength() external view returns (uint256);
    function allPools(uint256) external view returns (address);
}
