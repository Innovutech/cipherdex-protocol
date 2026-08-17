// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./PrivateLPToken.sol";

/**
 * @title PrivateLPTokenFactory
 * @notice Small deployer for pool-bound private LP tokens.
 *
 * Keeping the COTI PrivateERC20 creation bytecode here prevents the canonical
 * CPMM factory from exceeding compiler and EIP-170 limits. Creation is
 * permissionless because the token has no authority over a pool: only the pool
 * address can mint or burn it, and the pool's canonical factory is the only
 * caller allowed to bind an LP token exactly once.
 */
contract PrivateLPTokenFactory {
    mapping(address => address) public poolByToken;
    mapping(address => address) public issuerByToken;

    event PrivateLPTokenIssued(
        address indexed pool,
        address indexed token,
        address indexed issuer
    );

    function create(address pool) external returns (address token) {
        token = address(new PrivateLPToken(pool));
        poolByToken[token] = pool;
        issuerByToken[token] = msg.sender;
        emit PrivateLPTokenIssued(pool, token, msg.sender);
    }

    function isIssuedToken(
        address pool,
        address token,
        address issuer
    ) external view returns (bool) {
        return poolByToken[token] == pool && issuerByToken[token] == issuer;
    }
}
