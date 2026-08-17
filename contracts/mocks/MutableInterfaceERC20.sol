// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./MockERC20.sol";

contract MutableInterfaceERC20 is MockERC20 {
    bool public reportsInterface;

    constructor(string memory name_, string memory symbol_, uint8 decimals_)
        MockERC20(name_, symbol_, decimals_)
    {}

    function setReportsInterface(bool enabled) external {
        reportsInterface = enabled;
    }

    function supportsInterface(bytes4) external view returns (bool) {
        return reportsInterface;
    }
}
