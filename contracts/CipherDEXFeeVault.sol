// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@coti-io/coti-contracts/contracts/token/PrivateERC20/IPrivateERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/**
 * @title CipherDEXFeeVault
 * @notice Fixed-destination custody boundary for accrued protocol fees.
 *
 * Pools may send only their protocol-owned fee balances here. The beneficiary
 * is immutable, and no caller can choose an alternate withdrawal destination.
 * Private-token sweeps deliberately emit no amount.
 */
contract CipherDEXFeeVault {
    using SafeERC20 for IERC20;

    uint64 public constant MIN_CONFIDENTIAL_SWEEP_DELAY = 24 hours;
    address public immutable beneficiary;
    uint64 public immutable deployedAt;
    mapping(address => uint64) public nextConfidentialSweepAt;
    uint256 private reentrancyState = 1;

    error InvalidBeneficiary();
    error BeneficiaryOnly();
    error InvalidToken();
    error InvalidTokenMode();
    error NothingToSweep();
    error ConfidentialSweepNotReady();
    error Reentrancy();

    event PublicFeesSwept(
        address indexed token,
        address indexed beneficiary,
        uint256 amount
    );
    event ConfidentialFeesSwept(
        address indexed token,
        address indexed beneficiary
    );

    modifier nonReentrant() {
        if (reentrancyState != 1) revert Reentrancy();
        reentrancyState = 2;
        _;
        reentrancyState = 1;
    }

    modifier onlyBeneficiary() {
        if (msg.sender != beneficiary) revert BeneficiaryOnly();
        _;
    }

    constructor(address beneficiary_) {
        if (beneficiary_ == address(0)) revert InvalidBeneficiary();
        beneficiary = beneficiary_;
        deployedAt = uint64(block.timestamp);
    }

    function sweepPublicToken(address token)
        external
        onlyBeneficiary
        nonReentrant
        returns (uint256 amount)
    {
        if (token.code.length == 0) revert InvalidToken();
        if (_isConfidentialToken(token)) revert InvalidTokenMode();
        amount = IERC20(token).balanceOf(address(this));
        if (amount == 0) revert NothingToSweep();
        IERC20(token).safeTransfer(beneficiary, amount);
        emit PublicFeesSwept(token, beneficiary, amount);
    }

    function sweepConfidentialToken(address token)
        external
        onlyBeneficiary
        nonReentrant
    {
        if (token.code.length == 0) revert InvalidToken();
        if (!_isConfidentialToken(token)) revert InvalidTokenMode();
        uint64 earliest = nextConfidentialSweepAt[token];
        if (earliest == 0) earliest = deployedAt + MIN_CONFIDENTIAL_SWEEP_DELAY;
        if (block.timestamp < earliest) revert ConfidentialSweepNotReady();

        nextConfidentialSweepAt[token] = uint64(block.timestamp) + MIN_CONFIDENTIAL_SWEEP_DELAY;
        gtUint256 amount = IPrivateERC20(token).balanceOf();
        IPrivateERC20(token).transferGT(beneficiary, amount);
        emit ConfidentialFeesSwept(token, beneficiary);
    }

    function _isConfidentialToken(address token) internal view returns (bool) {
        (bool ok, bytes memory data) = token.staticcall(
            abi.encodeCall(IERC165.supportsInterface, (type(IPrivateERC20).interfaceId))
        );
        return ok && data.length == 32 && abi.decode(data, (bool));
    }
}
