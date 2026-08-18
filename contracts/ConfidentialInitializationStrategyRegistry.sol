// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./interfaces/IConfidentialCPMMFactory.sol";
import "./interfaces/IConfidentialInitializationStrategy.sol";
import "./interfaces/IConfidentialInitializationStrategyRegistry.sol";
import "./interfaces/IConfidentialLaunchpadMigrator.sol";

/**
 * @title ConfidentialInitializationStrategyRegistry
 * @notice One-time reviewed strategy registry bound to one confidential factory.
 */
contract ConfidentialInitializationStrategyRegistry is
    IConfidentialInitializationStrategyRegistry
{
    uint256 public constant REGISTRY_VERSION = 1;
    uint8 public constant MAX_INITIALIZATION_STRATEGIES = 2;
    address public configurationAuthority;
    address public factory;
    bool public finalized;

    mapping(bytes32 => bool) public isReviewedInitializationStrategyCodehash;
    mapping(address => uint8) public initializationStrategyClass;
    mapping(address => bytes32) public initializationStrategyRuntimeCodehash;
    mapping(address => bytes32) public initializationStrategyRegistration;
    address[] private initializationStrategies;

    error ConfigurationUnauthorized();
    error InvalidFactory();
    error FactoryAlreadyBound();
    error InvalidInitializationStrategyCodehash();
    error InvalidInitializationStrategy();
    error InitializationStrategyAlreadyRegistered();
    error InitializationStrategyRegistryFull();
    error InitializationStrategyRegistryAlreadyFinalized();
    error InitializationStrategyRegistryEmpty();

    constructor(bytes32[] memory reviewedStrategyCodehashes) {
        if (reviewedStrategyCodehashes.length == 0) {
            revert InvalidInitializationStrategyCodehash();
        }
        configurationAuthority = msg.sender;
        for (uint256 index = 0; index < reviewedStrategyCodehashes.length; index++) {
            bytes32 codehash = reviewedStrategyCodehashes[index];
            if (codehash == bytes32(0)) {
                revert InvalidInitializationStrategyCodehash();
            }
            isReviewedInitializationStrategyCodehash[codehash] = true;
        }
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return
            interfaceId ==
            type(IConfidentialInitializationStrategyRegistry).interfaceId ||
            interfaceId == type(IERC165).interfaceId;
    }

    function bindFactory(address factory_) external {
        if (msg.sender != configurationAuthority) {
            revert ConfigurationUnauthorized();
        }
        if (factory != address(0)) revert FactoryAlreadyBound();
        if (
            factory_.code.length == 0 ||
            IConfidentialCPMMFactory(factory_).PROTOCOL_VERSION() != 3 ||
            IConfidentialCPMMFactory(factory_).PRIVACY_MODE() != 1 ||
            IConfidentialCPMMFactory(factory_).initializationStrategyRegistry() !=
                address(this)
        ) revert InvalidFactory();
        factory = factory_;
        emit FactoryBound(factory_);
    }

    function registerInitializationStrategy(address strategy) external {
        if (msg.sender != configurationAuthority) {
            revert ConfigurationUnauthorized();
        }
        if (finalized) revert InitializationStrategyRegistryAlreadyFinalized();
        if (factory == address(0)) revert InvalidFactory();
        if (initializationStrategies.length >= MAX_INITIALIZATION_STRATEGIES) {
            revert InitializationStrategyRegistryFull();
        }
        if (
            strategy == address(0) ||
            initializationStrategyRuntimeCodehash[strategy] != bytes32(0)
        ) revert InitializationStrategyAlreadyRegistered();
        bytes32 runtimeCodehash = strategy.codehash;
        if (!isReviewedInitializationStrategyCodehash[runtimeCodehash]) {
            revert InvalidInitializationStrategy();
        }

        IConfidentialInitializationStrategy candidate =
            IConfidentialInitializationStrategy(strategy);
        bool supported;
        try candidate.supportsInterface(
            type(IConfidentialInitializationStrategy).interfaceId
        ) returns (bool result) {
            supported = result;
        } catch {
            revert InvalidInitializationStrategy();
        }
        address migrator = candidate.migrator();
        bytes32 migratorRuntimeCodehash = candidate.migratorRuntimeCodehash();
        if (
            !supported ||
            candidate.factory() != factory ||
            candidate.strategyRegistry() != address(this) ||
            candidate.PROTOCOL_VERSION() != 3 ||
            candidate.PRIVACY_MODE() != 1 ||
            candidate.STRATEGY_VERSION() != 1 ||
            !candidate.configurationFinalized() ||
            migrator == address(0) ||
            migratorRuntimeCodehash == bytes32(0) ||
            migrator.codehash != migratorRuntimeCodehash ||
            IConfidentialLaunchpadMigrator(migrator).PROTOCOL_VERSION() != 4 ||
            IConfidentialLaunchpadMigrator(migrator).factory() != factory ||
            IConfidentialLaunchpadMigrator(migrator).initializationStrategy() !=
                strategy ||
            candidate.factoryRegistration() != bytes32(0)
        ) revert InvalidInitializationStrategy();

        uint8 classIndex = uint8(initializationStrategies.length + 1);
        bytes32 registration = keccak256(
            abi.encode(
                address(this),
                factory,
                strategy,
                classIndex,
                runtimeCodehash,
                migrator,
                migratorRuntimeCodehash,
                block.chainid
            )
        );
        initializationStrategies.push(strategy);
        initializationStrategyClass[strategy] = classIndex;
        initializationStrategyRuntimeCodehash[strategy] = runtimeCodehash;
        initializationStrategyRegistration[strategy] = registration;
        candidate.bindFactoryRegistration(registration);
        if (candidate.factoryRegistration() != registration) {
            revert InvalidInitializationStrategy();
        }
        emit InitializationStrategyRegistered(
            classIndex,
            strategy,
            runtimeCodehash,
            registration
        );
    }

    function finalize() external {
        if (msg.sender != configurationAuthority) {
            revert ConfigurationUnauthorized();
        }
        if (finalized) revert InitializationStrategyRegistryAlreadyFinalized();
        if (initializationStrategies.length == 0) {
            revert InitializationStrategyRegistryEmpty();
        }
        finalized = true;
        emit InitializationStrategyRegistryFinalized(
            uint8(initializationStrategies.length)
        );
    }

    function initializationStrategiesLength() external view returns (uint256) {
        return initializationStrategies.length;
    }

    function initializationStrategyAt(
        uint8 classIndex
    ) external view returns (address) {
        if (classIndex == 0) return address(0);
        uint256 index = uint256(classIndex) - 1;
        if (index >= initializationStrategies.length) return address(0);
        return initializationStrategies[index];
    }

    function isRegisteredStrategy(address strategy) external view returns (bool) {
        bytes32 codehash = initializationStrategyRuntimeCodehash[strategy];
        bytes32 registration = initializationStrategyRegistration[strategy];
        if (
            !finalized ||
            strategy == address(0) ||
            codehash == bytes32(0) ||
            strategy.codehash != codehash ||
            registration == bytes32(0)
        ) return false;

        IConfidentialInitializationStrategy candidate =
            IConfidentialInitializationStrategy(strategy);
        address migrator = candidate.migrator();
        bytes32 migratorRuntimeCodehash = candidate.migratorRuntimeCodehash();
        return
            candidate.factoryRegistration() == registration &&
            migrator != address(0) &&
            migratorRuntimeCodehash != bytes32(0) &&
            migrator.codehash == migratorRuntimeCodehash &&
            IConfidentialLaunchpadMigrator(migrator).factory() == factory &&
            IConfidentialLaunchpadMigrator(migrator).initializationStrategy() ==
            strategy;
    }
}
