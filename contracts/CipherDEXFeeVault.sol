// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@coti-io/coti-contracts/contracts/token/PrivateERC20/IPrivateERC20.sol";
import "@coti-io/coti-contracts/contracts/utils/mpc/MpcCore.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import "./interfaces/IConfidentialCPMMFactory.sol";
import "./interfaces/IPublicCPMMFactory.sol";

interface IConfidentialFeeSource {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function feeVault() external view returns (address);
    function protocolFeeSwapCount0() external view returns (uint32);
    function protocolFeeSwapCount1() external view returns (uint32);
}

interface IPublicFeeSource {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function feeVault() external view returns (address);
}

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
    uint64 public constant CONFIDENTIAL_EPOCH_SECONDS = 24 hours;
    uint64 public constant MIN_CONFIDENTIAL_AGGREGATED_SWAPS = 8;
    uint256 public constant MAX_CONFIDENTIAL_SWEEP_EPOCHS = 32;
    address public immutable beneficiary;
    uint64 public immutable deployedAt;
    address public immutable confidentialFactoryConfigurator;
    address public confidentialFactory;
    address public publicFactory;
    mapping(address => uint256) public publicFees;
    mapping(address => mapping(uint64 => ctUint256)) private confidentialFeesByEpoch;
    mapping(address => mapping(uint64 => uint64)) public confidentialSwapCountByEpoch;
    mapping(address => uint64[]) private confidentialEpochs;
    mapping(address => uint256) public nextConfidentialEpochIndex;
    uint256 private reentrancyState = 1;

    error InvalidBeneficiary();
    error BeneficiaryOnly();
    error InvalidToken();
    error InvalidTokenMode();
    error NothingToSweep();
    error ConfidentialSweepNotReady();
    error ConfidentialFactoryOnly();
    error ConfidentialFactoryAlreadyConfigured();
    error InvalidConfidentialFactory();
    error InvalidConfidentialFeeSource();
    error PublicFactoryOnly();
    error PublicFactoryAlreadyConfigured();
    error InvalidPublicFactory();
    error InvalidPublicFeeSource();
    error InvalidAggregatedSwapCount();
    error PublicTransferAmountMismatch();
    error PrivateTransferAmountMismatch();
    error ArithmeticOverflow();
    error ArithmeticUnderflow();
    error Reentrancy();

    event PublicFeesSwept(
        address indexed token,
        address indexed beneficiary,
        uint256 amount
    );
    event PublicFeesSweepReceipt(
        address indexed token,
        address indexed beneficiary,
        uint256 debitedAmount,
        uint256 beneficiaryReceived
    );
    event ConfidentialFeesSwept(
        address indexed token,
        address indexed beneficiary,
        uint64 aggregatedSwapCount
    );
    event ConfidentialFactoryConfigured(address indexed factory);
    event PublicFactoryConfigured(address indexed factory);
    event PublicFeesDeposited(
        address indexed token,
        address indexed pool,
        uint256 amount
    );
    event ConfidentialFeesDeposited(
        address indexed token,
        address indexed pool,
        uint64 indexed epoch,
        uint32 aggregatedSwapCount
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
        confidentialFactoryConfigurator = msg.sender;
    }

    function setConfidentialFactory(address factory) external {
        if (msg.sender != confidentialFactoryConfigurator) {
            revert ConfidentialFactoryOnly();
        }
        if (confidentialFactory != address(0)) {
            revert ConfidentialFactoryAlreadyConfigured();
        }
        if (
            factory.code.length == 0 ||
            IConfidentialCPMMFactory(factory).feeVault() != address(this)
        ) revert InvalidConfidentialFactory();
        confidentialFactory = factory;
        emit ConfidentialFactoryConfigured(factory);
    }

    function setPublicFactory(address factory) external {
        if (msg.sender != confidentialFactoryConfigurator) {
            revert PublicFactoryOnly();
        }
        if (publicFactory != address(0)) {
            revert PublicFactoryAlreadyConfigured();
        }
        if (
            factory.code.length == 0 ||
            IPublicCPMMFactory(factory).feeVault() != address(this)
        ) revert InvalidPublicFactory();
        publicFactory = factory;
        emit PublicFactoryConfigured(factory);
    }

    function depositPublicFees(address token, uint256 amount)
        external
        nonReentrant
        returns (uint256 received)
    {
        address factory = publicFactory;
        if (factory == address(0) || !IPublicCPMMFactory(factory).isPool(msg.sender)) {
            revert PublicFactoryOnly();
        }
        if (token.code.length == 0 || amount == 0) revert InvalidToken();
        IPublicFeeSource source = IPublicFeeSource(msg.sender);
        if (
            source.feeVault() != address(this) ||
            (token != source.token0() && token != source.token1())
        ) revert InvalidPublicFeeSource();

        IERC20 publicToken = IERC20(token);
        uint256 sourceBalanceBefore = publicToken.balanceOf(msg.sender);
        uint256 vaultBalanceBefore = publicToken.balanceOf(address(this));
        publicToken.safeTransferFrom(msg.sender, address(this), amount);
        uint256 sourceBalanceAfter = publicToken.balanceOf(msg.sender);
        uint256 vaultBalanceAfter = publicToken.balanceOf(address(this));
        if (
            sourceBalanceAfter > sourceBalanceBefore ||
            vaultBalanceAfter < vaultBalanceBefore ||
            sourceBalanceBefore - sourceBalanceAfter != amount
        ) revert PublicTransferAmountMismatch();

        received = vaultBalanceAfter - vaultBalanceBefore;
        if (received == 0) revert PublicTransferAmountMismatch();
        publicFees[token] += received;
        emit PublicFeesDeposited(token, msg.sender, received);
    }

    function sweepPublicToken(address token)
        external
        onlyBeneficiary
        nonReentrant
        returns (uint256 amount)
    {
        if (token.code.length == 0) revert InvalidToken();
        IERC20 publicToken = IERC20(token);
        uint256 vaultBalanceBefore = publicToken.balanceOf(address(this));
        uint256 beneficiaryBalanceBefore = publicToken.balanceOf(beneficiary);
        amount = publicFees[token];
        if (amount == 0) revert NothingToSweep();
        if (vaultBalanceBefore < amount) revert PublicTransferAmountMismatch();
        publicFees[token] = 0;
        publicToken.safeTransfer(beneficiary, amount);
        uint256 vaultBalanceAfter = publicToken.balanceOf(address(this));
        uint256 beneficiaryBalanceAfter = publicToken.balanceOf(beneficiary);
        if (
            vaultBalanceAfter > vaultBalanceBefore ||
            beneficiaryBalanceAfter < beneficiaryBalanceBefore ||
            vaultBalanceBefore - vaultBalanceAfter != amount
        ) revert PublicTransferAmountMismatch();
        uint256 beneficiaryReceived = beneficiaryBalanceAfter - beneficiaryBalanceBefore;
        emit PublicFeesSwept(token, beneficiary, amount);
        emit PublicFeesSweepReceipt(
            token,
            beneficiary,
            amount,
            beneficiaryReceived
        );
    }

    function depositConfidentialFees(
        address token,
        gtUint256 amount,
        uint32 aggregatedSwapCount
    ) external nonReentrant {
        address factory = confidentialFactory;
        if (factory == address(0) || !IConfidentialCPMMFactory(factory).isPool(msg.sender)) {
            revert ConfidentialFactoryOnly();
        }
        IConfidentialFeeSource source = IConfidentialFeeSource(msg.sender);
        if (source.feeVault() != address(this)) revert InvalidConfidentialFeeSource();

        uint32 sourceCount;
        if (token == source.token0()) {
            sourceCount = source.protocolFeeSwapCount0();
        } else if (token == source.token1()) {
            sourceCount = source.protocolFeeSwapCount1();
        } else {
            revert InvalidConfidentialFeeSource();
        }
        if (aggregatedSwapCount == 0 || sourceCount != aggregatedSwapCount) {
            revert InvalidAggregatedSwapCount();
        }

        gtUint256 balanceBefore = IPrivateERC20(token).balanceOf();
        IPrivateERC20(token).transferFromGT(msg.sender, address(this), amount);
        gtUint256 balanceAfter = IPrivateERC20(token).balanceOf();
        gtUint256 expectedBalanceAfter = _addChecked(balanceBefore, amount);
        if (!MpcCore.decrypt(MpcCore.eq(balanceAfter, expectedBalanceAfter))) {
            revert PrivateTransferAmountMismatch();
        }

        uint64 epoch = uint64(block.timestamp / CONFIDENTIAL_EPOCH_SECONDS);
        uint64 previousCount = confidentialSwapCountByEpoch[token][epoch];
        if (previousCount == 0) confidentialEpochs[token].push(epoch);
        if (previousCount > type(uint64).max - aggregatedSwapCount) {
            revert ArithmeticOverflow();
        }
        confidentialSwapCountByEpoch[token][epoch] =
            previousCount + aggregatedSwapCount;
        confidentialFeesByEpoch[token][epoch] = MpcCore.offBoard(
            _addChecked(_readPrivate(confidentialFeesByEpoch[token][epoch]), amount)
        );
        emit ConfidentialFeesDeposited(token, msg.sender, epoch, aggregatedSwapCount);
    }

    function sweepConfidentialToken(address token)
        external
        onlyBeneficiary
        nonReentrant
    {
        if (token.code.length == 0) revert InvalidToken();
        if (!_isConfidentialToken(token)) revert InvalidTokenMode();
        uint256 start = nextConfidentialEpochIndex[token];
        uint256 end = _matureEpochEnd(token, start);
        uint64 aggregatedSwapCount;
        for (uint256 index = start; index < end; index++) {
            uint64 count = confidentialSwapCountByEpoch[token][confidentialEpochs[token][index]];
            if (aggregatedSwapCount > type(uint64).max - count) revert ArithmeticOverflow();
            aggregatedSwapCount += count;
        }
        if (aggregatedSwapCount < MIN_CONFIDENTIAL_AGGREGATED_SWAPS) {
            revert ConfidentialSweepNotReady();
        }

        gtUint256 amount = MpcCore.setPublic256(uint256(0));
        for (uint256 index = start; index < end; index++) {
            uint64 epoch = confidentialEpochs[token][index];
            amount = _addChecked(amount, _readPrivate(confidentialFeesByEpoch[token][epoch]));
            delete confidentialFeesByEpoch[token][epoch];
            delete confidentialSwapCountByEpoch[token][epoch];
        }
        nextConfidentialEpochIndex[token] = end;

        gtUint256 balanceBefore = IPrivateERC20(token).balanceOf();
        IPrivateERC20(token).transferGT(beneficiary, amount);
        gtUint256 balanceAfter = IPrivateERC20(token).balanceOf();
        gtUint256 expectedBalanceAfter = _subChecked(balanceBefore, amount);
        if (!MpcCore.decrypt(MpcCore.eq(balanceAfter, expectedBalanceAfter))) {
            revert PrivateTransferAmountMismatch();
        }
        emit ConfidentialFeesSwept(token, beneficiary, aggregatedSwapCount);
    }

    function nextConfidentialSweepAt(address token) external view returns (uint64) {
        uint256 index = nextConfidentialEpochIndex[token];
        if (index >= confidentialEpochs[token].length) return 0;
        return (confidentialEpochs[token][index] + 2) * CONFIDENTIAL_EPOCH_SECONDS;
    }

    function confidentialEpochCount(address token) external view returns (uint256) {
        return confidentialEpochs[token].length;
    }

    function confidentialEpochAt(address token, uint256 index) external view returns (uint64) {
        return confidentialEpochs[token][index];
    }

    function _matureEpochEnd(address token, uint256 start) internal view returns (uint256 end) {
        uint256 length = confidentialEpochs[token].length;
        end = start + MAX_CONFIDENTIAL_SWEEP_EPOCHS;
        if (end > length) end = length;
        uint64 currentEpoch = uint64(block.timestamp / CONFIDENTIAL_EPOCH_SECONDS);
        uint256 index = start;
        while (
            index < end &&
            uint256(confidentialEpochs[token][index]) + 2 <= currentEpoch
        ) {
            index++;
        }
        return index;
    }

    function _readPrivate(ctUint256 memory value) internal returns (gtUint256) {
        if (
            ctUint128.unwrap(value.ciphertextHigh) == 0 &&
            ctUint128.unwrap(value.ciphertextLow) == 0
        ) return MpcCore.setPublic256(uint256(0));
        return MpcCore.onBoard(value);
    }

    function _addChecked(gtUint256 left, gtUint256 right) internal returns (gtUint256 result) {
        (gtBool overflow, gtUint256 value) = MpcCore.checkedAddWithOverflowBit(left, right);
        if (MpcCore.decrypt(overflow)) revert ArithmeticOverflow();
        return value;
    }

    function _subChecked(gtUint256 left, gtUint256 right) internal returns (gtUint256 result) {
        (gtBool underflow, gtUint256 value) = MpcCore.checkedSubWithOverflowBit(left, right);
        if (MpcCore.decrypt(underflow)) revert ArithmeticUnderflow();
        return value;
    }

    function _isConfidentialToken(address token) internal view returns (bool) {
        (bool ok, bytes memory data) = token.staticcall(
            abi.encodeCall(IERC165.supportsInterface, (type(IPrivateERC20).interfaceId))
        );
        return ok && data.length == 32 && abi.decode(data, (bool));
    }
}
