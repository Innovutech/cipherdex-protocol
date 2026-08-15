// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IPrivateLPTokenFactory {
    function create(address pool) external returns (address token);
}
