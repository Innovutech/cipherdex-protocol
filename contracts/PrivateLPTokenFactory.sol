// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./PrivateLPToken.sol";

/**
 * @title PrivateLPTokenFactory
 * @notice Small, factory-owned deployer for pool-bound private LP tokens.
 *
 * Keeping the COTI PrivateERC20 creation bytecode here prevents the canonical
 * CPMM factory from exceeding the EIP-170 runtime bytecode limit.
 */
contract PrivateLPTokenFactory {
    address public immutable owner;

    error Unauthorized();

    constructor() {
        owner = msg.sender;
    }

    function create(address pool) external returns (address token) {
        if (msg.sender != owner) revert Unauthorized();
        token = address(new PrivateLPToken(pool));
    }
}
