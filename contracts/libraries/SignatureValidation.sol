// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/interfaces/IERC1271.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

library SignatureValidation {
    function isValidSignatureNow(
        address signer,
        bytes32 digest,
        bytes calldata signature
    ) internal view returns (bool) {
        if (signer.code.length == 0) {
            (address recovered, ECDSA.RecoverError error, ) =
                ECDSA.tryRecover(digest, signature);
            return error == ECDSA.RecoverError.NoError && recovered == signer;
        }

        (bool ok, bytes memory result) = signer.staticcall(
            abi.encodeCall(IERC1271.isValidSignature, (digest, signature))
        );
        return
            ok &&
            result.length >= 32 &&
            abi.decode(result, (bytes4)) == IERC1271.isValidSignature.selector;
    }
}
