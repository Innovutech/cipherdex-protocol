// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./PublicLPToken.sol";

/**
 * @title PublicLPTokenFactory
 * @notice Issues pool-bound public LP tokens without embedding their creation
 *         bytecode in every pool or in the public pool factory runtime.
 */
contract PublicLPTokenFactory {
    mapping(address => address) public poolByToken;
    mapping(address => address) public issuerByToken;

    error InvalidPool();

    event PublicLPTokenIssued(
        address indexed pool,
        address indexed token,
        address indexed issuer
    );

    function create(address pool) external returns (address token) {
        if (pool == address(0)) revert InvalidPool();
        token = address(new PublicLPToken(pool));
        poolByToken[token] = pool;
        issuerByToken[token] = msg.sender;
        emit PublicLPTokenIssued(pool, token, msg.sender);
    }

    function isIssuedToken(
        address pool,
        address token,
        address issuer
    ) external view returns (bool) {
        return poolByToken[token] == pool && issuerByToken[token] == issuer;
    }
}
