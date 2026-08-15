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

        IERC20(inputToken).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(inputToken).forceApprove(pool, amountIn);
        amountOut = IPublicCPMM(pool).swapExactInput(
            amountIn,
            minAmountOut,
            zeroForOne,
            deadline
        );
        IERC20(inputToken).forceApprove(pool, 0);
        IERC20(outputToken).safeTransfer(msg.sender, amountOut);

        emit SwapRouted(msg.sender, pool, inputToken, outputToken, amountIn, amountOut);
    }
}
