// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@coti-io/coti-contracts/contracts/token/PrivateERC20/IPrivateERC20.sol";
import "@coti-io/coti-contracts/contracts/utils/mpc/MpcCore.sol";

interface IMpcBestExecutionPoolProbe {
    function quoteGt(gtUint256 amountIn) external returns (gtUint256);
    function settleGt(address recipient, gtUint256 amountIn, gtUint256 minimumOut)
        external
        returns (gtUint256 amountOut);
}

/**
 * @dev Testnet-only probe for transaction-scoped GT reuse and private escrow.
 * This contract is not the production CipherDEX router.
 */
contract MpcBestExecutionRouterProbe {
    IPrivateERC20 public immutable tokenIn;
    address public immutable pool0;
    address public immutable pool1;
    address public immutable configurator;
    address public immutable authorizedCaller;
    bool public closed;
    mapping(bytes32 => bool) private consumedInputs;
    mapping(address => mapping(bytes32 => bool)) public usedRequestIds;
    uint256 private reentrancyState = 1;

    error InvalidConfiguration();
    error InputAlreadyConsumed();
    error RequestAlreadyUsed();
    error InvalidRequestId();
    error DeadlineExpired();
    error Reentrancy();
    error PrivateTransferAmountMismatch();
    error QuoteSettlementMismatch();
    error ResidualAllowance();
    error Unauthorized();
    error Closed();
    error RecoveryMismatch();

    event ProbeBestQuote(
        address indexed caller,
        bytes32 indexed requestId,
        address indexed selectedPool,
        ctUint256 result
    );
    event ProbeBestSwap(
        address indexed caller,
        bytes32 indexed requestId,
        address indexed selectedPool,
        ctUint256 result
    );

    modifier nonReentrant() {
        if (reentrancyState != 1) revert Reentrancy();
        reentrancyState = 2;
        _;
        reentrancyState = 1;
    }

    modifier onlyAuthorizedCaller() {
        if (msg.sender != authorizedCaller) revert Unauthorized();
        _;
    }

    modifier onlyOpen() {
        if (closed) revert Closed();
        _;
    }

    constructor(address tokenIn_, address pool0_, address pool1_, address authorizedCaller_) {
        if (
            tokenIn_ == address(0) ||
            pool0_.code.length == 0 ||
            pool1_.code.length == 0 ||
            pool0_ == pool1_ ||
            authorizedCaller_ == address(0)
        ) revert InvalidConfiguration();
        tokenIn = IPrivateERC20(tokenIn_);
        pool0 = pool0_;
        pool1 = pool1_;
        configurator = msg.sender;
        authorizedCaller = authorizedCaller_;
    }

    function requestBestQuoteExactInput(itUint256 calldata amountIn, bytes32 requestId)
        external
        nonReentrant
        onlyAuthorizedCaller
        onlyOpen
        returns (ctUint256 memory result)
    {
        _consumeRequestId(requestId);
        gtUint256 input = _validateAndConsume(amountIn);
        (address selectedPool, gtUint256 bestOutput) = _selectBest(input);
        result = MpcCore.offBoardToUser(bestOutput, msg.sender);
        emit ProbeBestQuote(msg.sender, requestId, selectedPool, result);
    }

    function swapBestExactInput(
        itUint256 calldata amountIn,
        itUint256 calldata minimumOut,
        bytes32 requestId,
        uint64 deadline
    ) external nonReentrant onlyAuthorizedCaller onlyOpen returns (ctUint256 memory result) {
        if (deadline < block.timestamp) revert DeadlineExpired();
        _consumeRequestId(requestId);
        gtUint256 input = _validateAndConsume(amountIn);
        gtUint256 minimum = _validateAndConsume(minimumOut);
        (address selectedPool, gtUint256 bestOutput) = _selectBest(input);

        gtUint256 startingBalance = tokenIn.balanceOf();
        tokenIn.transferFromGT(msg.sender, address(this), input);
        if (!MpcCore.decrypt(MpcCore.eq(tokenIn.balanceOf(), MpcCore.add(startingBalance, input)))) {
            revert PrivateTransferAmountMismatch();
        }

        tokenIn.approveGT(selectedPool, input);
        gtUint256 settledOutput = IMpcBestExecutionPoolProbe(selectedPool).settleGt(
            msg.sender,
            input,
            minimum
        );
        if (!MpcCore.decrypt(MpcCore.eq(settledOutput, bestOutput))) {
            revert QuoteSettlementMismatch();
        }
        if (!MpcCore.decrypt(MpcCore.eq(tokenIn.balanceOf(), startingBalance))) {
            revert PrivateTransferAmountMismatch();
        }
        if (
            !MpcCore.decrypt(MpcCore.eq(tokenIn.allowance(pool0, false), uint256(0))) ||
            !MpcCore.decrypt(MpcCore.eq(tokenIn.allowance(pool1, false), uint256(0)))
        ) revert ResidualAllowance();

        result = MpcCore.offBoardToUser(settledOutput, msg.sender);
        emit ProbeBestSwap(msg.sender, requestId, selectedPool, result);
    }

    function closeAndRecover(address recipient) external nonReentrant {
        if (msg.sender != configurator) revert Unauthorized();
        if (closed) revert Closed();
        if (recipient == address(0)) revert InvalidConfiguration();
        closed = true;

        gtUint256 balance = tokenIn.balanceOf();
        if (!MpcCore.decrypt(MpcCore.eq(balance, uint256(0)))) {
            tokenIn.transferGT(recipient, balance);
        }
        if (!MpcCore.decrypt(MpcCore.eq(tokenIn.balanceOf(), uint256(0)))) {
            revert RecoveryMismatch();
        }
    }

    function _selectBest(gtUint256 input)
        internal
        returns (address selectedPool, gtUint256 bestOutput)
    {
        gtUint256 output0 = IMpcBestExecutionPoolProbe(pool0).quoteGt(input);
        gtUint256 output1 = IMpcBestExecutionPoolProbe(pool1).quoteGt(input);
        gtBool secondIsBetter = MpcCore.gt(output1, output0);

        // COTI's mux returns the third argument when the bit is true.
        bestOutput = MpcCore.mux(secondIsBetter, output0, output1);
        selectedPool = MpcCore.decrypt(secondIsBetter) ? pool1 : pool0;
    }

    function _consumeRequestId(bytes32 requestId) internal {
        if (requestId == bytes32(0)) revert InvalidRequestId();
        if (usedRequestIds[msg.sender][requestId]) revert RequestAlreadyUsed();
        usedRequestIds[msg.sender][requestId] = true;
    }

    function _validateAndConsume(itUint256 calldata input) internal returns (gtUint256 value) {
        bytes32 digest = keccak256(
            abi.encode(
                ctUint128.unwrap(input.ciphertext.ciphertextHigh),
                ctUint128.unwrap(input.ciphertext.ciphertextLow),
                input.signature,
                address(this),
                msg.sender,
                msg.sig
            )
        );
        if (consumedInputs[digest]) revert InputAlreadyConsumed();
        value = MpcCore.validateCiphertext(input);
        consumedInputs[digest] = true;
    }
}
