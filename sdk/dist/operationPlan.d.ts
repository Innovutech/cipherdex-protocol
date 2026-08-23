export declare const CONFIDENTIAL_OPERATION: Readonly<{
    readonly QUOTE: "quote";
    readonly ADD_LIQUIDITY_QUOTE: "add-liquidity-quote";
    readonly SWAP: "swap";
    readonly ADD_LIQUIDITY: "add-liquidity";
    readonly REMOVE_LIQUIDITY: "remove-liquidity";
    readonly LOCK_LIQUIDITY: "lock-liquidity";
}>;
export type ConfidentialOperation = (typeof CONFIDENTIAL_OPERATION)[keyof typeof CONFIDENTIAL_OPERATION];
export declare const CONFIDENTIAL_SIGNATURE_PURPOSE: Readonly<{
    readonly TOKEN_APPROVAL: "token-approval";
    readonly AMOUNT_IN: "amount-in";
    readonly SPECIFIED_AMOUNT: "specified-amount";
    readonly MINIMUM_OUT: "minimum-out";
    readonly TOKEN0_AMOUNT: "token0-amount";
    readonly TOKEN1_AMOUNT: "token1-amount";
    readonly MINIMUM_SHARES: "minimum-shares";
    readonly MINIMUM_PRICE: "minimum-price";
    readonly MAXIMUM_PRICE: "maximum-price";
    readonly SHARES: "shares";
    readonly MINIMUM_TOKEN0: "minimum-token0";
    readonly MINIMUM_TOKEN1: "minimum-token1";
}>;
export type ConfidentialSignaturePurpose = (typeof CONFIDENTIAL_SIGNATURE_PURPOSE)[keyof typeof CONFIDENTIAL_SIGNATURE_PURPOSE];
export type ConfidentialAssetRole = "input" | "token0" | "token1" | "lp-token";
export type ConfidentialSignatureStep = Readonly<{
    id: string;
    position: number;
    total: number;
    kind: "coti-encrypted-input";
    purpose: ConfidentialSignaturePurpose;
    field: string;
    assetRole?: ConfidentialAssetRole;
    label: string;
    sensitive: true;
}>;
export type ConfidentialTransactionPurpose = "token-approval" | "quote" | "liquidity-quote" | "swap" | "add-liquidity" | "remove-liquidity" | "lock-liquidity";
export type ConfidentialTransactionStep = Readonly<{
    id: string;
    position: number;
    total: number;
    purpose: ConfidentialTransactionPurpose;
    label: string;
    dependsOn: readonly string[];
}>;
export type ConfidentialOperationPromptCounts = Readonly<{
    encryptedSignatures: number;
    sequentialTransactionConfirmations: number;
    batchedTransactionConfirmations: number;
    sequentialTotal: number;
    batchedTotal: number;
}>;
export type ConfidentialOperationPlan = Readonly<{
    version: 1;
    operation: ConfidentialOperation;
    route?: "direct" | "best-execution";
    signatures: readonly ConfidentialSignatureStep[];
    transactions: readonly ConfidentialTransactionStep[];
    batching: Readonly<{
        eligible: boolean;
        ordered: true;
        atomicity: "preferred";
        sequentialFallback: true;
    }>;
    prompts: ConfidentialOperationPromptCounts;
}>;
export declare function buildConfidentialQuoteOperationPlan(input?: Readonly<{
    route?: "direct" | "best-execution";
    candidateBatchCount?: number;
}>): ConfidentialOperationPlan;
export declare function buildConfidentialAddLiquidityQuoteOperationPlan(): ConfidentialOperationPlan;
export declare function buildConfidentialSwapOperationPlan(input?: Readonly<{
    approvalRequired?: boolean;
    route?: "direct" | "best-execution";
}>): ConfidentialOperationPlan;
export declare function buildConfidentialAddLiquidityOperationPlan(input?: Readonly<{
    token0ApprovalRequired?: boolean;
    token1ApprovalRequired?: boolean;
}>): ConfidentialOperationPlan;
export declare function buildConfidentialRemoveLiquidityOperationPlan(): ConfidentialOperationPlan;
export declare function buildConfidentialLockLiquidityOperationPlan(): ConfidentialOperationPlan;
