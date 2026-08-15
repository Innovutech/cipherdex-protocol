// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "./CipherDEXFeePolicy.sol";

/**
 * @title PublicCPMM
 * @notice Constant-product pool for ordinary ERC-20 assets.
 *
 * This is deliberately separate from ConfidentialCPMM. Every amount in this
 * mode is public by design, so events and public share accounting may expose
 * the normal ERC-20 settlement data. It shares the same fee and rounding
 * conventions, but does not read or write COTI MPC values.
 */
contract PublicCPMM is CipherDEXFeePolicy {
    using SafeERC20 for IERC20;

    uint256 public constant PROTOCOL_VERSION = 1;
    uint8 public constant PRIVACY_MODE = 0;
    address public immutable token0;
    address public immutable token1;
    uint8 public immutable token0Decimals;
    uint8 public immutable token1Decimals;
    uint256 public immutable scale0;
    uint256 public immutable scale1;
    uint256 public immutable feeBps;
    address public immutable feeVault;

    bool public initialized;
    uint256 public totalShares;
    mapping(address => uint256) public shares;
    uint256 public protocolFees0;
    uint256 public protocolFees1;
    uint256 public nextLockNonce;

    struct LockRecord {
        address owner;
        uint64 unlockTime;
        bool permanent;
        bool released;
        uint256 amount;
    }

    mapping(bytes32 => LockRecord) private locks;
    uint256 private reentrancyState = 1;

    error InvalidTokenPair();
    error InvalidDecimals();
    error InvalidFee();
    error InvalidFeeVault();
    error InvalidAmount();
    error PoolNotInitialized();
    error PoolAlreadyInitialized();
    error UnbalancedInitialLiquidity();
    error InvalidLiquidityRatio();
    error SlippageExceeded();
    error InsufficientLiquidity();
    error InsufficientShares();
    error DeadlineExpired();
    error InvalidLock();
    error Reentrancy();
    error UnmanagedBalance();
    error TransferAmountMismatch();
    error ProtocolFeeAccountingMismatch();
    error NoProtocolFees();

    event SwapExecuted(
        address indexed trader,
        bool indexed zeroForOne,
        uint256 amountIn,
        uint256 amountOut
    );
    event LiquidityAdded(
        address indexed provider,
        uint256 amount0,
        uint256 amount1,
        uint256 shares
    );
    event LiquidityRemoved(
        address indexed provider,
        uint256 amount0,
        uint256 amount1,
        uint256 shares
    );
    event LiquidityLocked(
        bytes32 indexed lockId,
        address indexed owner,
        uint64 unlockTime,
        bool permanent,
        uint256 shares
    );
    event LiquidityUnlocked(bytes32 indexed lockId, address indexed owner, uint256 shares);
    event ProtocolFeeAccrued(address indexed token, uint256 amount);
    event ProtocolFeesCollected(
        address indexed feeVault,
        uint256 token0Amount,
        uint256 token1Amount
    );

    modifier nonReentrant() {
        if (reentrancyState != 1) revert Reentrancy();
        reentrancyState = 2;
        _;
        reentrancyState = 1;
    }

    constructor(
        address token0_,
        address token1_,
        uint8 token0Decimals_,
        uint8 token1Decimals_,
        uint256 feeBps_,
        address feeVault_
    ) {
        if (token0_ == address(0) || token1_ == address(0) || token0_ == token1_) {
            revert InvalidTokenPair();
        }
        if (token0Decimals_ > 18 || token1Decimals_ > 18) revert InvalidDecimals();
        if (!isApprovedFeeTier(feeBps_)) revert InvalidFee();
        if (feeVault_.code.length == 0) revert InvalidFeeVault();
        if (_readTokenDecimals(token0_) != token0Decimals_) revert InvalidDecimals();
        if (_readTokenDecimals(token1_) != token1Decimals_) revert InvalidDecimals();

        token0 = token0_;
        token1 = token1_;
        token0Decimals = token0Decimals_;
        token1Decimals = token1Decimals_;
        scale0 = 10 ** (18 - token0Decimals_);
        scale1 = 10 ** (18 - token1Decimals_);
        feeBps = feeBps_;
        feeVault = feeVault_;
    }

    function quoteExactInput(uint256 amountIn, bool zeroForOne)
        external
        view
        returns (uint256 amountOut)
    {
        (uint256 reserveIn, uint256 reserveOut) = _reserves(zeroForOne);
        return _amountOut(amountIn, reserveIn, reserveOut);
    }

    function swapExactInput(
        uint256 amountIn,
        uint256 minAmountOut,
        bool zeroForOne,
        uint64 deadline
    ) external nonReentrant returns (uint256 amountOut) {
        _requireBeforeDeadline(deadline);
        if (amountIn == 0) revert InvalidAmount();

        IERC20 inputToken = IERC20(zeroForOne ? token0 : token1);
        IERC20 outputToken = IERC20(zeroForOne ? token1 : token0);
        (uint256 reserveIn, uint256 reserveOut) = _reserves(zeroForOne);
        uint256 rawInputBefore = inputToken.balanceOf(address(this));
        inputToken.safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 received = inputToken.balanceOf(address(this)) - rawInputBefore;
        if (received == 0) revert TransferAmountMismatch();

        amountOut = _amountOut(received, reserveIn, reserveOut);
        if (amountOut < minAmountOut) revert SlippageExceeded();
        uint256 netAmountIn = _netAmount(received);
        uint256 protocolFee = _protocolFeeFromTotal(received - netAmountIn);
        if (zeroForOne) {
            protocolFees0 += protocolFee;
        } else {
            protocolFees1 += protocolFee;
        }
        outputToken.safeTransfer(msg.sender, amountOut);
        if (protocolFee != 0) emit ProtocolFeeAccrued(address(inputToken), protocolFee);
        emit SwapExecuted(msg.sender, zeroForOne, received, amountOut);
    }

    function addLiquidity(
        uint256 amount0,
        uint256 amount1,
        uint256 minShares,
        uint64 deadline
    ) external nonReentrant returns (uint256 mintedShares) {
        _requireBeforeDeadline(deadline);
        if (amount0 == 0 || amount1 == 0) revert InvalidAmount();

        IERC20 first = IERC20(token0);
        IERC20 second = IERC20(token1);
        uint256 rawBefore0 = first.balanceOf(address(this));
        uint256 rawBefore1 = second.balanceOf(address(this));
        uint256 before0 = _effectiveBalance(rawBefore0, protocolFees0);
        uint256 before1 = _effectiveBalance(rawBefore1, protocolFees1);
        first.safeTransferFrom(msg.sender, address(this), amount0);
        second.safeTransferFrom(msg.sender, address(this), amount1);
        uint256 received0 = first.balanceOf(address(this)) - rawBefore0;
        uint256 received1 = second.balanceOf(address(this)) - rawBefore1;
        if (received0 == 0 || received1 == 0) revert TransferAmountMismatch();

        if (!initialized) {
            if (before0 != 0 || before1 != 0) revert UnmanagedBalance();
            if (Math.mulDiv(received0, scale0, 1) != Math.mulDiv(received1, scale1, 1)) {
                revert UnbalancedInitialLiquidity();
            }
            mintedShares = Math.mulDiv(received0, scale0, 1);
            initialized = true;
        } else {
            if (before0 == 0 || before1 == 0 || totalShares == 0) revert PoolNotInitialized();
            uint256 proportionalReceived1 = Math.mulDiv(received0, before1, before0);
            if (
                proportionalReceived1 != received1 ||
                mulmod(received0, before1, before0) != 0
            ) revert InvalidLiquidityRatio();
            uint256 share0 = Math.mulDiv(received0, totalShares, before0);
            uint256 share1 = Math.mulDiv(received1, totalShares, before1);
            if (share0 == 0 || share0 != share1) revert InvalidLiquidityRatio();
            mintedShares = share0;
        }

        if (mintedShares < minShares) revert SlippageExceeded();
        totalShares += mintedShares;
        shares[msg.sender] += mintedShares;
        emit LiquidityAdded(msg.sender, received0, received1, mintedShares);
    }

    function removeLiquidity(
        uint256 shareInput,
        uint256 minAmount0,
        uint256 minAmount1,
        uint64 deadline
    ) external nonReentrant returns (uint256 amount0, uint256 amount1) {
        _requireBeforeDeadline(deadline);
        if (shareInput == 0 || totalShares == 0) revert InsufficientShares();
        if (shareInput > shares[msg.sender]) revert InsufficientShares();

        (uint256 reserve0, uint256 reserve1) = _effectiveReserves();
        if (reserve0 == 0 || reserve1 == 0) revert InsufficientLiquidity();
        bool fullExit = shareInput == totalShares;
        amount0 = fullExit ? reserve0 : Math.mulDiv(shareInput, reserve0, totalShares);
        amount1 = fullExit ? reserve1 : Math.mulDiv(shareInput, reserve1, totalShares);
        if (amount0 < minAmount0 || amount1 < minAmount1) revert SlippageExceeded();

        shares[msg.sender] -= shareInput;
        totalShares -= shareInput;
        if (fullExit) initialized = false;
        IERC20(token0).safeTransfer(msg.sender, amount0);
        IERC20(token1).safeTransfer(msg.sender, amount1);
        emit LiquidityRemoved(msg.sender, amount0, amount1, shareInput);
    }

    /**
     * @notice Moves only accrued protocol-owned balances to the immutable vault.
     * @dev Permissionless execution is safe because the destination cannot be
     *      changed. State is cleared before external transfers and restored by
     *      transaction rollback if either transfer fails.
     */
    function collectProtocolFees()
        external
        nonReentrant
        returns (uint256 amount0, uint256 amount1)
    {
        amount0 = protocolFees0;
        amount1 = protocolFees1;
        if (amount0 == 0 && amount1 == 0) revert NoProtocolFees();

        protocolFees0 = 0;
        protocolFees1 = 0;
        if (amount0 != 0) IERC20(token0).safeTransfer(feeVault, amount0);
        if (amount1 != 0) IERC20(token1).safeTransfer(feeVault, amount1);
        emit ProtocolFeesCollected(feeVault, amount0, amount1);
    }

    function effectiveReserves() external view returns (uint256 reserve0, uint256 reserve1) {
        return _effectiveReserves();
    }

    function lockShares(
        uint256 shareInput,
        uint64 unlockTime,
        bool permanent,
        uint64 deadline
    ) external nonReentrant returns (bytes32 lockId) {
        _requireBeforeDeadline(deadline);
        if (shareInput == 0 || shareInput > shares[msg.sender]) revert InsufficientShares();
        if (
            permanent
                ? unlockTime != 0
                : unlockTime <= block.timestamp
        ) revert InvalidLock();

        lockId = keccak256(abi.encode(address(this), msg.sender, nextLockNonce++));
        locks[lockId] = LockRecord({
            owner: msg.sender,
            unlockTime: unlockTime,
            permanent: permanent,
            released: false,
            amount: shareInput
        });
        shares[msg.sender] -= shareInput;
        emit LiquidityLocked(lockId, msg.sender, unlockTime, permanent, shareInput);
    }

    function unlockShares(bytes32 lockId) external nonReentrant {
        LockRecord storage record = locks[lockId];
        if (record.owner != msg.sender || record.released || record.permanent) revert InvalidLock();
        if (block.timestamp < record.unlockTime) revert InvalidLock();
        record.released = true;
        shares[msg.sender] += record.amount;
        emit LiquidityUnlocked(lockId, msg.sender, record.amount);
    }

    function lockInfo(bytes32 lockId)
        external
        view
        returns (address owner, uint64 unlockTime, bool permanent, bool released, uint256 amount)
    {
        LockRecord storage record = locks[lockId];
        return (record.owner, record.unlockTime, record.permanent, record.released, record.amount);
    }

    function _reserves(bool zeroForOne)
        internal
        view
        returns (uint256 reserveIn, uint256 reserveOut)
    {
        (uint256 reserve0, uint256 reserve1) = _effectiveReserves();
        return zeroForOne ? (reserve0, reserve1) : (reserve1, reserve0);
    }

    function _effectiveReserves()
        internal
        view
        returns (uint256 reserve0, uint256 reserve1)
    {
        reserve0 = _effectiveBalance(
            IERC20(token0).balanceOf(address(this)),
            protocolFees0
        );
        reserve1 = _effectiveBalance(
            IERC20(token1).balanceOf(address(this)),
            protocolFees1
        );
    }

    function _effectiveBalance(uint256 rawBalance, uint256 accruedProtocolFee)
        internal
        pure
        returns (uint256)
    {
        if (rawBalance < accruedProtocolFee) revert ProtocolFeeAccountingMismatch();
        return rawBalance - accruedProtocolFee;
    }

    function _amountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut)
        internal
        view
        returns (uint256 amountOut)
    {
        if (amountIn == 0 || reserveIn == 0 || reserveOut == 0) revert InsufficientLiquidity();
        uint256 netIn = _netAmount(amountIn);
        if (netIn == 0) revert InvalidAmount();
        uint256 newReserveIn = reserveIn + netIn;
        if (newReserveIn < reserveIn) revert InsufficientLiquidity();
        uint256 retained = Math.mulDiv(
            reserveIn,
            reserveOut,
            newReserveIn,
            Math.Rounding.Ceil
        );
        if (retained >= reserveOut) revert InsufficientLiquidity();
        amountOut = reserveOut - retained;
        if (amountOut == 0) revert InsufficientLiquidity();
    }

    function _netAmount(uint256 amountIn) internal view returns (uint256) {
        return Math.mulDiv(amountIn, FEE_DENOMINATOR - feeBps, FEE_DENOMINATOR);
    }

    function _requireBeforeDeadline(uint64 deadline) internal view {
        if (deadline < block.timestamp) revert DeadlineExpired();
    }

    function _readTokenDecimals(address token) internal view returns (uint8) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSignature("decimals()"));
        if (!ok || data.length != 32) revert InvalidDecimals();
        uint256 value = abi.decode(data, (uint256));
        if (value > 18) revert InvalidDecimals();
        return uint8(value);
    }
}
