// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @dev Test-only token that attempts a configured callback during a transfer.
 * The callback is deliberately bubbled so tests prove the pool rejects the
 * entire operation rather than merely ignoring a failed nested call.
 */
contract ReentrantERC20 is ERC20 {
    uint8 private immutable tokenDecimals;
    address public callbackTarget;
    bytes public callbackData;
    bool public callbackEnabled;
    bool private callbackAttempted;

    constructor(uint8 decimals_) ERC20("Reentrant Token", "REENT") {
        tokenDecimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return tokenDecimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function configureCallback(address target, bytes calldata data) external {
        callbackTarget = target;
        callbackData = data;
        callbackEnabled = true;
        callbackAttempted = false;
    }

    function disableCallback() external {
        callbackEnabled = false;
        callbackAttempted = false;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (callbackEnabled && !callbackAttempted && callbackTarget != address(0)) {
            callbackAttempted = true;
            (bool ok, bytes memory returndata) = callbackTarget.call(callbackData);
            if (!ok) {
                assembly ("memory-safe") {
                    revert(add(returndata, 32), mload(returndata))
                }
            }
        }
        super._update(from, to, value);
    }
}
