// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@coti-io/coti-contracts/contracts/token/PrivateERC20/PrivateERC20.sol";
import "@coti-io/coti-contracts/contracts/token/PrivateERC20/IPrivateERC20.sol";
import "@coti-io/coti-contracts/contracts/utils/mpc/MpcCore.sol";

/**
 * @notice Disposable private LP token proving that fee/lock settlement can be
 *         internal to the token by overriding PrivateERC20._update.
 */
contract PrivateLPAccountingProbeToken is PrivateERC20 {
    uint256 public constant SCALE = 1 << 128;
    uint256 public constant MAX_OPERAND = SCALE - 1;

    struct LockRecord {
        address owner;
        uint64 unlockAt;
        bool permanent;
        bool active;
        ctUint256 amount;
    }

    address public immutable pool;
    ctUint256 private accountingTotalSharesState;
    ctUint256[2] private feeGrowthWholeState;
    ctUint256[2] private feeGrowthFractionState;
    ctUint256[2] private globalRemainderState;
    ctUint256[2] private lifetimeAccruedState;
    mapping(address => ctUint256[2]) private checkpointWholeState;
    mapping(address => ctUint256[2]) private checkpointFractionState;
    mapping(address => ctUint256[2]) private holderCarryState;
    mapping(address => ctUint256[2]) private claimableState;
    mapping(address => ctUint256) private lockedPrincipalState;
    mapping(bytes32 => LockRecord) private locks;

    error PoolOnly();
    error InvalidPrivateAccountingAmount();
    error PrivateAccountingOverflow();
    error PrivateAccountingUnderflow();
    error LockedPrivatePrincipal();
    error InvalidPrivateLock();

    modifier onlyPool() {
        if (msg.sender != pool) revert PoolOnly();
        _;
    }

    constructor(address pool_)
        PrivateERC20("Disposable Private LP Accounting Probe", "dpLP")
    {
        if (pool_ == address(0)) revert PoolOnly();
        pool = pool_;
        publicAmountsEnabled = false;
        _grantRole(MINTER_ROLE, pool_);
        _revokeRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    function supplyCap() public pure override returns (uint256) {
        return MAX_OPERAND;
    }

    function mintFromPool(address owner, gtUint256 amount) external onlyPool {
        _mint(owner, amount);
    }

    function burnFromPool(address owner, gtUint256 amount) external onlyPool {
        _burn(owner, amount);
    }

    function recordFees(uint8 side, gtUint256 lpFee) external onlyPool {
        if (side > 1) revert InvalidPrivateAccountingAmount();
        gtUint256 supply = _read(accountingTotalSharesState);
        _requirePositive(supply);
        _requirePositive(lpFee);
        if (!MpcCore.decrypt(MpcCore.le(lpFee, MAX_OPERAND))) {
            revert InvalidPrivateAccountingAmount();
        }
        gtUint256 feeWhole = MpcCore.div(lpFee, supply);
        gtUint256 feeRemainder = MpcCore.rem(lpFee, supply);
        gtUint256 fractionalNumerator = _addChecked(
            _mulChecked(feeRemainder, MpcCore.setPublic256(SCALE)),
            _read(globalRemainderState[side])
        );
        gtUint256 fractionIncrement = MpcCore.div(
            fractionalNumerator,
            supply
        );
        globalRemainderState[side] = MpcCore.offBoard(
            MpcCore.rem(fractionalNumerator, supply)
        );
        gtUint256 combinedFraction = _addChecked(
            _read(feeGrowthFractionState[side]),
            fractionIncrement
        );
        gtUint256 wholeCarry = MpcCore.div(combinedFraction, SCALE);
        feeGrowthFractionState[side] = MpcCore.offBoard(
            MpcCore.rem(combinedFraction, SCALE)
        );
        gtUint256 nextWhole = _addChecked(
            _addChecked(_read(feeGrowthWholeState[side]), feeWhole),
            wholeCarry
        );
        gtUint256 nextLifetime = _addChecked(
            _read(lifetimeAccruedState[side]),
            lpFee
        );
        if (!MpcCore.decrypt(MpcCore.le(nextWhole, nextLifetime))) {
            revert InvalidPrivateAccountingAmount();
        }
        feeGrowthWholeState[side] = MpcCore.offBoard(nextWhole);
        lifetimeAccruedState[side] = MpcCore.offBoard(nextLifetime);
    }

    function lockFromPool(
        bytes32 lockId,
        address owner,
        gtUint256 amount,
        uint64 unlockAt,
        bool permanent
    ) external onlyPool {
        if (lockId == bytes32(0) || locks[lockId].owner != address(0)) {
            revert InvalidPrivateLock();
        }
        _requirePositive(amount);
        _settle(owner);
        _requireUnlocked(owner, amount);
        lockedPrincipalState[owner] = MpcCore.offBoard(
            _addChecked(_read(lockedPrincipalState[owner]), amount)
        );
        locks[lockId] = LockRecord(
            owner,
            unlockAt,
            permanent,
            true,
            MpcCore.offBoard(amount)
        );
    }

    function unlockFromPool(bytes32 lockId, address expectedOwner) external onlyPool {
        LockRecord storage record = locks[lockId];
        if (
            !record.active ||
            record.owner != expectedOwner ||
            record.permanent ||
            block.timestamp < record.unlockAt
        ) revert InvalidPrivateLock();
        gtUint256 amount = _read(record.amount);
        lockedPrincipalState[record.owner] = MpcCore.offBoard(
            _subChecked(_read(lockedPrincipalState[record.owner]), amount)
        );
        record.active = false;
    }

    function consumeClaimFromPool(
        address owner,
        uint8 side
    ) external onlyPool returns (gtUint256 amount) {
        if (side > 1) revert InvalidPrivateAccountingAmount();
        _settle(owner);
        amount = _read(claimableState[owner][side]);
        claimableState[owner][side] = MpcCore.offBoard(
            MpcCore.setPublic256(uint256(0))
        );
    }

    function requestMyClaimable(uint8 side) external returns (ctUint256 memory) {
        if (side > 1) revert InvalidPrivateAccountingAmount();
        _settle(msg.sender);
        return MpcCore.offBoardToUser(
            _read(claimableState[msg.sender][side]),
            msg.sender
        );
    }

    function requestMyLockedPrincipal() external returns (ctUint256 memory) {
        return MpcCore.offBoardToUser(
            _read(lockedPrincipalState[msg.sender]),
            msg.sender
        );
    }

    function diagnosticHolderState(address owner)
        external
        onlyPool
        returns (
            gtUint256 balance,
            gtUint256 locked,
            gtUint256 claim0,
            gtUint256 claim1
        )
    {
        _settle(owner);
        balance = _getBalance(owner);
        locked = _read(lockedPrincipalState[owner]);
        claim0 = _read(claimableState[owner][0]);
        claim1 = _read(claimableState[owner][1]);
    }

    function lockInfo(bytes32 lockId)
        external
        view
        returns (address owner, uint64 unlockAt, bool permanent, bool active)
    {
        LockRecord storage record = locks[lockId];
        return (
            record.owner,
            record.unlockAt,
            record.permanent,
            record.active
        );
    }

    function requestTotalShares(address recipient)
        external
        onlyPool
        returns (ctUint256 memory)
    {
        return MpcCore.offBoardToUser(
            _read(accountingTotalSharesState),
            recipient
        );
    }

    function requestGlobalRemainder(uint8 side, address recipient)
        external
        onlyPool
        returns (ctUint256 memory)
    {
        if (side > 1) revert InvalidPrivateAccountingAmount();
        return MpcCore.offBoardToUser(
            _read(globalRemainderState[side]),
            recipient
        );
    }

    function _update(
        address from,
        address to,
        gtUint256 amount
    ) internal override {
        if (from != address(0)) _settle(from);
        if (to != address(0) && to != from) _settle(to);
        if (from != address(0)) _requireUnlocked(from, amount);

        gtUint256 currentSupply = _read(accountingTotalSharesState);
        gtUint256 nextSupply = currentSupply;
        if (from == address(0)) nextSupply = _addChecked(currentSupply, amount);
        if (to == address(0)) nextSupply = _subChecked(currentSupply, amount);

        super._update(from, to, amount);
        accountingTotalSharesState = MpcCore.offBoard(nextSupply);

    }

    function _settle(address owner) internal {
        gtUint256 ownerBalance = _getBalance(owner);
        for (uint8 side = 0; side < 2; side++) {
            gtUint256 currentWhole = _read(feeGrowthWholeState[side]);
            gtUint256 currentFraction = _read(
                feeGrowthFractionState[side]
            );
            gtUint256 previousWhole = _read(
                checkpointWholeState[owner][side]
            );
            gtUint256 previousFraction = _read(
                checkpointFractionState[owner][side]
            );
            gtUint256 wholeDelta = _subChecked(currentWhole, previousWhole);
            gtUint256 fractionDelta;
            if (MpcCore.decrypt(MpcCore.ge(currentFraction, previousFraction))) {
                fractionDelta = MpcCore.sub(
                    currentFraction,
                    previousFraction
                );
            } else {
                wholeDelta = _subChecked(
                    wholeDelta,
                    MpcCore.setPublic256(uint256(1))
                );
                fractionDelta = _subChecked(
                    _addChecked(MpcCore.setPublic256(SCALE), currentFraction),
                    previousFraction
                );
            }
            gtUint256 fractionalNumerator = _addChecked(
                _mulChecked(ownerBalance, fractionDelta),
                _read(holderCarryState[owner][side])
            );
            gtUint256 newClaim = _addChecked(
                _mulChecked(ownerBalance, wholeDelta),
                MpcCore.div(fractionalNumerator, SCALE)
            );
            claimableState[owner][side] = MpcCore.offBoard(
                _addChecked(_read(claimableState[owner][side]), newClaim)
            );
            holderCarryState[owner][side] = MpcCore.offBoard(
                MpcCore.rem(fractionalNumerator, SCALE)
            );
            checkpointWholeState[owner][side] = MpcCore.offBoard(currentWhole);
            checkpointFractionState[owner][side] = MpcCore.offBoard(
                currentFraction
            );
        }
    }

    function _requireUnlocked(address owner, gtUint256 amount) internal {
        gtUint256 unlocked = _subChecked(
            _getBalance(owner),
            _read(lockedPrincipalState[owner])
        );
        if (!MpcCore.decrypt(MpcCore.ge(unlocked, amount))) {
            revert LockedPrivatePrincipal();
        }
    }

    function _read(ctUint256 memory value) internal returns (gtUint256) {
        if (
            ctUint128.unwrap(value.ciphertextHigh) == 0 &&
            ctUint128.unwrap(value.ciphertextLow) == 0
        ) return MpcCore.setPublic256(uint256(0));
        return MpcCore.onBoard(value);
    }

    function _mulChecked(gtUint256 left, gtUint256 right)
        internal
        returns (gtUint256 result)
    {
        (gtBool overflow, gtUint256 value) =
            MpcCore.checkedMulWithOverflowBit(left, right);
        if (MpcCore.decrypt(overflow)) revert PrivateAccountingOverflow();
        return value;
    }

    function _addChecked(gtUint256 left, gtUint256 right)
        internal
        returns (gtUint256 result)
    {
        (gtBool overflow, gtUint256 value) =
            MpcCore.checkedAddWithOverflowBit(left, right);
        if (MpcCore.decrypt(overflow)) revert PrivateAccountingOverflow();
        return value;
    }

    function _subChecked(gtUint256 left, gtUint256 right)
        internal
        returns (gtUint256 result)
    {
        (gtBool underflow, gtUint256 value) =
            MpcCore.checkedSubWithOverflowBit(left, right);
        if (MpcCore.decrypt(underflow)) revert PrivateAccountingUnderflow();
        return value;
    }

    function _requirePositive(gtUint256 value) internal {
        if (!MpcCore.decrypt(MpcCore.gt(value, uint256(0)))) {
            revert InvalidPrivateAccountingAmount();
        }
    }
}

/**
 * @notice Disposable spender proving delegated PrivateERC20 transfer ordering.
 *         The amount is encrypted for this exact endpoint and the LP token
 *         enforces the owner's prior allowance before its internal settlement.
 */
contract PrivateLPAccountingDelegatedSpenderProbe {
    function transferFrom(
        address lpToken,
        address owner,
        address recipient,
        itUint256 calldata amount
    ) external {
        IPrivateERC20(lpToken).transferFromGT(
            owner,
            recipient,
            MpcCore.validateCiphertext(amount)
        );
    }
}

/**
 * @notice Disposable custody/accounting peer for the private LP token.
 */
contract PrivateLPAccountingProbe {
    bytes4 public constant LOCKED_PRIVATE_PRINCIPAL_SELECTOR =
        bytes4(keccak256("LockedPrivatePrincipal()"));
    uint8 public constant LOCK_DIAGNOSTIC_TRANSFER = 0;
    uint8 public constant LOCK_DIAGNOSTIC_BURN = 1;
    address public immutable token0;
    address public immutable token1;
    PrivateLPAccountingProbeToken public immutable lpToken;
    ctUint256[2] private activeReserveState;
    ctUint256[2] private protocolFeeState;
    ctUint256[2] private lpFeeLiabilityState;
    mapping(bytes32 => bool) private consumedInputs;
    uint256 public nextLockNonce;

    error InvalidTokenPair();
    error InputAlreadyConsumed();
    error PrivateTransferAmountMismatch();
    error PrivateLiabilityUnderflow();
    error LockedDiagnosticUnexpectedSuccess();
    error LockedDiagnosticUnexpectedError(bytes4 actualSelector);

    event PrivateLPAccountingConservationResult(
        address indexed caller,
        uint8 indexed side,
        ctUint256 rawBalance,
        ctUint256 activeReserve,
        ctUint256 protocolFees,
        ctUint256 lpFeeLiability,
        ctUint256 totalShares,
        ctUint256 globalRemainder
    );

    event PrivateLPAccountingDiagnosticSnapshot(
        address indexed caller,
        address indexed otherHolder,
        bytes32 indexed lockId,
        bool lockActive,
        uint64 unlockAt,
        bool permanent,
        ctUint256 callerBalance,
        ctUint256 otherBalance,
        ctUint256 totalShares,
        ctUint256 callerLocked,
        ctUint256 callerClaim0,
        ctUint256 callerClaim1,
        ctUint256 otherClaim0,
        ctUint256 otherClaim1,
        ctUint256 callerAllowance
    );

    event LockedPrivatePrincipalDiagnostic(
        address indexed caller,
        uint8 indexed operation,
        bytes4 errorSelector,
        bytes32 revertDataHash
    );

    constructor(address token0_, address token1_) {
        if (
            token0_ == address(0) ||
            token1_ == address(0) ||
            token0_ == token1_ ||
            token0_.code.length == 0 ||
            token1_.code.length == 0
        ) revert InvalidTokenPair();
        token0 = token0_;
        token1 = token1_;
        lpToken = new PrivateLPAccountingProbeToken(address(this));
    }

    function mintShares(itUint256 calldata amount) external {
        lpToken.mintFromPool(msg.sender, _validateAndConsume(amount, 0));
    }

    function burnShares(itUint256 calldata amount) external {
        lpToken.burnFromPool(msg.sender, _validateAndConsume(amount, 0));
    }

    function accrue(
        uint8 side,
        itUint256 calldata netInput,
        itUint256 calldata protocolFee,
        itUint256 calldata lpFee
    ) external {
        if (side > 1) revert InvalidTokenPair();
        gtUint256 net = _validateAndConsume(netInput, 0);
        gtUint256 protocol = _validateAndConsume(protocolFee, 1);
        gtUint256 lp = _validateAndConsume(lpFee, 2);
        gtUint256 total = _addChecked(_addChecked(net, protocol), lp);
        _pullExact(side == 0 ? token0 : token1, msg.sender, total);
        activeReserveState[side] = MpcCore.offBoard(
            _addChecked(_read(activeReserveState[side]), net)
        );
        protocolFeeState[side] = MpcCore.offBoard(
            _addChecked(_read(protocolFeeState[side]), protocol)
        );
        lpFeeLiabilityState[side] = MpcCore.offBoard(
            _addChecked(_read(lpFeeLiabilityState[side]), lp)
        );
        lpToken.recordFees(side, lp);
    }

    function lockShares(
        itUint256 calldata amount,
        uint64 unlockAt,
        bool permanent
    ) external returns (bytes32 lockId) {
        gtUint256 value = _validateAndConsume(amount, 0);
        lockId = keccak256(abi.encode(address(this), msg.sender, nextLockNonce++));
        lpToken.lockFromPool(lockId, msg.sender, value, unlockAt, permanent);
    }

    function unlockShares(bytes32 lockId) external {
        lpToken.unlockFromPool(lockId, msg.sender);
    }

    function diagnoseLockedTransfer(
        address recipient,
        itUint256 calldata amount
    ) external returns (bytes4 errorSelector, bytes32 revertDataHash) {
        gtUint256 value = _validateAndConsume(amount, 0);
        (bool success, bytes memory revertData) = address(lpToken).call(
            abi.encodeWithSelector(
                IPrivateERC20.transferFromGT.selector,
                msg.sender,
                recipient,
                gtUint256.unwrap(value)
            )
        );
        return _recordLockedDiagnostic(
            LOCK_DIAGNOSTIC_TRANSFER,
            success,
            revertData
        );
    }

    function diagnoseLockedBurn(
        itUint256 calldata amount
    ) external returns (bytes4 errorSelector, bytes32 revertDataHash) {
        gtUint256 value = _validateAndConsume(amount, 0);
        (bool success, bytes memory revertData) = address(lpToken).call(
            abi.encodeWithSelector(
                PrivateLPAccountingProbeToken.burnFromPool.selector,
                msg.sender,
                gtUint256.unwrap(value)
            )
        );
        return _recordLockedDiagnostic(
            LOCK_DIAGNOSTIC_BURN,
            success,
            revertData
        );
    }

    function requestDiagnosticSnapshot(address otherHolder, bytes32 lockId)
        external
    {
        (
            gtUint256 callerBalance,
            gtUint256 callerLocked,
            gtUint256 callerClaim0,
            gtUint256 callerClaim1
        ) = lpToken.diagnosticHolderState(msg.sender);
        (
            gtUint256 otherBalance,
            ,
            gtUint256 otherClaim0,
            gtUint256 otherClaim1
        ) = lpToken.diagnosticHolderState(otherHolder);
        gtUint256 callerAllowance = IPrivateERC20(address(lpToken)).allowance(
            msg.sender,
            true
        );
        (
            address lockOwner,
            uint64 unlockAt,
            bool permanent,
            bool active
        ) = lpToken.lockInfo(lockId);
        if (lockOwner != msg.sender) revert InvalidTokenPair();
        emit PrivateLPAccountingDiagnosticSnapshot(
            msg.sender,
            otherHolder,
            lockId,
            active,
            unlockAt,
            permanent,
            MpcCore.offBoardToUser(callerBalance, msg.sender),
            MpcCore.offBoardToUser(otherBalance, msg.sender),
            lpToken.requestTotalShares(msg.sender),
            MpcCore.offBoardToUser(callerLocked, msg.sender),
            MpcCore.offBoardToUser(callerClaim0, msg.sender),
            MpcCore.offBoardToUser(callerClaim1, msg.sender),
            MpcCore.offBoardToUser(otherClaim0, msg.sender),
            MpcCore.offBoardToUser(otherClaim1, msg.sender),
            MpcCore.offBoardToUser(callerAllowance, msg.sender)
        );
    }

    function claim(uint8 side) external returns (ctUint256 memory amount) {
        if (side > 1) revert InvalidTokenPair();
        gtUint256 value = lpToken.consumeClaimFromPool(msg.sender, side);
        lpFeeLiabilityState[side] = MpcCore.offBoard(
            _subChecked(_read(lpFeeLiabilityState[side]), value)
        );
        _pushExact(side == 0 ? token0 : token1, msg.sender, value);
        return MpcCore.offBoardToUser(value, msg.sender);
    }

    function requestConservation(uint8 side)
        external
        returns (
            ctUint256 memory rawBalance,
            ctUint256 memory activeReserve,
            ctUint256 memory protocolFees,
            ctUint256 memory lpFeeLiability,
            ctUint256 memory totalShares,
            ctUint256 memory globalRemainder
        )
    {
        if (side > 1) revert InvalidTokenPair();
        address token = side == 0 ? token0 : token1;
        rawBalance = MpcCore.offBoardToUser(_privateBalance(token), msg.sender);
        activeReserve = MpcCore.offBoardToUser(
            _read(activeReserveState[side]),
            msg.sender
        );
        protocolFees = MpcCore.offBoardToUser(
            _read(protocolFeeState[side]),
            msg.sender
        );
        lpFeeLiability = MpcCore.offBoardToUser(
            _read(lpFeeLiabilityState[side]),
            msg.sender
        );
        totalShares = lpToken.requestTotalShares(msg.sender);
        globalRemainder = lpToken.requestGlobalRemainder(side, msg.sender);
        emit PrivateLPAccountingConservationResult(
            msg.sender,
            side,
            rawBalance,
            activeReserve,
            protocolFees,
            lpFeeLiability,
            totalShares,
            globalRemainder
        );
    }

    function _validateAndConsume(
        itUint256 calldata input,
        uint8 slot
    ) internal returns (gtUint256 value) {
        bytes32 digest = keccak256(
            abi.encode(
                ctUint128.unwrap(input.ciphertext.ciphertextHigh),
                ctUint128.unwrap(input.ciphertext.ciphertextLow),
                input.signature,
                address(this),
                msg.sender,
                msg.sig,
                slot
            )
        );
        if (consumedInputs[digest]) revert InputAlreadyConsumed();
        value = MpcCore.validateCiphertext(input);
        consumedInputs[digest] = true;
    }

    function _recordLockedDiagnostic(
        uint8 operation,
        bool success,
        bytes memory revertData
    ) internal returns (bytes4 errorSelector, bytes32 revertDataHash) {
        if (success) revert LockedDiagnosticUnexpectedSuccess();
        if (revertData.length >= 4) {
            assembly ("memory-safe") {
                errorSelector := mload(add(revertData, 0x20))
            }
        }
        if (errorSelector != LOCKED_PRIVATE_PRINCIPAL_SELECTOR) {
            revert LockedDiagnosticUnexpectedError(errorSelector);
        }
        revertDataHash = keccak256(revertData);
        emit LockedPrivatePrincipalDiagnostic(
            msg.sender,
            operation,
            errorSelector,
            revertDataHash
        );
    }

    function _privateBalance(address token) internal returns (gtUint256) {
        return IPrivateERC20(token).balanceOf();
    }

    function _pullExact(address token, address from, gtUint256 amount) internal {
        gtUint256 beforeBalance = _privateBalance(token);
        IPrivateERC20(token).transferFromGT(from, address(this), amount);
        gtUint256 afterBalance = _privateBalance(token);
        if (!MpcCore.decrypt(MpcCore.eq(afterBalance, _addChecked(beforeBalance, amount)))) {
            revert PrivateTransferAmountMismatch();
        }
    }

    function _pushExact(address token, address to, gtUint256 amount) internal {
        gtUint256 beforeBalance = _privateBalance(token);
        IPrivateERC20(token).transferGT(to, amount);
        gtUint256 afterBalance = _privateBalance(token);
        if (!MpcCore.decrypt(MpcCore.eq(afterBalance, _subChecked(beforeBalance, amount)))) {
            revert PrivateTransferAmountMismatch();
        }
    }

    function _read(ctUint256 memory value) internal returns (gtUint256) {
        if (
            ctUint128.unwrap(value.ciphertextHigh) == 0 &&
            ctUint128.unwrap(value.ciphertextLow) == 0
        ) return MpcCore.setPublic256(uint256(0));
        return MpcCore.onBoard(value);
    }

    function _addChecked(gtUint256 left, gtUint256 right)
        internal
        returns (gtUint256 result)
    {
        (gtBool overflow, gtUint256 value) =
            MpcCore.checkedAddWithOverflowBit(left, right);
        if (MpcCore.decrypt(overflow)) revert PrivateTransferAmountMismatch();
        return value;
    }

    function _subChecked(gtUint256 left, gtUint256 right)
        internal
        returns (gtUint256 result)
    {
        (gtBool underflow, gtUint256 value) =
            MpcCore.checkedSubWithOverflowBit(left, right);
        if (MpcCore.decrypt(underflow)) revert PrivateLiabilityUnderflow();
        return value;
    }
}
