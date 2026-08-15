// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./interfaces/IPublicCPMM.sol";
import "./interfaces/IPublicCPMMFactory.sol";

/**
 * @title PublicCPMMQuoter
 * @notice Factory-gated read-only quoting for ordinary public CPMM pools.
 *
 * This helper is intentionally public-only. Confidential quotes must be
 * requested from the pool by the trader because COTI encrypted inputs bind the
 * caller and target contract.
 */
contract PublicCPMMQuoter {
    uint256 public constant PROTOCOL_VERSION = 1;

    address public immutable factory;

    error InvalidFactory();
    error InvalidPool();

    constructor(address factory_) {
        if (factory_ == address(0)) revert InvalidFactory();
        factory = factory_;
    }

    function quoteExactInput(
        address pool,
        uint256 amountIn,
        bool zeroForOne
    ) external view returns (uint256 amountOut) {
        if (!IPublicCPMMFactory(factory).isPool(pool)) revert InvalidPool();
        return IPublicCPMM(pool).quoteExactInput(amountIn, zeroForOne);
    }
}
