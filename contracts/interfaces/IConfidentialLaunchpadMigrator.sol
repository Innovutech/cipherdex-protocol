// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@coti-io/coti-contracts/contracts/utils/mpc/MpcCore.sol";

interface IConfidentialLaunchpadMigrator {
    event LaunchpadMigration(address indexed creator, address indexed pool);

    function PROTOCOL_VERSION() external view returns (uint256);
    function factory() external view returns (address);

    function migrate(
        address tokenA,
        address tokenB,
        uint8 decimalsA,
        uint8 decimalsB,
        uint256 feeBps,
        itUint256 calldata amount0,
        itUint256 calldata amount1,
        itUint256 calldata minShares,
        itUint256 calldata minPriceX18,
        itUint256 calldata maxPriceX18,
        uint64 deadline
    ) external returns (address pool, ctUint256 memory mintedShares);
}
