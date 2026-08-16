// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@coti-io/coti-contracts/contracts/utils/mpc/MpcCore.sol";

/**
 * @notice Testnet-only probe that isolates COTI MPC operations under eth_call.
 * @dev The constructor creates all reusable ciphertext in a transaction. None
 *      of the staged read functions calls SetPublic or plaintext Decrypt.
 *      This contract holds no assets and is never deployed by protocol scripts.
 */
contract MpcQuoteCallProbe {
    uint256 private constant FEE_DENOMINATOR = 10_000;
    uint256 private constant FEE_BPS = 30;
    bytes1 private constant UINT256_METADATA = bytes1(uint8(6));
    bytes4 private constant ONBOARD_UINT256_SELECTOR =
        bytes4(keccak256("OnBoard(bytes1,uint256,uint256)"));

    ctUint256 private reserve0;
    ctUint256 private reserve1;
    ctUint256 private reserve0ForQuoteIdentity;
    ctUint256 private zeroConstant;
    ctUint256 private oneConstant;
    ctUint256 private feeDenominatorConstant;
    ctUint256 private netFeeNumeratorConstant;

    constructor(
        uint256 reserve0_,
        uint256 reserve1_,
        address quoteIdentity
    ) {
        gtUint256 reserve0Garbled = MpcCore.setPublic256(reserve0_);
        gtUint256 reserve1Garbled = MpcCore.setPublic256(reserve1_);
        reserve0 = MpcCore.offBoard(reserve0Garbled);
        reserve1 = MpcCore.offBoard(reserve1Garbled);
        zeroConstant = MpcCore.offBoard(MpcCore.setPublic256(uint256(0)));
        oneConstant = MpcCore.offBoard(MpcCore.setPublic256(uint256(1)));
        feeDenominatorConstant = MpcCore.offBoard(
            MpcCore.setPublic256(FEE_DENOMINATOR)
        );
        netFeeNumeratorConstant = MpcCore.offBoard(
            MpcCore.setPublic256(FEE_DENOMINATOR - FEE_BPS)
        );
        reserve0ForQuoteIdentity = MpcCore.offBoardToUser(
            reserve0Garbled,
            quoteIdentity
        );
    }

    /**
     * @notice Mirrors PrivateERC20.balanceOf(address): a ciphertext-only read.
     */
    function storedUserCiphertext() external view returns (ctUint256 memory) {
        return reserve0ForQuoteIdentity;
    }

    function publicDecryptRoundTrip(uint256 value) external returns (uint256) {
        return MpcCore.decrypt(MpcCore.setPublic256(value));
    }

    function rawSetPublic(
        uint256 value
    ) external returns (bool ok, bytes memory data) {
        return address(MPC_PRECOMPILE).call(
            abi.encodeWithSelector(
                ExtendedOperations.SetPublic.selector,
                UINT256_METADATA,
                value
            )
        );
    }

    function rawStoredOnBoard()
        external
        returns (bool ok, bytes memory data)
    {
        return address(MPC_PRECOMPILE).call(
            abi.encodeWithSelector(
                ONBOARD_UINT256_SELECTOR,
                UINT256_METADATA,
                ctUint128.unwrap(reserve0.ciphertextHigh),
                ctUint128.unwrap(reserve0.ciphertextLow)
            )
        );
    }

    function storedRoundTrip() external returns (ctUint256 memory) {
        return MpcCore.offBoardToUser(MpcCore.onBoard(reserve0), msg.sender);
    }

    function validatedRoundTrip(
        itUint256 calldata input
    ) external returns (ctUint256 memory) {
        return MpcCore.offBoardToUser(
            MpcCore.validateCiphertext(input),
            msg.sender
        );
    }

    function storedAddRoundTrip() external returns (ctUint256 memory) {
        gtUint256 result = MpcCore.add(
            MpcCore.onBoard(reserve0),
            MpcCore.onBoard(reserve1)
        );
        return MpcCore.offBoardToUser(result, msg.sender);
    }

    function storedMulDivRoundTrip() external returns (ctUint256 memory) {
        gtUint256 first = MpcCore.onBoard(reserve0);
        gtUint256 second = MpcCore.onBoard(reserve1);
        gtUint256 result = MpcCore.div(MpcCore.mul(first, second), first);
        return MpcCore.offBoardToUser(result, msg.sender);
    }

    function storedCompareMuxRoundTrip() external returns (ctUint256 memory) {
        gtUint256 first = MpcCore.onBoard(reserve0);
        gtUint256 second = MpcCore.onBoard(reserve1);
        gtBool firstIsLower = MpcCore.lt(first, second);
        // MpcCore's mux returns the third argument when the bit is true.
        gtUint256 result = MpcCore.mux(firstIsLower, first, second);
        return MpcCore.offBoardToUser(result, msg.sender);
    }

    /**
     * @notice Full quote with a public amount and confidential stored reserves.
     * @dev Public scalar overloads avoid SetPublic entirely. Solidity validates
     *      the public input and fee calculation before entering MPC.
     */
    function quoteExactInputPublic(
        uint256 amountIn,
        bool zeroForOne
    ) external returns (ctUint256 memory) {
        require(amountIn > 0, "zero input");
        uint256 netAmountIn =
            (amountIn * (FEE_DENOMINATOR - FEE_BPS)) / FEE_DENOMINATOR;
        require(netAmountIn > 0, "zero net input");

        gtUint256 reserveIn = MpcCore.onBoard(
            zeroForOne ? reserve0 : reserve1
        );
        gtUint256 reserveOut = MpcCore.onBoard(
            zeroForOne ? reserve1 : reserve0
        );
        gtUint256 invariant = MpcCore.mul(reserveIn, reserveOut);
        gtUint256 newReserveIn = MpcCore.add(reserveIn, netAmountIn);
        gtUint256 quotient = MpcCore.div(invariant, newReserveIn);
        gtUint256 remainder = MpcCore.rem(invariant, newReserveIn);
        gtBool exact = MpcCore.eq(remainder, uint256(0));
        gtUint256 retainedReserve = MpcCore.mux(
            exact,
            MpcCore.add(quotient, uint256(1)),
            quotient
        );
        gtUint256 output = MpcCore.sub(reserveOut, retainedReserve);
        return MpcCore.offBoardToUser(output, msg.sender);
    }

    /**
     * @notice Full public-input quote using deployment-time encrypted constants.
     * @dev The dynamic amount is a public MPC operand. Every reusable constant
     *      is onboarded from ciphertext stored by the deployment transaction;
     *      this path performs no SetPublic or plaintext Decrypt during eth_call.
     */
    function quoteExactInputStoredConstants(
        uint256 amountIn,
        bool zeroForOne
    ) external returns (ctUint256 memory) {
        require(amountIn > 0, "zero input");
        gtUint256 zero = MpcCore.onBoard(zeroConstant);
        gtUint256 one = MpcCore.onBoard(oneConstant);
        gtUint256 feeDenominator = MpcCore.onBoard(
            feeDenominatorConstant
        );
        gtUint256 netFeeNumerator = MpcCore.onBoard(
            netFeeNumeratorConstant
        );
        gtUint256 reserveIn = MpcCore.onBoard(
            zeroForOne ? reserve0 : reserve1
        );
        gtUint256 reserveOut = MpcCore.onBoard(
            zeroForOne ? reserve1 : reserve0
        );
        gtUint256 netAmountIn = MpcCore.div(
            MpcCore.mul(amountIn, netFeeNumerator),
            feeDenominator
        );
        gtUint256 invariant = MpcCore.mul(reserveIn, reserveOut);
        gtUint256 newReserveIn = MpcCore.add(reserveIn, netAmountIn);
        gtUint256 quotient = MpcCore.div(invariant, newReserveIn);
        gtUint256 remainder = MpcCore.rem(invariant, newReserveIn);
        gtBool exact = MpcCore.eq(remainder, zero);
        gtUint256 retainedReserve = MpcCore.mux(
            exact,
            MpcCore.add(quotient, one),
            quotient
        );
        gtUint256 output = MpcCore.sub(reserveOut, retainedReserve);
        return MpcCore.offBoardToUser(output, msg.sender);
    }

    /**
     * @notice Full encrypted-input quote without SetPublic or plaintext Decrypt.
     */
    function quoteExactInputEncrypted(
        itUint256 calldata amountIn,
        bool zeroForOne
    ) external returns (ctUint256 memory) {
        gtUint256 input = MpcCore.validateCiphertext(amountIn);
        gtUint256 reserveIn = MpcCore.onBoard(
            zeroForOne ? reserve0 : reserve1
        );
        gtUint256 reserveOut = MpcCore.onBoard(
            zeroForOne ? reserve1 : reserve0
        );
        gtUint256 netProduct = MpcCore.mul(
            input,
            FEE_DENOMINATOR - FEE_BPS
        );
        gtUint256 netAmountIn = MpcCore.div(
            netProduct,
            FEE_DENOMINATOR
        );
        gtUint256 invariant = MpcCore.mul(reserveIn, reserveOut);
        gtUint256 newReserveIn = MpcCore.add(reserveIn, netAmountIn);
        gtUint256 quotient = MpcCore.div(invariant, newReserveIn);
        gtUint256 remainder = MpcCore.rem(invariant, newReserveIn);
        gtBool exact = MpcCore.eq(remainder, uint256(0));
        gtUint256 retainedReserve = MpcCore.mux(
            exact,
            MpcCore.add(quotient, uint256(1)),
            quotient
        );
        gtUint256 output = MpcCore.sub(reserveOut, retainedReserve);
        return MpcCore.offBoardToUser(output, msg.sender);
    }
}
