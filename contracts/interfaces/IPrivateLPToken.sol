// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@coti-io/coti-contracts/contracts/utils/mpc/MpcCore.sol";

/**
 * @dev Pool-only bridge for private LP share accounting.
 *
 * User-facing transfers and encrypted balances are inherited from the
 * official PrivateERC20 implementation. These three methods are intentionally
 * callable only by the bound pool in the concrete token.
 */
interface IPrivateLPToken {
    function pool() external view returns (address);
    function balanceOfGT(address account) external returns (gtUint256);
    function mintGt(address account, gtUint256 amount) external;
    function burnFromPool(address account, gtUint256 amount) external;
}
