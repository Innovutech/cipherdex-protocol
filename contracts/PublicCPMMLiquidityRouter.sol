// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "./interfaces/IPublicCPMM.sol";
import "./interfaces/IPublicCPMMFactory.sol";
import "./interfaces/IPublicCPMMLiquidityRouter.sol";
import "./interfaces/IPublicLPTokenFactory.sol";

/**
 * @title PublicCPMMLiquidityRouter
 * @notice Atomic create-or-add liquidity periphery for public CipherDEX pools.
 * @dev Existing direct factory and pool entry points remain unchanged. The
 *      router holds user tokens only for the duration of one non-reentrant call,
 *      uses exact temporary pool approvals, and returns every unused token.
 */
contract PublicCPMMLiquidityRouter is IPublicCPMMLiquidityRouter {
    using SafeERC20 for IERC20;

    uint256 public constant PROTOCOL_VERSION = 1;
    address public immutable factory;
    uint256 private reentrancyState = 1;

    struct CreateLiquidityParams {
        address tokenA;
        address tokenB;
        uint8 decimalsA;
        uint8 decimalsB;
        uint256 feeBps;
        uint256 amountADesired;
        uint256 amountBDesired;
        uint256 minShares;
        uint256 minPriceX18;
        uint256 maxPriceX18;
        uint64 deadline;
    }

    error InvalidFactory();
    error InvalidPool();
    error InvalidTokenPair();
    error InvalidAmount();
    error DeadlineExpired();
    error TransferAmountMismatch();
    error ResidualAllowance();
    error InvalidRecipient();
    error InvalidLPToken();
    error PermitFailed();
    error Reentrancy();

    modifier nonReentrant() {
        if (reentrancyState != 1) revert Reentrancy();
        reentrancyState = 2;
        _;
        reentrancyState = 1;
    }

    constructor(address factory_) {
        if (factory_.code.length == 0) revert InvalidFactory();
        IPublicCPMMFactory candidate = IPublicCPMMFactory(factory_);
        if (candidate.PROTOCOL_VERSION() != 1 || candidate.feeVault().code.length == 0) {
            revert InvalidFactory();
        }
        factory = factory_;
    }

    function createOrAddLiquidity(
        address tokenA,
        address tokenB,
        uint8 decimalsA,
        uint8 decimalsB,
        uint256 feeBps,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 minShares,
        uint256 minPriceX18,
        uint256 maxPriceX18,
        uint64 deadline
    ) external nonReentrant returns (
        address pool,
        uint256 mintedShares,
        uint256 amountAUsed,
        uint256 amountBUsed
    ) {
        CreateLiquidityParams memory params;
        params.tokenA = tokenA;
        params.tokenB = tokenB;
        params.decimalsA = decimalsA;
        params.decimalsB = decimalsB;
        params.feeBps = feeBps;
        params.amountADesired = amountADesired;
        params.amountBDesired = amountBDesired;
        params.minShares = minShares;
        params.minPriceX18 = minPriceX18;
        params.maxPriceX18 = maxPriceX18;
        params.deadline = deadline;
        return _createOrAddLiquidity(msg.sender, params);
    }

    function createOrAddLiquidityFor(
        address recipient,
        address tokenA,
        address tokenB,
        uint8 decimalsA,
        uint8 decimalsB,
        uint256 feeBps,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 minShares,
        uint256 minPriceX18,
        uint256 maxPriceX18,
        uint64 deadline
    ) external nonReentrant returns (
        address pool,
        uint256 mintedShares,
        uint256 amountAUsed,
        uint256 amountBUsed
    ) {
        if (recipient == address(0) || recipient == address(this)) {
            revert InvalidRecipient();
        }
        CreateLiquidityParams memory params;
        params.tokenA = tokenA;
        params.tokenB = tokenB;
        params.decimalsA = decimalsA;
        params.decimalsB = decimalsB;
        params.feeBps = feeBps;
        params.amountADesired = amountADesired;
        params.amountBDesired = amountBDesired;
        params.minShares = minShares;
        params.minPriceX18 = minPriceX18;
        params.maxPriceX18 = maxPriceX18;
        params.deadline = deadline;
        return _createOrAddLiquidity(recipient, params);
    }

    function _createOrAddLiquidity(
        address recipient,
        CreateLiquidityParams memory params
    ) internal returns (
        address pool,
        uint256 mintedShares,
        uint256 amountAUsed,
        uint256 amountBUsed
    ) {
        if (block.timestamp > params.deadline) revert DeadlineExpired();
        if (
            params.tokenA == address(0) ||
            params.tokenB == address(0) ||
            params.tokenA == params.tokenB
        ) {
            revert InvalidTokenPair();
        }
        if (params.amountADesired == 0 || params.amountBDesired == 0) {
            revert InvalidAmount();
        }

        bool aIsToken0 = params.tokenA < params.tokenB;
        address token0 = aIsToken0 ? params.tokenA : params.tokenB;
        address token1 = aIsToken0 ? params.tokenB : params.tokenA;
        uint8 decimals0 = aIsToken0 ? params.decimalsA : params.decimalsB;
        uint8 decimals1 = aIsToken0 ? params.decimalsB : params.decimalsA;
        uint256 desired0 = aIsToken0
            ? params.amountADesired
            : params.amountBDesired;
        uint256 desired1 = aIsToken0
            ? params.amountBDesired
            : params.amountADesired;

        IPublicCPMMFactory canonicalFactory = IPublicCPMMFactory(factory);
        bytes32 key = canonicalFactory.poolKey(
            token0,
            token1,
            decimals0,
            decimals1,
            params.feeBps
        );
        pool = canonicalFactory.getPool(key);
        bool poolCreated = pool == address(0);
        if (poolCreated) {
            pool = canonicalFactory.createPool(
                token0,
                token1,
                decimals0,
                decimals1,
                params.feeBps
            );
        }
        _requireCanonicalPool(
            canonicalFactory,
            pool,
            token0,
            token1,
            decimals0,
            decimals1,
            params.feeBps
        );

        IERC20 first = IERC20(token0);
        IERC20 second = IERC20(token1);
        uint256 starting0 = first.balanceOf(address(this));
        uint256 starting1 = second.balanceOf(address(this));
        _pullExact(first, msg.sender, desired0, starting0);
        _pullExact(second, msg.sender, desired1, starting1);

        first.forceApprove(pool, desired0);
        second.forceApprove(pool, desired1);
        mintedShares = IPublicCPMM(pool).addLiquidityFor(
            recipient,
            desired0,
            desired1,
            params.minShares,
            params.minPriceX18,
            params.maxPriceX18,
            params.deadline
        );
        first.forceApprove(pool, 0);
        second.forceApprove(pool, 0);
        if (first.allowance(address(this), pool) != 0) revert ResidualAllowance();
        if (second.allowance(address(this), pool) != 0) revert ResidualAllowance();

        uint256 remaining0 = first.balanceOf(address(this));
        uint256 remaining1 = second.balanceOf(address(this));
        if (remaining0 < starting0 || remaining1 < starting1) {
            revert TransferAmountMismatch();
        }
        uint256 refund0 = remaining0 - starting0;
        uint256 refund1 = remaining1 - starting1;
        amountAUsed = aIsToken0 ? desired0 - refund0 : desired1 - refund1;
        amountBUsed = aIsToken0 ? desired1 - refund1 : desired0 - refund0;
        if (refund0 != 0) first.safeTransfer(msg.sender, refund0);
        if (refund1 != 0) second.safeTransfer(msg.sender, refund1);
        if (
            first.balanceOf(address(this)) != starting0 ||
            second.balanceOf(address(this)) != starting1
        ) revert TransferAmountMismatch();

        emit PublicLiquidityRouted(
            recipient,
            pool,
            poolCreated,
            aIsToken0 ? amountAUsed : amountBUsed,
            aIsToken0 ? amountBUsed : amountAUsed,
            mintedShares
        );
    }

    function removeLiquidity(
        address pool,
        uint256 shareInput,
        uint256 minAmount0,
        uint256 minAmount1,
        uint64 deadline,
        address recipient
    ) external nonReentrant returns (uint256 amount0, uint256 amount1) {
        return _removeLiquidity(
            pool,
            shareInput,
            minAmount0,
            minAmount1,
            deadline,
            recipient
        );
    }

    function removeLiquidityWithPermit(
        address pool,
        uint256 shareInput,
        uint256 minAmount0,
        uint256 minAmount1,
        uint64 deadline,
        address recipient,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (uint256 amount0, uint256 amount1) {
        address lpToken = _requireRegisteredPool(pool).lpToken();
        try IERC20Permit(lpToken).permit(
            msg.sender,
            address(this),
            shareInput,
            permitDeadline,
            v,
            r,
            s
        ) {} catch {
            if (IERC20(lpToken).allowance(msg.sender, address(this)) < shareInput) {
                revert PermitFailed();
            }
        }
        return _removeLiquidity(
            pool,
            shareInput,
            minAmount0,
            minAmount1,
            deadline,
            recipient
        );
    }

    function _removeLiquidity(
        address pool,
        uint256 shareInput,
        uint256 minAmount0,
        uint256 minAmount1,
        uint64 deadline,
        address recipient
    ) internal returns (uint256 amount0, uint256 amount1) {
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (shareInput == 0) revert InvalidAmount();
        if (recipient == address(0) || recipient == address(this)) {
            revert InvalidRecipient();
        }
        IPublicCPMM canonicalPool = _requireRegisteredPool(pool);
        IERC20 lp = IERC20(canonicalPool.lpToken());
        uint256 startingBalance = lp.balanceOf(address(this));
        _pullExact(lp, msg.sender, shareInput, startingBalance);
        (amount0, amount1) = canonicalPool.removeLiquidityTo(
            recipient,
            shareInput,
            minAmount0,
            minAmount1,
            deadline
        );
        if (lp.balanceOf(address(this)) != startingBalance) {
            revert TransferAmountMismatch();
        }
    }

    function _requireCanonicalPool(
        IPublicCPMMFactory canonicalFactory,
        address pool,
        address token0,
        address token1,
        uint8 decimals0,
        uint8 decimals1,
        uint256 feeBps
    ) internal view {
        if (pool.code.length == 0 || !canonicalFactory.isPool(pool)) {
            revert InvalidPool();
        }
        IPublicCPMM candidate = IPublicCPMM(pool);
        if (
            candidate.PROTOCOL_VERSION() != canonicalFactory.PROTOCOL_VERSION() ||
            candidate.token0() != token0 ||
            candidate.token1() != token1 ||
            candidate.token0Decimals() != decimals0 ||
            candidate.token1Decimals() != decimals1 ||
            candidate.feeBps() != feeBps ||
            candidate.feeVault() != canonicalFactory.feeVault() ||
            candidate.lpTokenFactory() != canonicalFactory.lpTokenFactory()
        ) revert InvalidPool();
        _requireCanonicalLPToken(canonicalFactory, candidate, pool);
    }

    function _requireRegisteredPool(address pool)
        internal
        view
        returns (IPublicCPMM candidate)
    {
        IPublicCPMMFactory canonicalFactory = IPublicCPMMFactory(factory);
        if (pool.code.length == 0 || !canonicalFactory.isPool(pool)) {
            revert InvalidPool();
        }
        candidate = IPublicCPMM(pool);
        if (
            candidate.PROTOCOL_VERSION() != canonicalFactory.PROTOCOL_VERSION() ||
            candidate.feeVault() != canonicalFactory.feeVault() ||
            candidate.lpTokenFactory() != canonicalFactory.lpTokenFactory()
        ) revert InvalidPool();
        _requireCanonicalLPToken(canonicalFactory, candidate, pool);
    }

    function _requireCanonicalLPToken(
        IPublicCPMMFactory canonicalFactory,
        IPublicCPMM candidate,
        address pool
    ) internal view {
        address token = candidate.lpToken();
        if (
            token.code.length == 0 ||
            !IPublicLPTokenFactory(canonicalFactory.lpTokenFactory()).isIssuedToken(
                pool,
                token,
                pool
            )
        ) revert InvalidLPToken();
    }

    function _pullExact(
        IERC20 token,
        address from,
        uint256 amount,
        uint256 startingBalance
    ) internal {
        token.safeTransferFrom(from, address(this), amount);
        uint256 endingBalance = token.balanceOf(address(this));
        if (endingBalance < startingBalance || endingBalance - startingBalance != amount) {
            revert TransferAmountMismatch();
        }
    }
}
