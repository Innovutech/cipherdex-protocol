// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@coti-io/coti-contracts/contracts/token/PrivateERC20/IPrivateERC20.sol";
import "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/**
 * @dev Structural compatibility checks for external COTI private tokens.
 * Interface support is not an endorsement of a token's implementation or
 * economic behavior. Pool-side exact balance-delta checks remain authoritative.
 */
library PrivateTokenCompatibility {
    function supportsPrivateToken(address token) internal view returns (bool) {
        if (token.code.length == 0) return false;
        try IERC165(token).supportsInterface(type(IPrivateERC20).interfaceId) returns (
            bool supported
        ) {
            return supported;
        } catch {
            return false;
        }
    }

    function tryReadDecimals(
        address token
    ) internal view returns (bool valid, uint8 decimals) {
        if (token.code.length == 0) return (false, 0);
        (bool ok, bytes memory data) = token.staticcall(
            abi.encodeWithSignature("decimals()")
        );
        if (!ok || data.length != 32) return (false, 0);
        uint256 value = abi.decode(data, (uint256));
        if (value > 18) return (false, 0);
        return (true, uint8(value));
    }

    function isCompatible(address token) internal view returns (bool) {
        if (!supportsPrivateToken(token)) return false;
        (bool valid, ) = tryReadDecimals(token);
        return valid;
    }
}
