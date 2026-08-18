// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/interfaces/IERC1271.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

contract MockERC1271Wallet is IERC1271 {
    address public immutable owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function isValidSignature(
        bytes32 digest,
        bytes memory signature
    ) external view returns (bytes4) {
        (address recovered, ECDSA.RecoverError error, ) =
            ECDSA.tryRecover(digest, signature);
        return
            error == ECDSA.RecoverError.NoError && recovered == owner
                ? IERC1271.isValidSignature.selector
                : bytes4(0xffffffff);
    }

    function execute(
        address target,
        bytes calldata data
    ) external returns (bytes memory result) {
        require(msg.sender == owner, "owner only");
        (bool ok, bytes memory returned) = target.call(data);
        if (!ok) {
            assembly {
                revert(add(returned, 0x20), mload(returned))
            }
        }
        return returned;
    }
}
