// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IPublicBestExecutionRouter {
    function PROTOCOL_VERSION() external view returns (uint256);
    function factory() external view returns (address);
    function ALL_CANDIDATE_BITMAP() external view returns (uint8);

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
    );

    function swapBestExactInput(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        uint8 candidateBitmap,
        address recipient,
        uint64 deadline
    ) external returns (
        address selectedPool,
        uint256 selectedFeeBps,
        uint256 amountOut
    );
}
