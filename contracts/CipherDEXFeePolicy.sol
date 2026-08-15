// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title CipherDEXFeePolicy
 * @notice Immutable v1 swap-fee policy shared by public and confidential pools.
 *
 * The advertised total fee is charged from the swap input. One sixth of the
 * actual integer-rounded fee accrues to CipherDEX; the remainder belongs to
 * LPs. The split is part of the protocol version and cannot be changed for an
 * existing pool.
 */
abstract contract CipherDEXFeePolicy {
    uint256 public constant FEE_DENOMINATOR = 10_000;
    uint256 public constant PROTOCOL_FEE_SHARE_NUMERATOR = 1;
    uint256 public constant PROTOCOL_FEE_SHARE_DENOMINATOR = 6;

    uint256 public constant LOW_FEE_TIER_BPS = 5;
    uint256 public constant STANDARD_FEE_TIER_BPS = 30;
    uint256 public constant HIGH_FEE_TIER_BPS = 100;

    function isApprovedFeeTier(uint256 totalFeeBps) public pure returns (bool) {
        return totalFeeBps == LOW_FEE_TIER_BPS
            || totalFeeBps == STANDARD_FEE_TIER_BPS
            || totalFeeBps == HIGH_FEE_TIER_BPS;
    }

    function _protocolFeeFromTotal(uint256 totalFee) internal pure returns (uint256) {
        return totalFee / PROTOCOL_FEE_SHARE_DENOMINATOR;
    }
}
