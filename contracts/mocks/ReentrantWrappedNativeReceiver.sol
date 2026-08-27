// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IWrappedNativeToken.sol";

contract ReentrantWrappedNativeReceiver {
    IWrappedNativeToken public immutable wrappedNative;
    uint256 private nestedWithdrawal;

    constructor(address wrappedNative_) {
        wrappedNative = IWrappedNativeToken(wrappedNative_);
    }

    function deposit() external payable {
        wrappedNative.deposit{value: msg.value}();
    }

    function withdrawWithReentry(uint256 amount, uint256 nestedAmount) external {
        nestedWithdrawal = nestedAmount;
        wrappedNative.withdraw(amount);
        nestedWithdrawal = 0;
    }

    receive() external payable {
        uint256 amount = nestedWithdrawal;
        if (amount == 0) return;
        nestedWithdrawal = 0;
        wrappedNative.withdraw(amount);
    }
}
