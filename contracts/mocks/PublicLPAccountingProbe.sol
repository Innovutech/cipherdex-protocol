// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @notice Disposable proof that fee settlement can remain inside a pool-bound
 *         fungible LP token without a token-to-pool transfer callback.
 */
contract PublicLPAccountingProbeToken is ERC20 {
    uint256 public constant SCALE = 1e18;

    struct LockRecord {
        address owner;
        uint256 amount;
        uint64 unlockAt;
        bool permanent;
        bool active;
    }

    address public immutable pool;
    uint256[2] public feeGrowth;
    uint256[2] public globalRemainder;
    uint256[2] public retiredRemainder;
    mapping(address => uint256[2]) public checkpoint;
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
        if (side > 1 || lpFee == 0 || totalSupply() == 0) revert InvalidAmount();
        uint256 globalNumerator = lpFee * SCALE + globalRemainder[side];
        feeGrowth[side] += globalNumerator / totalSupply();
        globalRemainder[side] = globalNumerator % totalSupply();
    }

    function mintFromPool(address owner, uint256 amount) external onlyPool {
        if (amount == 0 || totalSupply() + amount > SCALE) revert InvalidAmount();
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
        uint256 numerator =
            balanceOf(owner) * (feeGrowth[side] - checkpoint[owner][side]) +
            holderCarry[owner][side];
        return claimable[owner][side] + numerator / SCALE;
    }

    function _update(address from, address to, uint256 amount) internal override {
        if (from != address(0)) _settle(from);
        if (to != address(0) && to != from) _settle(to);
        if (
            from != address(0) &&
            amount > balanceOf(from) - lockedPrincipal[from]
        ) revert LockedPrincipal();

        super._update(from, to, amount);

        if (to == address(0) && totalSupply() == 0) {
            for (uint8 side = 0; side < 2; side++) {
                retiredRemainder[side] += globalRemainder[side];
                globalRemainder[side] = 0;
            }
        }
    }

    function _settle(address owner) internal {
        uint256 ownerBalance = balanceOf(owner);
        for (uint8 side = 0; side < 2; side++) {
            uint256 delta = feeGrowth[side] - checkpoint[owner][side];
            uint256 holderNumerator =
                ownerBalance * delta + holderCarry[owner][side];
            claimable[owner][side] += holderNumerator / SCALE;
            holderCarry[owner][side] = holderNumerator % SCALE;
            checkpoint[owner][side] = feeGrowth[side];
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
