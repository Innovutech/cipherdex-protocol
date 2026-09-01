// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IPublicBestExecutionRouter.sol";
import "./interfaces/IWrappedNativeToken.sol";

/**
 * @title PublicBestExecutionNativeRouter
 * @notice Native-COTI adapter for the canonical public best-execution router.
 * @dev The existing router remains the only pool-selection authority. This
 *      adapter only wraps exact native input or unwraps exact native output.
 */
contract PublicBestExecutionNativeRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant PROTOCOL_VERSION = 1;
    uint8 public constant ALL_CANDIDATE_BITMAP = 7;

    address public immutable factory;
    address public immutable bestExecutionRouter;
    address public immutable wrappedNative;

    error InvalidConfiguration();
    error InvalidToken();
    error InvalidAmount();
    error InvalidRecipient();
    error TransferAmountMismatch();
    error NativeTransferFailed();
    error UnexpectedNativeSender();
    error ResidualAllowance();

    event NativeBestSwapRouted(
        address indexed trader,
        address indexed selectedPool,
        address indexed recipient,
        address inputToken,
        address outputToken,
        uint256 selectedFeeBps,
        uint8 candidateBitmap,
        uint256 amountIn,
        uint256 amountOut
    );

    constructor(
        address factory_,
        address bestExecutionRouter_,
        address wrappedNative_
    ) {
        if (
            factory_ == address(0) ||
            bestExecutionRouter_ == address(0) ||
            wrappedNative_ == address(0) ||
            factory_.code.length == 0 ||
            bestExecutionRouter_.code.length == 0 ||
            wrappedNative_.code.length == 0 ||
            factory_ == bestExecutionRouter_ ||
            factory_ == wrappedNative_ ||
            bestExecutionRouter_ == wrappedNative_
        ) revert InvalidConfiguration();

        IPublicBestExecutionRouter router = IPublicBestExecutionRouter(
            bestExecutionRouter_
        );
        if (
            router.factory() != factory_ ||
            router.PROTOCOL_VERSION() != PROTOCOL_VERSION ||
            router.ALL_CANDIDATE_BITMAP() != ALL_CANDIDATE_BITMAP
        ) revert InvalidConfiguration();

        factory = factory_;
        bestExecutionRouter = bestExecutionRouter_;
        wrappedNative = wrappedNative_;
    }

    receive() external payable {
        if (msg.sender != wrappedNative) revert UnexpectedNativeSender();
    }

    function swapExactNativeForToken(
        address tokenOut,
        uint256 minAmountOut,
        uint8 candidateBitmap,
        address recipient,
        uint64 deadline
    ) external payable nonReentrant returns (
        address selectedPool,
        uint256 selectedFeeBps,
        uint256 amountOut
    ) {
        if (msg.value == 0) revert InvalidAmount();
        _requirePairedToken(tokenOut);
        _requireRecipient(recipient);

        IERC20 wrapped = IERC20(wrappedNative);
        uint256 nativeBefore = address(this).balance - msg.value;
        uint256 wrappedBefore = wrapped.balanceOf(address(this));
        IWrappedNativeToken(wrappedNative).deposit{value: msg.value}();
        if (wrapped.balanceOf(address(this)) - wrappedBefore != msg.value) {
            revert TransferAmountMismatch();
        }

        wrapped.forceApprove(bestExecutionRouter, msg.value);
        (selectedPool, selectedFeeBps, amountOut) =
            IPublicBestExecutionRouter(bestExecutionRouter)
                .swapBestExactInput(
                    wrappedNative,
                    tokenOut,
                    msg.value,
                    minAmountOut,
                    candidateBitmap,
                    recipient,
                    deadline
                );
        wrapped.forceApprove(bestExecutionRouter, 0);
        if (wrapped.allowance(address(this), bestExecutionRouter) != 0) {
            revert ResidualAllowance();
        }
        if (
            wrapped.balanceOf(address(this)) != wrappedBefore ||
            address(this).balance != nativeBefore
        ) revert TransferAmountMismatch();

        emit NativeBestSwapRouted(
            msg.sender,
            selectedPool,
            recipient,
            address(0),
            tokenOut,
            selectedFeeBps,
            candidateBitmap,
            msg.value,
            amountOut
        );
    }

    function swapExactTokenForNative(
        address tokenIn,
        uint256 amountIn,
        uint256 minAmountOut,
        uint8 candidateBitmap,
        address payable recipient,
        uint64 deadline
    ) external nonReentrant returns (
        address selectedPool,
        uint256 selectedFeeBps,
        uint256 amountOut
    ) {
        if (amountIn == 0) revert InvalidAmount();
        _requirePairedToken(tokenIn);
        _requireRecipient(recipient);

        IERC20 input = IERC20(tokenIn);
        IERC20 wrapped = IERC20(wrappedNative);
        uint256 nativeBefore = address(this).balance;
        uint256 inputBefore = input.balanceOf(address(this));
        uint256 wrappedBefore = wrapped.balanceOf(address(this));
        input.safeTransferFrom(msg.sender, address(this), amountIn);
        if (input.balanceOf(address(this)) - inputBefore != amountIn) {
            revert TransferAmountMismatch();
        }

        input.forceApprove(bestExecutionRouter, amountIn);
        (selectedPool, selectedFeeBps, amountOut) =
            IPublicBestExecutionRouter(bestExecutionRouter)
                .swapBestExactInput(
                    tokenIn,
                    wrappedNative,
                    amountIn,
                    minAmountOut,
                    candidateBitmap,
                    address(this),
                    deadline
                );
        input.forceApprove(bestExecutionRouter, 0);
        if (input.allowance(address(this), bestExecutionRouter) != 0) {
            revert ResidualAllowance();
        }
        if (
            input.balanceOf(address(this)) != inputBefore ||
            wrapped.balanceOf(address(this)) - wrappedBefore != amountOut
        ) revert TransferAmountMismatch();

        IWrappedNativeToken(wrappedNative).withdraw(amountOut);
        if (
            wrapped.balanceOf(address(this)) != wrappedBefore ||
            address(this).balance - nativeBefore != amountOut
        ) revert TransferAmountMismatch();

        (bool success, ) = recipient.call{value: amountOut}("");
        if (!success) revert NativeTransferFailed();
        if (address(this).balance != nativeBefore) {
            revert TransferAmountMismatch();
        }

        emit NativeBestSwapRouted(
            msg.sender,
            selectedPool,
            recipient,
            tokenIn,
            address(0),
            selectedFeeBps,
            candidateBitmap,
            amountIn,
            amountOut
        );
    }

    function _requirePairedToken(address token) internal view {
        if (
            token == address(0) ||
            token == wrappedNative ||
            token == address(this) ||
            token == bestExecutionRouter ||
            token.code.length == 0
        ) revert InvalidToken();
    }

    function _requireRecipient(address recipient) internal view {
        if (
            recipient == address(0) ||
            recipient == address(this) ||
            recipient == wrappedNative ||
            recipient == bestExecutionRouter
        ) revert InvalidRecipient();
    }
}
