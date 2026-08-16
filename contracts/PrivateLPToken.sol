// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@coti-io/coti-contracts/contracts/token/PrivateERC20/PrivateERC20.sol";
import "@coti-io/coti-contracts/contracts/utils/mpc/MpcCore.sol";

/**
 * @title PrivateLPToken
 * @notice Pool-bound encrypted LP share token for a ConfidentialCPMM.
 *
 * The official PrivateERC20 transfer and approval paths remain available to
 * LPs, but all clear-amount operations and administrative roles are disabled.
 * Only the bound pool can mint shares or burn a holder's shares while moving
 * them into a protocol-enforced lock.
 */
contract PrivateLPToken is PrivateERC20 {
    address public immutable pool;

    error InvalidPool();
    error PoolOnly();
    error HolderBurnDisabled();

    constructor(address pool_)
        PrivateERC20("CipherDEX Private LP Share", "cLP")
    {
        if (pool_ == address(0)) revert InvalidPool();
        pool = pool_;
        publicAmountsEnabled = false;
        _grantRole(MINTER_ROLE, pool_);
        _revokeRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    function balanceOfGT(address account)
        external
        returns (gtUint256)
    {
        if (msg.sender != pool) revert PoolOnly();
        return _getBalance(account);
    }

    function burnFromPool(address account, gtUint256 amount)
        external
        nonReentrant
    {
        if (msg.sender != pool) revert PoolOnly();
        _burn(account, amount);
    }

    function burn(uint256) public pure override {
        revert HolderBurnDisabled();
    }

    function burn(itUint256 calldata) public pure override {
        revert HolderBurnDisabled();
    }

    function burnGt(gtUint256) public pure override {
        revert HolderBurnDisabled();
    }
}
