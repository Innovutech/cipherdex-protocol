// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@coti-io/coti-contracts/contracts/utils/mpc/MpcCore.sol";

interface IConfidentialFeeVault {
    function confidentialFactory() external view returns (address);
    function depositConfidentialFees(
        address token,
        gtUint256 amount,
        uint32 aggregatedSwapCount
    ) external;
}
