export declare const TOKEN_APPROVAL_MODE: Readonly<{
    readonly EXACT: "exact";
    readonly UNLIMITED: "unlimited";
}>;
export type TokenApprovalMode = (typeof TOKEN_APPROVAL_MODE)[keyof typeof TOKEN_APPROVAL_MODE];
export declare const DEFAULT_TOKEN_APPROVAL_MODE: "exact";
export declare const MAX_TOKEN_APPROVAL: bigint;
export declare const PUBLIC_ERC20_APPROVAL_ABI: readonly ["function allowance(address owner,address spender) view returns (uint256)", "function approve(address spender,uint256 amount) returns (bool)"];
export type PublicTokenApprovalCall = Readonly<{
    to: string;
    functionName: "approve";
    args: readonly [spender: string, amount: bigint];
}>;
export type PublicTokenApprovalPlan = Readonly<{
    mode: TokenApprovalMode;
    token: string;
    spender: string;
    requiredAmount: bigint;
    currentAllowance: bigint;
    targetAllowance: bigint;
    requiresZeroReset: boolean;
    calls: readonly PublicTokenApprovalCall[];
}>;
/**
 * Resolves the plaintext allowance target selected by the user. Confidential
 * integrations may encrypt this value with the official COTI SDK; this helper
 * never handles AES keys or ciphertexts.
 */
export declare function resolveTokenApprovalAmount(requiredAmount: bigint, mode?: TokenApprovalMode): bigint;
/**
 * Builds ordered public ERC-20 approval calls for a reviewed spend.
 *
 * Exact approval is the default and also reduces a pre-existing larger
 * allowance. Changing any nonzero allowance uses an approve(0) reset before the
 * target approval for compatibility with tokens that reject nonzero-to-nonzero
 * allowance changes. Callers must execute every returned call in order and
 * re-read allowance before submitting the protected operation.
 */
export declare function buildPublicTokenApprovalPlan(input: Readonly<{
    token: string;
    spender: string;
    requiredAmount: bigint;
    currentAllowance: bigint;
    mode?: TokenApprovalMode;
}>): PublicTokenApprovalPlan;
