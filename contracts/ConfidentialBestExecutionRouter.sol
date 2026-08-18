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
 * @notice Bounded canonical best execution across confidential fee/strategy variants.
 *
 * The nine-bit candidate namespace is factory-derived: three approved fee tiers
 * multiplied by the standard class plus at most two reviewed strategy classes.
 * A request may select at most three bits, preventing arbitrary pool injection
 * and bounding COTI MPC work to the already measured three-candidate ceiling.
 */
contract ConfidentialBestExecutionRouter is CipherDEXFeePolicy {
    uint256 public constant PROTOCOL_VERSION = 2;
    uint8 public constant MAX_CANDIDATES = 3;
    uint8 public constant MAX_POOL_CLASSES = 3;
    uint8 public constant CANDIDATE_BITMAP_BITS = 9;
    uint16 public constant DEFAULT_STANDARD_CANDIDATE_BITMAP =
        uint16((1 << 0) | (1 << 3) | (1 << 6));

    // Constructor-only storage keeps the reviewed runtime bytecode identical
    // across deployments, allowing the factory to authenticate its exact
    // implementation by codehash. There is deliberately no mutator.
    address public factory;
    mapping(address => mapping(bytes4 => mapping(bytes32 => bool))) public usedRequestIds;
    mapping(bytes32 => bool) private consumedInputs;
    uint256 private reentrancyState = 1;

    struct CandidateSet {
        address[MAX_CANDIDATES] pools;
        address[MAX_CANDIDATES] initializationStrategies;
        uint256[MAX_CANDIDATES] feeTiers;
        uint8 count;
        bool zeroForOne;
        address inputToken;
        uint16 candidateBitmap;
    }

    error InvalidFactory();
    error InvalidTokenPair();
    error InvalidTokenDecimals();
    error UnsupportedPrivateToken();
    error InvalidCanonicalPool();
    error InvalidCandidateBitmap();
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
        address selectedInitializationStrategy,
        uint16 candidateBitmap,
        bool zeroForOne,
        ctUint256 result
    );

    event ConfidentialBestSwapResult(
        address indexed caller,
        bytes32 indexed requestId,
        address indexed selectedPool,
        uint256 selectedFeeBps,
        address selectedInitializationStrategy,
        uint16 candidateBitmap,
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
            candidate.PROTOCOL_VERSION() != 3 ||
            candidate.PRIVACY_MODE() != 1 ||
            !candidate.initializationStrategyRegistryFinalized() ||
            candidate.initializationStrategiesLength() > 2
        ) revert InvalidFactory();
        factory = factory_;
    }

    function requestBestQuoteExactInput(
        address tokenIn,
        address tokenOut,
        itUint256 calldata amountIn,
        bytes32 requestId,
        uint64 deadline
    ) external nonReentrant returns (ctUint256 memory result) {
        return _requestBestQuoteExactInput(
            tokenIn,
            tokenOut,
            amountIn,
            DEFAULT_STANDARD_CANDIDATE_BITMAP,
            requestId,
            deadline
        );
    }

    function requestBestQuoteExactInputWithCandidates(
        address tokenIn,
        address tokenOut,
        itUint256 calldata amountIn,
        uint16 candidateBitmap,
        bytes32 requestId,
        uint64 deadline
    ) external nonReentrant returns (ctUint256 memory result) {
        return _requestBestQuoteExactInput(
            tokenIn,
            tokenOut,
            amountIn,
            candidateBitmap,
            requestId,
            deadline
        );
    }

    function _requestBestQuoteExactInput(
        address tokenIn,
        address tokenOut,
        itUint256 calldata amountIn,
        uint16 candidateBitmap,
        bytes32 requestId,
        uint64 deadline
    ) internal returns (ctUint256 memory result) {
        _requireBeforeDeadline(deadline);
        CandidateSet memory candidates = _resolveCandidates(
            tokenIn,
            tokenOut,
            candidateBitmap
        );
        _consumeRequestId(requestId);
        gtUint256 input = _validateAndConsume(amountIn);
        (
            address selectedPool,
            uint256 selectedFeeBps,
            address selectedStrategy,
            gtUint256 bestOutput
        ) = _selectBest(candidates, input);

        result = MpcCore.offBoardToUser(bestOutput, msg.sender);
        emit ConfidentialBestQuoteResult(
            msg.sender,
            requestId,
            selectedPool,
            selectedFeeBps,
            selectedStrategy,
            candidateBitmap,
            candidates.zeroForOne,
            result
        );
    }

    function swapBestExactInput(
        address tokenIn,
        address tokenOut,
        itUint256 calldata amountIn,
        itUint256 calldata minimumOut,
        bytes32 requestId,
        uint64 deadline
    ) external nonReentrant returns (ctUint256 memory result) {
        return _swapBestExactInput(
            tokenIn,
            tokenOut,
            amountIn,
            minimumOut,
            DEFAULT_STANDARD_CANDIDATE_BITMAP,
            requestId,
            deadline
        );
    }

    function swapBestExactInputWithCandidates(
        address tokenIn,
        address tokenOut,
        itUint256 calldata amountIn,
        itUint256 calldata minimumOut,
        uint16 candidateBitmap,
        bytes32 requestId,
        uint64 deadline
    ) external nonReentrant returns (ctUint256 memory result) {
        return _swapBestExactInput(
            tokenIn,
            tokenOut,
            amountIn,
            minimumOut,
            candidateBitmap,
            requestId,
            deadline
        );
    }

    function _swapBestExactInput(
        address tokenIn,
        address tokenOut,
        itUint256 calldata amountIn,
        itUint256 calldata minimumOut,
        uint16 candidateBitmap,
        bytes32 requestId,
        uint64 deadline
    ) internal returns (ctUint256 memory result) {
        _requireBeforeDeadline(deadline);
        CandidateSet memory candidates = _resolveCandidates(
            tokenIn,
            tokenOut,
            candidateBitmap
        );
        _consumeRequestId(requestId);
        gtUint256 input = _validateAndConsume(amountIn);
        gtUint256 minimum = _validateAndConsume(minimumOut);
        (
            address selectedPool,
            uint256 selectedFeeBps,
            address selectedStrategy,
            gtUint256 bestOutput
        ) = _selectBest(candidates, input);

        IPrivateERC20 privateInputToken = IPrivateERC20(candidates.inputToken);
        gtUint256 startingBalance = privateInputToken.balanceOf();
        _requireZeroCandidateAllowances(privateInputToken, candidates);
        privateInputToken.transferFromGT(msg.sender, address(this), input);
        gtUint256 fundedBalance = privateInputToken.balanceOf();
        if (
            !MpcCore.decrypt(
                MpcCore.eq(fundedBalance, MpcCore.add(startingBalance, input))
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
            selectedStrategy,
            candidateBitmap,
            candidates.zeroForOne,
            result
        );
    }

    function _resolveCandidates(
        address tokenIn,
        address tokenOut,
        uint16 candidateBitmap
    ) internal view returns (CandidateSet memory candidates) {
        if (
            tokenIn == address(0) ||
            tokenOut == address(0) ||
            tokenIn == tokenOut
        ) revert InvalidTokenPair();
        if (
            candidateBitmap == 0 ||
            candidateBitmap >= (uint16(1) << CANDIDATE_BITMAP_BITS) ||
            _populationCount(candidateBitmap) > MAX_CANDIDATES
        ) revert InvalidCandidateBitmap();

        IConfidentialCPMMFactory canonicalFactory =
            IConfidentialCPMMFactory(factory);
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
        candidates.candidateBitmap = candidateBitmap;

        uint256[3] memory tiers = [
            LOW_FEE_TIER_BPS,
            STANDARD_FEE_TIER_BPS,
            HIGH_FEE_TIER_BPS
        ];
        uint256 classCount =
            canonicalFactory.initializationStrategiesLength() + 1;
        for (uint256 feeIndex = 0; feeIndex < 3; feeIndex++) {
            for (uint8 classIndex = 0; classIndex < MAX_POOL_CLASSES; classIndex++) {
                uint8 bitIndex = uint8(feeIndex * MAX_POOL_CLASSES + classIndex);
                if ((candidateBitmap & (uint16(1) << bitIndex)) == 0) continue;
                if (classIndex >= classCount) revert InvalidCandidateBitmap();

                address strategy = canonicalFactory.initializationStrategyAt(
                    classIndex
                );
                bytes32 key = canonicalFactory.poolKey(
                    token0,
                    token1,
                    decimals0,
                    decimals1,
                    tiers[feeIndex],
                    strategy
                );
                address pool = canonicalFactory.getPool(key);
                if (pool == address(0)) continue;
                if (
                    pool.code.length == 0 ||
                    !canonicalFactory.isPool(pool)
                ) revert InvalidCanonicalPool();

                IConfidentialCPMM candidate = IConfidentialCPMM(pool);
                if (
                    candidate.PROTOCOL_VERSION() !=
                        canonicalFactory.PROTOCOL_VERSION() ||
                    candidate.PRIVACY_MODE() !=
                        canonicalFactory.PRIVACY_MODE() ||
                    candidate.token0() != token0 ||
                    candidate.token1() != token1 ||
                    candidate.token0Decimals() != decimals0 ||
                    candidate.token1Decimals() != decimals1 ||
                    candidate.feeBps() != tiers[feeIndex] ||
                    candidate.initializationStrategy() != strategy
                ) revert InvalidCanonicalPool();
                if (!candidate.initialized()) continue;

                uint256 candidateIndex = candidates.count;
                candidates.pools[candidateIndex] = pool;
                candidates.initializationStrategies[candidateIndex] = strategy;
                candidates.feeTiers[candidateIndex] = tiers[feeIndex];
                candidates.count += 1;
            }
        }
        if (candidates.count == 0) revert NoViablePool();
    }

    function _selectBest(
        CandidateSet memory candidates,
        gtUint256 input
    ) internal returns (
        address selectedPool,
        uint256 selectedFeeBps,
        address selectedStrategy,
        gtUint256 bestOutput
    ) {
        gtBool bestValid;
        gtUint256 bestIndex = MpcCore.setPublic256(uint256(0));

        // Candidate traversal is fee first, then standard before reviewed
        // strategies. Strict replacement therefore gives deterministic equal-
        // output priority to lower fee, then standard, then lower class index.
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
        selectedStrategy = candidates.initializationStrategies[selectedIndex];
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
            if (!MpcCore.decrypt(MpcCore.eq(remainingAllowance, uint256(0)))) {
                revert ResidualAllowance();
            }
        }
    }

    function _populationCount(uint16 bitmap) internal pure returns (uint8 count) {
        while (bitmap != 0) {
            count += uint8(bitmap & 1);
            bitmap >>= 1;
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
