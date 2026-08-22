// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../CipherDEXInputBatch.sol";

/**
 * @notice Asset-free testnet probe for contract-level batch authorization plus
 *         raw ciphertext onboarding. It is not part of a protocol deployment.
 */
contract MpcBatchAuthorizationProbe is CipherDEXInputBatch {
    uint256 public constant PROTOCOL_VERSION = 1;
    bytes32 public constant TWO_SLOT_SCHEMA =
        keccak256("CipherDEX.probeTwo(first,second)");
    bytes32 public constant FIVE_SLOT_SCHEMA =
        keccak256("CipherDEX.probeFive(first,second,third,fourth,fifth)");

    event MpcBatchProbeResult(
        address indexed caller,
        bytes32 indexed nonce,
        uint8 slotCount,
        ctUint256 result
    );

    function probeTwo(
        ctUint256[] calldata ciphertexts,
        CipherDEXInputBatchAuthorization calldata authorization
    ) external returns (ctUint256 memory result) {
        (gtUint256[] memory values, ) = _authorizeAndOnboardInputBatch(
            ciphertexts,
            authorization,
            PROTOCOL_VERSION,
            TWO_SLOT_SCHEMA,
            2
        );
        result = MpcCore.offBoardToUser(
            MpcCore.add(values[0], values[1]),
            msg.sender
        );
        emit MpcBatchProbeResult(msg.sender, authorization.nonce, 2, result);
    }

    function probeFive(
        ctUint256[] calldata ciphertexts,
        CipherDEXInputBatchAuthorization calldata authorization
    ) external returns (ctUint256 memory result) {
        (gtUint256[] memory values, ) = _authorizeAndOnboardInputBatch(
            ciphertexts,
            authorization,
            PROTOCOL_VERSION,
            FIVE_SLOT_SCHEMA,
            5
        );
        gtUint256 sum = values[0];
        for (uint256 i = 1; i < values.length; ++i) {
            sum = MpcCore.add(sum, values[i]);
        }
        result = MpcCore.offBoardToUser(sum, msg.sender);
        emit MpcBatchProbeResult(msg.sender, authorization.nonce, 5, result);
    }
}
