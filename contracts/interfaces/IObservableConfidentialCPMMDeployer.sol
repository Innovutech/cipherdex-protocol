// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IObservableConfidentialCPMMDeployer {
    function DEPLOYER_VERSION() external view returns (uint256);
    function factory() external view returns (address);
    function bindFactory(address factory_) external;
    function deployPool(
        bytes32 key,
        address token0,
        address token1,
        uint8 decimals0,
        uint8 decimals1,
        uint256 feeBps,
        address feeVault,
        address initializationStrategy
    ) external returns (address pool);
}
