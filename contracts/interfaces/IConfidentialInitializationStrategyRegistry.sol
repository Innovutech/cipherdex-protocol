// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/introspection/IERC165.sol";

interface IConfidentialInitializationStrategyRegistry is IERC165 {
    event FactoryBound(address indexed factory);
    event InitializationStrategyRegistered(
        uint8 indexed classIndex,
        address indexed strategy,
        bytes32 runtimeCodehash,
        bytes32 registration
    );
    event InitializationStrategyRegistryFinalized(uint8 strategyCount);

    function REGISTRY_VERSION() external view returns (uint256);
    function MAX_INITIALIZATION_STRATEGIES() external view returns (uint8);
    function configurationAuthority() external view returns (address);
    function factory() external view returns (address);
    function finalized() external view returns (bool);
    function bindFactory(address factory_) external;
    function registerInitializationStrategy(address strategy) external;
    function finalize() external;
    function initializationStrategiesLength() external view returns (uint256);
    function initializationStrategyAt(uint8 classIndex) external view returns (address);
    function initializationStrategyClass(address strategy) external view returns (uint8);
    function initializationStrategyRuntimeCodehash(address strategy) external view returns (bytes32);
    function initializationStrategyRegistration(address strategy) external view returns (bytes32);
    function isRegisteredStrategy(address strategy) external view returns (bool);
}
