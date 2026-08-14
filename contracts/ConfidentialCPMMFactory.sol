// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ConfidentialCPMM.sol";
import "./interfaces/IConfidentialCPMMFactory.sol";

/**
 * @title ConfidentialCPMMFactory
 * @notice Permissionless deterministic factory for immutable confidential pools.
 *
 * There is no owner, fee manager or withdrawal authority. The pool's fee and pair
 * are fixed in its constructor and the factory only records public pool identity.
 */
contract ConfidentialCPMMFactory is IConfidentialCPMMFactory {
    uint256 public constant PROTOCOL_VERSION = 1;
    mapping(bytes32 => address) public getPool;
    mapping(address => bool) public isPool;
    address[] private pools;

    error InvalidTokenPair();
    error PoolAlreadyExists();

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

        (address token0, address token1, uint8 decimals0, uint8 decimals1) = tokenA < tokenB
            ? (tokenA, tokenB, decimalsA, decimalsB)
            : (tokenB, tokenA, decimalsB, decimalsA);

        bytes32 key = poolKey(token0, token1, decimals0, decimals1, feeBps);
        if (getPool[key] != address(0)) revert PoolAlreadyExists();

        pool = address(new ConfidentialCPMM{salt: key}(
            token0,
            token1,
            decimals0,
            decimals1,
            feeBps
        ));
        getPool[key] = pool;
        isPool[pool] = true;
        pools.push(pool);

        emit PoolCreated(token0, token1, decimals0, decimals1, feeBps, pool);
    }

    function poolKey(
        address token0,
        address token1,
        uint8 decimals0,
        uint8 decimals1,
        uint256 feeBps
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(token0, token1, decimals0, decimals1, feeBps));
    }

    function allPoolsLength() external view returns (uint256) {
        return pools.length;
    }

    function allPools(uint256 index) external view returns (address) {
        return pools[index];
    }
}
