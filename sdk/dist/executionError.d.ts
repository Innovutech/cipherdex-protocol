export declare const CIPHERDEX_TRANSFER_AMOUNT_MISMATCH_SELECTOR: "0xb0a6ea29";
export declare const CIPHERDEX_EXECUTION_ISSUE_CODE: Readonly<{
    readonly TOKEN_TRANSFER_AMOUNT_MISMATCH: "token-transfer-amount-mismatch";
}>;
export type CipherDexExecutionOperation = "public-swap" | "public-create-or-add-liquidity" | "public-remove-liquidity" | "public-native-swap" | "public-native-create-or-add-liquidity" | "public-native-remove-liquidity" | "public-protocol-fee-collection";
export type CipherDexExecutionStage = "preflight" | "execution";
export type CipherDexExecutionContext = Readonly<{
    operation: CipherDexExecutionOperation;
    tokenAddress?: string;
    stage?: CipherDexExecutionStage;
}>;
export type CipherDexExecutionIssue = Readonly<{
    code: typeof CIPHERDEX_EXECUTION_ISSUE_CODE.TOKEN_TRANSFER_AMOUNT_MISMATCH;
    kind: "token-transfer-semantics";
    selector: typeof CIPHERDEX_TRANSFER_AMOUNT_MISMATCH_SELECTOR;
    operation: CipherDexExecutionOperation;
    stage: CipherDexExecutionStage;
    tokenAddress?: string;
    retryableWithSameState: false;
    compatibilityMayChange: true;
}>;
export type CipherDexPreflightTransaction = Readonly<{
    from: string;
    to: string;
    data: string;
    value?: bigint;
    gasLimit?: bigint;
}>;
export interface CipherDexPreflightAdapter {
    estimateGas(transaction: CipherDexPreflightTransaction): Promise<bigint>;
}
export type CipherDexPreflightResult = Readonly<{
    ok: true;
    gasEstimate: bigint;
}> | Readonly<{
    ok: false;
    issue: CipherDexExecutionIssue;
}>;
export declare function classifyCipherDexExecutionError(error: unknown, context: CipherDexExecutionContext): CipherDexExecutionIssue | null;
export declare function preflightCipherDexTransaction(input: Readonly<{
    adapter: CipherDexPreflightAdapter;
    transaction: CipherDexPreflightTransaction;
    context: Omit<CipherDexExecutionContext, "stage">;
}>): Promise<CipherDexPreflightResult>;
