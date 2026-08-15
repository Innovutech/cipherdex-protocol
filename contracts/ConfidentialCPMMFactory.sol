// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ConfidentialCPMM.sol";
import "./PrivateLPTokenFactory.sol";
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
contract ConfidentialCPMMFactory is IConfidentialCPMMFactory {
    uint256 public constant PROTOCOL_VERSION = 1;
    mapping(bytes32 => address) public getPool;
    mapping(address => bool) public isPool;
    address[] private pools;
    address public immutable lpTokenFactory;
    address public immutable bootstrapConfigurator;
    address public bootstrapAdapter;

    error InvalidTokenPair();
    error PoolAlreadyExists();
    error UnknownPool();
    error BootstrapAdapterUnauthorized();
    error BootstrapAdapterAlreadyConfigured();
    error InvalidBootstrapAdapter();

    constructor() {
        bootstrapConfigurator = msg.sender;
        lpTokenFactory = address(new PrivateLPTokenFactory());
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
        if (tokenA == address(0) || tokenB == address(0) || tokenA == tokenB) {
            revert InvalidTokenPair();
        }

        (address token0, address token1, uint8 decimals0, uint8 decimals1) = tokenA < tokenB
            ? (tokenA, tokenB, decimalsA, decimalsB)
            : (tokenB, tokenA, decimalsB, decimalsA);

        bytes32 key = poolKey(token0, token1, decimals0, decimals1, feeBps);
        if (getPool[key] != address(0)) revert PoolAlreadyExists();

        pool = address(new ConfidentialCPMM{salt: key}(
            token0,
            token1,
            decimals0,
            decimals1,
            feeBps
        ));
        address lpTokenAddress = IPrivateLPTokenFactory(lpTokenFactory).create(pool);
        IConfidentialCPMM(pool).initializeLPToken(lpTokenAddress);
        getPool[key] = pool;
        isPool[pool] = true;
        pools.push(pool);

        emit PoolCreated(token0, token1, decimals0, decimals1, feeBps, pool);
        emit PrivateLPTokenCreated(pool, lpTokenAddress);
    }

    function poolKey(
        address token0,
        address token1,
        uint8 decimals0,
        uint8 decimals1,
        uint256 feeBps
    ) public pure returns (bytes32) {
        return token0 < token1
            ? keccak256(abi.encode(token0, token1, decimals0, decimals1, feeBps))
            : keccak256(abi.encode(token1, token0, decimals1, decimals0, feeBps));
    }

    /**
     * @notice Completes an atomic launchpad bootstrap for a known factory pool.
     * @dev The launchpad validates the creator-signed inputs and transfers the
     *      corresponding private assets before calling this function. The pool
     *      verifies its actual private balances and price bounds again. No
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
}
