// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/Address.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IPublicCPMM.sol";
import "./interfaces/IPublicCPMMFactory.sol";

/**
 * @title PublicCPMMLimitOrderBook
 * @notice Permissionless full-fill limit orders for canonical public CPMM pools.
 * @dev Makers escrow an exact public ERC-20 input and may add a native COTI
 *      execution bounty. Any address may fill a live order once the pool itself
 *      can satisfy the maker's minimum output. This contract has no keeper,
 *      owner, rescue, or confidential-token execution path.
 */
contract PublicCPMMLimitOrderBook is ReentrancyGuard {
    using Address for address payable;
    using SafeERC20 for IERC20;

    uint256 public constant PROTOCOL_VERSION = 1;
    uint8 public constant PRIVACY_MODE = 0;
    uint256 public constant NATIVE_BOUNTY_PUSH_GAS_LIMIT = 30_000;

    enum OrderStatus {
        Open,
        Filled,
        Cancelled
    }

    struct Order {
        uint256 id;
        address maker;
        address recipient;
        address pool;
        address tokenIn;
        address tokenOut;
        bool zeroForOne;
        uint256 amountIn;
        uint256 minAmountOut;
        uint64 expiry;
        uint256 executionBounty;
        OrderStatus status;
    }

    address public immutable factory;
    uint256 public nextOrderId = 1;
    uint256 public totalOpenExecutionBounties;
    uint256 public totalClaimableNativeBounties;

    mapping(uint256 => Order) private orders;
    mapping(address => uint256) public totalEscrowed;
    mapping(address => uint256) public claimableNativeBounties;

    error InvalidFactory();
    error InvalidPool();
    error InvalidAmount();
    error InvalidMinimumOutput();
    error InvalidRecipient();
    error InvalidExpiry();
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

    event OrderCreated(
        uint256 indexed orderId,
        address indexed maker,
        address indexed pool,
        address recipient,
        address tokenIn,
        address tokenOut,
        bool zeroForOne,
        uint256 amountIn,
        uint256 minAmountOut,
        uint64 expiry,
        uint256 executionBounty
    );

    event OrderFilled(
        uint256 indexed orderId,
        address indexed maker,
        address indexed filler,
        address recipient,
        uint256 amountIn,
        uint256 amountOut,
        uint256 executionBounty
    );

    event OrderCancelled(
        uint256 indexed orderId,
        address indexed maker,
        uint256 amountIn,
        uint256 executionBounty
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

    constructor(address factory_) {
        if (factory_ == address(0) || factory_.code.length == 0) {
            revert InvalidFactory();
        }
        factory = factory_;
    }

    function createOrder(
        address pool,
        bool zeroForOne,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        uint64 expiry
    ) external payable nonReentrant returns (uint256 orderId) {
        if (!IPublicCPMMFactory(factory).isPool(pool)) revert InvalidPool();
        if (amountIn == 0) revert InvalidAmount();
        if (minAmountOut == 0) revert InvalidMinimumOutput();
        if (recipient == address(0) || recipient == address(this)) {
            revert InvalidRecipient();
        }
        if (expiry <= block.timestamp) revert InvalidExpiry();

        address token0 = IPublicCPMM(pool).token0();
        address token1 = IPublicCPMM(pool).token1();
        address tokenIn = zeroForOne ? token0 : token1;
        address tokenOut = zeroForOne ? token1 : token0;

        orderId = nextOrderId++;
        orders[orderId] = Order({
            id: orderId,
            maker: msg.sender,
            recipient: recipient,
            pool: pool,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            zeroForOne: zeroForOne,
            amountIn: amountIn,
            minAmountOut: minAmountOut,
            expiry: expiry,
            executionBounty: msg.value,
            status: OrderStatus.Open
        });
        totalEscrowed[tokenIn] += amountIn;
        totalOpenExecutionBounties += msg.value;

        IERC20 input = IERC20(tokenIn);
        uint256 balanceBefore = input.balanceOf(address(this));
        input.safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 balanceAfter = input.balanceOf(address(this));
        if (balanceAfter < balanceBefore || balanceAfter - balanceBefore != amountIn) {
            revert TransferAmountMismatch();
        }
        _requireEscrowBacked(input);

        emit OrderCreated(
            orderId,
            msg.sender,
            pool,
            recipient,
            tokenIn,
            tokenOut,
            zeroForOne,
            amountIn,
            minAmountOut,
            expiry,
            msg.value
        );
    }

    function canFillOrder(uint256 orderId)
        external
        view
        returns (bool canFill, uint256 expectedAmountOut)
    {
        Order storage order = orders[orderId];
        if (
            order.maker == address(0) ||
            order.status != OrderStatus.Open ||
            block.timestamp > order.expiry
        ) {
            return (false, 0);
        }

        try IPublicCPMM(order.pool).quoteExactInput(order.amountIn, order.zeroForOne)
            returns (uint256 quotedAmountOut)
        {
            expectedAmountOut = quotedAmountOut;
            canFill = quotedAmountOut >= order.minAmountOut;
        } catch {
            return (false, 0);
        }
    }

    function fillOrder(uint256 orderId)
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        Order storage order = _openOrder(orderId);
        if (block.timestamp > order.expiry) revert OrderExpired();

        address maker = order.maker;
        address recipient = order.recipient;
        address pool = order.pool;
        address tokenIn = order.tokenIn;
        address tokenOut = order.tokenOut;
        bool zeroForOne = order.zeroForOne;
        uint256 amountIn = order.amountIn;
        uint256 minAmountOut = order.minAmountOut;
        uint256 executionBounty = order.executionBounty;

        IERC20 input = IERC20(tokenIn);
        IERC20 output = IERC20(tokenOut);
        _requireEscrowBacked(input);

        order.status = OrderStatus.Filled;
        order.executionBounty = 0;
        totalEscrowed[tokenIn] -= amountIn;
        totalOpenExecutionBounties -= executionBounty;

        uint256 inputBalanceBefore = input.balanceOf(address(this));
        uint256 outputBalanceBefore = output.balanceOf(address(this));
        input.forceApprove(pool, amountIn);
        uint256 poolAmountOut = IPublicCPMM(pool).swapExactInput(
            amountIn,
            minAmountOut,
            zeroForOne,
            order.expiry
        );
        input.forceApprove(pool, 0);
        if (input.allowance(address(this), pool) != 0) revert ResidualAllowance();

        uint256 inputBalanceAfter = input.balanceOf(address(this));
        uint256 outputBalanceAfter = output.balanceOf(address(this));
        if (
            inputBalanceBefore < amountIn ||
            inputBalanceAfter != inputBalanceBefore - amountIn ||
            outputBalanceAfter < outputBalanceBefore ||
            outputBalanceAfter - outputBalanceBefore != poolAmountOut
        ) revert TransferAmountMismatch();
        _requireEscrowBacked(input);
        _requireNativeBountiesBacked();

        amountOut = _transferOutput(output, recipient, poolAmountOut, minAmountOut);
        _requireEscrowBacked(output);

        _payOrCreditNativeBounty(orderId, msg.sender, executionBounty);

        emit OrderFilled(
            orderId,
            maker,
            msg.sender,
            recipient,
            amountIn,
            amountOut,
            executionBounty
        );
    }

    function cancelOrder(uint256 orderId) external nonReentrant {
        Order storage order = _openOrder(orderId);
        if (order.maker != msg.sender) revert NotOrderMaker();

        address tokenIn = order.tokenIn;
        uint256 amountIn = order.amountIn;
        uint256 executionBounty = order.executionBounty;
        IERC20 input = IERC20(tokenIn);
        _requireEscrowBacked(input);

        order.status = OrderStatus.Cancelled;
        order.executionBounty = 0;
        totalEscrowed[tokenIn] -= amountIn;
        totalOpenExecutionBounties -= executionBounty;

        uint256 balanceBefore = input.balanceOf(address(this));
        input.safeTransfer(msg.sender, amountIn);
        uint256 balanceAfter = input.balanceOf(address(this));
        if (balanceBefore < amountIn || balanceAfter != balanceBefore - amountIn) {
            revert TransferAmountMismatch();
        }
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

    function getOrder(uint256 orderId) external view returns (Order memory) {
        return orders[orderId];
    }

    function _openOrder(uint256 orderId) internal view returns (Order storage order) {
        order = orders[orderId];
        if (order.maker == address(0)) revert OrderNotFound();
        if (order.status != OrderStatus.Open) revert OrderNotOpen();
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
        uint256 liabilities = totalOpenExecutionBounties + totalClaimableNativeBounties;
        if (address(this).balance < liabilities) {
            revert NativeBountyAccountingMismatch();
        }
    }

    function _transferOutput(
        IERC20 token,
        address recipient,
        uint256 amount,
        uint256 minimumReceived
    ) internal returns (uint256 received) {
        uint256 senderBefore = token.balanceOf(address(this));
        uint256 recipientBefore = token.balanceOf(recipient);
        if (senderBefore < amount) revert TransferAmountMismatch();
        token.safeTransfer(recipient, amount);
        uint256 senderAfter = token.balanceOf(address(this));
        uint256 recipientAfter = token.balanceOf(recipient);
        if (
            senderAfter > senderBefore ||
            senderBefore - senderAfter != amount ||
            recipientAfter < recipientBefore
        ) revert TransferAmountMismatch();
        received = recipientAfter - recipientBefore;
        if (received < minimumReceived) revert SlippageExceeded();
    }
}
