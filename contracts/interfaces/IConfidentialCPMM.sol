// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@coti-io/coti-contracts/contracts/utils/mpc/MpcCore.sol";

interface IConfidentialCPMM {
    function swapExactInput(
        itUint256 calldata amountIn,
        itUint256 calldata minAmountOut,
        bool zeroForOne
    ) external returns (ctUint256 memory amountOut);

    function addLiquidity(
        itUint256 calldata amount0,
        itUint256 calldata amount1,
        itUint256 calldata minShares
    ) external returns (ctUint256 memory mintedShares);

    function removeLiquidity(
        itUint256 calldata shares,
        itUint256 calldata minAmount0,
        itUint256 calldata minAmount1
    ) external returns (ctUint256 memory amount0, ctUint256 memory amount1);
}

