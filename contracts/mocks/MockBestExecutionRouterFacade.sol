// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MockBestExecutionRouterFacade {
    uint256 public constant PROTOCOL_VERSION = 2;
    address public factory;

    constructor(address factory_) {
        factory = factory_;
    }
}
