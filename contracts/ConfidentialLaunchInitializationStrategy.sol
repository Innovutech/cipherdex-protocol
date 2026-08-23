// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./interfaces/IConfidentialCPMM.sol";
import "./interfaces/IConfidentialCPMMFactory.sol";
import "./interfaces/IConfidentialInitializationStrategy.sol";
import "./interfaces/IConfidentialInitializationStrategyRegistry.sol";
import "./interfaces/IConfidentialLaunchpadMigrator.sol";
import "./ConfidentialLaunchpadMigrator.sol";

/**
 * @title ConfidentialLaunchInitializationStrategy
 * @notice Initialization-only policy for atomic launch-protected pools.
 *
 * The strategy never receives tokens and has no post-initialization callback.
 * The pinned migrator prepares and consumes a creator-authorized launch inside
 * the same transaction as the protected pool's first liquidity operation. A
 * failed migration therefore leaves no commitment or empty reserved pool.
 */
contract ConfidentialLaunchInitializationStrategy is
    IConfidentialInitializationStrategy
{
    uint256 public constant STRATEGY_VERSION = 1;
    uint256 public constant PROTOCOL_VERSION = 3;
    uint8 public constant PRIVACY_MODE = 1;
    address public factory;
    address public strategyRegistry;
    address public migrator;
    bytes32 public migratorRuntimeCodehash;
    bytes32 public factoryRegistration;

    mapping(bytes32 => LaunchRecord) private launches;
    mapping(bytes32 => bytes32) public activeLaunchForPoolKey;
    uint256 private reentrancyState = 1;

    error InvalidFactory();
    error FactoryRegistrationUnauthorized();
    error FactoryRegistrationAlreadyBound();
    error InvalidFactoryRegistration();
    error InvalidLaunch();
    error LaunchAlreadyExists();
    error ActiveLaunchExists();
    error CompletedPoolCannotBeSuperseded();
    error UnknownLaunch();
    error LaunchNotActive();
    error InitializationUnauthorized();
    error StrategyCodeChanged();
    error Reentrancy();

    modifier nonReentrant() {
        if (reentrancyState != 1) revert Reentrancy();
        reentrancyState = 2;
        _;
        reentrancyState = 1;
    }

    constructor(
        address factory_,
        address strategyRegistry_
    ) {
        if (factory_.code.length == 0) revert InvalidFactory();
        if (
            IConfidentialCPMMFactory(factory_).PROTOCOL_VERSION() !=
                PROTOCOL_VERSION ||
            IConfidentialCPMMFactory(factory_).PRIVACY_MODE() != PRIVACY_MODE
        ) revert InvalidFactory();
        if (
            strategyRegistry_.code.length == 0 ||
            IConfidentialInitializationStrategyRegistry(strategyRegistry_)
                .factory() != factory_
        ) revert InvalidFactory();

        factory = factory_;
        strategyRegistry = strategyRegistry_;

        address deployedMigrator = address(
            new ConfidentialLaunchpadMigrator(factory_, address(this))
        );
        migrator = deployedMigrator;
        migratorRuntimeCodehash = deployedMigrator.codehash;
        emit MigratorConfigured(deployedMigrator, migratorRuntimeCodehash);
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return
            interfaceId == type(IConfidentialInitializationStrategy).interfaceId ||
            interfaceId == type(IERC165).interfaceId;
    }

    function configurationFinalized() external pure returns (bool) {
        return true;
    }

    function bindFactoryRegistration(bytes32 registration) external {
        if (msg.sender != strategyRegistry) {
            revert FactoryRegistrationUnauthorized();
        }
        if (factoryRegistration != bytes32(0)) {
            revert FactoryRegistrationAlreadyBound();
        }
        if (registration == bytes32(0) || migrator == address(0)) {
            revert InvalidFactoryRegistration();
        }
        factoryRegistration = registration;
        emit FactoryRegistrationBound(registration);
    }

    function prepareLaunch(
        bytes32 launchId,
        address creator,
        address tokenA,
        address tokenB,
        uint8 decimalsA,
        uint8 decimalsB,
        uint256 feeBps,
        uint64 migrationDeadline,
        bytes32 authorizationHash
    ) external nonReentrant returns (address pool, bytes32 poolKey_) {
        if (msg.sender != migrator || msg.sender.codehash != migratorRuntimeCodehash) {
            revert StrategyCodeChanged();
        }
        if (
            launchId == bytes32(0) ||
            creator == address(0) ||
            tokenA == address(0) ||
            tokenB == address(0) ||
            tokenA == tokenB ||
            authorizationHash == bytes32(0) ||
            migrationDeadline < block.timestamp
        ) revert InvalidLaunch();
        if (
            factoryRegistration == bytes32(0) ||
            !IConfidentialInitializationStrategyRegistry(strategyRegistry)
                .isRegisteredStrategy(address(this))
        ) revert InvalidFactoryRegistration();
        if (launches[launchId].status != LaunchStatus.NONE) {
            revert LaunchAlreadyExists();
        }

        IConfidentialCPMMFactory canonicalFactory =
            IConfidentialCPMMFactory(factory);
        (address token0, address token1, uint8 decimals0, uint8 decimals1) =
            tokenA < tokenB
                ? (tokenA, tokenB, decimalsA, decimalsB)
                : (tokenB, tokenA, decimalsB, decimalsA);
        poolKey_ = canonicalFactory.poolKey(
            token0,
            token1,
            decimals0,
            decimals1,
            feeBps,
            address(this)
        );
        bytes32 previousLaunchId = activeLaunchForPoolKey[poolKey_];
        if (previousLaunchId != bytes32(0)) {
            LaunchRecord storage previous = launches[previousLaunchId];
            if (previous.status == LaunchStatus.MIGRATING) {
                revert ActiveLaunchExists();
            }
            if (previous.status == LaunchStatus.COMPLETED) {
                revert CompletedPoolCannotBeSuperseded();
            }
        }

        pool = canonicalFactory.getOrCreatePoolForCommitment(
            token0, token1, decimals0, decimals1, feeBps
        );
        if (IConfidentialCPMM(pool).initialized()) {
            revert CompletedPoolCannotBeSuperseded();
        }

        launches[launchId] = LaunchRecord({
            authorizationHash: authorizationHash,
            poolKey: poolKey_,
            creator: creator,
            pool: pool,
            migrationDeadline: migrationDeadline,
            status: LaunchStatus.MIGRATING
        });
        activeLaunchForPoolKey[poolKey_] = launchId;
        emit LaunchPrepared(
            launchId,
            poolKey_,
            pool,
            creator,
            migrationDeadline,
            authorizationHash
        );
    }

    function authorizeInitialization(
        bytes32 launchId,
        address migratorCaller,
        address pool,
        address creator,
        bytes32 authorizationHash
    ) external nonReentrant returns (bytes32 poolKey) {
        if (msg.sender != factory) revert InitializationUnauthorized();
        if (
            migratorCaller != migrator ||
            migratorCaller.codehash != migratorRuntimeCodehash
        ) revert StrategyCodeChanged();
        LaunchRecord storage record = launches[launchId];
        if (record.status == LaunchStatus.NONE) revert UnknownLaunch();
        if (
            record.status != LaunchStatus.MIGRATING ||
            activeLaunchForPoolKey[record.poolKey] != launchId ||
            block.timestamp > record.migrationDeadline
        ) revert LaunchNotActive();
        if (
            pool != record.pool ||
            creator != record.creator ||
            authorizationHash != record.authorizationHash ||
            IConfidentialCPMM(pool).initialized()
        ) revert InitializationUnauthorized();

        record.status = LaunchStatus.COMPLETED;
        poolKey = record.poolKey;
        emit LaunchInitializationAuthorized(
            launchId,
            pool,
            creator,
            authorizationHash
        );
    }

    function getLaunch(
        bytes32 launchId
    ) external view returns (LaunchRecord memory) {
        return launches[launchId];
    }

}
