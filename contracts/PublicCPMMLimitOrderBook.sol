// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/Address.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "./interfaces/IPublicBestExecutionRouter.sol";

/**
 * @title PublicCPMMLimitOrderBook
 * @notice Permissionless pair-level escrow orders routed across canonical pools.
 * @dev Makers escrow exact-transfer public ERC-20 input. Fillers may execute an
 *      eligible full or partial amount through the immutable best-execution
 *      router and receive the proportional native COTI bounty.
 */
contract PublicCPMMLimitOrderBook is ReentrancyGuard {
    using Address for address payable;
    using SafeERC20 for IERC20;

    uint256 public constant PROTOCOL_VERSION = 1;
    uint8 public constant PRIVACY_MODE = 0;
    uint256 public constant NATIVE_BOUNTY_PUSH_GAS_LIMIT = 30_000;

    enum OrderStatus {
        None,
        Open,
        Filled,
        Cancelled
    }

    struct CreateOrderParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minAmountOut;
        address recipient;
        uint64 expiry;
        uint8 candidateBitmap;
        bool allowPartialFills;
        uint256 minimumFillAmount;
    }

    struct Amendment {
        address recipient;
        uint256 minAmountOutForRemaining;
        uint64 expiry;
        uint8 candidateBitmap;
        bool allowPartialFills;
        uint256 minimumFillAmount;
    }

    struct Order {
        uint256 id;
        address maker;
        address recipient;
        address tokenIn;
        address tokenOut;
        uint256 remainingAmountIn;
        uint256 priceNumerator;
        uint256 priceDenominator;
        uint256 minimumFillAmount;
        uint256 remainingExecutionBounty;
        uint64 expiry;
        uint32 revision;
        uint8 candidateBitmap;
        bool allowPartialFills;
    }

    address public immutable factory;
    address public immutable bestExecutionRouter;
    address payable public immutable surplusBeneficiary;
    uint256 public nextOrderId = 1;
    uint256 public totalOpenExecutionBounties;
    uint256 public totalClaimableNativeBounties;

    mapping(uint256 => Order) private orders;
    mapping(uint256 => OrderStatus) public orderStatus;
    mapping(address => uint256) public totalEscrowed;
    mapping(address => uint256) public claimableNativeBounties;

    error InvalidFactory();
    error InvalidRouter();
    error InvalidSurplusBeneficiary();
    error InvalidTokenPair();
    error InvalidAmount();
    error InvalidMinimumOutput();
    error InvalidRecipient();
    error InvalidExpiry();
    error InvalidCandidateBitmap();
    error InvalidPartialFillConfiguration();
    error InvalidFillAmount();
    error OrderNotFound();
    error OrderNotOpen();
    error OrderExpired();
    error NotOrderMaker();
    error TransferAmountMismatch();
    error SlippageExceeded();
    error ResidualAllowance();
    error EscrowNotBacked();
    error InvalidBountyRecipient();
    error NoClaimableNativeBounty();
    error NativeBountyAccountingMismatch();
    error PermitFailed();
    error NoSurplus();

    event OrderCreated(
        uint256 indexed orderId,
        address indexed maker,
        address indexed tokenIn,
        address tokenOut,
        address recipient,
        uint256 amountIn,
        uint256 minAmountOut,
        uint64 expiry,
        uint8 candidateBitmap,
        bool allowPartialFills,
        uint256 minimumFillAmount,
        uint256 executionBounty
    );

    event OrderAmended(
        uint256 indexed orderId,
        address indexed maker,
        uint32 revision,
        address recipient,
        uint256 minAmountOutForRemaining,
        uint64 expiry,
        uint8 candidateBitmap,
        bool allowPartialFills,
        uint256 minimumFillAmount
    );

    event OrderBountyIncreased(
        uint256 indexed orderId,
        address indexed maker,
        uint256 amount,
        uint256 remainingExecutionBounty
    );

    event OrderFilled(
        uint256 indexed orderId,
        address indexed maker,
        address indexed filler,
        address recipient,
        address selectedPool,
        uint256 selectedFeeBps,
        uint256 amountIn,
        uint256 amountOut,
        uint256 minimumAmountOut,
        uint256 remainingAmountIn,
        uint256 executionBounty
    );

    event OrderCancelled(
        uint256 indexed orderId,
        address indexed maker,
        uint256 returnedAmountIn,
        uint256 returnedExecutionBounty
    );

    event NativeBountyCredited(
        uint256 indexed orderId,
        address indexed beneficiary,
        uint256 amount
    );

    event NativeBountyClaimed(
        address indexed beneficiary,
        address indexed recipient,
        uint256 amount
    );

    event TokenSurplusSwept(
        address indexed token,
        address indexed beneficiary,
        uint256 amount
    );

    event NativeSurplusSwept(
        address indexed beneficiary,
        uint256 amount
    );

    constructor(
        address factory_,
        address bestExecutionRouter_,
        address payable surplusBeneficiary_
    ) {
        if (factory_ == address(0) || factory_.code.length == 0) {
            revert InvalidFactory();
        }
        if (
            bestExecutionRouter_ == address(0) ||
            bestExecutionRouter_.code.length == 0
        ) revert InvalidRouter();
        try IPublicBestExecutionRouter(bestExecutionRouter_).factory()
            returns (address boundFactory)
        {
            if (boundFactory != factory_) revert InvalidRouter();
        } catch {
            revert InvalidRouter();
        }
        try IPublicBestExecutionRouter(bestExecutionRouter_).PROTOCOL_VERSION()
            returns (uint256 routerVersion)
        {
            if (routerVersion != PROTOCOL_VERSION) revert InvalidRouter();
        } catch {
            revert InvalidRouter();
        }
        if (
            surplusBeneficiary_ == address(0) ||
            surplusBeneficiary_ == address(this)
        ) revert InvalidSurplusBeneficiary();
        factory = factory_;
        bestExecutionRouter = bestExecutionRouter_;
        surplusBeneficiary = surplusBeneficiary_;
    }

    function createOrder(CreateOrderParams calldata params)
        external
        payable
        nonReentrant
        returns (uint256 orderId)
    {
        return _createOrder(params, msg.sender, msg.value);
    }

    function createOrderWithPermit(
        CreateOrderParams calldata params,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external payable nonReentrant returns (uint256 orderId) {
        try IERC20Permit(params.tokenIn).permit(
            msg.sender,
            address(this),
            params.amountIn,
            permitDeadline,
            v,
            r,
            s
        ) {} catch {
            if (
                params.tokenIn.code.length == 0 ||
                IERC20(params.tokenIn).allowance(msg.sender, address(this)) <
                    params.amountIn
            ) revert PermitFailed();
        }
        return _createOrder(params, msg.sender, msg.value);
    }

    function amendOrder(uint256 orderId, Amendment calldata amendment)
        external
        nonReentrant
    {
        Order storage order = _openOrder(orderId);
        if (order.maker != msg.sender) revert NotOrderMaker();
        _validateMutableTerms(
            order.remainingAmountIn,
            amendment.minAmountOutForRemaining,
            amendment.recipient,
            amendment.expiry,
            amendment.candidateBitmap,
            amendment.allowPartialFills,
            amendment.minimumFillAmount
        );

        order.recipient = amendment.recipient;
        order.priceNumerator = amendment.minAmountOutForRemaining;
        order.priceDenominator = order.remainingAmountIn;
        order.expiry = amendment.expiry;
        order.candidateBitmap = amendment.candidateBitmap;
        order.allowPartialFills = amendment.allowPartialFills;
        order.minimumFillAmount = amendment.allowPartialFills
            ? amendment.minimumFillAmount
            : order.remainingAmountIn;
        order.revision += 1;

        emit OrderAmended(
            orderId,
            msg.sender,
            order.revision,
            order.recipient,
            amendment.minAmountOutForRemaining,
            order.expiry,
            order.candidateBitmap,
            order.allowPartialFills,
            order.minimumFillAmount
        );
    }

    function increaseExecutionBounty(uint256 orderId)
        external
        payable
        nonReentrant
    {
        Order storage order = _openOrder(orderId);
        if (order.maker != msg.sender) revert NotOrderMaker();
        if (msg.value == 0) revert InvalidAmount();
        order.remainingExecutionBounty += msg.value;
        totalOpenExecutionBounties += msg.value;
        _requireNativeBountiesBacked();
        emit OrderBountyIncreased(
            orderId,
            msg.sender,
            msg.value,
            order.remainingExecutionBounty
        );
    }

    function canFillOrder(uint256 orderId, uint256 amountInToFill)
        external
        view
        returns (
            bool canFill,
            address selectedPool,
            uint256 selectedFeeBps,
            uint256 expectedAmountOut,
            uint256 minimumAmountOut
        )
    {
        Order storage order = orders[orderId];
        if (
            orderStatus[orderId] != OrderStatus.Open ||
            block.timestamp > order.expiry ||
            !_validFillAmount(order, amountInToFill)
        ) return (false, address(0), 0, 0, 0);

        minimumAmountOut = _minimumOutput(order, amountInToFill);
        try IPublicBestExecutionRouter(bestExecutionRouter).quoteBestExactInput(
            order.tokenIn,
            order.tokenOut,
            amountInToFill,
            order.candidateBitmap
        ) returns (
            address pool,
            uint256 feeBps,
            bool,
            uint256 quotedAmountOut
        ) {
            selectedPool = pool;
            selectedFeeBps = feeBps;
            expectedAmountOut = quotedAmountOut;
            canFill = quotedAmountOut >= minimumAmountOut;
        } catch {
            return (false, address(0), 0, 0, minimumAmountOut);
        }
    }

    function fillOrder(uint256 orderId, uint256 amountInToFill)
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        Order storage order = _openOrder(orderId);
        if (block.timestamp > order.expiry) revert OrderExpired();
        if (!_validFillAmount(order, amountInToFill)) revert InvalidFillAmount();

        address maker = order.maker;
        address recipient = order.recipient;
        address tokenIn = order.tokenIn;
        address tokenOut = order.tokenOut;
        uint8 candidateBitmap = order.candidateBitmap;
        uint64 expiry = order.expiry;
        uint256 remainingBefore = order.remainingAmountIn;
        uint256 minimumAmountOut = _minimumOutput(order, amountInToFill);
        uint256 bounty = amountInToFill == remainingBefore
            ? order.remainingExecutionBounty
            : Math.mulDiv(
                order.remainingExecutionBounty,
                amountInToFill,
                remainingBefore
            );
        uint256 remainingAfter = remainingBefore - amountInToFill;

        IERC20 input = IERC20(tokenIn);
        _requireEscrowBacked(input);
        totalEscrowed[tokenIn] -= amountInToFill;
        totalOpenExecutionBounties -= bounty;

        if (remainingAfter == 0) {
            orderStatus[orderId] = OrderStatus.Filled;
            delete orders[orderId];
        } else {
            order.remainingAmountIn = remainingAfter;
            order.remainingExecutionBounty -= bounty;
        }

        uint256 inputBefore = input.balanceOf(address(this));
        input.forceApprove(bestExecutionRouter, amountInToFill);
        address selectedPool;
        uint256 selectedFeeBps;
        (selectedPool, selectedFeeBps, amountOut) =
            IPublicBestExecutionRouter(bestExecutionRouter).swapBestExactInput(
                tokenIn,
                tokenOut,
                amountInToFill,
                minimumAmountOut,
                candidateBitmap,
                recipient,
                expiry
            );
        input.forceApprove(bestExecutionRouter, 0);
        if (input.allowance(address(this), bestExecutionRouter) != 0) {
            revert ResidualAllowance();
        }
        uint256 inputAfter = input.balanceOf(address(this));
        if (
            inputBefore < amountInToFill ||
            inputAfter != inputBefore - amountInToFill
        ) revert TransferAmountMismatch();
        if (amountOut < minimumAmountOut) revert SlippageExceeded();
        _requireEscrowBacked(input);

        _payOrCreditNativeBounty(orderId, msg.sender, bounty);

        emit OrderFilled(
            orderId,
            maker,
            msg.sender,
            recipient,
            selectedPool,
            selectedFeeBps,
            amountInToFill,
            amountOut,
            minimumAmountOut,
            remainingAfter,
            bounty
        );
    }

    function cancelOrder(uint256 orderId) external nonReentrant {
        Order storage order = _openOrder(orderId);
        if (order.maker != msg.sender) revert NotOrderMaker();

        address tokenIn = order.tokenIn;
        uint256 amountIn = order.remainingAmountIn;
        uint256 executionBounty = order.remainingExecutionBounty;
        IERC20 input = IERC20(tokenIn);
        _requireEscrowBacked(input);

        totalEscrowed[tokenIn] -= amountIn;
        totalOpenExecutionBounties -= executionBounty;
        orderStatus[orderId] = OrderStatus.Cancelled;
        delete orders[orderId];

        _transferExact(input, msg.sender, amountIn);
        _requireEscrowBacked(input);
        _payOrCreditNativeBounty(orderId, msg.sender, executionBounty);

        emit OrderCancelled(orderId, msg.sender, amountIn, executionBounty);
    }

    function claimNativeBounty(address payable recipient)
        external
        nonReentrant
        returns (uint256 amount)
    {
        if (recipient == address(0) || recipient == address(this)) {
            revert InvalidBountyRecipient();
        }
        amount = claimableNativeBounties[msg.sender];
        if (amount == 0) revert NoClaimableNativeBounty();

        claimableNativeBounties[msg.sender] = 0;
        totalClaimableNativeBounties -= amount;
        recipient.sendValue(amount);
        _requireNativeBountiesBacked();

        emit NativeBountyClaimed(msg.sender, recipient, amount);
    }

    function sweepTokenSurplus(address token)
        external
        nonReentrant
        returns (uint256 amount)
    {
        if (token == address(0) || token.code.length == 0) {
            revert InvalidTokenPair();
        }
        IERC20 asset = IERC20(token);
        uint256 balance = asset.balanceOf(address(this));
        uint256 liability = totalEscrowed[token];
        if (balance <= liability) revert NoSurplus();
        amount = balance - liability;
        _transferExact(asset, surplusBeneficiary, amount);
        _requireEscrowBacked(asset);
        emit TokenSurplusSwept(token, surplusBeneficiary, amount);
    }

    function sweepNativeSurplus()
        external
        nonReentrant
        returns (uint256 amount)
    {
        uint256 liabilities =
            totalOpenExecutionBounties + totalClaimableNativeBounties;
        if (address(this).balance <= liabilities) revert NoSurplus();
        amount = address(this).balance - liabilities;
        surplusBeneficiary.sendValue(amount);
        _requireNativeBountiesBacked();
        emit NativeSurplusSwept(surplusBeneficiary, amount);
    }

    function getOrder(uint256 orderId) external view returns (Order memory) {
        return orders[orderId];
    }

    function minimumOutputFor(uint256 orderId, uint256 amountInToFill)
        external
        view
        returns (uint256)
    {
        Order storage order = _openOrder(orderId);
        if (!_validFillAmount(order, amountInToFill)) revert InvalidFillAmount();
        return _minimumOutput(order, amountInToFill);
    }

    function _createOrder(
        CreateOrderParams calldata params,
        address maker,
        uint256 executionBounty
    ) internal returns (uint256 orderId) {
        _validateMutableTerms(
            params.amountIn,
            params.minAmountOut,
            params.recipient,
            params.expiry,
            params.candidateBitmap,
            params.allowPartialFills,
            params.minimumFillAmount
        );
        if (
            params.tokenIn == address(0) ||
            params.tokenOut == address(0) ||
            params.tokenIn == params.tokenOut ||
            params.tokenIn.code.length == 0 ||
            params.tokenOut.code.length == 0
        ) revert InvalidTokenPair();

        orderId = nextOrderId++;
        orders[orderId] = Order({
            id: orderId,
            maker: maker,
            recipient: params.recipient,
            tokenIn: params.tokenIn,
            tokenOut: params.tokenOut,
            remainingAmountIn: params.amountIn,
            priceNumerator: params.minAmountOut,
            priceDenominator: params.amountIn,
            minimumFillAmount: params.allowPartialFills
                ? params.minimumFillAmount
                : params.amountIn,
            remainingExecutionBounty: executionBounty,
            expiry: params.expiry,
            revision: 0,
            candidateBitmap: params.candidateBitmap,
            allowPartialFills: params.allowPartialFills
        });
        orderStatus[orderId] = OrderStatus.Open;
        totalEscrowed[params.tokenIn] += params.amountIn;
        totalOpenExecutionBounties += executionBounty;

        IERC20 input = IERC20(params.tokenIn);
        uint256 balanceBefore = input.balanceOf(address(this));
        input.safeTransferFrom(maker, address(this), params.amountIn);
        uint256 balanceAfter = input.balanceOf(address(this));
        if (
            balanceAfter < balanceBefore ||
            balanceAfter - balanceBefore != params.amountIn
        ) revert TransferAmountMismatch();
        _requireEscrowBacked(input);
        _requireNativeBountiesBacked();

        emit OrderCreated(
            orderId,
            maker,
            params.tokenIn,
            params.tokenOut,
            params.recipient,
            params.amountIn,
            params.minAmountOut,
            params.expiry,
            params.candidateBitmap,
            params.allowPartialFills,
            params.allowPartialFills ? params.minimumFillAmount : params.amountIn,
            executionBounty
        );
    }

    function _validateMutableTerms(
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        uint64 expiry,
        uint8 candidateBitmap,
        bool allowPartialFills,
        uint256 minimumFillAmount
    ) internal view {
        if (amountIn == 0) revert InvalidAmount();
        if (minAmountOut == 0) revert InvalidMinimumOutput();
        if (recipient == address(0) || recipient == address(this)) {
            revert InvalidRecipient();
        }
        if (expiry <= block.timestamp) revert InvalidExpiry();
        uint8 supported = IPublicBestExecutionRouter(bestExecutionRouter)
            .ALL_CANDIDATE_BITMAP();
        if (
            candidateBitmap == 0 ||
            (candidateBitmap & ~supported) != 0
        ) revert InvalidCandidateBitmap();
        if (
            allowPartialFills
                ? minimumFillAmount == 0 || minimumFillAmount > amountIn
                : minimumFillAmount != 0 && minimumFillAmount != amountIn
        ) revert InvalidPartialFillConfiguration();
    }

    function _openOrder(uint256 orderId) internal view returns (Order storage order) {
        OrderStatus status = orderStatus[orderId];
        if (status == OrderStatus.None) revert OrderNotFound();
        if (status != OrderStatus.Open) revert OrderNotOpen();
        order = orders[orderId];
    }

    function _validFillAmount(Order storage order, uint256 amountInToFill)
        internal
        view
        returns (bool)
    {
        if (
            amountInToFill == 0 ||
            amountInToFill > order.remainingAmountIn
        ) return false;
        if (!order.allowPartialFills) {
            return amountInToFill == order.remainingAmountIn;
        }
        return amountInToFill == order.remainingAmountIn ||
            amountInToFill >= order.minimumFillAmount;
    }

    function _minimumOutput(Order storage order, uint256 amountInToFill)
        internal
        view
        returns (uint256)
    {
        return Math.mulDiv(
            amountInToFill,
            order.priceNumerator,
            order.priceDenominator,
            Math.Rounding.Ceil
        );
    }

    function _requireEscrowBacked(IERC20 token) internal view {
        if (token.balanceOf(address(this)) < totalEscrowed[address(token)]) {
            revert EscrowNotBacked();
        }
    }

    function _payOrCreditNativeBounty(
        uint256 orderId,
        address beneficiary,
        uint256 amount
    ) internal {
        if (amount != 0) {
            (bool paid,) = payable(beneficiary).call{
                value: amount,
                gas: NATIVE_BOUNTY_PUSH_GAS_LIMIT
            }("");
            if (!paid) {
                claimableNativeBounties[beneficiary] += amount;
                totalClaimableNativeBounties += amount;
                emit NativeBountyCredited(orderId, beneficiary, amount);
            }
        }
        _requireNativeBountiesBacked();
    }

    function _requireNativeBountiesBacked() internal view {
        uint256 liabilities =
            totalOpenExecutionBounties + totalClaimableNativeBounties;
        if (address(this).balance < liabilities) {
            revert NativeBountyAccountingMismatch();
        }
    }

    function _transferExact(IERC20 token, address recipient, uint256 amount)
        internal
    {
        uint256 senderBefore = token.balanceOf(address(this));
        uint256 recipientBefore = token.balanceOf(recipient);
        if (senderBefore < amount) revert TransferAmountMismatch();
        token.safeTransfer(recipient, amount);
        uint256 senderAfter = token.balanceOf(address(this));
        uint256 recipientAfter = token.balanceOf(recipient);
        if (
            senderAfter > senderBefore ||
            senderBefore - senderAfter != amount ||
            recipientAfter < recipientBefore ||
            recipientAfter - recipientBefore != amount
        ) revert TransferAmountMismatch();
    }
}
