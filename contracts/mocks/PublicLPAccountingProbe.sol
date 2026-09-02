// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @notice Disposable proof that fee settlement can remain inside a pool-bound
 *         fungible LP token without a token-to-pool transfer callback.
 */
contract PublicLPAccountingProbeToken is ERC20 {
    uint256 public constant SCALE = 1 << 128;
    uint256 public constant MAX_OPERAND = SCALE - 1;

    struct LockRecord {
        address owner;
        uint256 amount;
        uint64 unlockAt;
        bool permanent;
        bool active;
    }

    address public immutable pool;
    uint256[2] public feeGrowthWhole;
    uint256[2] public feeGrowthFraction;
    uint256[2] public globalRemainder;
    uint256[2] public lifetimeAccrued;
    mapping(address => uint256[2]) public checkpointWhole;
    mapping(address => uint256[2]) public checkpointFraction;
    mapping(address => uint256[2]) public holderCarry;
    mapping(address => uint256[2]) public claimable;
    mapping(address => uint256) public lockedPrincipal;
    mapping(bytes32 => LockRecord) public locks;

    error PoolOnly();
    error InvalidAmount();
    error LockedPrincipal();
    error InvalidLock();

    modifier onlyPool() {
        if (msg.sender != pool) revert PoolOnly();
        _;
    }

    constructor(address pool_) ERC20("Disposable LP Accounting Probe", "dLP") {
        if (pool_ == address(0)) revert PoolOnly();
        pool = pool_;
    }

    function recordFees(uint8 side, uint256 lpFee) external onlyPool {
        uint256 supply = totalSupply();
        if (
            side > 1 ||
            lpFee == 0 ||
            lpFee > MAX_OPERAND ||
            supply == 0 ||
            supply > MAX_OPERAND
        ) revert InvalidAmount();
        uint256 feeWhole = lpFee / supply;
        uint256 feeRemainder = lpFee % supply;
        uint256 fractionalNumerator =
            feeRemainder * SCALE + globalRemainder[side];
        uint256 fractionIncrement = fractionalNumerator / supply;
        globalRemainder[side] = fractionalNumerator % supply;
        uint256 combinedFraction =
            feeGrowthFraction[side] + fractionIncrement;
        feeGrowthWhole[side] += feeWhole + combinedFraction / SCALE;
        feeGrowthFraction[side] = combinedFraction % SCALE;
        lifetimeAccrued[side] += lpFee;
        if (feeGrowthWhole[side] > lifetimeAccrued[side]) {
            revert InvalidAmount();
        }
    }

    function mintFromPool(address owner, uint256 amount) external onlyPool {
        if (amount == 0 || totalSupply() + amount > MAX_OPERAND) revert InvalidAmount();
        _mint(owner, amount);
    }

    function burnFromPool(address owner, uint256 amount) external onlyPool {
        if (amount == 0) revert InvalidAmount();
        _burn(owner, amount);
    }

    function lockFromPool(
        bytes32 lockId,
        address owner,
        uint256 amount,
        uint64 unlockAt,
        bool permanent
    ) external onlyPool {
        if (
            lockId == bytes32(0) ||
            amount == 0 ||
            locks[lockId].owner != address(0) ||
            amount > balanceOf(owner) - lockedPrincipal[owner]
        ) revert InvalidLock();
        _settle(owner);
        lockedPrincipal[owner] += amount;
        locks[lockId] = LockRecord(owner, amount, unlockAt, permanent, true);
    }

    function unlockFromPool(bytes32 lockId) external onlyPool {
        LockRecord storage record = locks[lockId];
        if (
            !record.active ||
            record.permanent ||
            block.timestamp < record.unlockAt
        ) revert InvalidLock();
        record.active = false;
        lockedPrincipal[record.owner] -= record.amount;
    }

    function consumeClaimFromPool(
        address owner,
        uint8 side
    ) external onlyPool returns (uint256 amount) {
        if (side > 1) revert InvalidAmount();
        _settle(owner);
        amount = claimable[owner][side];
        claimable[owner][side] = 0;
    }

    function previewClaim(address owner, uint8 side) external view returns (uint256) {
        if (side > 1) revert InvalidAmount();
        (uint256 wholeDelta, uint256 fractionDelta) = _growthDelta(owner, side);
        uint256 fractionalNumerator =
            balanceOf(owner) * fractionDelta + holderCarry[owner][side];
        return claimable[owner][side] +
            balanceOf(owner) * wholeDelta +
            fractionalNumerator / SCALE;
    }

    function _update(address from, address to, uint256 amount) internal override {
        if (from != address(0)) _settle(from);
        if (to != address(0) && to != from) _settle(to);
        if (
            from != address(0) &&
            amount > balanceOf(from) - lockedPrincipal[from]
        ) revert LockedPrincipal();

        super._update(from, to, amount);
    }

    function _settle(address owner) internal {
        uint256 ownerBalance = balanceOf(owner);
        for (uint8 side = 0; side < 2; side++) {
            (uint256 wholeDelta, uint256 fractionDelta) =
                _growthDelta(owner, side);
            uint256 fractionalNumerator =
                ownerBalance * fractionDelta + holderCarry[owner][side];
            claimable[owner][side] +=
                ownerBalance * wholeDelta + fractionalNumerator / SCALE;
            holderCarry[owner][side] = fractionalNumerator % SCALE;
            checkpointWhole[owner][side] = feeGrowthWhole[side];
            checkpointFraction[owner][side] = feeGrowthFraction[side];
        }
    }

    function _growthDelta(address owner, uint8 side)
        internal
        view
        returns (uint256 wholeDelta, uint256 fractionDelta)
    {
        wholeDelta = feeGrowthWhole[side] - checkpointWhole[owner][side];
        uint256 currentFraction = feeGrowthFraction[side];
        uint256 previousFraction = checkpointFraction[owner][side];
        if (currentFraction >= previousFraction) {
            fractionDelta = currentFraction - previousFraction;
        } else {
            if (wholeDelta == 0) revert InvalidAmount();
            wholeDelta -= 1;
            fractionDelta = SCALE + currentFraction - previousFraction;
        }
    }
}

contract PublicLPAccountingProbe {
    PublicLPAccountingProbeToken public immutable lpToken;
    uint256[2] public activeReserve;
    uint256[2] public protocolFees;
    uint256[2] public lpFeeLiability;
    uint256[2] public paidClaims;
    uint256 public nextLockNonce;

    error LiabilityUnderflow();
    error LockOwnerOnly();

    constructor() {
        lpToken = new PublicLPAccountingProbeToken(address(this));
    }

    function mint(uint256 amount) external {
        lpToken.mintFromPool(msg.sender, amount);
    }

    function burn(uint256 amount) external {
        lpToken.burnFromPool(msg.sender, amount);
    }

    function accrue(
        uint8 side,
        uint256 netInput,
        uint256 protocolFee,
        uint256 lpFee
    ) external {
        activeReserve[side] += netInput;
        protocolFees[side] += protocolFee;
        lpFeeLiability[side] += lpFee;
        if (lpFee != 0) lpToken.recordFees(side, lpFee);
    }

    function lock(
        uint256 amount,
        uint64 unlockAt,
        bool permanent
    ) external returns (bytes32 lockId) {
        lockId = keccak256(abi.encode(address(this), msg.sender, nextLockNonce++));
        lpToken.lockFromPool(lockId, msg.sender, amount, unlockAt, permanent);
    }

    function unlock(bytes32 lockId) external {
        (address owner, , , , ) = lpToken.locks(lockId);
        if (owner != msg.sender) revert LockOwnerOnly();
        lpToken.unlockFromPool(lockId);
    }

    function claim(uint8 side) external returns (uint256 amount) {
        amount = lpToken.consumeClaimFromPool(msg.sender, side);
        if (amount > lpFeeLiability[side]) revert LiabilityUnderflow();
        lpFeeLiability[side] -= amount;
        paidClaims[side] += amount;
    }
}
