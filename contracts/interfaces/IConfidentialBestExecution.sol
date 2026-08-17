// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@coti-io/coti-contracts/contracts/utils/mpc/MpcCore.sol";

/**
 * @notice Narrow transaction-scoped GT surface exposed only to the canonical
 *         confidential best-execution router.
 */
interface IConfidentialBestExecutionPool {
    function quoteExactInputForRouter(
        gtUint256 amountIn,
        bool zeroForOne
    ) external returns (gtUint256 amountOut, gtBool valid);

    function settleExactInputForRouter(
        address recipient,
        gtUint256 amountIn,
        gtUint256 minimumOut,
        bool zeroForOne,
        uint64 deadline
    ) external returns (gtUint256 amountOut);
}

interface IConfidentialBestExecutionRouter {
    function PROTOCOL_VERSION() external view returns (uint256);
    function factory() external view returns (address);
}
