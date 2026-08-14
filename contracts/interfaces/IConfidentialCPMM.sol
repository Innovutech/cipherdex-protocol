// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@coti-io/coti-contracts/contracts/utils/mpc/MpcCore.sol";

interface IConfidentialCPMM {
    function PROTOCOL_VERSION() external view returns (uint256);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function token0Decimals() external view returns (uint8);
    function token1Decimals() external view returns (uint8);
    function scale0() external view returns (uint256);
    function scale1() external view returns (uint256);
    function feeBps() external view returns (uint256);
    function initialized() external view returns (bool);

    function quoteExactInput(
        itUint256 calldata amountIn,
        bool zeroForOne
    ) external returns (ctUint256 memory amountOut);

    function swapExactInput(
        itUint256 calldata amountIn,
        itUint256 calldata minAmountOut,
        bool zeroForOne,
        uint64 deadline
    ) external returns (ctUint256 memory amountOut);

    function addLiquidity(
        itUint256 calldata amount0,
        itUint256 calldata amount1,
        itUint256 calldata minShares,
        uint64 deadline
    ) external returns (ctUint256 memory mintedShares);

    function removeLiquidity(
        itUint256 calldata shares,
        itUint256 calldata minAmount0,
        itUint256 calldata minAmount1,
        uint64 deadline
    ) external returns (ctUint256 memory amount0, ctUint256 memory amount1);

    function myShares() external returns (ctUint256 memory);
    function lockInfo(bytes32 lockId)
        external
        view
        returns (address owner, uint64 unlockTime, bool permanent, bool released);
}
