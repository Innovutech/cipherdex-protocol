// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IConfidentialCPMM.sol";

interface IObservableConfidentialCPMM is IConfidentialCPMM {
    event PublicPriceObservation(
        uint64 indexed sequence,
        uint256 priceBucketX18,
        uint64 observedAt,
        uint64 publishedAt,
        uint32 activityCount,
        uint256 quantumX18,
        bool initial
    );

    function initialPriceReferenceX18() external view returns (uint256);
    function initializeLiquidity(
        itUint256 calldata amount0,
        itUint256 calldata amount1,
        itUint256 calldata minShares,
        itUint256 calldata minPriceX18,
        itUint256 calldata maxPriceX18,
        uint256 initialPriceReferenceX18,
        uint64 deadline
    ) external returns (ctUint256 memory mintedShares);
    function bootstrapLiquidity(
        address provider,
        address fundingSource,
        uint256 amount0,
        uint256 amount1,
        uint256 minShares,
        uint256 minPriceX18,
        uint256 maxPriceX18,
        uint256 initialPriceReferenceX18
    ) external returns (ctUint256 memory mintedShares);
    function bootstrapLiquidityWithDisposition(
        address provider,
        address fundingSource,
        uint256 amount0,
        uint256 amount1,
        uint256 minShares,
        uint256 minPriceX18,
        uint256 maxPriceX18,
        uint256 initialPriceReferenceX18,
        uint8 disposition,
        uint64 unlockTime
    ) external returns (ctUint256 memory mintedShares, bytes32 lockId);
    function publicPriceBucketX18() external view returns (uint256);
    function publicPriceQuantumX18() external view returns (uint256);
    function publicObservationSequence() external view returns (uint64);
    function publicObservationAt() external view returns (uint64);
    function publicObservationPublishedAt() external view returns (uint64);
    function publicObservationActivityCount() external view returns (uint32);
    function swapsSinceObservationClose() external view returns (uint32);
    function lastObservationClosedAt() external view returns (uint64);
    function hasPendingObservation() external view returns (bool);
    function pendingObservationAt() external view returns (uint64);
    function pendingObservationActivityCount() external view returns (uint32);
    function observationDueForNextSwap() external view returns (bool);
}
