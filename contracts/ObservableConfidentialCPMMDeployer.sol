// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ObservableConfidentialCPMM.sol";
import "./interfaces/IObservableConfidentialCPMMDeployer.sol";
import "./interfaces/IObservableConfidentialCPMMFactory.sol";

/**
 * @dev Constructor-only bytecode container. Runtime is exactly the supplied bytes.
 */
contract ObservablePoolCreationCodeStore {
    constructor(bytes memory code) {
        assembly ("memory-safe") {
            return(add(code, 0x20), mload(code))
        }
    }
}

/**
 * @notice Factory-bound CREATE2 deployer kept separate from factory registry logic.
 */
contract ObservableConfidentialCPMMDeployer is
    IObservableConfidentialCPMMDeployer
{
    uint256 public constant DEPLOYER_VERSION = 1;
    address public configurationAuthority;
    address public factory;
    address public immutable creationCodeStore0;
    address public immutable creationCodeStore1;
    uint32 public immutable creationCodeSize0;
    uint32 public immutable creationCodeSize1;
    bytes32 public immutable creationCodeHash;

    error ConfigurationUnauthorized();
    error FactoryAlreadyBound();
    error InvalidFactory();
    error DeploymentUnauthorized();
    error PoolDeploymentFailed();

    constructor() {
        configurationAuthority = msg.sender;
        bytes memory creationCode = type(ObservableConfidentialCPMM).creationCode;
        uint256 firstSize = creationCode.length / 2;
        uint256 secondSize = creationCode.length - firstSize;
        bytes memory first = _slice(creationCode, 0, firstSize);
        bytes memory second = _slice(creationCode, firstSize, secondSize);
        creationCodeStore0 = address(new ObservablePoolCreationCodeStore(first));
        creationCodeStore1 = address(new ObservablePoolCreationCodeStore(second));
        creationCodeSize0 = uint32(firstSize);
        creationCodeSize1 = uint32(secondSize);
        creationCodeHash = keccak256(creationCode);
    }

    function bindFactory(address factory_) external {
        if (msg.sender != configurationAuthority) {
            revert ConfigurationUnauthorized();
        }
        if (factory != address(0)) revert FactoryAlreadyBound();
        if (
            factory_.code.length == 0 ||
            IObservableConfidentialCPMMFactory(factory_).PROTOCOL_VERSION() != 1 ||
            IObservableConfidentialCPMMFactory(factory_).PRIVACY_MODE() != 2 ||
            IObservableConfidentialCPMMFactory(factory_).poolDeployer() !=
                address(this)
        ) revert InvalidFactory();
        factory = factory_;
    }

    function deployPool(
        bytes32 key,
        address token0,
        address token1,
        uint8 decimals0,
        uint8 decimals1,
        uint256 feeBps,
        address feeVault,
        address initializationStrategy
    ) external returns (address pool) {
        if (msg.sender != factory) revert DeploymentUnauthorized();
        bytes memory creationCode = _readCreationCode();
        if (keccak256(creationCode) != creationCodeHash) {
            revert PoolDeploymentFailed();
        }
        bytes memory initCode = bytes.concat(
            creationCode,
            abi.encode(
                token0,
                token1,
                decimals0,
                decimals1,
                feeBps,
                feeVault,
                initializationStrategy,
                factory
            )
        );
        assembly ("memory-safe") {
            pool := create2(0, add(initCode, 0x20), mload(initCode), key)
        }
        if (pool == address(0) || pool.code.length == 0) {
            revert PoolDeploymentFailed();
        }
    }

    function _readCreationCode() internal view returns (bytes memory code) {
        uint256 firstSize = creationCodeSize0;
        uint256 secondSize = creationCodeSize1;
        code = new bytes(firstSize + secondSize);
        address firstStore = creationCodeStore0;
        address secondStore = creationCodeStore1;
        assembly ("memory-safe") {
            extcodecopy(firstStore, add(code, 0x20), 0, firstSize)
            extcodecopy(
                secondStore,
                add(add(code, 0x20), firstSize),
                0,
                secondSize
            )
        }
    }

    function _slice(
        bytes memory source,
        uint256 start,
        uint256 length
    ) private pure returns (bytes memory result) {
        result = new bytes(length);
        for (uint256 offset = 0; offset < length; offset += 32) {
            assembly ("memory-safe") {
                mstore(
                    add(add(result, 0x20), offset),
                    mload(add(add(source, 0x20), add(start, offset)))
                )
            }
        }
    }
}
