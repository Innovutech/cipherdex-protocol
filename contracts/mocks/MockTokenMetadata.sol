// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MockTokenMetadata {
    uint8 private immutable tokenDecimals;

    constructor(uint8 tokenDecimals_) {
        tokenDecimals = tokenDecimals_;
    }

    function decimals() external view returns (uint8) {
        return tokenDecimals;
    }
}
