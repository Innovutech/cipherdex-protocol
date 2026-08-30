// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IPublicCPMMLimitOrderActions {
    function createOrder(
        address pool,
        bool zeroForOne,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        uint64 expiry
    ) external payable returns (uint256 orderId);

    function fillOrder(uint256 orderId) external returns (uint256 amountOut);
    function cancelOrder(uint256 orderId) external;
    function claimNativeBounty(address payable recipient) external returns (uint256 amount);
}

contract RejectingNativeLimitOrderActor {
    constructor() payable {}

    function createOrder(
        address orderBook,
        address tokenIn,
        address pool,
        bool zeroForOne,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        uint64 expiry,
        uint256 executionBounty
    ) external returns (uint256 orderId) {
        IERC20(tokenIn).approve(orderBook, amountIn);
        return IPublicCPMMLimitOrderActions(orderBook).createOrder{
            value: executionBounty
        }(
            pool,
            zeroForOne,
            amountIn,
            minAmountOut,
            recipient,
            expiry
        );
    }

    function fillOrder(address orderBook, uint256 orderId) external {
        IPublicCPMMLimitOrderActions(orderBook).fillOrder(orderId);
    }

    function cancelOrder(address orderBook, uint256 orderId) external {
        IPublicCPMMLimitOrderActions(orderBook).cancelOrder(orderId);
    }

    function claimNativeBounty(address orderBook, address payable recipient) external {
        IPublicCPMMLimitOrderActions(orderBook).claimNativeBounty(recipient);
    }
}
