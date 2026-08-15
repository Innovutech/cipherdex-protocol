// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@coti-io/coti-contracts/contracts/token/PrivateERC20/IPrivateERC20.sol";
import "@coti-io/coti-contracts/contracts/utils/mpc/MpcCore.sol";

import "./interfaces/IConfidentialCPMM.sol";
import "./interfaces/IConfidentialCPMMFactory.sol";
import "./interfaces/IConfidentialLaunchpadMigrator.sol";

/**
 * @title ConfidentialLaunchpadMigrator
 * @notice Atomic permissionless bootstrap adapter for COTI PrivateERC20 pools.
 *
 * The creator signs every encrypted input for this contract and its `migrate`
 * selector. The migrator validates those inputs locally, pulls the exact
 * encrypted amounts through the official `transferFromGT` allowance path, and
 * asks the factory to initialize a new or empty pool in the same transaction.
 * A failed pool initialization reverts the transfers as well.
 *
 * This contract does not claim hidden recipients or hidden token identities.
 * It emits only creator/pool identity; amounts, price bounds and LP shares stay
 * inside COTI MPC values.
 */
contract ConfidentialLaunchpadMigrator is IConfidentialLaunchpadMigrator {
    uint256 public constant PROTOCOL_VERSION = 1;

    address public immutable factory;
    uint256 private reentrancyState = 1;
    mapping(bytes32 => bool) private consumedInputs;

    error InvalidFactory();
    error InvalidTokenPair();
    error PoolAlreadyInitialized();
    error DeadlineExpired();
    error InputAlreadyConsumed();
    error Reentrancy();

    modifier nonReentrant() {
        if (reentrancyState != 1) revert Reentrancy();
        reentrancyState = 2;
        _;
        reentrancyState = 1;
    }

    constructor(address factory_) {
        if (factory_ == address(0)) revert InvalidFactory();
        factory = factory_;
    }

    /**
     * @notice Create or select an empty factory pool and seed it atomically.
     *
     * Inputs use the pool's canonical order after address sorting: `amount0`
     * belongs to the lower token address and `amount1` to the higher address.
     * `priceX18` is normalized token1 per normalized token0. The encrypted
     * bounds allow a launchpad to preserve a bonding-curve final price without
     * exposing the ratio on-chain.
     *
     * The caller must have granted this migrator encrypted allowances for both
     * tokens. Those approvals remain a separate, explicit user action.
     */
    function migrate(
        address tokenA,
        address tokenB,
        uint8 decimalsA,
        uint8 decimalsB,
        uint256 feeBps,
        itUint256 calldata amount0,
        itUint256 calldata amount1,
        itUint256 calldata minShares,
        itUint256 calldata minPriceX18,
        itUint256 calldata maxPriceX18,
        uint64 deadline
    ) external nonReentrant returns (address pool, ctUint256 memory mintedShares) {
        (pool, mintedShares, ) = _migrate(
            tokenA,
            tokenB,
            decimalsA,
            decimalsB,
            feeBps,
            amount0,
            amount1,
            minShares,
            minPriceX18,
            maxPriceX18,
            deadline,
            false,
            0,
            0
        );
    }

    /**
     * @notice Atomically migrates liquidity with an explicit LP disposition.
     * @dev `disposition` uses the pool constants: 0 creator-held, 1 timed lock,
     *      and 2 permanent lock. The five encrypted values are still signed
     *      for this exact selector; public disposition fields are independently
     *      validated by the pool.
     */
    function migrateWithDisposition(
        address tokenA,
        address tokenB,
        uint8 decimalsA,
        uint8 decimalsB,
        uint256 feeBps,
        itUint256 calldata amount0,
        itUint256 calldata amount1,
        itUint256 calldata minShares,
        itUint256 calldata minPriceX18,
        itUint256 calldata maxPriceX18,
        uint64 deadline,
        uint8 disposition,
        uint64 unlockTime
    ) external nonReentrant returns (address pool, ctUint256 memory mintedShares, bytes32 lockId) {
        return _migrate(
            tokenA,
            tokenB,
            decimalsA,
            decimalsB,
            feeBps,
            amount0,
            amount1,
            minShares,
            minPriceX18,
            maxPriceX18,
            deadline,
            true,
            disposition,
            unlockTime
        );
    }

    function _migrate(
        address tokenA,
        address tokenB,
        uint8 decimalsA,
        uint8 decimalsB,
        uint256 feeBps,
        itUint256 calldata amount0,
        itUint256 calldata amount1,
        itUint256 calldata minShares,
        itUint256 calldata minPriceX18,
        itUint256 calldata maxPriceX18,
        uint64 deadline,
        bool withDisposition,
        uint8 disposition,
        uint64 unlockTime
    ) internal returns (address pool, ctUint256 memory mintedShares, bytes32 lockId) {
        if (deadline < block.timestamp) revert DeadlineExpired();
        if (tokenA == address(0) || tokenB == address(0) || tokenA == tokenB) {
            revert InvalidTokenPair();
        }

        gtUint256 gtAmount0 = _validateAndConsume(amount0, 0);
        gtUint256 gtAmount1 = _validateAndConsume(amount1, 1);
        gtUint256 gtMinShares = _validateAndConsume(minShares, 2);
        gtUint256 gtMinPrice = _validateAndConsume(minPriceX18, 3);
        gtUint256 gtMaxPrice = _validateAndConsume(maxPriceX18, 4);

        (address token0, address token1, uint8 decimals0, uint8 decimals1) = tokenA < tokenB
            ? (tokenA, tokenB, decimalsA, decimalsB)
            : (tokenB, tokenA, decimalsB, decimalsA);
        IConfidentialCPMMFactory factoryContract = IConfidentialCPMMFactory(factory);
        bytes32 key = factoryContract.poolKey(token0, token1, decimals0, decimals1, feeBps);
        pool = factoryContract.getPool(key);
        if (pool == address(0)) {
            pool = factoryContract.createPool(token0, token1, decimals0, decimals1, feeBps);
        }

        if (IConfidentialCPMM(pool).initialized()) revert PoolAlreadyInitialized();

        // The signed values were validated for this migrator and selector;
        // transferFromGT only consumes the resulting MPC values under the
        // explicit encrypted allowances granted to this migrator.
        IPrivateERC20(token0).transferFromGT(msg.sender, pool, gtAmount0);
        IPrivateERC20(token1).transferFromGT(msg.sender, pool, gtAmount1);

        if (withDisposition) {
            (mintedShares, lockId) = factoryContract.bootstrapPoolWithDisposition(
                pool,
                msg.sender,
                gtUint256.unwrap(gtAmount0),
                gtUint256.unwrap(gtAmount1),
                gtUint256.unwrap(gtMinShares),
                gtUint256.unwrap(gtMinPrice),
                gtUint256.unwrap(gtMaxPrice),
                disposition,
                unlockTime
            );
        } else {
            mintedShares = factoryContract.bootstrapPool(
                pool,
                msg.sender,
                gtUint256.unwrap(gtAmount0),
                gtUint256.unwrap(gtAmount1),
                gtUint256.unwrap(gtMinShares),
                gtUint256.unwrap(gtMinPrice),
                gtUint256.unwrap(gtMaxPrice)
            );
        }
        emit LaunchpadMigration(msg.sender, pool);
        if (withDisposition) {
            emit LaunchpadLockDisposition(msg.sender, pool, disposition, lockId, unlockTime);
        }
    }

    function _validateAndConsume(itUint256 calldata input, uint8 slot)
        internal
        returns (gtUint256 value)
    {
        bytes32 digest = keccak256(
            abi.encode(
                slot,
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
