// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@coti-io/coti-contracts/contracts/token/PrivateERC20/IPrivateERC20.sol";
import "@coti-io/coti-contracts/contracts/utils/mpc/MpcCore.sol";

import "./CipherDEXFeePolicy.sol";
import "./interfaces/IConfidentialBestExecution.sol";
import "./interfaces/IConfidentialCPMM.sol";
import "./interfaces/IConfidentialCPMMFactory.sol";

/**
 * @title ConfidentialBestExecutionRouter
 * @notice Canonical single-hop best execution across CipherDEX confidential
 *         fee tiers. Candidate identity is derived exclusively from the bound
 *         factory; callers cannot inject pools or arbitrary execution targets.
 *
 * The current COTI runtime requires MPC quotes to execute in transactions.
 * Outputs remain encrypted for the caller. Only final viability and the winning
 * candidate index are decrypted; input, minimum output, candidate outputs and
 * losing-candidate ordering are never published.
 */
contract ConfidentialBestExecutionRouter is CipherDEXFeePolicy {
    uint256 public constant PROTOCOL_VERSION = 1;
    uint256 private constant CANDIDATE_COUNT = 3;

    address public immutable factory;
    mapping(address => mapping(bytes4 => mapping(bytes32 => bool))) public usedRequestIds;
    mapping(bytes32 => bool) private consumedInputs;
    uint256 private reentrancyState = 1;

    struct CandidateSet {
        address[CANDIDATE_COUNT] pools;
        uint256[CANDIDATE_COUNT] feeTiers;
        uint8 count;
        bool zeroForOne;
        address inputToken;
    }

    error InvalidFactory();
    error InvalidTokenPair();
    error InvalidTokenDecimals();
    error UnsupportedPrivateToken();
    error InvalidCanonicalPool();
    error NoViablePool();
    error InvalidRecipient();
    error InvalidRequestId();
    error RequestAlreadyUsed();
    error InputAlreadyConsumed();
    error DeadlineExpired();
    error Reentrancy();
    error PrivateTransferAmountMismatch();
    error QuoteSettlementMismatch();
    error ResidualAllowance();

    event ConfidentialBestQuoteResult(
        address indexed caller,
        bytes32 indexed requestId,
        address indexed selectedPool,
        uint256 selectedFeeBps,
        bool zeroForOne,
        ctUint256 result
    );

    event ConfidentialBestSwapResult(
        address indexed caller,
        bytes32 indexed requestId,
        address indexed selectedPool,
        uint256 selectedFeeBps,
        bool zeroForOne,
        ctUint256 result
    );

    modifier nonReentrant() {
        if (reentrancyState != 1) revert Reentrancy();
        reentrancyState = 2;
        _;
        reentrancyState = 1;
    }

    constructor(address factory_) {
        if (factory_.code.length == 0) revert InvalidFactory();
        IConfidentialCPMMFactory candidate = IConfidentialCPMMFactory(factory_);
        if (
            candidate.PROTOCOL_VERSION() != 2 ||
            candidate.PRIVACY_MODE() != 1
        ) revert InvalidFactory();
        factory = factory_;
    }

    /**
     * @notice Requests an exact encrypted best quote across every initialized
     *         canonical v1 fee-tier pool for the ordered token pair.
     * @dev This is a paid transaction on the current COTI runtime. It changes
     *      only router replay state and emits one caller-encrypted result.
     */
    function requestBestQuoteExactInput(
        address tokenIn,
        address tokenOut,
        itUint256 calldata amountIn,
        bytes32 requestId,
        uint64 deadline
    ) external nonReentrant returns (ctUint256 memory result) {
        _requireBeforeDeadline(deadline);
        CandidateSet memory candidates = _resolveCandidates(tokenIn, tokenOut);
        _consumeRequestId(requestId);
        gtUint256 input = _validateAndConsume(amountIn);
        (address selectedPool, uint256 selectedFeeBps, gtUint256 bestOutput) =
            _selectBest(candidates, input);

        result = MpcCore.offBoardToUser(bestOutput, msg.sender);
        emit ConfidentialBestQuoteResult(
            msg.sender,
            requestId,
            selectedPool,
            selectedFeeBps,
            candidates.zeroForOne,
            result
        );
    }

    /**
     * @notice Atomically selects and settles the best initialized canonical pool.
     * @dev The router escrows only the exact encrypted input, grants only the
     *      selected pool an exact temporary allowance and returns to its starting
     *      input-token balance with every candidate allowance at zero.
     */
    function swapBestExactInput(
        address tokenIn,
        address tokenOut,
        itUint256 calldata amountIn,
        itUint256 calldata minimumOut,
        bytes32 requestId,
        uint64 deadline
    ) external nonReentrant returns (ctUint256 memory result) {
        _requireBeforeDeadline(deadline);
        CandidateSet memory candidates = _resolveCandidates(tokenIn, tokenOut);
        _consumeRequestId(requestId);
        gtUint256 input = _validateAndConsume(amountIn);
        gtUint256 minimum = _validateAndConsume(minimumOut);
        (address selectedPool, uint256 selectedFeeBps, gtUint256 bestOutput) =
            _selectBest(candidates, input);

        IPrivateERC20 privateInputToken = IPrivateERC20(candidates.inputToken);
        gtUint256 startingBalance = privateInputToken.balanceOf();
        _requireZeroCandidateAllowances(privateInputToken, candidates);
        privateInputToken.transferFromGT(msg.sender, address(this), input);
        gtUint256 fundedBalance = privateInputToken.balanceOf();
        if (
            !MpcCore.decrypt(
                MpcCore.eq(
                    fundedBalance,
                    MpcCore.add(startingBalance, input)
                )
            )
        ) revert PrivateTransferAmountMismatch();

        privateInputToken.approveGT(selectedPool, input);
        gtUint256 settledOutput = IConfidentialBestExecutionPool(selectedPool)
            .settleExactInputForRouter(
                msg.sender,
                input,
                minimum,
                candidates.zeroForOne,
                deadline
            );
        if (!MpcCore.decrypt(MpcCore.eq(settledOutput, bestOutput))) {
            revert QuoteSettlementMismatch();
        }
        gtUint256 finalBalance = privateInputToken.balanceOf();
        if (!MpcCore.decrypt(MpcCore.eq(finalBalance, startingBalance))) {
            revert PrivateTransferAmountMismatch();
        }
        _requireZeroCandidateAllowances(privateInputToken, candidates);

        result = MpcCore.offBoardToUser(settledOutput, msg.sender);
        emit ConfidentialBestSwapResult(
            msg.sender,
            requestId,
            selectedPool,
            selectedFeeBps,
            candidates.zeroForOne,
            result
        );
    }

    function _resolveCandidates(
        address tokenIn,
        address tokenOut
    ) internal view returns (CandidateSet memory candidates) {
        if (
            tokenIn == address(0) ||
            tokenOut == address(0) ||
            tokenIn == tokenOut
        ) revert InvalidTokenPair();

        IConfidentialCPMMFactory canonicalFactory = IConfidentialCPMMFactory(factory);
        if (
            !canonicalFactory.isApprovedPrivateToken(tokenIn) ||
            !canonicalFactory.isApprovedPrivateToken(tokenOut)
        ) revert UnsupportedPrivateToken();

        uint8 tokenInDecimals = _readTokenDecimals(tokenIn);
        uint8 tokenOutDecimals = _readTokenDecimals(tokenOut);
        address token0;
        address token1;
        uint8 decimals0;
        uint8 decimals1;
        if (tokenIn < tokenOut) {
            token0 = tokenIn;
            token1 = tokenOut;
            decimals0 = tokenInDecimals;
            decimals1 = tokenOutDecimals;
            candidates.zeroForOne = true;
        } else {
            token0 = tokenOut;
            token1 = tokenIn;
            decimals0 = tokenOutDecimals;
            decimals1 = tokenInDecimals;
            candidates.zeroForOne = false;
        }
        candidates.inputToken = tokenIn;

        uint256[CANDIDATE_COUNT] memory tiers = [
            LOW_FEE_TIER_BPS,
            STANDARD_FEE_TIER_BPS,
            HIGH_FEE_TIER_BPS
        ];
        for (uint256 index = 0; index < CANDIDATE_COUNT; index++) {
            bytes32 key = canonicalFactory.poolKey(
                token0,
                token1,
                decimals0,
                decimals1,
                tiers[index]
            );
            address pool = canonicalFactory.getPool(key);
            if (pool == address(0)) continue;
            if (
                pool.code.length == 0 ||
                !canonicalFactory.isPool(pool)
            ) revert InvalidCanonicalPool();

            IConfidentialCPMM candidate = IConfidentialCPMM(pool);
            if (
                candidate.PROTOCOL_VERSION() != canonicalFactory.PROTOCOL_VERSION() ||
                candidate.PRIVACY_MODE() != canonicalFactory.PRIVACY_MODE() ||
                candidate.token0() != token0 ||
                candidate.token1() != token1 ||
                candidate.token0Decimals() != decimals0 ||
                candidate.token1Decimals() != decimals1 ||
                candidate.feeBps() != tiers[index]
            ) revert InvalidCanonicalPool();
            if (!candidate.initialized()) continue;

            uint256 candidateIndex = candidates.count;
            candidates.pools[candidateIndex] = pool;
            candidates.feeTiers[candidateIndex] = tiers[index];
            candidates.count += 1;
        }
        if (candidates.count == 0) revert NoViablePool();
    }

    function _selectBest(
        CandidateSet memory candidates,
        gtUint256 input
    ) internal returns (
        address selectedPool,
        uint256 selectedFeeBps,
        gtUint256 bestOutput
    ) {
        gtBool bestValid;
        gtUint256 bestIndex = MpcCore.setPublic256(uint256(0));

        for (uint256 index = 0; index < candidates.count; index++) {
            (gtUint256 candidateOutput, gtBool candidateValid) =
                IConfidentialBestExecutionPool(candidates.pools[index])
                    .quoteExactInputForRouter(input, candidates.zeroForOne);

            if (index == 0) {
                bestOutput = candidateOutput;
                bestValid = candidateValid;
                continue;
            }

            gtBool replace = MpcCore.and(
                candidateValid,
                MpcCore.or(
                    MpcCore.not(bestValid),
                    MpcCore.gt(candidateOutput, bestOutput)
                )
            );
            bestOutput = _selectIf(replace, candidateOutput, bestOutput);
            bestIndex = _selectIf(
                replace,
                MpcCore.setPublic256(index),
                bestIndex
            );
            bestValid = MpcCore.or(bestValid, candidateValid);
        }

        if (!MpcCore.decrypt(bestValid)) revert NoViablePool();
        uint256 selectedIndex = MpcCore.decrypt(bestIndex);
        if (selectedIndex >= candidates.count) revert InvalidCanonicalPool();
        selectedPool = candidates.pools[selectedIndex];
        selectedFeeBps = candidates.feeTiers[selectedIndex];
    }

    function _requireZeroCandidateAllowances(
        IPrivateERC20 token,
        CandidateSet memory candidates
    ) internal {
        for (uint256 index = 0; index < candidates.count; index++) {
            gtUint256 remainingAllowance = token.allowance(
                candidates.pools[index],
                false
            );
            if (
                !MpcCore.decrypt(
                    MpcCore.eq(
                        remainingAllowance,
                        uint256(0)
                    )
                )
            ) revert ResidualAllowance();
        }
    }

    function _consumeRequestId(bytes32 requestId) internal {
        if (requestId == bytes32(0)) revert InvalidRequestId();
        if (usedRequestIds[msg.sender][msg.sig][requestId]) {
            revert RequestAlreadyUsed();
        }
        usedRequestIds[msg.sender][msg.sig][requestId] = true;
    }

    function _validateAndConsume(
        itUint256 calldata input
    ) internal returns (gtUint256 value) {
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

    function _readTokenDecimals(address token) internal view returns (uint8) {
        (bool ok, bytes memory data) = token.staticcall(
            abi.encodeWithSignature("decimals()")
        );
        if (!ok || data.length != 32) revert InvalidTokenDecimals();
        uint256 value = abi.decode(data, (uint256));
        if (value > 18) revert InvalidTokenDecimals();
        return uint8(value);
    }

    /**
     * @dev COTI's MpcCore.mux selects its third argument when condition is true.
     * This wrapper presents conventional `(condition, whenTrue, whenFalse)` order.
     */
    function _selectIf(
        gtBool condition,
        gtUint256 whenTrue,
        gtUint256 whenFalse
    ) internal returns (gtUint256) {
        return MpcCore.mux(condition, whenFalse, whenTrue);
    }

    function _requireBeforeDeadline(uint64 deadline) internal view {
        if (deadline < block.timestamp) revert DeadlineExpired();
    }
}
