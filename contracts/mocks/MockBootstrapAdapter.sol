// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IConfidentialCPMMFactory.sol";
import "../interfaces/IConfidentialCPMM.sol";

contract MockBootstrapAdapter {
    function isPool(address) external pure returns (bool) {
        return false;
    }

    function getOrCreatePoolForCommitment(
        address factory,
        address tokenA,
        address tokenB,
        uint8 decimalsA,
        uint8 decimalsB,
        uint256 feeBps
    ) external returns (address pool) {
        return IConfidentialCPMMFactory(factory).getOrCreatePoolForCommitment(
            tokenA,
            tokenB,
            decimalsA,
            decimalsB,
            feeBps
        );
    }

    function initializeLPToken(address pool, address lpToken) external {
        IConfidentialCPMM(pool).initializeLPToken(lpToken);
    }

    function bootstrapLiquidity(
        address pool,
        address provider,
        address fundingSource,
        uint256 amount0,
        uint256 amount1,
        uint256 minShares,
        uint256 minPriceX18,
        uint256 maxPriceX18
    ) external {
        IConfidentialCPMM(pool).bootstrapLiquidity(
            provider,
            fundingSource,
            amount0,
            amount1,
            minShares,
            minPriceX18,
            maxPriceX18
        );
    }

    function bootstrapLiquidityWithDisposition(
        address pool,
        address provider,
        address fundingSource,
        uint256 amount0,
        uint256 amount1,
        uint256 minShares,
        uint256 minPriceX18,
        uint256 maxPriceX18,
        uint8 disposition,
        uint64 unlockTime
    ) external {
        IConfidentialCPMM(pool).bootstrapLiquidityWithDisposition(
            provider,
            fundingSource,
            amount0,
            amount1,
            minShares,
            minPriceX18,
            maxPriceX18,
            disposition,
            unlockTime
        );
    }
}
