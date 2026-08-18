// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@coti-io/coti-contracts/contracts/token/PrivateERC20/IPrivateERC20.sol";
import "@coti-io/coti-contracts/contracts/utils/mpc/MpcCore.sol";
import "./interfaces/IConfidentialCPMM.sol";
import "./interfaces/IConfidentialCPMMFactory.sol";
import "./interfaces/IConfidentialInitializationStrategy.sol";
import "./interfaces/IConfidentialLaunchpadMigrator.sol";
import "./libraries/SignatureValidation.sol";

/**
 * @title ConfidentialLaunchpadMigrator
 * @notice Atomic permissionless bootstrap adapter for COTI PrivateERC20 pools.
 *
 * The creator signs every encrypted input for this contract and its `migrate`
 * selector. The migrator validates those inputs locally, pulls the exact
 * encrypted amounts into transaction-scoped escrow, grants the canonical pool
 * exact encrypted allowances, and initializes it in the same transaction. A
 * failed pool initialization reverts every transfer and approval.
 *
 * This contract does not claim hidden recipients or hidden token identities.
 * It emits only creator/pool identity; amounts, price bounds and LP shares stay
 * inside COTI MPC values.
 */
contract ConfidentialLaunchpadMigrator is IConfidentialLaunchpadMigrator {
    uint256 public constant PROTOCOL_VERSION = 4;
    bytes32 public constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant EIP712_NAME_HASH = keccak256("CipherDEX Launchpad Migrator");
    bytes32 private constant EIP712_VERSION_HASH = keccak256("1");
    bytes32 public constant MIGRATION_TYPEHASH = keccak256(
        "Migration(bytes32 launchId,bytes32 launchCommitmentHash,address initializationStrategy,address creator,address tokenA,address tokenB,uint8 decimalsA,uint8 decimalsB,uint256 feeBps,bytes32 encryptedInputsHash,uint64 deadline,bool withDisposition,uint8 disposition,uint64 unlockTime)"
    );

    address public immutable factory;
    address public immutable initializationStrategy;
    uint256 private immutable deploymentChainId;
    bytes32 private immutable deploymentDomainSeparator;
    uint256 private reentrancyState = 1;
    mapping(bytes32 => bool) private consumedInputs;

    error InvalidFactory();
    error InvalidInitializationStrategy();
    error InvalidTokenPair();
    error DeadlineExpired();
    error InputAlreadyConsumed();
    error Reentrancy();
    error InvalidAuthorization();
    error InvalidLaunchCommitment();
    error PrivateTransferAmountMismatch();

    modifier nonReentrant() {
        if (reentrancyState != 1) revert Reentrancy();
        reentrancyState = 2;
        _;
        reentrancyState = 1;
    }

    constructor(address factory_, address initializationStrategy_) {
        if (factory_.code.length == 0) revert InvalidFactory();
        // The reviewed strategy creates its own exact migrator while the
        // strategy is under construction, so no proxy or lookalike facade can
        // be admitted later. Calls back into the strategy are not possible
        // until its constructor has completed.
        if (
            initializationStrategy_ == address(0) ||
            msg.sender != initializationStrategy_
        ) revert InvalidInitializationStrategy();
        factory = factory_;
        initializationStrategy = initializationStrategy_;
        deploymentChainId = block.chainid;
        deploymentDomainSeparator = _buildDomainSeparator(block.chainid);
    }

    /**
     * @notice Create or resolve the canonical factory pool and seed it atomically.
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
    function migrate(MigrationRequest calldata request)
        external
        nonReentrant
        returns (address pool, ctUint256 memory mintedShares)
    {
        (pool, mintedShares, ) = _migrate(request, false, 0, 0);
    }

    /**
     * @notice Atomically migrates liquidity with an explicit LP disposition.
     * @dev `disposition` uses the pool constants: 0 creator-held, 1 timed lock,
     *      and 2 permanent lock. The five encrypted values are still signed
     *      for this exact selector; public disposition fields are independently
     *      validated by the pool.
     */
    function migrateWithDisposition(
        MigrationRequest calldata request,
        uint8 disposition,
        uint64 unlockTime
    ) external nonReentrant returns (address pool, ctUint256 memory mintedShares, bytes32 lockId) {
        return _migrate(request, true, disposition, unlockTime);
    }

    function _migrate(
        MigrationRequest calldata request,
        bool withDisposition,
        uint8 disposition,
        uint64 unlockTime
    ) internal returns (address pool, ctUint256 memory mintedShares, bytes32 lockId) {
        if (request.deadline < block.timestamp) revert DeadlineExpired();
        if (
            request.launchId == bytes32(0) ||
            request.launchCommitmentHash == bytes32(0)
        ) revert InvalidLaunchCommitment();
        if (request.tokenA == address(0) || request.tokenB == address(0) || request.tokenA == request.tokenB) {
            revert InvalidTokenPair();
        }

        if (
            !_isMigrationAuthorizationValid(
                msg.sender,
                request,
                withDisposition,
                disposition,
                unlockTime
            )
        ) revert InvalidAuthorization();

        (address token0, address token1, uint8 decimals0, uint8 decimals1) = request.tokenA < request.tokenB
            ? (request.tokenA, request.tokenB, request.decimalsA, request.decimalsB)
            : (request.tokenB, request.tokenA, request.decimalsB, request.decimalsA);
        IConfidentialCPMMFactory factoryContract = IConfidentialCPMMFactory(factory);
        bytes32 key = factoryContract.poolKey(
            token0,
            token1,
            decimals0,
            decimals1,
            request.feeBps,
            initializationStrategy
        );
        pool = factoryContract.getPool(key);
        if (pool == address(0) || !factoryContract.isPool(pool)) {
            revert InvalidLaunchCommitment();
        }
        IConfidentialCPMM canonicalPool = IConfidentialCPMM(pool);
        if (
            canonicalPool.PROTOCOL_VERSION() !=
                factoryContract.PROTOCOL_VERSION() ||
            canonicalPool.PRIVACY_MODE() != factoryContract.PRIVACY_MODE() ||
            canonicalPool.token0() != token0 ||
            canonicalPool.token1() != token1 ||
            canonicalPool.token0Decimals() != decimals0 ||
            canonicalPool.token1Decimals() != decimals1 ||
            canonicalPool.feeBps() != request.feeBps ||
            canonicalPool.initializationStrategy() != initializationStrategy ||
            canonicalPool.initialized()
        ) revert InvalidLaunchCommitment();

        gtUint256 gtAmount0 = _validateAndConsume(request.amount0, 0);
        gtUint256 gtAmount1 = _validateAndConsume(request.amount1, 1);
        gtUint256 gtMinShares = _validateAndConsume(request.minShares, 2);
        gtUint256 gtMinPrice = _validateAndConsume(request.minPriceX18, 3);
        gtUint256 gtMaxPrice = _validateAndConsume(request.maxPriceX18, 4);

        // Pull into atomic escrow using the creator's explicit encrypted
        // allowances. The pool then pulls the same values using one-time exact
        // approvals, allowing it to verify transfer deltas even when its
        // deterministic address received an unsolicited balance beforehand.
        gtUint256 startingBalance0 = _pullPrivateExact(
            IPrivateERC20(token0),
            msg.sender,
            gtAmount0
        );
        gtUint256 startingBalance1 = _pullPrivateExact(
            IPrivateERC20(token1),
            msg.sender,
            gtAmount1
        );
        IPrivateERC20(token0).approveGT(pool, gtAmount0);
        IPrivateERC20(token1).approveGT(pool, gtAmount1);

        if (withDisposition) {
            (mintedShares, lockId) = factoryContract.bootstrapPoolWithDisposition(
                initializationStrategy,
                request.launchId,
                request.launchCommitmentHash,
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
                initializationStrategy,
                request.launchId,
                request.launchCommitmentHash,
                pool,
                msg.sender,
                gtUint256.unwrap(gtAmount0),
                gtUint256.unwrap(gtAmount1),
                gtUint256.unwrap(gtMinShares),
                gtUint256.unwrap(gtMinPrice),
                gtUint256.unwrap(gtMaxPrice)
            );
        }
        _requirePrivateBalance(IPrivateERC20(token0), startingBalance0);
        _requirePrivateBalance(IPrivateERC20(token1), startingBalance1);
        emit LaunchpadMigration(
            request.launchId,
            msg.sender,
            pool,
            initializationStrategy,
            request.launchCommitmentHash
        );
        if (withDisposition) {
            emit LaunchpadLockDisposition(msg.sender, pool, disposition, lockId, unlockTime);
        }
    }

    function _isMigrationAuthorizationValid(
        address creator,
        MigrationRequest calldata request,
        bool withDisposition,
        uint8 disposition,
        uint64 unlockTime
    ) internal view returns (bool) {
        bytes32 digest = _migrationAuthorizationDigest(
            creator,
            request,
            withDisposition,
            disposition,
            unlockTime
        );
        return SignatureValidation.isValidSignatureNow(
            creator,
            digest,
            request.authorization
        );
    }

    function _pullPrivateExact(
        IPrivateERC20 token,
        address from,
        gtUint256 amount
    ) internal returns (gtUint256 beforeBalance) {
        beforeBalance = token.balanceOf();
        token.transferFromGT(from, address(this), amount);
        (gtBool overflow, gtUint256 expectedBalance) =
            MpcCore.checkedAddWithOverflowBit(beforeBalance, amount);
        if (MpcCore.decrypt(overflow)) revert PrivateTransferAmountMismatch();
        gtUint256 actualBalance = token.balanceOf();
        if (!MpcCore.decrypt(MpcCore.eq(actualBalance, expectedBalance))) {
            revert PrivateTransferAmountMismatch();
        }
    }

    function _requirePrivateBalance(
        IPrivateERC20 token,
        gtUint256 expectedBalance
    ) internal {
        gtUint256 actualBalance = token.balanceOf();
        if (!MpcCore.decrypt(MpcCore.eq(actualBalance, expectedBalance))) {
            revert PrivateTransferAmountMismatch();
        }
    }

    function _migrationAuthorizationDigest(
        address creator,
        MigrationRequest calldata request,
        bool withDisposition,
        uint8 disposition,
        uint64 unlockTime
    ) internal view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    MIGRATION_TYPEHASH,
                    request.launchId,
                    request.launchCommitmentHash,
                    initializationStrategy,
                    creator,
                    request.tokenA,
                    request.tokenB,
                    request.decimalsA,
                    request.decimalsB,
                    request.feeBps,
                    _encryptedInputsHash(
                        request.amount0,
                        request.amount1,
                        request.minShares,
                        request.minPriceX18,
                        request.maxPriceX18
                    ),
                    request.deadline,
                    withDisposition,
                    disposition,
                    unlockTime
                )
            )
        );
    }

    function _inputCommitment(itUint256 calldata input) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                ctUint128.unwrap(input.ciphertext.ciphertextHigh),
                ctUint128.unwrap(input.ciphertext.ciphertextLow),
                keccak256(input.signature)
            )
        );
    }

    function _encryptedInputsHash(
        itUint256 calldata amount0,
        itUint256 calldata amount1,
        itUint256 calldata minShares,
        itUint256 calldata minPriceX18,
        itUint256 calldata maxPriceX18
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                _inputCommitment(amount0),
                _inputCommitment(amount1),
                _inputCommitment(minShares),
                _inputCommitment(minPriceX18),
                _inputCommitment(maxPriceX18)
            )
        );
    }

    function _hashTypedDataV4(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparatorV4(), structHash));
    }

    function _domainSeparatorV4() internal view returns (bytes32) {
        if (block.chainid == deploymentChainId) return deploymentDomainSeparator;
        return _buildDomainSeparator(block.chainid);
    }

    function _buildDomainSeparator(uint256 chainId) private view returns (bytes32) {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                EIP712_NAME_HASH,
                EIP712_VERSION_HASH,
                chainId,
                address(this)
            )
        );
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
