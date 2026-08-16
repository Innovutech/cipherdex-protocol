// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ConfidentialCPMM.sol";
import "./CipherDEXFeePolicy.sol";
import "./interfaces/IConfidentialCPMM.sol";
import "./interfaces/IConfidentialCPMMFactory.sol";
import "./interfaces/IPrivateLPTokenFactory.sol";

/**
 * @title ConfidentialCPMMFactory
 * @notice Permissionless deterministic factory for immutable confidential pools.
 *
 * There is no owner, fee manager or withdrawal authority. The pool's fee and pair
 * are fixed in its constructor and the factory only records public pool identity.
 */
contract ConfidentialCPMMFactory is IConfidentialCPMMFactory, CipherDEXFeePolicy {
    uint256 public constant PROTOCOL_VERSION = 2;
    uint8 public constant PRIVACY_MODE = 1;
    mapping(bytes32 => address) public getPool;
    mapping(address => bool) public isPool;
    mapping(bytes32 => bool) public isApprovedPrivateTokenCodehash;
    bytes32[] private approvedPrivateTokenCodehashes;
    address[] private pools;
    address public immutable lpTokenFactory;
    address public immutable feeVault;
    address public immutable bootstrapConfigurator;
    address public bootstrapAdapter;

    error InvalidTokenPair();
    error InvalidFee();
    error InvalidFeeVault();
    error InvalidLPTokenFactory();
    error InvalidPrivateTokenCodehash();
    error UnsupportedPrivateTokenImplementation();
    error PoolAlreadyExists();
    error UnknownPool();
    error BootstrapAdapterUnauthorized();
    error BootstrapAdapterAlreadyConfigured();
    error InvalidBootstrapAdapter();
    error PoolAlreadyInitialized();

    constructor(
        address feeVault_,
        address lpTokenFactory_,
        bytes32[] memory privateTokenCodehashes_
    ) {
        if (feeVault_.code.length == 0) revert InvalidFeeVault();
        if (lpTokenFactory_.code.length == 0) revert InvalidLPTokenFactory();
        if (privateTokenCodehashes_.length == 0) revert InvalidPrivateTokenCodehash();
        for (uint256 index = 0; index < privateTokenCodehashes_.length; index++) {
            bytes32 codehash = privateTokenCodehashes_[index];
            if (codehash == bytes32(0)) revert InvalidPrivateTokenCodehash();
            if (!isApprovedPrivateTokenCodehash[codehash]) {
                isApprovedPrivateTokenCodehash[codehash] = true;
                approvedPrivateTokenCodehashes.push(codehash);
            }
        }
        bootstrapConfigurator = msg.sender;
        lpTokenFactory = lpTokenFactory_;
        feeVault = feeVault_;
    }

    /**
     * @notice Binds the one launchpad adapter allowed to initialize a factory pool.
     * @dev This is a one-time deployment operation. It cannot change pool
     *      parameters, withdraw tokens, or be repeated after configuration.
     */
    function setBootstrapAdapter(address adapter) external {
        if (msg.sender != bootstrapConfigurator) revert BootstrapAdapterUnauthorized();
        if (bootstrapAdapter != address(0)) revert BootstrapAdapterAlreadyConfigured();
        if (adapter.code.length == 0) revert InvalidBootstrapAdapter();
        bootstrapAdapter = adapter;
        emit BootstrapAdapterConfigured(adapter);
    }

    function createPool(
        address tokenA,
        address tokenB,
        uint8 decimalsA,
        uint8 decimalsB,
        uint256 feeBps
    ) external returns (address pool) {
        (address token0, address token1, uint8 decimals0, uint8 decimals1) = _validateAndSortPool(
            tokenA,
            tokenB,
            decimalsA,
            decimalsB,
            feeBps
        );
        bytes32 key = poolKey(token0, token1, decimals0, decimals1, feeBps);
        if (getPool[key] != address(0)) revert PoolAlreadyExists();
        pool = _deployPool(key, token0, token1, decimals0, decimals1, feeBps);
        getPool[key] = pool;
    }

    /**
     * @notice Resolves the one canonical pool for an atomic launchpad bootstrap.
     * @dev Only the immutable adapter may call this function. If the pool does
     *      not exist, creation and the later bootstrap occur in the same outer
     *      migrator transaction. An existing initialized market is never
     *      replaced or shadowed by an alternate launchpad namespace.
     */
    function getOrCreatePoolForBootstrap(
        address tokenA,
        address tokenB,
        uint8 decimalsA,
        uint8 decimalsB,
        uint256 feeBps
    ) external returns (address pool) {
        if (msg.sender != bootstrapAdapter) revert BootstrapAdapterUnauthorized();
        (address token0, address token1, uint8 decimals0, uint8 decimals1) = _validateAndSortPool(
            tokenA,
            tokenB,
            decimalsA,
            decimalsB,
            feeBps
        );
        bytes32 key = poolKey(token0, token1, decimals0, decimals1, feeBps);
        pool = getPool[key];
        if (pool == address(0)) {
            pool = _deployPool(key, token0, token1, decimals0, decimals1, feeBps);
            getPool[key] = pool;
        } else if (IConfidentialCPMM(pool).initialized()) {
            revert PoolAlreadyInitialized();
        }
    }

    function _validateAndSortPool(
        address tokenA,
        address tokenB,
        uint8 decimalsA,
        uint8 decimalsB,
        uint256 feeBps
    ) internal view returns (address token0, address token1, uint8 decimals0, uint8 decimals1) {
        if (tokenA == address(0) || tokenB == address(0) || tokenA == tokenB) {
            revert InvalidTokenPair();
        }
        if (!isApprovedFeeTier(feeBps)) revert InvalidFee();
        if (
            !isApprovedPrivateTokenCodehash[tokenA.codehash] ||
            !isApprovedPrivateTokenCodehash[tokenB.codehash]
        ) revert UnsupportedPrivateTokenImplementation();

        return tokenA < tokenB
            ? (tokenA, tokenB, decimalsA, decimalsB)
            : (tokenB, tokenA, decimalsB, decimalsA);
    }

    function _deployPool(
        bytes32 key,
        address token0,
        address token1,
        uint8 decimals0,
        uint8 decimals1,
        uint256 feeBps
    ) internal returns (address pool) {
        pool = address(new ConfidentialCPMM{salt: key}(
            token0,
            token1,
            decimals0,
            decimals1,
            feeBps,
            feeVault
        ));
        address lpTokenAddress = IPrivateLPTokenFactory(lpTokenFactory).create(pool);
        IConfidentialCPMM(pool).initializeLPToken(lpTokenAddress);
        isPool[pool] = true;
        pools.push(pool);

        emit PoolCreated(token0, token1, decimals0, decimals1, feeBps, pool);
        emit PrivateLPTokenCreated(pool, lpTokenAddress);
    }

    function poolKey(
        address token0,
        address token1,
        uint8,
        uint8,
        uint256 feeBps
    ) public pure returns (bytes32) {
        return token0 < token1
            ? keccak256(abi.encode(token0, token1, feeBps, PRIVACY_MODE, PROTOCOL_VERSION))
            : keccak256(abi.encode(token1, token0, feeBps, PRIVACY_MODE, PROTOCOL_VERSION));
    }

    /**
     * @notice Completes an atomic launchpad bootstrap for a known factory pool.
     * @dev The launchpad validates creator-signed inputs, escrows the exact private
     *      assets and grants the pool matching encrypted allowances before calling
     *      this function. The pool validates its logical empty-reserve state and
     *      price bounds, then pulls exact deltas from the adapter.
     *      Compatible token transfers and pool accounting remain atomic; raw
     *      unsolicited token balances never enter reserves or LP claims. No
     *      plaintext amount crosses this boundary.
     */
    function bootstrapPool(
        address pool,
        address provider,
        uint256 amount0,
        uint256 amount1,
        uint256 minShares,
        uint256 minPriceX18,
        uint256 maxPriceX18
    ) external returns (ctUint256 memory mintedShares) {
        if (msg.sender != bootstrapAdapter) revert BootstrapAdapterUnauthorized();
        if (!isPool[pool]) revert UnknownPool();
        return IConfidentialCPMM(pool).bootstrapLiquidity(
            provider,
            msg.sender,
            amount0,
            amount1,
            minShares,
            minPriceX18,
            maxPriceX18
        );
    }

    /**
     * @notice Atomically bootstraps a pool with a creator-held or locked LP
     *         disposition selected by the launchpad.
     */
    function bootstrapPoolWithDisposition(
        address pool,
        address provider,
        uint256 amount0,
        uint256 amount1,
        uint256 minShares,
        uint256 minPriceX18,
        uint256 maxPriceX18,
        uint8 disposition,
        uint64 unlockTime
    ) external returns (ctUint256 memory mintedShares, bytes32 lockId) {
        if (msg.sender != bootstrapAdapter) revert BootstrapAdapterUnauthorized();
        if (!isPool[pool]) revert UnknownPool();
        return IConfidentialCPMM(pool).bootstrapLiquidityWithDisposition(
            provider,
            msg.sender,
            amount0,
            amount1,
            minShares,
            minPriceX18,
            maxPriceX18,
            disposition,
            unlockTime
        );
    }

    function allPoolsLength() external view returns (uint256) {
        return pools.length;
    }

    function allPools(uint256 index) external view returns (address) {
        return pools[index];
    }

    function approvedPrivateTokenCodehashesLength() external view returns (uint256) {
        return approvedPrivateTokenCodehashes.length;
    }

    function approvedPrivateTokenCodehash(uint256 index) external view returns (bytes32) {
        return approvedPrivateTokenCodehashes[index];
    }

    /**
     * @notice Checks the token's current runtime implementation against this
     *         factory's immutable deployment-time policy.
     */
    function isApprovedPrivateToken(address token) external view returns (bool) {
        return token.code.length != 0 && isApprovedPrivateTokenCodehash[token.codehash];
    }
}
