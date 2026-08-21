// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./MockTokenMetadata.sol";

contract MockTokenMetadataVariant is MockTokenMetadata {
    bytes32 public immutable implementationMarker;

    constructor(uint8 tokenDecimals_, bytes32 implementationMarker_)
        MockTokenMetadata(tokenDecimals_)
    {
        implementationMarker = implementationMarker_;
    }
}
