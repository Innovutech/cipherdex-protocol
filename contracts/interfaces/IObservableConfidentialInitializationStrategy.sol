// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/introspection/IERC165.sol";

interface IObservableConfidentialInitializationStrategy is IERC165 {
    enum LaunchStatus {
        NONE,
        MIGRATING,
        COMPLETED
    }

    struct LaunchRecord {
        bytes32 authorizationHash;
        bytes32 poolKey;
        address creator;
        address pool;
        uint256 initialPriceReferenceX18;
        uint64 migrationDeadline;
        LaunchStatus status;
    }

    event MigratorConfigured(address indexed migrator, bytes32 runtimeCodehash);
    event FactoryRegistrationBound(bytes32 indexed registration);
    event LaunchPrepared(
        bytes32 indexed launchId,
        bytes32 indexed poolKey,
        address indexed pool,
        address creator,
        uint256 initialPriceReferenceX18,
        uint64 migrationDeadline,
        bytes32 authorizationHash
    );
    event LaunchInitializationAuthorized(
        bytes32 indexed launchId,
        address indexed pool,
        address indexed creator,
        bytes32 authorizationHash
    );

    function STRATEGY_VERSION() external view returns (uint256);
    function PROTOCOL_VERSION() external view returns (uint256);
    function PRIVACY_MODE() external view returns (uint8);
    function factory() external view returns (address);
    function strategyRegistry() external view returns (address);
    function migrator() external view returns (address);
    function migratorRuntimeCodehash() external view returns (bytes32);
    function configurationFinalized() external view returns (bool);
    function factoryRegistration() external view returns (bytes32);
    function bindFactoryRegistration(bytes32 registration) external;
    function prepareLaunch(
        bytes32 launchId,
        address creator,
        address tokenA,
        address tokenB,
        uint8 decimalsA,
        uint8 decimalsB,
        uint256 feeBps,
        uint256 initialPriceReferenceX18,
        uint64 migrationDeadline,
        bytes32 authorizationHash
    ) external returns (address pool, bytes32 poolKey);
    function authorizeInitialization(
        bytes32 launchId,
        address migratorCaller,
        address pool,
        address creator,
        bytes32 authorizationHash,
        uint256 initialPriceReferenceX18
    ) external returns (bytes32 poolKey);
    function getLaunch(bytes32 launchId) external view returns (LaunchRecord memory);
    function activeLaunchForPoolKey(bytes32 poolKey) external view returns (bytes32);
}
