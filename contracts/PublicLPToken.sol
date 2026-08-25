// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/**
 * @title PublicLPToken
 * @notice Transferable, permit-enabled full-range LP shares for one public pool.
 * @dev Only the immutable pool can mint, burn, or move shares into and out of
 *      protocol-enforced lock escrow. Holders otherwise receive standard ERC-20
 *      and EIP-2612 behavior from audited OpenZeppelin primitives.
 */
contract PublicLPToken is ERC20Permit {
    address public immutable pool;

    error InvalidPool();
    error PoolOnly();

    modifier onlyPool() {
        if (msg.sender != pool) revert PoolOnly();
        _;
    }

    constructor(address pool_)
        ERC20("CipherDEX Public LP Share", "cLP")
        ERC20Permit("CipherDEX Public LP Share")
    {
        if (pool_ == address(0)) revert InvalidPool();
        pool = pool_;
    }

    function mintFromPool(address account, uint256 amount) external onlyPool {
        _mint(account, amount);
    }

    function burnFromPool(address account, uint256 amount) external onlyPool {
        _burn(account, amount);
    }

    function escrowFromPool(address account, uint256 amount) external onlyPool {
        _transfer(account, pool, amount);
    }

    function releaseFromPool(address account, uint256 amount) external onlyPool {
        _transfer(pool, account, amount);
    }
}
