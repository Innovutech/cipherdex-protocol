// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./PublicCPMM.sol";
import "./CipherDEXFeePolicy.sol";

/**
 * @title PublicCPMMFactory
 * @notice Permissionless deterministic-key registry for public/public pools.
 */
contract PublicCPMMFactory is CipherDEXFeePolicy {
    uint256 public constant PROTOCOL_VERSION = 2;
    uint8 public constant PRIVACY_MODE = 0;

    mapping(bytes32 => address) public getPool;
    mapping(address => bool) public isPool;
    address[] public allPools;
    address public immutable feeVault;

    error InvalidTokenPair();
    error InvalidFee();
    error InvalidFeeVault();
    error PoolAlreadyExists();

    event PoolCreated(
        address indexed token0,
        address indexed token1,
        uint8 token0Decimals,
        uint8 token1Decimals,
        uint256 feeBps,
        address pool
    );

    constructor(address feeVault_) {
        if (feeVault_.code.length == 0) revert InvalidFeeVault();
        feeVault = feeVault_;
    }

    function createPool(
        address tokenA,
        address tokenB,
        uint8 decimalsA,
        uint8 decimalsB,
        uint256 feeBps
    ) external returns (address pool) {
        if (tokenA == address(0) || tokenB == address(0) || tokenA == tokenB) {
            revert InvalidTokenPair();
        }
        if (!isApprovedFeeTier(feeBps)) revert InvalidFee();
        (address token0, address token1, uint8 decimals0, uint8 decimals1) = tokenA < tokenB
            ? (tokenA, tokenB, decimalsA, decimalsB)
            : (tokenB, tokenA, decimalsB, decimalsA);
        bytes32 key = poolKey(token0, token1, decimals0, decimals1, feeBps);
        if (getPool[key] != address(0)) revert PoolAlreadyExists();

        pool = address(new PublicCPMM(
            token0,
            token1,
            decimals0,
            decimals1,
            feeBps,
            feeVault
        ));
        getPool[key] = pool;
        isPool[pool] = true;
        allPools.push(pool);
        emit PoolCreated(token0, token1, decimals0, decimals1, feeBps, pool);
    }

    function poolKey(
        address token0,
        address token1,
        uint8,
        uint8,
        uint256 feeBps
    ) public pure returns (bytes32) {
        return token0 < token1
            ? keccak256(abi.encode(token0, token1, feeBps, PRIVACY_MODE, PROTOCOL_VERSION))
            : keccak256(abi.encode(token1, token0, feeBps, PRIVACY_MODE, PROTOCOL_VERSION));
    }

    function allPoolsLength() external view returns (uint256) {
        return allPools.length;
    }
}
