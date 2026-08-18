// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@coti-io/coti-contracts/contracts/utils/mpc/MpcCore.sol";

interface IConfidentialLaunchpadMigrator {
    struct MigrationRequest {
        bytes32 launchId;
        bytes32 launchCommitmentHash;
        address tokenA;
        address tokenB;
        uint8 decimalsA;
        uint8 decimalsB;
        uint256 feeBps;
        itUint256 amount0;
        itUint256 amount1;
        itUint256 minShares;
        itUint256 minPriceX18;
        itUint256 maxPriceX18;
        uint64 deadline;
        bytes authorization;
    }

    event LaunchpadMigration(
        bytes32 indexed launchId,
        address indexed creator,
        address indexed pool,
        address initializationStrategy,
        bytes32 launchCommitmentHash
    );
    event LaunchpadLockDisposition(
        address indexed creator,
        address indexed pool,
        uint8 disposition,
        bytes32 lockId,
        uint64 unlockTime
    );

    function PROTOCOL_VERSION() external view returns (uint256);
    function factory() external view returns (address);
    function initializationStrategy() external view returns (address);

    function migrate(MigrationRequest calldata request)
        external
        returns (address pool, ctUint256 memory mintedShares);

    function migrateWithDisposition(
        MigrationRequest calldata request,
        uint8 disposition,
        uint64 unlockTime
    ) external returns (address pool, ctUint256 memory mintedShares, bytes32 lockId);

}
