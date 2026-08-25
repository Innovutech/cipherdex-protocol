// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IPublicCPMMRouter {
    function PROTOCOL_VERSION() external view returns (uint256);
    function factory() external view returns (address);
    function swapExactInput(
        address pool,
        uint256 amountIn,
        uint256 minAmountOut,
        bool zeroForOne,
        uint64 deadline
    ) external returns (uint256 amountOut);
}
