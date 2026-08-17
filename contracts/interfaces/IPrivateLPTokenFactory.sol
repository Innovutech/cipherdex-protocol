// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IPrivateLPTokenFactory {
    function create(address pool) external returns (address token);
    function isIssuedToken(
        address pool,
        address token,
        address issuer
    ) external view returns (bool);
}
