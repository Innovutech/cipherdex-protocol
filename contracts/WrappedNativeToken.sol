// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "./interfaces/IWrappedNativeToken.sol";

/**
 * @title WrappedNativeToken
 * @notice Immutable one-to-one ERC-20 representation of the chain's native asset.
 * @dev Forced native transfers may make the contract over-collateralized, but
 *      every minted token remains backed by at least one native base unit.
 */
contract WrappedNativeToken is ERC20, IWrappedNativeToken {
    error InvalidAmount();
    error InvalidRecipient();
    error NativeTransferFailed();

    event Deposit(address indexed account, uint256 amount);
    event Withdrawal(address indexed account, uint256 amount);

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    receive() external payable {
        deposit();
    }

    function deposit() public payable {
        if (msg.value == 0) revert InvalidAmount();
        _mint(msg.sender, msg.value);
        emit Deposit(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        if (amount == 0) revert InvalidAmount();
        _burn(msg.sender, amount);
        (bool success, ) = payable(msg.sender).call{value: amount}("");
        if (!success) revert NativeTransferFailed();
        emit Withdrawal(msg.sender, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (to == address(this)) revert InvalidRecipient();
        super._update(from, to, value);
    }
}
