// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./CipherDEXFeePolicy.sol";
import "./interfaces/IPublicCPMM.sol";
import "./interfaces/IPublicCPMMFactory.sol";

/**
 * @title PublicBestExecutionRouter
 * @notice Selects and settles against the best canonical public pool for a pair.
 * @dev The search space is the three immutable v1 fee tiers. Routing never trusts
 *      caller-supplied pool addresses and deliberately chooses one pool rather
 *      than splitting a swap across pools.
 */
contract PublicBestExecutionRouter is CipherDEXFeePolicy, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant PROTOCOL_VERSION = 1;
    uint8 public constant LOW_FEE_CANDIDATE = 1 << 0;
    uint8 public constant STANDARD_FEE_CANDIDATE = 1 << 1;
    uint8 public constant HIGH_FEE_CANDIDATE = 1 << 2;
    uint8 public constant ALL_CANDIDATE_BITMAP =
        LOW_FEE_CANDIDATE | STANDARD_FEE_CANDIDATE | HIGH_FEE_CANDIDATE;

    address public immutable factory;

    error InvalidFactory();
    error InvalidTokenPair();
    error InvalidAmount();
    error InvalidCandidateBitmap();
    error InvalidRecipient();
    error NoRoute();
    error SlippageExceeded();
    error TransferAmountMismatch();
    error ResidualAllowance();

    event BestSwapRouted(
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

    constructor(address factory_) {
        if (factory_ == address(0) || factory_.code.length == 0) {
            revert InvalidFactory();
        }
        if (
            IPublicCPMMFactory(factory_).PROTOCOL_VERSION() != PROTOCOL_VERSION ||
            IPublicCPMMFactory(factory_).feeVault() == address(0)
        ) revert InvalidFactory();
        factory = factory_;
    }

    function quoteBestExactInput(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint8 candidateBitmap
    ) external view returns (
        address selectedPool,
        uint256 selectedFeeBps,
        bool zeroForOne,
        uint256 amountOut
    ) {
        _validateRequest(tokenIn, tokenOut, amountIn, candidateBitmap);
        return _quoteBestExactInput(tokenIn, tokenOut, amountIn, candidateBitmap);
    }

    function swapBestExactInput(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        uint8 candidateBitmap,
        address recipient,
        uint64 deadline
    ) external nonReentrant returns (
        address selectedPool,
        uint256 selectedFeeBps,
        uint256 amountOut
    ) {
        _validateRequest(tokenIn, tokenOut, amountIn, candidateBitmap);
        if (recipient == address(0) || recipient == address(this)) {
            revert InvalidRecipient();
        }

        IERC20 input = IERC20(tokenIn);
        IERC20 output = IERC20(tokenOut);
        uint256 inputBefore = input.balanceOf(address(this));
        input.safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 inputAfter = input.balanceOf(address(this));
        if (inputAfter < inputBefore || inputAfter - inputBefore != amountIn) {
            revert TransferAmountMismatch();
        }

        bool zeroForOne;
        uint256 quotedAmountOut;
        (selectedPool, selectedFeeBps, zeroForOne, quotedAmountOut) =
            _quoteBestExactInput(tokenIn, tokenOut, amountIn, candidateBitmap);
        if (quotedAmountOut < minAmountOut) revert SlippageExceeded();

        uint256 outputBefore = output.balanceOf(address(this));
        input.forceApprove(selectedPool, amountIn);
        uint256 poolAmountOut = IPublicCPMM(selectedPool).swapExactInput(
            amountIn,
            minAmountOut,
            zeroForOne,
            deadline
        );
        input.forceApprove(selectedPool, 0);
        if (input.allowance(address(this), selectedPool) != 0) {
            revert ResidualAllowance();
        }

        uint256 outputAfter = output.balanceOf(address(this));
        if (
            input.balanceOf(address(this)) != inputBefore ||
            outputAfter < outputBefore ||
            outputAfter - outputBefore != poolAmountOut
        ) revert TransferAmountMismatch();

        amountOut = _transferOut(output, recipient, poolAmountOut, minAmountOut);
        if (output.balanceOf(address(this)) != outputBefore) {
            revert TransferAmountMismatch();
        }

        emit BestSwapRouted(
            msg.sender,
            selectedPool,
            recipient,
            tokenIn,
            tokenOut,
            selectedFeeBps,
            candidateBitmap,
            amountIn,
            amountOut
        );
    }

    function _quoteBestExactInput(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint8 candidateBitmap
    ) internal view returns (
        address selectedPool,
        uint256 selectedFeeBps,
        bool zeroForOne,
        uint256 amountOut
    ) {
        uint256[3] memory feeTiers = [
            LOW_FEE_TIER_BPS,
            STANDARD_FEE_TIER_BPS,
            HIGH_FEE_TIER_BPS
        ];

        for (uint8 index; index < feeTiers.length; ++index) {
            if ((candidateBitmap & (uint8(1) << index)) == 0) continue;
            uint256 feeTier = feeTiers[index];
            bytes32 key = IPublicCPMMFactory(factory).poolKey(
                tokenIn,
                tokenOut,
                0,
                0,
                feeTier
            );
            address pool = IPublicCPMMFactory(factory).getPool(key);
            if (pool == address(0) || !IPublicCPMMFactory(factory).isPool(pool)) {
                continue;
            }

            bool direction;
            try IPublicCPMM(pool).token0() returns (address token0) {
                address token1 = IPublicCPMM(pool).token1();
                if (token0 == tokenIn && token1 == tokenOut) direction = true;
                else if (token0 == tokenOut && token1 == tokenIn) direction = false;
                else continue;
                if (IPublicCPMM(pool).feeBps() != feeTier) continue;
            } catch {
                continue;
            }

            try IPublicCPMM(pool).quoteExactInput(amountIn, direction)
                returns (uint256 candidateAmountOut)
            {
                if (candidateAmountOut > amountOut) {
                    selectedPool = pool;
                    selectedFeeBps = feeTier;
                    zeroForOne = direction;
                    amountOut = candidateAmountOut;
                }
            } catch {}
        }

        if (selectedPool == address(0)) revert NoRoute();
    }

    function _validateRequest(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint8 candidateBitmap
    ) internal pure {
        if (
            tokenIn == address(0) ||
            tokenOut == address(0) ||
            tokenIn == tokenOut
        ) revert InvalidTokenPair();
        if (amountIn == 0) revert InvalidAmount();
        if (
            candidateBitmap == 0 ||
            (candidateBitmap & ~ALL_CANDIDATE_BITMAP) != 0
        ) revert InvalidCandidateBitmap();
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
