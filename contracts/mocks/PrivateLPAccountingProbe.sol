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
    uint256 public constant SCALE = 1e18;

    struct LockRecord {
        address owner;
        uint64 unlockAt;
        bool permanent;
        bool active;
        ctUint256 amount;
    }

    address public immutable pool;
    ctUint256 private accountingTotalSharesState;
    ctUint256[2] private feeGrowthState;
    ctUint256[2] private globalRemainderState;
    ctUint256[2] private retiredRemainderState;
    mapping(address => ctUint256[2]) private checkpointState;
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
        return SCALE;
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
        gtUint256 globalNumerator = _addChecked(
            _mulChecked(lpFee, MpcCore.setPublic256(SCALE)),
            _read(globalRemainderState[side])
        );
        gtUint256 growthDelta = MpcCore.div(globalNumerator, supply);
        gtUint256 remainder = MpcCore.rem(globalNumerator, supply);
        feeGrowthState[side] = MpcCore.offBoard(
            _addChecked(_read(feeGrowthState[side]), growthDelta)
        );
        globalRemainderState[side] = MpcCore.offBoard(remainder);
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

    function requestRetiredRemainder(uint8 side, address recipient)
        external
        onlyPool
        returns (ctUint256 memory)
    {
        if (side > 1) revert InvalidPrivateAccountingAmount();
        return MpcCore.offBoardToUser(
            _read(retiredRemainderState[side]),
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

        if (
            to == address(0) &&
            MpcCore.decrypt(MpcCore.eq(nextSupply, uint256(0)))
        ) {
            for (uint8 side = 0; side < 2; side++) {
                retiredRemainderState[side] = MpcCore.offBoard(
                    _addChecked(
                        _read(retiredRemainderState[side]),
                        _read(globalRemainderState[side])
                    )
                );
                globalRemainderState[side] = MpcCore.offBoard(
                    MpcCore.setPublic256(uint256(0))
                );
            }
        }
    }

    function _settle(address owner) internal {
        gtUint256 ownerBalance = _getBalance(owner);
        for (uint8 side = 0; side < 2; side++) {
            gtUint256 growth = _read(feeGrowthState[side]);
            gtUint256 delta = _subChecked(
                growth,
                _read(checkpointState[owner][side])
            );
            gtUint256 holderNumerator = _addChecked(
                _mulChecked(ownerBalance, delta),
                _read(holderCarryState[owner][side])
            );
            gtUint256 newClaim = MpcCore.div(holderNumerator, SCALE);
            gtUint256 carry = MpcCore.rem(holderNumerator, SCALE);
            claimableState[owner][side] = MpcCore.offBoard(
                _addChecked(_read(claimableState[owner][side]), newClaim)
            );
            holderCarryState[owner][side] = MpcCore.offBoard(carry);
            checkpointState[owner][side] = MpcCore.offBoard(growth);
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
            ctUint256 memory retiredRemainder
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
        retiredRemainder = lpToken.requestRetiredRemainder(side, msg.sender);
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
