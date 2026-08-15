// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@coti-io/coti-contracts/contracts/token/PrivateERC20/IPrivateERC20.sol";
import "@coti-io/coti-contracts/contracts/utils/mpc/MpcCore.sol";
import "./interfaces/IPrivateLPToken.sol";
import "./CipherDEXFeePolicy.sol";

/**
 * @title ConfidentialCPMM
 * @notice Amount-confidential constant-product pool for COTI PrivateERC20 assets.
 *
 * The pool deliberately does not claim anonymous or hidden-recipient execution.
 * The standard PrivateERC20 interface takes public addresses and emits public
 * participant addresses in Transfer events. Amounts, reserves, LP shares and
 * pass/fail values remain confidential; pool identity, token addresses, direction,
 * and participant addresses remain observable.
 *
 * This contract is a testnet feasibility implementation. It is not a mainnet
 * deployment and has not received an external audit.
 */
contract ConfidentialCPMM is CipherDEXFeePolicy {
    uint256 public constant PROTOCOL_VERSION = 2;
    uint8 public constant PRIVACY_MODE = 1;
    uint256 public constant PRICE_SCALE = 1e18;
    uint32 public constant MIN_CONFIDENTIAL_COLLECTION_SWAPS = 8;
    uint64 public constant MIN_CONFIDENTIAL_COLLECTION_DELAY = 1 hours;
    uint8 public constant LP_DISPOSITION_CREATOR_HELD = 0;
    uint8 public constant LP_DISPOSITION_TIMED_LOCK = 1;
    uint8 public constant LP_DISPOSITION_PERMANENT_LOCK = 2;

    address public immutable token0;
    address public immutable token1;
    uint8 public immutable token0Decimals;
    uint8 public immutable token1Decimals;
    uint256 public immutable scale0;
    uint256 public immutable scale1;
    uint256 public immutable feeBps;
    address public immutable feeVault;
    address public immutable bootstrapper;
    address public lpToken;

    bool public initialized;

    // Ciphertext storage is intentionally not exposed through public getters.
    // Reserves are protocol accounting, not raw token-contract balance reads:
    // compatible PrivateERC20 transfers revert atomically on failure, while
    // unsolicited transfers must not change pricing or LP claims.
    ctUint256 private reserve0State;
    ctUint256 private reserve1State;
    ctUint256 private protocolFees0State;
    ctUint256 private protocolFees1State;
    ctUint256 private totalShares;
    mapping(address => ctUint256) private shares;
    mapping(bytes32 => bool) private consumedInputs;
    uint32 public protocolFeeSwapCount0;
    uint32 public protocolFeeSwapCount1;
    uint64 public protocolFeeWindowStart0;
    uint64 public protocolFeeWindowStart1;
    uint256 public nextLockNonce;

    struct LockRecord {
        address owner;
        uint64 unlockTime;
        bool permanent;
        bool released;
        ctUint256 amount;
    }

    mapping(bytes32 => LockRecord) private locks;

    uint256 private reentrancyState = 1;

    error InvalidTokenPair();
    error InvalidDecimals();
    error InvalidFee();
    error InvalidFeeVault();
    error InvalidPrivateAmount();
    error PoolNotInitialized();
    error PoolAlreadyInitialized();
    error ArithmeticOverflow();
    error ArithmeticUnderflow();
    error DivisionByZero();
    error SlippageExceeded();
    error InsufficientPrivateLiquidity();
    error InsufficientPrivateShares();
    error InvalidLiquidityRatio();
    error InvalidPriceBounds();
    error PriceOutsideBounds();
    error BootstrapBalanceMismatch();
    error BootstrapUnauthorized();
    error InvalidLPToken();
    error LPTokenAlreadyInitialized();
    error InvalidLPDisposition();
    error InvalidLiquidityProvider();
    error InputAlreadyConsumed();
    error DeadlineExpired();
    error Reentrancy();
    error InvalidCollectionSelection();
    error ConfidentialCollectionNotReady();

    event SwapExecuted(address indexed trader, bool indexed zeroForOne);
    event LiquidityAdded(address indexed provider);
    event PoolBootstrapped(address indexed provider);
    event LiquidityRemoved(address indexed provider);
    event LiquidityLocked(
        bytes32 indexed lockId,
        address indexed owner,
        uint64 unlockTime,
        bool permanent
    );
    event LiquidityUnlocked(bytes32 indexed lockId, address indexed owner);
    event ConfidentialQuoteResult(
        address indexed caller,
        bytes32 indexed requestId,
        bool indexed zeroForOne,
        ctUint256 result
    );
    event ConfidentialProtocolFeesCollected(
        address indexed token,
        address indexed feeVault,
        uint32 aggregatedSwapCount
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
        // When created by the canonical factory this is the factory. Directly
        // deployed pools deliberately retain the deployer as their bootstrapper.
        bootstrapper = msg.sender;
    }

    /**
     * @notice Binds the factory-created private LP share token exactly once.
     * @dev The factory deploys the pool first, then deploys a token whose
     *      immutable pool address points back here. Directly deployed pools may
     *      leave this unset and use the internal compatibility accounting.
     */
    function initializeLPToken(address lpToken_) external {
        if (msg.sender != bootstrapper) revert BootstrapUnauthorized();
        if (initialized || lpToken != address(0)) revert LPTokenAlreadyInitialized();
        if (lpToken_.code.length == 0) revert InvalidLPToken();
        if (IPrivateLPToken(lpToken_).pool() != address(this)) revert InvalidLPToken();
        lpToken = lpToken_;
    }

    /**
     * @notice Returns a user-specific encrypted LP-share balance.
     * @dev This is intentionally non-view because MPC onboarding/offboarding is
     *      not a normal EVM static read on COTI.
     */
    function myShares() external returns (ctUint256 memory) {
        if (lpToken != address(0)) {
            return IPrivateLPToken(lpToken).balanceOf(msg.sender);
        }
        return MpcCore.offBoardToUser(_shareBalance(msg.sender), msg.sender);
    }

    /**
     * @notice Simulates a private quote and returns the result encrypted for the caller.
     * @dev Clients must verify on the COTI-compatible RPC whether eth_call supports
     *      the MPC precompile operations used by private balance reads. It is not a
     *      conventional view function by design.
     */
    function quoteExactInput(
        itUint256 calldata amountIn,
        bool zeroForOne
    ) external returns (ctUint256 memory amountOut) {
        return _quoteExactInput(amountIn, zeroForOne, msg.sender);
    }

    /**
     * @notice Computes an exact private quote in a transaction and emits the
     *         result encrypted for the caller.
     * @dev COTI testnet MPC precompiles are not executable through eth_call.
     *      A non-custodial quote identity can submit this request, read the
     *      ciphertext from the receipt and decrypt only its own result. The
     *      request is permissionless and never grants swap or fund authority.
     */
    function requestQuoteExactInput(
        itUint256 calldata amountIn,
        bool zeroForOne,
        bytes32 requestId
    ) external returns (ctUint256 memory result) {
        result = _quoteExactInput(amountIn, zeroForOne, msg.sender);
        emit ConfidentialQuoteResult(msg.sender, requestId, zeroForOne, result);
    }

    function _quoteExactInput(
        itUint256 calldata amountIn,
        bool zeroForOne,
        address recipient
    ) internal returns (ctUint256 memory result) {
        if (!initialized) revert PoolNotInitialized();
        gtUint256 input = MpcCore.validateCiphertext(amountIn);
        gtUint256 reserveIn = zeroForOne ? _reserve0() : _reserve1();
        gtUint256 reserveOut = zeroForOne ? _reserve1() : _reserve0();
        gtUint256 output = _amountOut(input, reserveIn, reserveOut);
        return MpcCore.offBoardToUser(output, recipient);
    }

    /**
     * @notice Executes a swap with encrypted input and encrypted minimum output.
     * @dev The recipient is msg.sender and therefore public at the EVM layer. The
     *      amount and resulting output are never placed in this pool's events/errors.
     */
    function swapExactInput(
        itUint256 calldata amountIn,
        itUint256 calldata minAmountOut,
        bool zeroForOne,
        uint64 deadline
    ) external nonReentrant returns (ctUint256 memory amountOut) {
        _requireBeforeDeadline(deadline);
        gtUint256 input = _validateAndConsume(amountIn);
        gtUint256 minimum = MpcCore.validateCiphertext(minAmountOut);
        gtUint256 reserve0 = _reserve0();
        gtUint256 reserve1 = _reserve1();
        gtUint256 reserveIn = zeroForOne ? reserve0 : reserve1;
        gtUint256 reserveOut = zeroForOne ? reserve1 : reserve0;
        (
            gtUint256 output,
            ,
            gtUint256 protocolFee
        ) = _swapAmounts(input, reserveIn, reserveOut);
        gtUint256 reserveCredit = _subChecked(input, protocolFee);

        if (!MpcCore.decrypt(MpcCore.ge(output, minimum))) revert SlippageExceeded();

        if (zeroForOne) {
            reserve0State = MpcCore.offBoard(_addChecked(reserve0, reserveCredit));
            reserve1State = MpcCore.offBoard(_subChecked(reserve1, output));
            protocolFees0State = MpcCore.offBoard(
                _addChecked(_protocolFees0(), protocolFee)
            );
            _recordProtocolFeeAccrual(true);
            IPrivateERC20(token0).transferFromGT(msg.sender, address(this), input);
            IPrivateERC20(token1).transferGT(msg.sender, output);
        } else {
            reserve1State = MpcCore.offBoard(_addChecked(reserve1, reserveCredit));
            reserve0State = MpcCore.offBoard(_subChecked(reserve0, output));
            protocolFees1State = MpcCore.offBoard(
                _addChecked(_protocolFees1(), protocolFee)
            );
            _recordProtocolFeeAccrual(false);
            IPrivateERC20(token1).transferFromGT(msg.sender, address(this), input);
            IPrivateERC20(token0).transferGT(msg.sender, output);
        }

        emit SwapExecuted(msg.sender, zeroForOne);
        return MpcCore.offBoardToUser(output, msg.sender);
    }

    /**
     * @notice Batches encrypted protocol fees into the immutable fee vault.
     * @dev The collected amount is never decrypted or emitted. Each token side
     *      requires both a minimum number of swaps and a minimum time window,
     *      preventing a normal one-swap collection from disclosing that swap's
     *      fee to the beneficiary. Low-volume fees remain encrypted in the pool
     *      until both immutable conditions are met.
     */
    function collectProtocolFees(bool collectToken0, bool collectToken1)
        external
        nonReentrant
    {
        if (!collectToken0 && !collectToken1) revert InvalidCollectionSelection();

        if (collectToken0) {
            uint32 count0 = protocolFeeSwapCount0;
            _requireConfidentialCollectionReady(count0, protocolFeeWindowStart0);
            gtUint256 amount0 = _protocolFees0();
            protocolFees0State = MpcCore.offBoard(MpcCore.setPublic256(uint256(0)));
            protocolFeeSwapCount0 = 0;
            protocolFeeWindowStart0 = 0;
            IPrivateERC20(token0).transferGT(feeVault, amount0);
            emit ConfidentialProtocolFeesCollected(token0, feeVault, count0);
        }

        if (collectToken1) {
            uint32 count1 = protocolFeeSwapCount1;
            _requireConfidentialCollectionReady(count1, protocolFeeWindowStart1);
            gtUint256 amount1 = _protocolFees1();
            protocolFees1State = MpcCore.offBoard(MpcCore.setPublic256(uint256(0)));
            protocolFeeSwapCount1 = 0;
            protocolFeeWindowStart1 = 0;
            IPrivateERC20(token1).transferGT(feeVault, amount1);
            emit ConfidentialProtocolFeesCollected(token1, feeVault, count1);
        }
    }

    /**
     * @notice Adds proportional private liquidity and mints private shares.
     * @dev Initial liquidity establishes the pool price from its arbitrary
     *      normalized deposit ratio. Later deposits transfer only the exact
     *      proportional amount; excess input remains with the caller instead
     *      of becoming a donation.
     */
    function addLiquidity(
        itUint256 calldata amount0,
        itUint256 calldata amount1,
        itUint256 calldata minShares,
        uint64 deadline
    ) external nonReentrant returns (ctUint256 memory mintedShares) {
        _requireBeforeDeadline(deadline);
        gtUint256 input0 = _validateAndConsume(amount0);
        gtUint256 input1 = _validateAndConsume(amount1);
        gtUint256 minimum = MpcCore.validateCiphertext(minShares);
        _requirePositive(input0);
        _requirePositive(input1);

        gtUint256 deposit0 = input0;
        gtUint256 deposit1 = input1;
        gtUint256 minted;
        gtUint256 reserve0 = _reserve0();
        gtUint256 reserve1 = _reserve1();

        if (!initialized) {
            if (
                MpcCore.decrypt(MpcCore.ne(reserve0, MpcCore.setPublic256(uint256(0)))) ||
                MpcCore.decrypt(MpcCore.ne(reserve1, MpcCore.setPublic256(uint256(0))))
            ) revert BootstrapBalanceMismatch();
            gtUint256 normalized0 = _scale(input0, scale0);
            gtUint256 normalized1 = _scale(input1, scale1);
            // The minimum normalized side is a deterministic private share
            // unit that supports any non-zero initial ratio without multiplying
            // the two deposits. Avoiding a geometric mean removes a uint256
            // product overflow and an expensive encrypted square-root loop.
            // The first LP still owns 100% of totalShares, so the denomination
            // does not affect ownership or full-exit amounts.
            minted = MpcCore.min(normalized0, normalized1);
            _requirePositive(minted);
            if (!MpcCore.decrypt(MpcCore.ge(minted, minimum))) revert SlippageExceeded();
            initialized = true;
        } else {
            gtUint256 currentTotal = _readPrivate(totalShares);
            _requirePositive(reserve0);
            _requirePositive(reserve1);
            _requirePositive(currentTotal);

            // All three denominators are proven positive above. Avoid repeating
            // encrypted zero checks for each division: besides being redundant,
            // every decrypted predicate consumes another COTI MPC callback.
            gtUint256 share0 = MpcCore.div(_mulChecked(input0, currentTotal), reserve0);
            gtUint256 share1 = MpcCore.div(_mulChecked(input1, currentTotal), reserve1);
            minted = MpcCore.min(share0, share1);
            _requirePositive(minted);
            if (!MpcCore.decrypt(MpcCore.ge(minted, minimum))) revert SlippageExceeded();

            // Shares are rounded down from each offered side. Accepted token
            // amounts are then rounded up so a new LP can never receive shares
            // while underpaying the corresponding reserve fraction.
            deposit0 = _ceilDiv(_mulChecked(minted, reserve0), currentTotal);
            deposit1 = _ceilDiv(_mulChecked(minted, reserve1), currentTotal);
            // minted > 0 and both reserves > 0 imply positive deposits. Also,
            // minted <= floor(input * total / reserve) proves
            // ceil(minted * reserve / total) <= input for each side. The
            // reference fuzz suite enforces both properties without disclosing
            // these otherwise redundant encrypted comparisons on-chain.
        }

        reserve0State = MpcCore.offBoard(_addChecked(reserve0, deposit0));
        reserve1State = MpcCore.offBoard(_addChecked(reserve1, deposit1));
        totalShares = MpcCore.offBoard(_addChecked(_readPrivate(totalShares), minted));
        if (lpToken == address(0)) {
            shares[msg.sender] = MpcCore.offBoard(
                _addChecked(_readPrivate(shares[msg.sender]), minted)
            );
        } else {
            IPrivateLPToken(lpToken).mintGt(msg.sender, minted);
        }

        IPrivateERC20(token0).transferFromGT(msg.sender, address(this), deposit0);
        IPrivateERC20(token1).transferFromGT(msg.sender, address(this), deposit1);

        emit LiquidityAdded(msg.sender);
        return MpcCore.offBoardToUser(minted, msg.sender);
    }

    /**
     * @notice Initializes a factory-created pool from already transferred MPC
     *         values. This is the only bridge needed by the launchpad migrator.
     * @dev The caller must be the immutable bootstrapper (the canonical factory
     *      for factory-created pools). The values are already validated by the
     *      migrator; this function checks price bounds and the share floor before
     *      committing encrypted reserve state. The factory-bound migrator has
     *      already transferred both assets in the same transaction, so any
     *      bootstrap failure rolls back custody and accounting together.
     *
     *      `priceX18` is normalized token1 per normalized token0. Both bounds
     *      are encrypted MPC values and therefore never appear in an event.
     */
    function bootstrapLiquidity(
        address provider,
        uint256 amount0_,
        uint256 amount1_,
        uint256 minShares_,
        uint256 minPriceX18_,
        uint256 maxPriceX18_
    ) external nonReentrant returns (ctUint256 memory mintedShares) {
        (gtUint256 minted, ) = _bootstrapLiquidity(
            provider,
            amount0_,
            amount1_,
            minShares_,
            minPriceX18_,
            maxPriceX18_,
            LP_DISPOSITION_CREATOR_HELD,
            0
        );
        return MpcCore.offBoardToUser(minted, provider);
    }

    /**
     * @notice Atomically bootstraps liquidity and chooses the LP disposition.
     * @dev Timed and permanent dispositions never mint the initial LP token to
     *      the provider. The private share amount is held by the pool's lock
     *      record; timed unlock mints it after the deadline, while permanent
     *      disposition burns it irreversibly from the provider's perspective.
     */
    function bootstrapLiquidityWithDisposition(
        address provider,
        uint256 amount0_,
        uint256 amount1_,
        uint256 minShares_,
        uint256 minPriceX18_,
        uint256 maxPriceX18_,
        uint8 disposition,
        uint64 unlockTime
    ) external nonReentrant returns (ctUint256 memory mintedShares, bytes32 lockId) {
        (gtUint256 minted, bytes32 createdLockId) = _bootstrapLiquidity(
            provider,
            amount0_,
            amount1_,
            minShares_,
            minPriceX18_,
            maxPriceX18_,
            disposition,
            unlockTime
        );
        return (MpcCore.offBoardToUser(minted, provider), createdLockId);
    }

    function _bootstrapLiquidity(
        address provider,
        uint256 amount0_,
        uint256 amount1_,
        uint256 minShares_,
        uint256 minPriceX18_,
        uint256 maxPriceX18_,
        uint8 disposition,
        uint64 unlockTime
    ) internal returns (gtUint256 minted, bytes32 lockId) {
        if (msg.sender != bootstrapper) revert BootstrapUnauthorized();
        if (initialized) revert PoolAlreadyInitialized();
        if (provider == address(0)) revert InvalidLiquidityProvider();
        if (disposition > LP_DISPOSITION_PERMANENT_LOCK) revert InvalidLPDisposition();
        if (
            disposition == LP_DISPOSITION_TIMED_LOCK
                ? unlockTime <= block.timestamp
                : unlockTime != 0
        ) revert InvalidLPDisposition();

        gtUint256 amount0 = gtUint256.wrap(amount0_);
        gtUint256 amount1 = gtUint256.wrap(amount1_);
        gtUint256 minimumShares = gtUint256.wrap(minShares_);
        gtUint256 minimumPrice = gtUint256.wrap(minPriceX18_);
        gtUint256 maximumPrice = gtUint256.wrap(maxPriceX18_);
        _requirePositive(amount0);
        _requirePositive(amount1);
        _requirePositive(maximumPrice);

        if (MpcCore.decrypt(MpcCore.gt(minimumPrice, maximumPrice))) {
            revert InvalidPriceBounds();
        }

        gtUint256 normalized0 = _scale(amount0, scale0);
        gtUint256 normalized1 = _scale(amount1, scale1);
        gtUint256 priceNumerator = _mulChecked(normalized1, MpcCore.setPublic256(PRICE_SCALE));
        gtUint256 lowerBound = _mulChecked(normalized0, minimumPrice);
        gtUint256 upperBound = _mulChecked(normalized0, maximumPrice);
        if (!MpcCore.decrypt(MpcCore.ge(priceNumerator, lowerBound))) {
            revert PriceOutsideBounds();
        }
        if (!MpcCore.decrypt(MpcCore.le(priceNumerator, upperBound))) {
            revert PriceOutsideBounds();
        }

        if (
            MpcCore.decrypt(MpcCore.ne(_reserve0(), MpcCore.setPublic256(uint256(0)))) ||
            MpcCore.decrypt(MpcCore.ne(_reserve1(), MpcCore.setPublic256(uint256(0))))
        ) {
            revert BootstrapBalanceMismatch();
        }

        // The minimum normalized side defines the initial private share unit.
        // Unlike ordinary addLiquidity, bootstrap may intentionally establish a
        // non-1:1 bonding-curve price; full exit still returns both reserves.
        minted = MpcCore.min(normalized0, normalized1);
        _requirePositive(minted);
        if (!MpcCore.decrypt(MpcCore.ge(minted, minimumShares))) {
            revert SlippageExceeded();
        }

        initialized = true;
        reserve0State = MpcCore.offBoard(amount0);
        reserve1State = MpcCore.offBoard(amount1);
        totalShares = MpcCore.offBoard(minted);
        if (disposition == LP_DISPOSITION_CREATOR_HELD) {
            if (lpToken == address(0)) {
                shares[provider] = MpcCore.offBoard(minted);
            } else {
                IPrivateLPToken(lpToken).mintGt(provider, minted);
            }
        } else {
            lockId = keccak256(abi.encode(address(this), provider, nextLockNonce++));
            locks[lockId] = LockRecord({
                owner: provider,
                unlockTime: unlockTime,
                permanent: disposition == LP_DISPOSITION_PERMANENT_LOCK,
                released: false,
                amount: MpcCore.offBoard(minted)
            });
            emit LiquidityLocked(
                lockId,
                provider,
                unlockTime,
                disposition == LP_DISPOSITION_PERMANENT_LOCK
            );
        }
        emit PoolBootstrapped(provider);
    }

    /**
     * @notice Burns private LP shares and withdraws the corresponding private reserves.
     */
    function removeLiquidity(
        itUint256 calldata shareInput,
        itUint256 calldata minAmount0,
        itUint256 calldata minAmount1,
        uint64 deadline
    ) external nonReentrant returns (ctUint256 memory amount0, ctUint256 memory amount1) {
        _requireBeforeDeadline(deadline);
        gtUint256 requestedShares = _validateAndConsume(shareInput);
        gtUint256 minimum0 = MpcCore.validateCiphertext(minAmount0);
        gtUint256 minimum1 = MpcCore.validateCiphertext(minAmount1);
        gtUint256 currentTotal = _readPrivate(totalShares);
        gtUint256 userShares = _shareBalance(msg.sender);

        _requirePositive(requestedShares);
        _requirePositive(currentTotal);
        if (!MpcCore.decrypt(MpcCore.le(requestedShares, userShares))) {
            revert InsufficientPrivateShares();
        }

        gtUint256 reserve0 = _reserve0();
        gtUint256 reserve1 = _reserve1();
        gtUint256 amount0Calculated = MpcCore.div(
            _mulChecked(requestedShares, reserve0),
            currentTotal
        );
        gtUint256 amount1Calculated = MpcCore.div(
            _mulChecked(requestedShares, reserve1),
            currentTotal
        );
        gtBool fullExit = MpcCore.eq(requestedShares, currentTotal);
        // COTI mux selects its second value when the bit is true and its first
        // value when false. A full exit must select the complete reserve.
        amount0Calculated = MpcCore.mux(fullExit, amount0Calculated, reserve0);
        amount1Calculated = MpcCore.mux(fullExit, amount1Calculated, reserve1);

        if (!MpcCore.decrypt(MpcCore.ge(amount0Calculated, minimum0))) revert SlippageExceeded();
        if (!MpcCore.decrypt(MpcCore.ge(amount1Calculated, minimum1))) revert SlippageExceeded();

        totalShares = MpcCore.offBoard(
            MpcCore.mux(
                fullExit,
                _subChecked(currentTotal, requestedShares),
                MpcCore.setPublic256(uint256(0))
            )
        );
        if (lpToken == address(0)) {
            shares[msg.sender] = MpcCore.offBoard(
                _subChecked(userShares, requestedShares)
            );
        } else {
            IPrivateLPToken(lpToken).burnFromPool(msg.sender, requestedShares);
        }
        reserve0State = MpcCore.offBoard(_subChecked(reserve0, amount0Calculated));
        reserve1State = MpcCore.offBoard(_subChecked(reserve1, amount1Calculated));
        if (MpcCore.decrypt(fullExit)) initialized = false;

        IPrivateERC20(token0).transferGT(msg.sender, amount0Calculated);
        IPrivateERC20(token1).transferGT(msg.sender, amount1Calculated);

        emit LiquidityRemoved(msg.sender);
        return (
            MpcCore.offBoardToUser(amount0Calculated, msg.sender),
            MpcCore.offBoardToUser(amount1Calculated, msg.sender)
        );
    }

    /**
     * @notice Moves private LP shares into a time lock or irreversible permanent lock.
     * @dev The locked amount is never emitted or returned publicly.
     */
    function lockShares(
        itUint256 calldata shareInput,
        uint64 unlockTime,
        bool permanent,
        uint64 deadline
    ) external nonReentrant returns (bytes32 lockId) {
        _requireBeforeDeadline(deadline);
        if (
            permanent
                ? unlockTime != 0
                : unlockTime <= block.timestamp
        ) revert InvalidLPDisposition();

        gtUint256 requestedShares = _validateAndConsume(shareInput);
        gtUint256 userShares = _shareBalance(msg.sender);
        _requirePositive(requestedShares);
        if (!MpcCore.decrypt(MpcCore.le(requestedShares, userShares))) {
            revert InsufficientPrivateShares();
        }

        lockId = keccak256(abi.encode(address(this), msg.sender, nextLockNonce++));
        locks[lockId] = LockRecord({
            owner: msg.sender,
            unlockTime: unlockTime,
            permanent: permanent,
            released: false,
            amount: MpcCore.offBoard(requestedShares)
        });
        if (lpToken == address(0)) {
            shares[msg.sender] = MpcCore.offBoard(_subChecked(userShares, requestedShares));
        } else {
            IPrivateLPToken(lpToken).burnFromPool(msg.sender, requestedShares);
        }

        emit LiquidityLocked(lockId, msg.sender, unlockTime, permanent);
    }

    /**
     * @notice Releases a non-permanent lock back to its original provider.
     */
    function unlockShares(bytes32 lockId) external nonReentrant {
        LockRecord storage record = locks[lockId];
        if (record.owner != msg.sender || record.released) revert InsufficientPrivateShares();
        if (record.permanent || block.timestamp < record.unlockTime) {
            revert InvalidLiquidityRatio();
        }

        gtUint256 locked = _readPrivate(record.amount);
        if (lpToken == address(0)) {
            shares[msg.sender] = MpcCore.offBoard(_addChecked(_readPrivate(shares[msg.sender]), locked));
        } else {
            IPrivateLPToken(lpToken).mintGt(msg.sender, locked);
        }
        record.released = true;

        emit LiquidityUnlocked(lockId, msg.sender);
    }

    /**
     * @notice Returns only public lock metadata. The locked share amount is private.
     */
    function lockInfo(bytes32 lockId)
        external
        view
        returns (address owner, uint64 unlockTime, bool permanent, bool released)
    {
        LockRecord storage record = locks[lockId];
        return (record.owner, record.unlockTime, record.permanent, record.released);
    }

    function _reserve0() internal returns (gtUint256) {
        return _readPrivate(reserve0State);
    }

    function _reserve1() internal returns (gtUint256) {
        return _readPrivate(reserve1State);
    }

    function _protocolFees0() internal returns (gtUint256) {
        return _readPrivate(protocolFees0State);
    }

    function _protocolFees1() internal returns (gtUint256) {
        return _readPrivate(protocolFees1State);
    }

    function _shareBalance(address account) internal returns (gtUint256) {
        if (lpToken == address(0)) return _readPrivate(shares[account]);
        return IPrivateLPToken(lpToken).balanceOfGT(account);
    }

    function _amountOut(
        gtUint256 amountIn,
        gtUint256 reserveIn,
        gtUint256 reserveOut
    ) internal returns (gtUint256) {
        (gtUint256 amountOut, , ) = _swapAmounts(amountIn, reserveIn, reserveOut);
        return amountOut;
    }

    function _swapAmounts(
        gtUint256 amountIn,
        gtUint256 reserveIn,
        gtUint256 reserveOut
    ) internal returns (
        gtUint256 amountOut,
        gtUint256 netAmountIn,
        gtUint256 protocolFee
    ) {
        _requirePositive(amountIn);
        _requirePositive(reserveIn);
        _requirePositive(reserveOut);

        gtUint256 feeFactor = MpcCore.setPublic256(FEE_DENOMINATOR - feeBps);
        gtUint256 feeDenominator = MpcCore.setPublic256(FEE_DENOMINATOR);
        gtUint256 netProduct = _mulChecked(amountIn, feeFactor);
        netAmountIn = MpcCore.div(netProduct, feeDenominator);
        _requirePositive(netAmountIn);
        gtUint256 totalFee = _subChecked(amountIn, netAmountIn);
        protocolFee = MpcCore.div(
            _mulChecked(
                totalFee,
                MpcCore.setPublic256(PROTOCOL_FEE_SHARE_NUMERATOR)
            ),
            MpcCore.setPublic256(PROTOCOL_FEE_SHARE_DENOMINATOR)
        );
        gtUint256 newReserveIn = _addChecked(reserveIn, netAmountIn);
        gtUint256 invariant = _mulChecked(reserveIn, reserveOut);
        // Round the retained reserve up. Subtracting a floored retained reserve
        // would round output upward and can violate x*y >= k after the swap.
        gtUint256 newReserveOut = _ceilDiv(invariant, newReserveIn);
        amountOut = _subChecked(reserveOut, newReserveOut);
        _requirePositive(amountOut);
    }

    function _recordProtocolFeeAccrual(bool token0Side) internal {
        if (token0Side) {
            if (protocolFeeSwapCount0 == 0) {
                protocolFeeWindowStart0 = uint64(block.timestamp);
            }
            protocolFeeSwapCount0 += 1;
        } else {
            if (protocolFeeSwapCount1 == 0) {
                protocolFeeWindowStart1 = uint64(block.timestamp);
            }
            protocolFeeSwapCount1 += 1;
        }
    }

    function _requireConfidentialCollectionReady(uint32 count, uint64 windowStart)
        internal
        view
    {
        if (
            count < MIN_CONFIDENTIAL_COLLECTION_SWAPS
                || windowStart == 0
                || block.timestamp < uint256(windowStart) + MIN_CONFIDENTIAL_COLLECTION_DELAY
        ) revert ConfidentialCollectionNotReady();
    }

    function _scale(gtUint256 value, uint256 factor) internal returns (gtUint256) {
        return _mulChecked(value, MpcCore.setPublic256(factor));
    }

    function _mulChecked(gtUint256 a, gtUint256 b) internal returns (gtUint256) {
        (gtBool overflow, gtUint256 result) = MpcCore.checkedMulWithOverflowBit(a, b);
        if (MpcCore.decrypt(overflow)) revert ArithmeticOverflow();
        return result;
    }

    function _addChecked(gtUint256 a, gtUint256 b) internal returns (gtUint256) {
        (gtBool overflow, gtUint256 result) = MpcCore.checkedAddWithOverflowBit(a, b);
        if (MpcCore.decrypt(overflow)) revert ArithmeticOverflow();
        return result;
    }

    function _subChecked(gtUint256 a, gtUint256 b) internal returns (gtUint256) {
        (gtBool underflow, gtUint256 result) = MpcCore.checkedSubWithOverflowBit(a, b);
        if (MpcCore.decrypt(underflow)) revert ArithmeticUnderflow();
        return result;
    }

    function _ceilDiv(gtUint256 numerator, gtUint256 denominator) internal returns (gtUint256) {
        // Every call site proves denominator > 0 before reaching this helper.
        // Use the encrypted remainder instead of multiplying the quotient back
        // and decrypting exactness. A non-zero remainder implies quotient <
        // type(uint256).max, so quotient + 1 cannot overflow.
        gtUint256 quotient = MpcCore.div(numerator, denominator);
        gtUint256 remainder = MpcCore.rem(numerator, denominator);
        gtBool exact = MpcCore.eq(remainder, MpcCore.setPublic256(uint256(0)));
        return MpcCore.mux(
            exact,
            MpcCore.add(quotient, MpcCore.setPublic256(uint256(1))),
            quotient
        );
    }

    function _requirePositive(gtUint256 value) internal {
        if (!MpcCore.decrypt(MpcCore.gt(value, MpcCore.setPublic256(uint256(0))))) {
            revert InvalidPrivateAmount();
        }
    }

    function _validateAndConsume(itUint256 memory input) internal returns (gtUint256) {
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
        gtUint256 value = MpcCore.validateCiphertext(input);
        consumedInputs[digest] = true;
        return value;
    }

    function _readPrivate(ctUint256 memory value) internal returns (gtUint256) {
        if (
            ctUint128.unwrap(value.ciphertextHigh) == 0 &&
            ctUint128.unwrap(value.ciphertextLow) == 0
        ) {
            return MpcCore.setPublic256(uint256(0));
        }
        return MpcCore.onBoard(value);
    }

    function _requireBeforeDeadline(uint64 deadline) internal view {
        if (deadline < block.timestamp) revert DeadlineExpired();
    }

    function _readTokenDecimals(address token) internal view returns (uint8) {
        (bool ok, bytes memory data) = token.staticcall(
            abi.encodeWithSignature("decimals()")
        );
        if (!ok || data.length != 32) revert InvalidDecimals();
        uint256 value = abi.decode(data, (uint256));
        if (value > 18) revert InvalidDecimals();
        return uint8(value);
    }
}
