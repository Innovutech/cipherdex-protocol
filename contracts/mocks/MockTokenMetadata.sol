// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@coti-io/coti-contracts/contracts/token/PrivateERC20/IPrivateERC20.sol";

contract MockTokenMetadata {
    uint8 private immutable tokenDecimals;

    constructor(uint8 tokenDecimals_) {
        tokenDecimals = tokenDecimals_;
    }

    function decimals() external view returns (uint8) {
        return tokenDecimals;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IPrivateERC20).interfaceId;
    }
}
