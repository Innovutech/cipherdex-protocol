import { isEvmNativeAssetAddress } from "./nativeAsset.js";
export const TOKEN_APPROVAL_MODE = Object.freeze({
    EXACT: "exact",
    UNLIMITED: "unlimited",
});
export const DEFAULT_TOKEN_APPROVAL_MODE = TOKEN_APPROVAL_MODE.EXACT;
export const MAX_TOKEN_APPROVAL = (1n << 256n) - 1n;
export const PUBLIC_ERC20_APPROVAL_ABI = [
    "function allowance(address owner,address spender) view returns (uint256)",
    "function approve(address spender,uint256 amount) returns (bool)",
];
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = /^0x0{40}$/i;
function assertAddress(value, label) {
    if (!ADDRESS.test(value) || ZERO_ADDRESS.test(value) || isEvmNativeAssetAddress(value)) {
        throw new TypeError(`Invalid ${label} address`);
    }
}
function assertUint256(value, label, allowZero) {
    if (typeof value !== "bigint" ||
        value < (allowZero ? 0n : 1n) ||
        value > MAX_TOKEN_APPROVAL) {
        throw new TypeError(`Invalid ${label}`);
    }
}
function assertApprovalMode(mode) {
    if (mode !== TOKEN_APPROVAL_MODE.EXACT &&
        mode !== TOKEN_APPROVAL_MODE.UNLIMITED) {
        throw new TypeError("Invalid token approval mode");
    }
}
/**
 * Resolves the plaintext allowance target selected by the user. Confidential
 * integrations may encrypt this value with the official COTI SDK; this helper
 * never handles AES keys or ciphertexts.
 */
export function resolveTokenApprovalAmount(requiredAmount, mode = DEFAULT_TOKEN_APPROVAL_MODE) {
    assertUint256(requiredAmount, "required token approval amount", false);
    assertApprovalMode(mode);
    return mode === TOKEN_APPROVAL_MODE.UNLIMITED
        ? MAX_TOKEN_APPROVAL
        : requiredAmount;
}
function approvalCall(token, spender, amount) {
    return Object.freeze({
        to: token,
        functionName: "approve",
        args: Object.freeze([spender, amount]),
    });
}
/**
 * Builds ordered public ERC-20 approval calls for a reviewed spend.
 *
 * Exact approval is the default and also reduces a pre-existing larger
 * allowance. Changing any nonzero allowance uses an approve(0) reset before the
 * target approval for compatibility with tokens that reject nonzero-to-nonzero
 * allowance changes. Callers must execute every returned call in order and
 * re-read allowance before submitting the protected operation.
 */
export function buildPublicTokenApprovalPlan(input) {
    assertAddress(input.token, "token");
    assertAddress(input.spender, "spender");
    assertUint256(input.currentAllowance, "current token allowance", true);
    const mode = input.mode ?? DEFAULT_TOKEN_APPROVAL_MODE;
    const targetAllowance = resolveTokenApprovalAmount(input.requiredAmount, mode);
    const requiresZeroReset = input.currentAllowance !== 0n && input.currentAllowance !== targetAllowance;
    const calls = [];
    if (requiresZeroReset) {
        calls.push(approvalCall(input.token, input.spender, 0n));
    }
    if (input.currentAllowance !== targetAllowance) {
        calls.push(approvalCall(input.token, input.spender, targetAllowance));
    }
    return Object.freeze({
        mode,
        token: input.token,
        spender: input.spender,
        requiredAmount: input.requiredAmount,
        currentAllowance: input.currentAllowance,
        targetAllowance,
        requiresZeroReset,
        calls: Object.freeze(calls),
    });
}
