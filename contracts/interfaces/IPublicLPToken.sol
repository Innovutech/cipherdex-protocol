// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";

interface IPublicLPToken is IERC20, IERC20Permit {
    function pool() external view returns (address);
    function mintFromPool(address account, uint256 amount) external;
    function burnFromPool(address account, uint256 amount) external;
    function escrowFromPool(address account, uint256 amount) external;
    function releaseFromPool(address account, uint256 amount) external;
}
