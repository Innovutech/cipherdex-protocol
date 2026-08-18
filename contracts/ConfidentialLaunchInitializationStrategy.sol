// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./interfaces/IConfidentialCPMM.sol";
import "./interfaces/IConfidentialCPMMFactory.sol";
import "./interfaces/IConfidentialInitializationStrategy.sol";
import "./interfaces/IConfidentialInitializationStrategyRegistry.sol";
import "./interfaces/IConfidentialLaunchpadMigrator.sol";
import "./ConfidentialLaunchpadMigrator.sol";
import "./libraries/SignatureValidation.sol";

/**
 * @title ConfidentialLaunchInitializationStrategy
 * @notice Initialization-only policy for committed launch-protected pools.
 *
 * The strategy never receives tokens and has no post-initialization callback.
 * A launch commitment requires signatures from both the creator and the fixed
 * launch authority. The factory consumes that commitment atomically with the
 * protected pool's first liquidity operation.
 */
contract ConfidentialLaunchInitializationStrategy is
    IConfidentialInitializationStrategy
{
    uint256 public constant STRATEGY_VERSION = 1;
    uint256 public constant PROTOCOL_VERSION = 3;
    uint8 public constant PRIVACY_MODE = 1;
    bytes32 public constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 public constant LAUNCH_COMMITMENT_TYPEHASH = keccak256(
        "LaunchCommitment(bytes32 launchId,address creator,address token0,address token1,uint8 decimals0,uint8 decimals1,uint256 feeBps,uint8 privacyMode,uint256 poolVersion,address factory,address migrator,address initializationStrategy,address launchAuthority,uint256 chainId,uint64 authorizationDeadline,uint64 migrationDeadline)"
    );
    bytes32 private constant EIP712_NAME_HASH =
        keccak256("CipherDEX Launch Initialization");
    bytes32 private constant EIP712_VERSION_HASH = keccak256("1");

    address public factory;
    address public strategyRegistry;
    address public migrator;
    bytes32 public migratorRuntimeCodehash;
    address public launchAuthority;
    uint256 public deploymentChainId;
    bytes32 private deploymentDomainSeparator;
    bytes32 public factoryRegistration;

    mapping(bytes32 => LaunchRecord) private launches;
    mapping(bytes32 => bytes32) public activeLaunchForPoolKey;
    uint256 private reentrancyState = 1;

    error InvalidFactory();
    error InvalidLaunchAuthority();
    error FactoryRegistrationUnauthorized();
    error FactoryRegistrationAlreadyBound();
    error InvalidFactoryRegistration();
    error InvalidCommitment();
    error InvalidCreatorAuthorization();
    error InvalidAuthorityAuthorization();
    error LaunchAlreadyExists();
    error ActiveLaunchExists();
    error CompletedPoolCannotBeSuperseded();
    error UnknownLaunch();
    error LaunchNotActive();
    error LaunchNotExpired();
    error CancellationUnauthorized();
    error InitializationUnauthorized();
    error StrategyCodeChanged();
    error Reentrancy();

    modifier nonReentrant() {
        if (reentrancyState != 1) revert Reentrancy();
        reentrancyState = 2;
        _;
        reentrancyState = 1;
    }

    constructor(
        address factory_,
        address strategyRegistry_,
        address launchAuthority_
    ) {
        if (factory_.code.length == 0) revert InvalidFactory();
        if (
            IConfidentialCPMMFactory(factory_).PROTOCOL_VERSION() !=
                PROTOCOL_VERSION ||
            IConfidentialCPMMFactory(factory_).PRIVACY_MODE() != PRIVACY_MODE
        ) revert InvalidFactory();
        if (launchAuthority_ == address(0)) revert InvalidLaunchAuthority();
        if (
            strategyRegistry_.code.length == 0 ||
            IConfidentialInitializationStrategyRegistry(strategyRegistry_)
                .factory() != factory_
        ) revert InvalidFactory();

        factory = factory_;
        strategyRegistry = strategyRegistry_;
        launchAuthority = launchAuthority_;
        deploymentChainId = block.chainid;
        deploymentDomainSeparator = _buildDomainSeparator(block.chainid);

        address deployedMigrator = address(
            new ConfidentialLaunchpadMigrator(factory_, address(this))
        );
        migrator = deployedMigrator;
        migratorRuntimeCodehash = deployedMigrator.codehash;
        emit MigratorConfigured(deployedMigrator, migratorRuntimeCodehash);
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return
            interfaceId == type(IConfidentialInitializationStrategy).interfaceId ||
            interfaceId == type(IERC165).interfaceId;
    }

    function configurationFinalized() external pure returns (bool) {
        return true;
    }

    function bindFactoryRegistration(bytes32 registration) external {
        if (msg.sender != strategyRegistry) {
            revert FactoryRegistrationUnauthorized();
        }
        if (factoryRegistration != bytes32(0)) {
            revert FactoryRegistrationAlreadyBound();
        }
        if (registration == bytes32(0) || migrator == address(0)) {
            revert InvalidFactoryRegistration();
        }
        factoryRegistration = registration;
        emit FactoryRegistrationBound(registration);
    }

    function launchCommitmentDigest(
        LaunchCommitment calldata commitment
    ) public view returns (bytes32) {
        return _hashTypedDataV4(_launchCommitmentStructHash(commitment));
    }

    function commitLaunch(
        LaunchCommitment calldata commitment,
        bytes calldata creatorAuthorization,
        bytes calldata authorityAuthorization
    ) external nonReentrant returns (address pool, bytes32 commitmentHash) {
        _validateCommitment(commitment);
        commitmentHash = launchCommitmentDigest(commitment);
        if (
            !_isValidSignature(
                commitment.creator,
                commitmentHash,
                creatorAuthorization
            )
        ) revert InvalidCreatorAuthorization();
        if (
            !_isValidSignature(
                launchAuthority,
                commitmentHash,
                authorityAuthorization
            )
        ) revert InvalidAuthorityAuthorization();
        if (launches[commitment.launchId].status != LaunchStatus.NONE) {
            revert LaunchAlreadyExists();
        }

        IConfidentialCPMMFactory canonicalFactory =
            IConfidentialCPMMFactory(factory);
        bytes32 poolKey = canonicalFactory.poolKey(
            commitment.token0,
            commitment.token1,
            commitment.decimals0,
            commitment.decimals1,
            commitment.feeBps,
            address(this)
        );
        bytes32 previousLaunchId = activeLaunchForPoolKey[poolKey];
        if (previousLaunchId != bytes32(0)) {
            LaunchRecord storage previous = launches[previousLaunchId];
            if (
                previous.status == LaunchStatus.COMMITTED &&
                block.timestamp > previous.migrationDeadline
            ) {
                previous.status = LaunchStatus.EXPIRED;
                emit LaunchExpired(previousLaunchId, poolKey);
            }
            if (previous.status == LaunchStatus.COMMITTED) {
                revert ActiveLaunchExists();
            }
            if (previous.status == LaunchStatus.COMPLETED) {
                revert CompletedPoolCannotBeSuperseded();
            }
        }

        pool = canonicalFactory.getOrCreatePoolForCommitment(
            commitment.token0,
            commitment.token1,
            commitment.decimals0,
            commitment.decimals1,
            commitment.feeBps
        );
        if (IConfidentialCPMM(pool).initialized()) {
            revert CompletedPoolCannotBeSuperseded();
        }

        launches[commitment.launchId] = LaunchRecord({
            commitmentHash: commitmentHash,
            poolKey: poolKey,
            creator: commitment.creator,
            pool: pool,
            migrationDeadline: commitment.migrationDeadline,
            status: LaunchStatus.COMMITTED
        });
        activeLaunchForPoolKey[poolKey] = commitment.launchId;
        emit LaunchCommitted(
            commitment.launchId,
            poolKey,
            pool,
            commitment.creator,
            commitment.migrationDeadline,
            commitmentHash
        );
    }

    function cancelLaunch(bytes32 launchId) external nonReentrant {
        LaunchRecord storage record = launches[launchId];
        if (record.status == LaunchStatus.NONE) revert UnknownLaunch();
        if (record.status != LaunchStatus.COMMITTED) revert LaunchNotActive();
        if (msg.sender != record.creator && msg.sender != launchAuthority) {
            revert CancellationUnauthorized();
        }
        record.status = LaunchStatus.CANCELED;
        emit LaunchCanceled(launchId, record.poolKey);
    }

    function expireLaunch(bytes32 launchId) external nonReentrant {
        LaunchRecord storage record = launches[launchId];
        if (record.status == LaunchStatus.NONE) revert UnknownLaunch();
        if (record.status != LaunchStatus.COMMITTED) revert LaunchNotActive();
        if (block.timestamp <= record.migrationDeadline) {
            revert LaunchNotExpired();
        }
        record.status = LaunchStatus.EXPIRED;
        emit LaunchExpired(launchId, record.poolKey);
    }

    function authorizeInitialization(
        bytes32 launchId,
        address migratorCaller,
        address pool,
        address creator,
        bytes32 commitmentHash
    ) external nonReentrant returns (bytes32 poolKey) {
        if (msg.sender != factory) revert InitializationUnauthorized();
        if (
            migratorCaller != migrator ||
            migratorCaller.codehash != migratorRuntimeCodehash
        ) revert StrategyCodeChanged();
        LaunchRecord storage record = launches[launchId];
        if (record.status == LaunchStatus.NONE) revert UnknownLaunch();
        if (
            record.status != LaunchStatus.COMMITTED ||
            activeLaunchForPoolKey[record.poolKey] != launchId ||
            block.timestamp > record.migrationDeadline
        ) revert LaunchNotActive();
        if (
            pool != record.pool ||
            creator != record.creator ||
            commitmentHash != record.commitmentHash ||
            IConfidentialCPMM(pool).initialized()
        ) revert InitializationUnauthorized();

        record.status = LaunchStatus.COMPLETED;
        poolKey = record.poolKey;
        emit LaunchInitializationAuthorized(
            launchId,
            pool,
            creator,
            commitmentHash
        );
    }

    function getLaunch(
        bytes32 launchId
    ) external view returns (LaunchRecord memory) {
        return launches[launchId];
    }

    function _validateCommitment(
        LaunchCommitment calldata commitment
    ) internal view {
        if (
            factoryRegistration == bytes32(0) ||
            !IConfidentialInitializationStrategyRegistry(strategyRegistry)
                .isRegisteredStrategy(address(this)) ||
            migrator == address(0) ||
            commitment.launchId == bytes32(0) ||
            commitment.creator == address(0) ||
            commitment.creator == launchAuthority ||
            commitment.token0 == address(0) ||
            commitment.token1 == address(0) ||
            commitment.token0 >= commitment.token1 ||
            commitment.decimals0 > 18 ||
            commitment.decimals1 > 18 ||
            commitment.privacyMode != PRIVACY_MODE ||
            commitment.poolVersion != PROTOCOL_VERSION ||
            commitment.factory != factory ||
            commitment.migrator != migrator ||
            commitment.initializationStrategy != address(this) ||
            commitment.launchAuthority != launchAuthority ||
            commitment.chainId != block.chainid ||
            commitment.authorizationDeadline < block.timestamp ||
            commitment.migrationDeadline <= block.timestamp ||
            commitment.authorizationDeadline > commitment.migrationDeadline
        ) revert InvalidCommitment();
    }

    function _launchCommitmentStructHash(
        LaunchCommitment calldata commitment
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                LAUNCH_COMMITMENT_TYPEHASH,
                commitment.launchId,
                commitment.creator,
                commitment.token0,
                commitment.token1,
                commitment.decimals0,
                commitment.decimals1,
                commitment.feeBps,
                commitment.privacyMode,
                commitment.poolVersion,
                commitment.factory,
                commitment.migrator,
                commitment.initializationStrategy,
                commitment.launchAuthority,
                commitment.chainId,
                commitment.authorizationDeadline,
                commitment.migrationDeadline
            )
        );
    }

    function _hashTypedDataV4(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(
            abi.encodePacked("\x19\x01", _domainSeparatorV4(), structHash)
        );
    }

    function _isValidSignature(
        address signer,
        bytes32 digest,
        bytes calldata signature
    ) internal view returns (bool) {
        return SignatureValidation.isValidSignatureNow(signer, digest, signature);
    }

    function _domainSeparatorV4() internal view returns (bytes32) {
        if (block.chainid == deploymentChainId) {
            return deploymentDomainSeparator;
        }
        return _buildDomainSeparator(block.chainid);
    }

    function _buildDomainSeparator(
        uint256 chainId
    ) private view returns (bytes32) {
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
}
