// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "./interfaces/IPublicCPMM.sol";
import "./interfaces/IPublicCPMMFactory.sol";
import "./interfaces/IPublicCPMMLiquidityRouter.sol";

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

    error InvalidFactory();
    error InvalidPool();
    error InvalidTokenPair();
    error InvalidAmount();
    error DeadlineExpired();
    error TransferAmountMismatch();
    error ResidualAllowance();
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
        if (candidate.PROTOCOL_VERSION() != 2 || candidate.feeVault().code.length == 0) {
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
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (tokenA == address(0) || tokenB == address(0) || tokenA == tokenB) {
            revert InvalidTokenPair();
        }
        if (amountADesired == 0 || amountBDesired == 0) revert InvalidAmount();

        bool aIsToken0 = tokenA < tokenB;
        address token0 = aIsToken0 ? tokenA : tokenB;
        address token1 = aIsToken0 ? tokenB : tokenA;
        uint8 decimals0 = aIsToken0 ? decimalsA : decimalsB;
        uint8 decimals1 = aIsToken0 ? decimalsB : decimalsA;
        uint256 desired0 = aIsToken0 ? amountADesired : amountBDesired;
        uint256 desired1 = aIsToken0 ? amountBDesired : amountADesired;

        IPublicCPMMFactory canonicalFactory = IPublicCPMMFactory(factory);
        bytes32 key = canonicalFactory.poolKey(
            token0,
            token1,
            decimals0,
            decimals1,
            feeBps
        );
        pool = canonicalFactory.getPool(key);
        bool poolCreated = pool == address(0);
        if (poolCreated) {
            pool = canonicalFactory.createPool(
                token0,
                token1,
                decimals0,
                decimals1,
                feeBps
            );
        }
        _requireCanonicalPool(
            canonicalFactory,
            pool,
            token0,
            token1,
            decimals0,
            decimals1,
            feeBps
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
            msg.sender,
            desired0,
            desired1,
            minShares,
            minPriceX18,
            maxPriceX18,
            deadline
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
            msg.sender,
            pool,
            poolCreated,
            aIsToken0 ? amountAUsed : amountBUsed,
            aIsToken0 ? amountBUsed : amountAUsed,
            mintedShares
        );
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
            candidate.feeVault() != canonicalFactory.feeVault()
        ) revert InvalidPool();
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
