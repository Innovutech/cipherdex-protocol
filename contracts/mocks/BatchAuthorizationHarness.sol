// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../CipherDEXInputBatch.sol";

contract BatchAuthorizationHarness is CipherDEXInputBatch {
    uint256 public constant PROTOCOL_VERSION = 7;
    bytes32 public constant SCHEMA_HASH =
        keccak256("CipherDEX.harness(first,second)");

    function authorize(
        ctUint256[] calldata ciphertexts,
        CipherDEXInputBatchAuthorization calldata authorization
    ) external returns (bytes32) {
        return _authorizeInputBatch(
            ciphertexts,
            authorization,
            PROTOCOL_VERSION,
            SCHEMA_HASH,
            2
        );
    }

    function authorizeAlternate(
        ctUint256[] calldata ciphertexts,
        CipherDEXInputBatchAuthorization calldata authorization
    ) external returns (bytes32) {
        return _authorizeInputBatch(
            ciphertexts,
            authorization,
            PROTOCOL_VERSION,
            SCHEMA_HASH,
            2
        );
    }
}
