// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IPublicFeeVault {
    function publicFactory() external view returns (address);
    function publicFees(address token) external view returns (uint256);
    function depositPublicFees(address token, uint256 amount)
        external
        returns (uint256 received);
}
