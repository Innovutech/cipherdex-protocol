// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract RevertingBalanceERC20 is ERC20 {
    bool public revertBalanceReads;

    constructor(string memory name_, string memory symbol_)
        ERC20(name_, symbol_)
    {}

    function setRevertBalanceReads(bool value) external {
        revertBalanceReads = value;
    }

    function balanceOf(address account) public view override returns (uint256) {
        if (revertBalanceReads) revert("BALANCE_READ_DISABLED");
        return super.balanceOf(account);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
