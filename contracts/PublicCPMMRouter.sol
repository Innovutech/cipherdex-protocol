// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/IPublicCPMM.sol";
import "./interfaces/IPublicCPMMFactory.sol";

/**
 * @title PublicCPMMRouter
 * @notice Factory-gated exact-input router for ordinary public CPMM pools.
 *
 * The router temporarily holds the caller's public input, calls the pool, and
 * forwards the public output back to the caller. It must not be used for
 * ConfidentialCPMM: COTI input ciphertexts authenticate msg.sender and the
 * target pool, so forwarding those calls would invalidate the signed input.
 */
contract PublicCPMMRouter {
    using SafeERC20 for IERC20;

    uint256 public constant PROTOCOL_VERSION = 1;

    address public immutable factory;
    uint256 private reentrancyState = 1;

    error InvalidFactory();
    error InvalidPool();
    error InvalidAmount();
    error SlippageExceeded();
    error TransferAmountMismatch();
    error Reentrancy();

    event SwapRouted(
        address indexed trader,
        address indexed pool,
        address indexed inputToken,
        address outputToken,
        uint256 amountIn,
        uint256 amountOut
    );

    modifier nonReentrant() {
        if (reentrancyState != 1) revert Reentrancy();
        reentrancyState = 2;
        _;
        reentrancyState = 1;
    }

    constructor(address factory_) {
        if (factory_ == address(0)) revert InvalidFactory();
        factory = factory_;
    }

    function swapExactInput(
        address pool,
        uint256 amountIn,
        uint256 minAmountOut,
        bool zeroForOne,
        uint64 deadline
    ) external nonReentrant returns (uint256 amountOut) {
        if (!IPublicCPMMFactory(factory).isPool(pool)) revert InvalidPool();
        if (amountIn == 0) revert InvalidAmount();

        address inputToken = zeroForOne
            ? IPublicCPMM(pool).token0()
            : IPublicCPMM(pool).token1();
        address outputToken = zeroForOne
            ? IPublicCPMM(pool).token1()
            : IPublicCPMM(pool).token0();

        IERC20 input = IERC20(inputToken);
        uint256 inputBalanceBefore = input.balanceOf(address(this));
        input.safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 inputBalanceAfter = input.balanceOf(address(this));
        if (
            inputBalanceAfter < inputBalanceBefore ||
            inputBalanceAfter - inputBalanceBefore != amountIn
        ) revert TransferAmountMismatch();
        input.forceApprove(pool, amountIn);
        uint256 routerAmountOut = IPublicCPMM(pool).swapExactInput(
            amountIn,
            0,
            zeroForOne,
            deadline
        );
        input.forceApprove(pool, 0);
        if (input.balanceOf(address(this)) != inputBalanceBefore) {
            revert TransferAmountMismatch();
        }

        amountOut = _transferOut(
            IERC20(outputToken),
            msg.sender,
            routerAmountOut,
            minAmountOut
        );

        emit SwapRouted(msg.sender, pool, inputToken, outputToken, amountIn, amountOut);
    }

    function _transferOut(
        IERC20 token,
        address recipient,
        uint256 amount,
        uint256 minimumReceived
    ) internal returns (uint256 received) {
        uint256 senderBefore = token.balanceOf(address(this));
        uint256 recipientBefore = token.balanceOf(recipient);
        if (senderBefore < amount) revert TransferAmountMismatch();
        token.safeTransfer(recipient, amount);
        uint256 senderAfter = token.balanceOf(address(this));
        uint256 recipientAfter = token.balanceOf(recipient);
        if (
            senderAfter > senderBefore ||
            senderBefore - senderAfter != amount ||
            recipientAfter < recipientBefore
        ) revert TransferAmountMismatch();
        received = recipientAfter - recipientBefore;
        if (received < minimumReceived) revert SlippageExceeded();
    }
}
