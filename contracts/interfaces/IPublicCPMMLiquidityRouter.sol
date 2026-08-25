// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IPublicCPMMLiquidityRouter {
    event PublicLiquidityRouted(
        address indexed provider,
        address indexed pool,
        bool indexed poolCreated,
        uint256 amount0,
        uint256 amount1,
        uint256 shares
    );

    function PROTOCOL_VERSION() external view returns (uint256);
    function factory() external view returns (address);

    function createOrAddLiquidity(
        address tokenA,
        address tokenB,
        uint8 decimalsA,
        uint8 decimalsB,
        uint256 feeBps,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 minShares,
        uint256 minPriceX18,
        uint256 maxPriceX18,
        uint64 deadline
    ) external returns (
        address pool,
        uint256 mintedShares,
        uint256 amountAUsed,
        uint256 amountBUsed
    );

    function createOrAddLiquidityFor(
        address recipient,
        address tokenA,
        address tokenB,
        uint8 decimalsA,
        uint8 decimalsB,
        uint256 feeBps,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 minShares,
        uint256 minPriceX18,
        uint256 maxPriceX18,
        uint64 deadline
    ) external returns (
        address pool,
        uint256 mintedShares,
        uint256 amountAUsed,
        uint256 amountBUsed
    );

    function removeLiquidity(
        address pool,
        uint256 shares,
        uint256 minAmount0,
        uint256 minAmount1,
        uint64 deadline,
        address recipient
    ) external returns (uint256 amount0, uint256 amount1);

    function removeLiquidityWithPermit(
        address pool,
        uint256 shares,
        uint256 minAmount0,
        uint256 minAmount1,
        uint64 deadline,
        address recipient,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (uint256 amount0, uint256 amount1);
}
