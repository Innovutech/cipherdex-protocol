// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IConfidentialCPMMFactory.sol";

contract MockBootstrapAdapter {
    function getOrCreatePoolForBootstrap(
        address factory,
        address tokenA,
        address tokenB,
        uint8 decimalsA,
        uint8 decimalsB,
        uint256 feeBps
    ) external returns (address pool) {
        return IConfidentialCPMMFactory(factory).getOrCreatePoolForBootstrap(
            tokenA,
            tokenB,
            decimalsA,
            decimalsB,
            feeBps
        );
    }
}
