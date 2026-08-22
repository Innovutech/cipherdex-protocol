// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@coti-io/coti-contracts/contracts/utils/mpc/MpcCore.sol";
import "./libraries/SignatureValidation.sol";

struct CipherDEXInputBatchAuthorization {
    uint256 protocolVersion;
    bytes32 schemaHash;
    bytes32 nonce;
    uint64 deadline;
    bytes signature;
}

/**
 * @notice Function-scoped authorization for an ordered batch of raw COTI ciphertexts.
 * @dev A target must call `_authorizeAndOnboardInputBatch` before using any slot.
 *      The EIP-712 domain binds chain and target; the struct additionally binds
 *      protocol version, caller, selector, schema, ordered ciphertext commitments,
 *      nonce and deadline. A reverted MPC operation rolls back nonce consumption.
 */
abstract contract CipherDEXInputBatch {
    bytes32 public constant INPUT_BATCH_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 public constant INPUT_BATCH_TYPEHASH = keccak256(
        "CipherDEXInputBatch(uint256 protocolVersion,address caller,address target,bytes4 selector,bytes32 schemaHash,bytes32 ciphertextsHash,bytes32 nonce,uint64 deadline)"
    );
    bytes32 public constant INPUT_BATCH_DOMAIN_NAME_HASH =
        keccak256("CipherDEX Confidential Inputs");
    bytes32 public constant INPUT_BATCH_DOMAIN_VERSION_HASH = keccak256("1");

    uint256 private immutable inputBatchDeploymentChainId;
    bytes32 private immutable inputBatchDeploymentDomainSeparator;
    mapping(address => mapping(bytes32 => bool)) public inputBatchNonceUsed;

    error InvalidInputBatchCount();
    error InvalidInputBatchSchema();
    error InvalidInputBatchProtocolVersion();
    error InvalidInputBatchNonce();
    error InputBatchNonceAlreadyUsed();
    error InputBatchDeadlineExpired();
    error InvalidInputBatchAuthorization();
    error DuplicateInputBatchCiphertext();

    event ConfidentialInputBatchAuthorized(
        address indexed caller,
        bytes4 indexed selector,
        bytes32 indexed nonce,
        bytes32 digest
    );

    constructor() {
        inputBatchDeploymentChainId = block.chainid;
        inputBatchDeploymentDomainSeparator = _buildInputBatchDomainSeparator(
            block.chainid
        );
    }

    function inputBatchDomainSeparator() public view returns (bytes32) {
        if (block.chainid == inputBatchDeploymentChainId) {
            return inputBatchDeploymentDomainSeparator;
        }
        return _buildInputBatchDomainSeparator(block.chainid);
    }

    function inputBatchCiphertextCommitment(
        ctUint256 calldata ciphertext
    ) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                ctUint128.unwrap(ciphertext.ciphertextHigh),
                ctUint128.unwrap(ciphertext.ciphertextLow)
            )
        );
    }

    function inputBatchCiphertextsHash(
        ctUint256[] calldata ciphertexts
    ) public pure returns (bytes32) {
        bytes32[] memory commitments = new bytes32[](ciphertexts.length);
        for (uint256 i = 0; i < ciphertexts.length; ++i) {
            commitments[i] = inputBatchCiphertextCommitment(ciphertexts[i]);
        }
        return keccak256(abi.encode(commitments));
    }

    function inputBatchAuthorizationDigest(
        address caller,
        bytes4 selector,
        ctUint256[] calldata ciphertexts,
        uint256 protocolVersion,
        bytes32 schemaHash,
        bytes32 nonce,
        uint64 deadline
    ) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                INPUT_BATCH_TYPEHASH,
                protocolVersion,
                caller,
                address(this),
                selector,
                schemaHash,
                inputBatchCiphertextsHash(ciphertexts),
                nonce,
                deadline
            )
        );
        return keccak256(
            abi.encodePacked("\x19\x01", inputBatchDomainSeparator(), structHash)
        );
    }

    function _authorizeInputBatch(
        ctUint256[] calldata ciphertexts,
        CipherDEXInputBatchAuthorization calldata authorization,
        uint256 expectedProtocolVersion,
        bytes32 expectedSchemaHash,
        uint256 expectedSlotCount
    ) internal returns (bytes32 digest) {
        if (ciphertexts.length != expectedSlotCount) revert InvalidInputBatchCount();
        if (authorization.protocolVersion != expectedProtocolVersion) {
            revert InvalidInputBatchProtocolVersion();
        }
        if (authorization.schemaHash != expectedSchemaHash) {
            revert InvalidInputBatchSchema();
        }
        if (authorization.nonce == bytes32(0)) revert InvalidInputBatchNonce();
        if (authorization.deadline < block.timestamp) revert InputBatchDeadlineExpired();
        if (inputBatchNonceUsed[msg.sender][authorization.nonce]) {
            revert InputBatchNonceAlreadyUsed();
        }

        bytes32[] memory commitments = new bytes32[](ciphertexts.length);
        for (uint256 i = 0; i < ciphertexts.length; ++i) {
            bytes32 commitment = inputBatchCiphertextCommitment(ciphertexts[i]);
            for (uint256 j = 0; j < i; ++j) {
                if (commitments[j] == commitment) {
                    revert DuplicateInputBatchCiphertext();
                }
            }
            commitments[i] = commitment;
        }

        digest = inputBatchAuthorizationDigest(
            msg.sender,
            msg.sig,
            ciphertexts,
            authorization.protocolVersion,
            authorization.schemaHash,
            authorization.nonce,
            authorization.deadline
        );
        if (!SignatureValidation.isValidSignatureNow(
            msg.sender,
            digest,
            authorization.signature
        )) revert InvalidInputBatchAuthorization();

        inputBatchNonceUsed[msg.sender][authorization.nonce] = true;
        emit ConfidentialInputBatchAuthorized(
            msg.sender,
            msg.sig,
            authorization.nonce,
            digest
        );
    }

    function _onboardInputBatch(
        ctUint256[] calldata ciphertexts
    ) internal returns (gtUint256[] memory values) {
        values = new gtUint256[](ciphertexts.length);
        for (uint256 i = 0; i < ciphertexts.length; ++i) {
            values[i] = MpcCore.onBoard(ciphertexts[i]);
        }
    }

    function _authorizeAndOnboardInputBatch(
        ctUint256[] calldata ciphertexts,
        CipherDEXInputBatchAuthorization calldata authorization,
        uint256 expectedProtocolVersion,
        bytes32 expectedSchemaHash,
        uint256 expectedSlotCount
    ) internal returns (gtUint256[] memory values, bytes32 digest) {
        digest = _authorizeInputBatch(
            ciphertexts,
            authorization,
            expectedProtocolVersion,
            expectedSchemaHash,
            expectedSlotCount
        );
        values = _onboardInputBatch(ciphertexts);
    }

    function _buildInputBatchDomainSeparator(
        uint256 chainId
    ) private view returns (bytes32) {
        return keccak256(
            abi.encode(
                INPUT_BATCH_DOMAIN_TYPEHASH,
                INPUT_BATCH_DOMAIN_NAME_HASH,
                INPUT_BATCH_DOMAIN_VERSION_HASH,
                chainId,
                address(this)
            )
        );
    }
}
