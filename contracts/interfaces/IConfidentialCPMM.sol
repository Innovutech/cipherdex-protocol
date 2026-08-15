// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@coti-io/coti-contracts/contracts/utils/mpc/MpcCore.sol";

interface IConfidentialCPMM {
    event ConfidentialQuoteResult(
        address indexed caller,
        bytes32 indexed requestId,
        bool indexed zeroForOne,
        ctUint256 result
    );

    function PROTOCOL_VERSION() external view returns (uint256);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function token0Decimals() external view returns (uint8);
    function token1Decimals() external view returns (uint8);
    function scale0() external view returns (uint256);
    function scale1() external view returns (uint256);
    function feeBps() external view returns (uint256);
    function feeVault() external view returns (address);
    function PROTOCOL_FEE_SHARE_NUMERATOR() external view returns (uint256);
    function PROTOCOL_FEE_SHARE_DENOMINATOR() external view returns (uint256);
    function bootstrapper() external view returns (address);
    function lpToken() external view returns (address);
    function initialized() external view returns (bool);
    function protocolFeeSwapCount0() external view returns (uint32);
    function protocolFeeSwapCount1() external view returns (uint32);
    function protocolFeeWindowStart0() external view returns (uint64);
    function protocolFeeWindowStart1() external view returns (uint64);

    function initializeLPToken(address lpToken_) external;

    function quoteExactInput(
        itUint256 calldata amountIn,
        bool zeroForOne
    ) external returns (ctUint256 memory amountOut);

    function requestQuoteExactInput(
        itUint256 calldata amountIn,
        bool zeroForOne,
        bytes32 requestId
    ) external returns (ctUint256 memory result);

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

    function bootstrapLiquidity(
        address provider,
        uint256 amount0,
        uint256 amount1,
        uint256 minShares,
        uint256 minPriceX18,
        uint256 maxPriceX18
    ) external returns (ctUint256 memory mintedShares);

    function bootstrapLiquidityWithDisposition(
        address provider,
        uint256 amount0,
        uint256 amount1,
        uint256 minShares,
        uint256 minPriceX18,
        uint256 maxPriceX18,
        uint8 disposition,
        uint64 unlockTime
    ) external returns (ctUint256 memory mintedShares, bytes32 lockId);

    function removeLiquidity(
        itUint256 calldata shares,
        itUint256 calldata minAmount0,
        itUint256 calldata minAmount1,
        uint64 deadline
    ) external returns (ctUint256 memory amount0, ctUint256 memory amount1);

    function collectProtocolFees(bool collectToken0, bool collectToken1) external;

    function myShares() external returns (ctUint256 memory);
    function lockInfo(bytes32 lockId)
        external
        view
        returns (address owner, uint64 unlockTime, bool permanent, bool released);
}
