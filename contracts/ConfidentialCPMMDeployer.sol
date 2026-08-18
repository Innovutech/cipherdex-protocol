// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ConfidentialCPMM.sol";
import "./interfaces/IConfidentialCPMMDeployer.sol";
import "./interfaces/IConfidentialCPMMFactory.sol";

/**
 * @notice Factory-bound CREATE2 deployer kept separate from factory registry logic.
 */
contract ConfidentialCPMMDeployer is IConfidentialCPMMDeployer {
    uint256 public constant DEPLOYER_VERSION = 1;
    address public configurationAuthority;
    address public factory;

    error ConfigurationUnauthorized();
    error FactoryAlreadyBound();
    error InvalidFactory();
    error DeploymentUnauthorized();

    constructor() {
        configurationAuthority = msg.sender;
    }

    function bindFactory(address factory_) external {
        if (msg.sender != configurationAuthority) {
            revert ConfigurationUnauthorized();
        }
        if (factory != address(0)) revert FactoryAlreadyBound();
        if (
            factory_.code.length == 0 ||
            IConfidentialCPMMFactory(factory_).PROTOCOL_VERSION() != 3 ||
            IConfidentialCPMMFactory(factory_).poolDeployer() != address(this)
        ) revert InvalidFactory();
        factory = factory_;
    }

    function deployPool(
        bytes32 key,
        address token0,
        address token1,
        uint8 decimals0,
        uint8 decimals1,
        uint256 feeBps,
        address feeVault,
        address initializationStrategy
    ) external returns (address pool) {
        if (msg.sender != factory) revert DeploymentUnauthorized();
        pool = address(
            new ConfidentialCPMM{salt: key}(
                token0,
                token1,
                decimals0,
                decimals1,
                feeBps,
                feeVault,
                initializationStrategy,
                factory
            )
        );
    }

}
