// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IPublicLPTokenFactory {
    function create(address pool) external returns (address token);
    function poolByToken(address token) external view returns (address);
    function issuerByToken(address token) external view returns (address);
    function isIssuedToken(address pool, address token, address issuer)
        external
        view
        returns (bool);
}
