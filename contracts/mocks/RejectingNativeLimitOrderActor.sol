// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IPublicCPMMLimitOrderActions {
    struct CreateOrderParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minAmountOut;
        address recipient;
        uint64 expiry;
        uint8 candidateBitmap;
        bool allowPartialFills;
        uint256 minimumFillAmount;
    }

    function createOrder(CreateOrderParams calldata params)
        external
        payable
        returns (uint256 orderId);

    function fillOrder(uint256 orderId, uint256 amountInToFill)
        external
        returns (uint256 amountOut);
    function cancelOrder(uint256 orderId) external;
    function claimNativeBounty(address payable recipient) external returns (uint256 amount);
}

contract RejectingNativeLimitOrderActor {
    constructor() payable {}

    function createOrder(
        address orderBook,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        uint64 expiry,
        uint8 candidateBitmap,
        bool allowPartialFills,
        uint256 minimumFillAmount,
        uint256 executionBounty
    ) external returns (uint256 orderId) {
        IERC20(tokenIn).approve(orderBook, amountIn);
        return IPublicCPMMLimitOrderActions(orderBook).createOrder{
            value: executionBounty
        }(
            IPublicCPMMLimitOrderActions.CreateOrderParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                amountIn: amountIn,
                minAmountOut: minAmountOut,
                recipient: recipient,
                expiry: expiry,
                candidateBitmap: candidateBitmap,
                allowPartialFills: allowPartialFills,
                minimumFillAmount: minimumFillAmount
            })
        );
    }

    function fillOrder(address orderBook, uint256 orderId, uint256 amountInToFill)
        external
    {
        IPublicCPMMLimitOrderActions(orderBook).fillOrder(orderId, amountInToFill);
    }

    function cancelOrder(address orderBook, uint256 orderId) external {
        IPublicCPMMLimitOrderActions(orderBook).cancelOrder(orderId);
    }

    function claimNativeBounty(address orderBook, address payable recipient) external {
        IPublicCPMMLimitOrderActions(orderBook).claimNativeBounty(recipient);
    }
}
