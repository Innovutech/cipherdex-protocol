// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/introspection/IERC165.sol";

interface IConfidentialInitializationStrategy is IERC165 {
    enum LaunchStatus {
        NONE,
        COMMITTED,
        CANCELED,
        EXPIRED,
        COMPLETED
    }

    struct LaunchCommitment {
        bytes32 launchId;
        address creator;
        address token0;
        address token1;
        uint8 decimals0;
        uint8 decimals1;
        uint256 feeBps;
        uint8 privacyMode;
        uint256 poolVersion;
        address factory;
        address migrator;
        address initializationStrategy;
        address launchAuthority;
        uint256 chainId;
        uint64 authorizationDeadline;
        uint64 migrationDeadline;
    }

    struct LaunchRecord {
        bytes32 commitmentHash;
        bytes32 poolKey;
        address creator;
        address pool;
        uint64 migrationDeadline;
        LaunchStatus status;
    }

    event MigratorConfigured(address indexed migrator, bytes32 runtimeCodehash);
    event FactoryRegistrationBound(bytes32 indexed registration);
    event LaunchCommitted(
        bytes32 indexed launchId,
        bytes32 indexed poolKey,
        address indexed pool,
        address creator,
        uint64 migrationDeadline,
        bytes32 commitmentHash
    );
    event LaunchCanceled(bytes32 indexed launchId, bytes32 indexed poolKey);
    event LaunchExpired(bytes32 indexed launchId, bytes32 indexed poolKey);
    event LaunchInitializationAuthorized(
        bytes32 indexed launchId,
        address indexed pool,
        address indexed creator,
        bytes32 commitmentHash
    );

    function STRATEGY_VERSION() external view returns (uint256);
    function PROTOCOL_VERSION() external view returns (uint256);
    function PRIVACY_MODE() external view returns (uint8);
    function factory() external view returns (address);
    function strategyRegistry() external view returns (address);
    function migrator() external view returns (address);
    function migratorRuntimeCodehash() external view returns (bytes32);
    function launchAuthority() external view returns (address);
    function configurationFinalized() external view returns (bool);
    function factoryRegistration() external view returns (bytes32);

    function bindFactoryRegistration(bytes32 registration) external;
    function launchCommitmentDigest(
        LaunchCommitment calldata commitment
    ) external view returns (bytes32);
    function commitLaunch(
        LaunchCommitment calldata commitment,
        bytes calldata creatorAuthorization,
        bytes calldata authorityAuthorization
    ) external returns (address pool, bytes32 commitmentHash);
    function cancelLaunch(bytes32 launchId) external;
    function expireLaunch(bytes32 launchId) external;
    function authorizeInitialization(
        bytes32 launchId,
        address migratorCaller,
        address pool,
        address creator,
        bytes32 commitmentHash
    ) external returns (bytes32 poolKey);
    function getLaunch(bytes32 launchId) external view returns (LaunchRecord memory);
    function activeLaunchForPoolKey(bytes32 poolKey) external view returns (bytes32);
}
