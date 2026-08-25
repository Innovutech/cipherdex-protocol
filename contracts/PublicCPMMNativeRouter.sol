// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/IPublicCPMM.sol";
import "./interfaces/IPublicCPMMFactory.sol";
import "./interfaces/IPublicCPMMRouter.sol";
import "./interfaces/IPublicCPMMLiquidityRouter.sol";
import "./interfaces/IPublicLPTokenFactory.sol";
import "./interfaces/IWrappedNativeToken.sol";

/**
 * @title PublicCPMMNativeRouter
 * @notice Additive native-asset adapter for the canonical public CPMM router.
 * @dev Public pools remain ERC-20-only. This adapter wraps native exact input,
 *      or unwraps wrapped-native exact output, around the existing factory-gated
 *      router. It has no owner, mutable configuration, or asset-recovery path.
 */
contract PublicCPMMNativeRouter {
    using SafeERC20 for IERC20;

    uint256 public constant PROTOCOL_VERSION = 1;

    address public immutable factory;
    address public immutable publicRouter;
    address public immutable publicLiquidityRouter;
    address public immutable wrappedNative;
    uint256 private reentrancyState = 1;

    error InvalidConfiguration();
    error InvalidPool();
    error InvalidAmount();
    error InvalidRecipient();
    error WrappedNativePairRequired();
    error TransferAmountMismatch();
    error SlippageExceeded();
    error NativeTransferFailed();
    error UnexpectedNativeSender();
    error ResidualAllowance();
    error PermitFailed();
    error Reentrancy();

    event NativeSwapRouted(
        address indexed trader,
        address indexed recipient,
        address indexed pool,
        address inputToken,
        address outputToken,
        uint256 amountIn,
        uint256 amountOut
    );
    event NativeLiquidityAdded(
        address indexed provider,
        address indexed recipient,
        address indexed pool,
        address pairedToken,
        uint256 nativeAmount,
        uint256 tokenAmount,
        uint256 shares
    );
    event NativeLiquidityRemoved(
        address indexed provider,
        address indexed recipient,
        address indexed pool,
        address pairedToken,
        uint256 nativeAmount,
        uint256 tokenAmount,
        uint256 shares
    );

    modifier nonReentrant() {
        if (reentrancyState != 1) revert Reentrancy();
        reentrancyState = 2;
        _;
        reentrancyState = 1;
    }

    constructor(
        address factory_,
        address publicRouter_,
        address publicLiquidityRouter_,
        address wrappedNative_
    ) {
        if (
            factory_ == address(0) ||
            publicRouter_ == address(0) ||
            publicLiquidityRouter_ == address(0) ||
            wrappedNative_ == address(0) ||
            factory_.code.length == 0 ||
            publicRouter_.code.length == 0 ||
            publicLiquidityRouter_.code.length == 0 ||
            wrappedNative_.code.length == 0 ||
            IPublicCPMMRouter(publicRouter_).factory() != factory_ ||
            IPublicCPMMLiquidityRouter(publicLiquidityRouter_).factory() != factory_
        ) revert InvalidConfiguration();
        factory = factory_;
        publicRouter = publicRouter_;
        publicLiquidityRouter = publicLiquidityRouter_;
        wrappedNative = wrappedNative_;
    }

    receive() external payable {
        if (msg.sender != wrappedNative) revert UnexpectedNativeSender();
    }

    function swapExactNativeForToken(
        address pool,
        uint256 minAmountOut,
        uint64 deadline,
        address recipient
    ) external payable nonReentrant returns (uint256 amountOut) {
        if (msg.value == 0) revert InvalidAmount();
        _requireRecipient(recipient);
        (bool zeroForOne, address outputToken) = _requireWrappedNativePair(pool, true);

        IERC20 wrapped = IERC20(wrappedNative);
        uint256 wrappedBefore = wrapped.balanceOf(address(this));
        IWrappedNativeToken(wrappedNative).deposit{value: msg.value}();
        if (wrapped.balanceOf(address(this)) - wrappedBefore != msg.value) {
            revert TransferAmountMismatch();
        }

        wrapped.forceApprove(publicRouter, msg.value);
        uint256 routedAmountOut = IPublicCPMMRouter(publicRouter).swapExactInput(
            pool,
            msg.value,
            0,
            zeroForOne,
            deadline
        );
        wrapped.forceApprove(publicRouter, 0);
        if (wrapped.balanceOf(address(this)) != wrappedBefore) {
            revert TransferAmountMismatch();
        }

        amountOut = _transferTokenOut(
            IERC20(outputToken),
            recipient,
            routedAmountOut,
            minAmountOut
        );
        emit NativeSwapRouted(
            msg.sender,
            recipient,
            pool,
            address(0),
            outputToken,
            msg.value,
            amountOut
        );
    }

    function swapExactTokenForNative(
        address pool,
        uint256 amountIn,
        uint256 minAmountOut,
        uint64 deadline,
        address payable recipient
    ) external nonReentrant returns (uint256 amountOut) {
        if (amountIn == 0) revert InvalidAmount();
        _requireRecipient(recipient);
        (bool zeroForOne, address inputToken) = _requireWrappedNativePair(pool, false);

        IERC20 input = IERC20(inputToken);
        uint256 inputBefore = input.balanceOf(address(this));
        input.safeTransferFrom(msg.sender, address(this), amountIn);
        if (input.balanceOf(address(this)) - inputBefore != amountIn) {
            revert TransferAmountMismatch();
        }

        input.forceApprove(publicRouter, amountIn);
        IERC20 wrapped = IERC20(wrappedNative);
        uint256 wrappedBefore = wrapped.balanceOf(address(this));
        uint256 routedAmountOut = IPublicCPMMRouter(publicRouter).swapExactInput(
            pool,
            amountIn,
            minAmountOut,
            zeroForOne,
            deadline
        );
        input.forceApprove(publicRouter, 0);
        if (input.balanceOf(address(this)) != inputBefore) {
            revert TransferAmountMismatch();
        }
        if (wrapped.balanceOf(address(this)) - wrappedBefore != routedAmountOut) {
            revert TransferAmountMismatch();
        }
        if (routedAmountOut < minAmountOut) revert SlippageExceeded();

        uint256 nativeBefore = address(this).balance;
        IWrappedNativeToken(wrappedNative).withdraw(routedAmountOut);
        if (address(this).balance - nativeBefore != routedAmountOut) {
            revert TransferAmountMismatch();
        }
        if (wrapped.balanceOf(address(this)) != wrappedBefore) {
            revert TransferAmountMismatch();
        }

        (bool success, ) = recipient.call{value: routedAmountOut}("");
        if (!success) revert NativeTransferFailed();
        amountOut = routedAmountOut;
        emit NativeSwapRouted(
            msg.sender,
            recipient,
            pool,
            inputToken,
            address(0),
            amountIn,
            amountOut
        );
    }

    function createOrAddLiquidityNative(
        address token,
        uint8 tokenDecimals,
        uint256 feeBps,
        uint256 tokenAmountDesired,
        uint256 minShares,
        uint256 minPriceX18,
        uint256 maxPriceX18,
        uint64 deadline,
        address recipient
    ) external payable nonReentrant returns (
        address pool,
        uint256 mintedShares,
        uint256 nativeAmountUsed,
        uint256 tokenAmountUsed
    ) {
        if (msg.value == 0 || tokenAmountDesired == 0) revert InvalidAmount();
        _requireRecipient(recipient);
        if (
            token == address(0) ||
            token == wrappedNative ||
            token.code.length == 0
        ) revert InvalidConfiguration();

        IERC20 wrapped = IERC20(wrappedNative);
        IERC20 paired = IERC20(token);
        uint256 wrappedBefore = wrapped.balanceOf(address(this));
        uint256 tokenBefore = paired.balanceOf(address(this));
        uint256 nativeBefore = address(this).balance - msg.value;

        _pullExact(paired, msg.sender, tokenAmountDesired, tokenBefore);
        IWrappedNativeToken(wrappedNative).deposit{value: msg.value}();
        if (wrapped.balanceOf(address(this)) - wrappedBefore != msg.value) {
            revert TransferAmountMismatch();
        }

        wrapped.forceApprove(publicLiquidityRouter, msg.value);
        paired.forceApprove(publicLiquidityRouter, tokenAmountDesired);
        (
            pool,
            mintedShares,
            nativeAmountUsed,
            tokenAmountUsed
        ) = IPublicCPMMLiquidityRouter(publicLiquidityRouter)
            .createOrAddLiquidityFor(
                recipient,
                wrappedNative,
                token,
                18,
                tokenDecimals,
                feeBps,
                msg.value,
                tokenAmountDesired,
                minShares,
                minPriceX18,
                maxPriceX18,
                deadline
            );
        wrapped.forceApprove(publicLiquidityRouter, 0);
        paired.forceApprove(publicLiquidityRouter, 0);
        if (
            wrapped.allowance(address(this), publicLiquidityRouter) != 0 ||
            paired.allowance(address(this), publicLiquidityRouter) != 0
        ) revert ResidualAllowance();

        uint256 wrappedRefund = wrapped.balanceOf(address(this)) - wrappedBefore;
        uint256 tokenRefund = paired.balanceOf(address(this)) - tokenBefore;
        if (
            nativeAmountUsed > msg.value ||
            tokenAmountUsed > tokenAmountDesired ||
            wrappedRefund != msg.value - nativeAmountUsed ||
            tokenRefund != tokenAmountDesired - tokenAmountUsed
        ) revert TransferAmountMismatch();

        if (tokenRefund != 0) {
            _transferTokenOut(paired, msg.sender, tokenRefund, tokenRefund);
        }
        if (wrappedRefund != 0) {
            IWrappedNativeToken(wrappedNative).withdraw(wrappedRefund);
            _sendNative(payable(msg.sender), wrappedRefund);
        }
        if (
            wrapped.balanceOf(address(this)) != wrappedBefore ||
            paired.balanceOf(address(this)) != tokenBefore ||
            address(this).balance != nativeBefore
        ) revert TransferAmountMismatch();

        emit NativeLiquidityAdded(
            msg.sender,
            recipient,
            pool,
            token,
            nativeAmountUsed,
            tokenAmountUsed,
            mintedShares
        );
    }

    function removeLiquidityNative(
        address pool,
        uint256 shareInput,
        uint256 minTokenAmount,
        uint256 minNativeAmount,
        uint64 deadline,
        address payable recipient
    ) external nonReentrant returns (uint256 tokenAmount, uint256 nativeAmount) {
        return _removeLiquidityNative(
            pool,
            shareInput,
            minTokenAmount,
            minNativeAmount,
            deadline,
            recipient
        );
    }

    function removeLiquidityNativeWithPermit(
        address pool,
        uint256 shareInput,
        uint256 minTokenAmount,
        uint256 minNativeAmount,
        uint64 deadline,
        address payable recipient,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (uint256 tokenAmount, uint256 nativeAmount) {
        address lp = _requireWrappedNativePairPool(pool).lpToken();
        try IERC20Permit(lp).permit(
            msg.sender,
            address(this),
            shareInput,
            permitDeadline,
            v,
            r,
            s
        ) {} catch {
            if (IERC20(lp).allowance(msg.sender, address(this)) < shareInput) {
                revert PermitFailed();
            }
        }
        return _removeLiquidityNative(
            pool,
            shareInput,
            minTokenAmount,
            minNativeAmount,
            deadline,
            recipient
        );
    }

    function _removeLiquidityNative(
        address pool,
        uint256 shareInput,
        uint256 minTokenAmount,
        uint256 minNativeAmount,
        uint64 deadline,
        address payable recipient
    ) internal returns (uint256 tokenAmount, uint256 nativeAmount) {
        if (shareInput == 0) revert InvalidAmount();
        _requireRecipient(recipient);
        IPublicCPMM canonicalPool = _requireWrappedNativePairPool(pool);
        bool wrappedIsToken0 = canonicalPool.token0() == wrappedNative;
        address pairedToken = wrappedIsToken0
            ? canonicalPool.token1()
            : canonicalPool.token0();
        IERC20 lp = IERC20(canonicalPool.lpToken());
        IERC20 paired = IERC20(pairedToken);
        IERC20 wrapped = IERC20(wrappedNative);
        uint256 lpBefore = lp.balanceOf(address(this));
        uint256 tokenBefore = paired.balanceOf(address(this));
        uint256 wrappedBefore = wrapped.balanceOf(address(this));
        uint256 nativeBefore = address(this).balance;

        _pullExact(lp, msg.sender, shareInput, lpBefore);
        lp.forceApprove(publicLiquidityRouter, shareInput);
        (uint256 amount0, uint256 amount1) = IPublicCPMMLiquidityRouter(
            publicLiquidityRouter
        ).removeLiquidity(
            pool,
            shareInput,
            wrappedIsToken0 ? minNativeAmount : minTokenAmount,
            wrappedIsToken0 ? minTokenAmount : minNativeAmount,
            deadline,
            address(this)
        );
        lp.forceApprove(publicLiquidityRouter, 0);
        if (lp.allowance(address(this), publicLiquidityRouter) != 0) {
            revert ResidualAllowance();
        }

        nativeAmount = wrappedIsToken0 ? amount0 : amount1;
        tokenAmount = wrappedIsToken0 ? amount1 : amount0;
        if (
            lp.balanceOf(address(this)) != lpBefore ||
            wrapped.balanceOf(address(this)) - wrappedBefore != nativeAmount ||
            paired.balanceOf(address(this)) - tokenBefore != tokenAmount
        ) revert TransferAmountMismatch();

        tokenAmount = _transferTokenOut(
            paired,
            recipient,
            tokenAmount,
            minTokenAmount
        );
        IWrappedNativeToken(wrappedNative).withdraw(nativeAmount);
        _sendNative(recipient, nativeAmount);
        if (
            wrapped.balanceOf(address(this)) != wrappedBefore ||
            paired.balanceOf(address(this)) != tokenBefore ||
            address(this).balance != nativeBefore
        ) revert TransferAmountMismatch();

        emit NativeLiquidityRemoved(
            msg.sender,
            recipient,
            pool,
            pairedToken,
            nativeAmount,
            tokenAmount,
            shareInput
        );
    }

    function _requireWrappedNativePair(address pool, bool wrappedIsInput)
        internal
        view
        returns (bool zeroForOne, address pairedToken)
    {
        if (!IPublicCPMMFactory(factory).isPool(pool)) revert InvalidPool();
        address token0 = IPublicCPMM(pool).token0();
        address token1 = IPublicCPMM(pool).token1();
        bool wrappedIsToken0 = token0 == wrappedNative;
        bool wrappedIsToken1 = token1 == wrappedNative;
        if (wrappedIsToken0 == wrappedIsToken1) revert WrappedNativePairRequired();

        zeroForOne = wrappedIsInput ? wrappedIsToken0 : !wrappedIsToken0;
        pairedToken = wrappedIsToken0 ? token1 : token0;
    }

    function _requireWrappedNativePairPool(address pool)
        internal
        view
        returns (IPublicCPMM candidate)
    {
        IPublicCPMMFactory canonicalFactory = IPublicCPMMFactory(factory);
        if (!canonicalFactory.isPool(pool)) revert InvalidPool();
        candidate = IPublicCPMM(pool);
        bool wrappedIsToken0 = candidate.token0() == wrappedNative;
        bool wrappedIsToken1 = candidate.token1() == wrappedNative;
        if (wrappedIsToken0 == wrappedIsToken1) {
            revert WrappedNativePairRequired();
        }
        address lpFactory = canonicalFactory.lpTokenFactory();
        address lp = candidate.lpToken();
        if (
            candidate.PROTOCOL_VERSION() != canonicalFactory.PROTOCOL_VERSION() ||
            candidate.feeVault() != canonicalFactory.feeVault() ||
            candidate.lpTokenFactory() != lpFactory ||
            lp.code.length == 0 ||
            !IPublicLPTokenFactory(lpFactory).isIssuedToken(pool, lp, pool)
        ) revert InvalidPool();
    }

    function _requireRecipient(address recipient) internal view {
        if (
            recipient == address(0) ||
            recipient == address(this) ||
            recipient == wrappedNative
        ) revert InvalidRecipient();
    }

    function _transferTokenOut(
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

    function _pullExact(
        IERC20 token,
        address from,
        uint256 amount,
        uint256 startingBalance
    ) internal {
        token.safeTransferFrom(from, address(this), amount);
        uint256 endingBalance = token.balanceOf(address(this));
        if (
            endingBalance < startingBalance ||
            endingBalance - startingBalance != amount
        ) revert TransferAmountMismatch();
    }

    function _sendNative(address payable recipient, uint256 amount) internal {
        (bool success, ) = recipient.call{value: amount}("");
        if (!success) revert NativeTransferFailed();
    }
}
