// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IPublicCPMM {
    function PROTOCOL_VERSION() external view returns (uint256);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function token0Decimals() external view returns (uint8);
    function token1Decimals() external view returns (uint8);
    function scale0() external view returns (uint256);
    function scale1() external view returns (uint256);
    function feeBps() external view returns (uint256);
    function feeVault() external view returns (address);
    function lpTokenFactory() external view returns (address);
    function lpToken() external view returns (address);
    function PROTOCOL_FEE_SHARE_NUMERATOR() external view returns (uint256);
    function PROTOCOL_FEE_SHARE_DENOMINATOR() external view returns (uint256);
    function protocolFees0() external view returns (uint256);
    function protocolFees1() external view returns (uint256);
    function initialized() external view returns (bool);
    function totalShares() external view returns (uint256);
    function shares(address provider) external view returns (uint256);
    function quoteExactInput(uint256 amountIn, bool zeroForOne) external view returns (uint256);
    function swapExactInput(uint256,uint256,bool,uint64) external returns (uint256);
    function addLiquidity(uint256,uint256,uint256,uint256,uint256,uint64) external returns (uint256);
    function addLiquidityFor(address,uint256,uint256,uint256,uint256,uint256,uint64) external returns (uint256);
    function removeLiquidity(uint256,uint256,uint256,uint64) external returns (uint256,uint256);
    function removeLiquidityTo(address,uint256,uint256,uint256,uint64) external returns (uint256,uint256);
    function collectProtocolFees(bool,bool) external returns (uint256,uint256);
    function effectiveReserves() external view returns (uint256,uint256);
    function lockShares(uint256,uint64,bool,uint64) external returns (bytes32);
    function unlockShares(bytes32) external;
    function lockInfo(bytes32) external view returns (address,uint64,bool,bool,uint256);
}
