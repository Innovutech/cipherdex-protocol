// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@coti-io/coti-contracts/contracts/utils/mpc/MpcCore.sol";

/**
 * @notice Disposable proof for fixed-layout packing inside standard COTI IT.
 *         It has no asset custody and is not a production ABI.
 */
contract PrivateITPackingProbe {
    uint256 public constant FIELD_BITS = 128;
    uint256 public constant FIELD_BASE = 1 << FIELD_BITS;
    uint256 public constant FIELD_MASK = FIELD_BASE - 1;
    uint8 public constant OPERATION_SWAP = 0;
    uint8 public constant OPERATION_LIQUIDITY = 1;
    uint8 public constant OPERATION_ARITHMETIC = 2;
    uint8 public constant OPERATION_DECODE = 3;

    mapping(bytes32 => bool) private consumedInputs;
    mapping(address => mapping(bytes4 => mapping(bytes32 => bool)))
        public usedRequestIds;
    uint256 public successfulCalls;

    error DeadlineExpired();
    error InputAlreadyConsumed();
    error InvalidAmount();
    error InvalidMode();
    error InvalidRequestId();
    error RequestAlreadyUsed();
    error SlippageExceeded();
    error ArithmeticOverflow();
    error ArithmeticUnderflow();

    event PrivatePackingResult(
        address indexed caller,
        bytes32 indexed requestId,
        uint8 indexed operation,
        uint8 privacyMode,
        ctUint256 highField,
        ctUint256 lowField,
        ctUint256 result
    );

    function swapSeparate(
        itUint256 calldata amountIn,
        itUint256 calldata minimumOut,
        uint8 privacyMode,
        bytes32 requestId,
        uint64 deadline
    ) external returns (ctUint256 memory result) {
        _begin(requestId, deadline, privacyMode);
        gtUint256 high = _validateAndConsume(amountIn, 0);
        gtUint256 low = _validateAndConsume(minimumOut, 1);
        return _completeSwap(high, low, privacyMode, requestId);
    }

    function swapPacked(
        itUint256 calldata packedInput,
        uint8 privacyMode,
        bytes32 requestId,
        uint64 deadline
    ) external returns (ctUint256 memory result) {
        _begin(requestId, deadline, privacyMode);
        (gtUint256 high, gtUint256 low) = _unpack(
            _validateAndConsume(packedInput, 0)
        );
        return _completeSwap(high, low, privacyMode, requestId);
    }

    function liquiditySeparate(
        itUint256 calldata amount0,
        itUint256 calldata amount1,
        uint8 privacyMode,
        bytes32 requestId
    ) external returns (ctUint256 memory result) {
        _begin(requestId, type(uint64).max, privacyMode);
        gtUint256 high = _validateAndConsume(amount0, 0);
        gtUint256 low = _validateAndConsume(amount1, 1);
        return _completeLiquidity(high, low, privacyMode, requestId);
    }

    function liquidityPacked(
        itUint256 calldata packedAmounts,
        uint8 privacyMode,
        bytes32 requestId
    ) external returns (ctUint256 memory result) {
        _begin(requestId, type(uint64).max, privacyMode);
        (gtUint256 high, gtUint256 low) = _unpack(
            _validateAndConsume(packedAmounts, 0)
        );
        return _completeLiquidity(high, low, privacyMode, requestId);
    }

    function arithmeticSeparate(
        itUint256 calldata highInput,
        itUint256 calldata lowInput,
        uint256 multiplier,
        bool subtract,
        bytes32 requestId
    ) external returns (ctUint256 memory result) {
        _begin(requestId, type(uint64).max, 1);
        gtUint256 high = _validateAndConsume(highInput, 0);
        gtUint256 low = _validateAndConsume(lowInput, 1);
        return _completeArithmetic(
            high,
            low,
            multiplier,
            subtract,
            requestId
        );
    }

    function arithmeticPacked(
        itUint256 calldata packedInput,
        uint256 multiplier,
        bool subtract,
        bytes32 requestId
    ) external returns (ctUint256 memory result) {
        _begin(requestId, type(uint64).max, 1);
        (gtUint256 high, gtUint256 low) = _unpack(
            _validateAndConsume(packedInput, 0)
        );
        return _completeArithmetic(
            high,
            low,
            multiplier,
            subtract,
            requestId
        );
    }

    function decodeSeparate(
        itUint256 calldata highInput,
        itUint256 calldata lowInput,
        bytes32 requestId
    ) external returns (ctUint256 memory result) {
        _begin(requestId, type(uint64).max, 1);
        gtUint256 high = _validateAndConsume(highInput, 0);
        gtUint256 low = _validateAndConsume(lowInput, 1);
        successfulCalls += 1;
        return _emitResult(
            requestId,
            OPERATION_DECODE,
            1,
            high,
            low,
            high
        );
    }

    function decodePacked(
        itUint256 calldata packedInput,
        bytes32 requestId
    ) external returns (ctUint256 memory result) {
        _begin(requestId, type(uint64).max, 1);
        (gtUint256 high, gtUint256 low) = _unpack(
            _validateAndConsume(packedInput, 0)
        );
        successfulCalls += 1;
        return _emitResult(
            requestId,
            OPERATION_DECODE,
            1,
            high,
            low,
            high
        );
    }

    function _completeSwap(
        gtUint256 amountIn,
        gtUint256 minimumOut,
        uint8 privacyMode,
        bytes32 requestId
    ) internal returns (ctUint256 memory resultCiphertext) {
        _requirePositive(amountIn);
        gtUint256 output = _mulChecked(
            amountIn,
            MpcCore.setPublic256(uint256(2))
        );
        if (!MpcCore.decrypt(MpcCore.ge(output, minimumOut))) {
            revert SlippageExceeded();
        }
        successfulCalls += 1;
        return _emitResult(
            requestId,
            OPERATION_SWAP,
            privacyMode,
            amountIn,
            minimumOut,
            output
        );
    }

    function _completeLiquidity(
        gtUint256 amount0,
        gtUint256 amount1,
        uint8 privacyMode,
        bytes32 requestId
    ) internal returns (ctUint256 memory resultCiphertext) {
        _requirePositive(amount0);
        _requirePositive(amount1);
        gtUint256 result = _addChecked(amount0, amount1);
        successfulCalls += 1;
        return _emitResult(
            requestId,
            OPERATION_LIQUIDITY,
            privacyMode,
            amount0,
            amount1,
            result
        );
    }

    function _completeArithmetic(
        gtUint256 high,
        gtUint256 low,
        uint256 multiplier,
        bool subtract,
        bytes32 requestId
    ) internal returns (ctUint256 memory resultCiphertext) {
        gtUint256 result = subtract
            ? _subChecked(high, low)
            : _mulChecked(high, MpcCore.setPublic256(multiplier));
        successfulCalls += 1;
        return _emitResult(
            requestId,
            OPERATION_ARITHMETIC,
            1,
            high,
            low,
            result
        );
    }

    function _emitResult(
        bytes32 requestId,
        uint8 operation,
        uint8 privacyMode,
        gtUint256 high,
        gtUint256 low,
        gtUint256 result
    ) internal returns (ctUint256 memory resultCiphertext) {
        ctUint256 memory highCiphertext = MpcCore.offBoardToUser(high, msg.sender);
        ctUint256 memory lowCiphertext = MpcCore.offBoardToUser(low, msg.sender);
        resultCiphertext = MpcCore.offBoardToUser(result, msg.sender);
        emit PrivatePackingResult(
            msg.sender,
            requestId,
            operation,
            privacyMode,
            highCiphertext,
            lowCiphertext,
            resultCiphertext
        );
    }

    function _unpack(
        gtUint256 packed
    ) internal returns (gtUint256 high, gtUint256 low) {
        high = MpcCore.div(packed, FIELD_BASE);
        low = MpcCore.rem(packed, FIELD_BASE);
    }

    function _begin(bytes32 requestId, uint64 deadline, uint8 privacyMode) internal {
        if (deadline < block.timestamp) revert DeadlineExpired();
        if (privacyMode != 1 && privacyMode != 2) revert InvalidMode();
        if (requestId == bytes32(0)) revert InvalidRequestId();
        if (usedRequestIds[msg.sender][msg.sig][requestId]) {
            revert RequestAlreadyUsed();
        }
        usedRequestIds[msg.sender][msg.sig][requestId] = true;
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

    function _requirePositive(gtUint256 value) internal {
        if (!MpcCore.decrypt(MpcCore.gt(value, uint256(0)))) {
            revert InvalidAmount();
        }
    }

    function _addChecked(
        gtUint256 left,
        gtUint256 right
    ) internal returns (gtUint256 result) {
        (gtBool overflow, gtUint256 value) =
            MpcCore.checkedAddWithOverflowBit(left, right);
        if (MpcCore.decrypt(overflow)) revert ArithmeticOverflow();
        return value;
    }

    function _mulChecked(
        gtUint256 left,
        gtUint256 right
    ) internal returns (gtUint256 result) {
        (gtBool overflow, gtUint256 value) =
            MpcCore.checkedMulWithOverflowBit(left, right);
        if (MpcCore.decrypt(overflow)) revert ArithmeticOverflow();
        return value;
    }

    function _subChecked(
        gtUint256 left,
        gtUint256 right
    ) internal returns (gtUint256 result) {
        (gtBool underflow, gtUint256 value) =
            MpcCore.checkedSubWithOverflowBit(left, right);
        if (MpcCore.decrypt(underflow)) revert ArithmeticUnderflow();
        return value;
    }
}
