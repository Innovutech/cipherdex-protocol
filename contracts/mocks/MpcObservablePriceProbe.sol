// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@coti-io/coti-contracts/contracts/utils/mpc/MpcCore.sol";

/**
 * @title MpcObservablePriceProbe
 * @notice Disposable COTI testnet probe for measuring confidential price publication.
 * @dev This contract does not transfer tokens and is not a deployable AMM component.
 */
contract MpcObservablePriceProbe {
    uint256 public constant PRICE_SCALE = 1e18;
    uint8 public constant MODE_DISABLED = 0;
    uint8 public constant MODE_IMMEDIATE = 1;
    uint8 public constant MODE_DELAYED = 2;

    address public immutable owner;
    uint256 public immutable scale0;
    uint256 public immutable scale1;
    uint256 public immutable feeBps;
    uint256 public immutable priceQuantumX18;
    uint32 public immutable minimumOperations;
    uint64 public immutable minimumInterval;
    uint8 public immutable observationMode;

    ctUint256 private reserve0State;
    ctUint256 private reserve1State;
    ctUint256 private pendingPriceBucketState;

    uint32 public operationsSinceObservation;
    uint64 public lastObservationAt;
    bool public hasPendingObservation;
    uint64 public pendingObservationAt;
    uint32 public pendingActivityCount;

    uint256 public publicPriceBucketX18;
    uint64 public publicObservationAt;
    uint32 public publicActivityCount;
    bool public closed;

    error Unauthorized();
    error Closed();
    error InvalidConfiguration();
    error InvalidAmount();
    error NativeRecoveryFailed();

    event ObservationAdvanced(
        bool indexed published,
        uint64 indexed observationAt,
        uint32 activityCount
    );
    event ProbeClosed(address indexed recipient);

    modifier onlyOpen() {
        if (closed) revert Closed();
        _;
    }

    constructor(
        address owner_,
        uint256 reserve0_,
        uint256 reserve1_,
        uint8 token0Decimals_,
        uint8 token1Decimals_,
        uint256 feeBps_,
        uint256 priceQuantumX18_,
        uint32 minimumOperations_,
        uint64 minimumInterval_,
        uint8 observationMode_
    ) {
        if (
            owner_ == address(0) ||
            reserve0_ == 0 ||
            reserve1_ == 0 ||
            token0Decimals_ > 18 ||
            token1Decimals_ > 18 ||
            feeBps_ >= 10_000 ||
            priceQuantumX18_ == 0 ||
            minimumOperations_ == 0 ||
            observationMode_ > MODE_DELAYED
        ) revert InvalidConfiguration();

        owner = owner_;
        scale0 = 10 ** (18 - token0Decimals_);
        scale1 = 10 ** (18 - token1Decimals_);
        feeBps = feeBps_;
        priceQuantumX18 = priceQuantumX18_;
        minimumOperations = minimumOperations_;
        minimumInterval = minimumInterval_;
        observationMode = observationMode_;
        lastObservationAt = uint64(block.timestamp);
        reserve0State = MpcCore.offBoard(MpcCore.setPublic256(reserve0_));
        reserve1State = MpcCore.offBoard(MpcCore.setPublic256(reserve1_));
    }

    /**
     * @notice Executes only the confidential arithmetic and reserve writes of a CPMM swap.
     * @dev Token movement, allowances, slippage and fees are intentionally outside this gas probe.
     */
    function executeSwapLike(
        itUint256 calldata amountIn,
        bool zeroForOne
    ) external onlyOpen returns (bool published) {
        gtUint256 input = MpcCore.validateCiphertext(amountIn);
        if (!MpcCore.decrypt(MpcCore.gt(input, uint256(0)))) revert InvalidAmount();

        gtUint256 reserve0 = MpcCore.onBoard(reserve0State);
        gtUint256 reserve1 = MpcCore.onBoard(reserve1State);
        gtUint256 reserveIn = zeroForOne ? reserve0 : reserve1;
        gtUint256 reserveOut = zeroForOne ? reserve1 : reserve0;

        gtUint256 netAmountIn = MpcCore.div(
            MpcCore.checkedMul(input, 10_000 - feeBps),
            10_000
        );
        if (!MpcCore.decrypt(MpcCore.gt(netAmountIn, uint256(0)))) {
            revert InvalidAmount();
        }

        gtUint256 nextReserveIn = MpcCore.checkedAdd(reserveIn, netAmountIn);
        gtUint256 invariant = MpcCore.checkedMul(reserveIn, reserveOut);
        gtUint256 quotient = MpcCore.div(invariant, nextReserveIn);
        gtUint256 remainder = MpcCore.rem(invariant, nextReserveIn);
        gtUint256 retainedReserve = MpcCore.add(
            quotient,
            MpcCore.mux(
                MpcCore.gt(remainder, uint256(0)),
                MpcCore.setPublic256(uint256(1)),
                uint256(0)
            )
        );
        gtUint256 amountOut = MpcCore.checkedSub(reserveOut, retainedReserve);
        if (!MpcCore.decrypt(MpcCore.gt(amountOut, uint256(0)))) revert InvalidAmount();

        gtUint256 nextReserve0 = zeroForOne ? nextReserveIn : retainedReserve;
        gtUint256 nextReserve1 = zeroForOne ? retainedReserve : nextReserveIn;
        reserve0State = MpcCore.offBoard(nextReserve0);
        reserve1State = MpcCore.offBoard(nextReserve1);
        return _recordOperation(nextReserve0, nextReserve1);
    }

    function closeAndRecover(address payable recipient) external {
        if (msg.sender != owner) revert Unauthorized();
        if (closed) revert Closed();
        closed = true;
        (bool ok, ) = recipient.call{value: address(this).balance}("");
        if (!ok) revert NativeRecoveryFailed();
        emit ProbeClosed(recipient);
    }

    function _recordOperation(
        gtUint256 reserve0,
        gtUint256 reserve1
    ) internal returns (bool published) {
        if (observationMode == MODE_DISABLED) return false;

        uint32 activityCount = operationsSinceObservation + 1;
        operationsSinceObservation = activityCount;
        if (
            activityCount < minimumOperations ||
            block.timestamp - uint256(lastObservationAt) < minimumInterval
        ) return false;

        gtUint256 bucket = _quantizedPrice(reserve0, reserve1);
        uint64 observedAt = uint64(block.timestamp);
        operationsSinceObservation = 0;
        lastObservationAt = observedAt;

        if (observationMode == MODE_IMMEDIATE) {
            publicPriceBucketX18 = MpcCore.decrypt(bucket);
            publicObservationAt = observedAt;
            publicActivityCount = activityCount;
            emit ObservationAdvanced(true, observedAt, activityCount);
            return true;
        }

        if (hasPendingObservation) {
            publicPriceBucketX18 = MpcCore.decrypt(
                MpcCore.onBoard(pendingPriceBucketState)
            );
            publicObservationAt = pendingObservationAt;
            publicActivityCount = pendingActivityCount;
            published = true;
        }
        pendingPriceBucketState = MpcCore.offBoard(bucket);
        pendingObservationAt = observedAt;
        pendingActivityCount = activityCount;
        hasPendingObservation = true;
        emit ObservationAdvanced(published, observedAt, activityCount);
    }

    function _quantizedPrice(
        gtUint256 reserve0,
        gtUint256 reserve1
    ) internal returns (gtUint256 bucket) {
        gtUint256 normalized0 = MpcCore.checkedMul(reserve0, scale0);
        gtUint256 normalized1 = MpcCore.checkedMul(reserve1, scale1);
        gtUint256 priceX18 = MpcCore.div(
            MpcCore.checkedMul(normalized1, PRICE_SCALE),
            normalized0
        );
        gtUint256 bucketIndex = MpcCore.div(priceX18, priceQuantumX18);
        return MpcCore.checkedMul(bucketIndex, priceQuantumX18);
    }
}
