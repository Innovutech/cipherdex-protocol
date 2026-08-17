// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@coti-io/coti-contracts/contracts/token/PrivateERC20/IPrivateERC20.sol";
import "@coti-io/coti-contracts/contracts/utils/mpc/MpcCore.sol";

/**
 * @dev Testnet-only probe for transaction-scoped GT reuse across contracts.
 * This contract is not a CipherDEX pool and must never be used for deployment.
 */
contract MpcBestExecutionPoolProbe {
    IPrivateERC20 public immutable tokenIn;
    IPrivateERC20 public immutable tokenOut;
    uint256 public immutable numerator;
    uint256 public immutable denominator;
    address public immutable configurator;
    address public router;
    bool public closed;

    error Unauthorized();
    error AlreadyConfigured();
    error InvalidConfiguration();
    error SlippageExceeded();
    error PrivateTransferAmountMismatch();
    error Closed();
    error RecoveryMismatch();

    constructor(address tokenIn_, address tokenOut_, uint256 numerator_, uint256 denominator_) {
        if (
            tokenIn_ == address(0) ||
            tokenOut_ == address(0) ||
            tokenIn_ == tokenOut_ ||
            numerator_ == 0 ||
            denominator_ == 0
        ) revert InvalidConfiguration();
        tokenIn = IPrivateERC20(tokenIn_);
        tokenOut = IPrivateERC20(tokenOut_);
        numerator = numerator_;
        denominator = denominator_;
        configurator = msg.sender;
    }

    function configureRouter(address router_) external {
        if (msg.sender != configurator) revert Unauthorized();
        if (closed) revert Closed();
        if (router != address(0)) revert AlreadyConfigured();
        if (router_.code.length == 0) revert InvalidConfiguration();
        router = router_;
    }

    function quoteGt(gtUint256 amountIn) external returns (gtUint256) {
        if (closed) revert Closed();
        _requireRouter();
        return _quote(amountIn);
    }

    function settleGt(address recipient, gtUint256 amountIn, gtUint256 minimumOut)
        external
        returns (gtUint256 amountOut)
    {
        if (closed) revert Closed();
        _requireRouter();
        if (recipient == address(0)) revert InvalidConfiguration();

        amountOut = _quote(amountIn);
        if (!MpcCore.decrypt(MpcCore.ge(amountOut, minimumOut))) {
            revert SlippageExceeded();
        }

        gtUint256 inputBefore = tokenIn.balanceOf();
        tokenIn.transferFromGT(msg.sender, address(this), amountIn);
        if (!MpcCore.decrypt(MpcCore.eq(tokenIn.balanceOf(), MpcCore.add(inputBefore, amountIn)))) {
            revert PrivateTransferAmountMismatch();
        }

        gtUint256 outputBefore = tokenOut.balanceOf();
        tokenOut.transferGT(recipient, amountOut);
        if (!MpcCore.decrypt(MpcCore.eq(tokenOut.balanceOf(), MpcCore.sub(outputBefore, amountOut)))) {
            revert PrivateTransferAmountMismatch();
        }
    }

    function closeAndRecover(address recipient) external {
        if (msg.sender != configurator) revert Unauthorized();
        if (closed) revert Closed();
        if (recipient == address(0)) revert InvalidConfiguration();
        closed = true;

        gtUint256 inputBalance = tokenIn.balanceOf();
        if (!MpcCore.decrypt(MpcCore.eq(inputBalance, uint256(0)))) {
            tokenIn.transferGT(recipient, inputBalance);
        }
        gtUint256 outputBalance = tokenOut.balanceOf();
        if (!MpcCore.decrypt(MpcCore.eq(outputBalance, uint256(0)))) {
            tokenOut.transferGT(recipient, outputBalance);
        }
        if (
            !MpcCore.decrypt(MpcCore.eq(tokenIn.balanceOf(), uint256(0))) ||
            !MpcCore.decrypt(MpcCore.eq(tokenOut.balanceOf(), uint256(0)))
        ) revert RecoveryMismatch();
    }

    function _quote(gtUint256 amountIn) internal returns (gtUint256) {
        return MpcCore.div(MpcCore.mul(amountIn, numerator), denominator);
    }

    function _requireRouter() internal view {
        if (msg.sender != router || router == address(0)) revert Unauthorized();
    }
}
