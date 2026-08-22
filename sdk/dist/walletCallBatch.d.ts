export declare const WALLET_CALLS_VERSION: "2.0.0";
export declare const WALLET_CALL_CAPABILITIES_METHOD: "wallet_getCapabilities";
export declare const WALLET_CALL_BATCH_METHOD: "wallet_sendCalls";
export declare const WALLET_CALL_STATUS_METHOD: "wallet_getCallsStatus";
export declare const MAX_CIPHERDEX_WALLET_CALLS: 8;
export type WalletAtomicCapabilityStatus = "supported" | "ready" | "unsupported";
export type WalletCallBatchSupport = Readonly<{
    batchingSupported: boolean;
    atomicStatus: WalletAtomicCapabilityStatus | "unknown";
    source: "chain" | "global" | "none";
}>;
export type WalletCallBatchPreference = "prefer-atomic" | "allow-non-atomic" | "require-atomic";
export type WalletCallStep = Readonly<{
    id: string;
    purpose: string;
    label: string;
}>;
export type WalletCallInput = Readonly<{
    stepId: string;
    to: string;
    data: string;
    value?: bigint;
}>;
export type PreparedWalletCall = Readonly<{
    stepId: string;
    purpose: string;
    label: string;
    to: string;
    data: string;
    value: bigint;
}>;
export type WalletSendCallsParams = Readonly<{
    version: typeof WALLET_CALLS_VERSION;
    id?: string;
    from: string;
    chainId: string;
    atomicRequired: boolean;
    calls: readonly Readonly<{
        to: string;
        data: string;
        value?: string;
    }>[];
}>;
export type WalletSendCallsRequest = Readonly<{
    method: typeof WALLET_CALL_BATCH_METHOD;
    params: readonly [WalletSendCallsParams];
}>;
export type WalletGetCapabilitiesRequest = Readonly<{
    method: typeof WALLET_CALL_CAPABILITIES_METHOD;
    params: readonly [string, readonly string[]];
}>;
export type WalletCallExecutionPlan = Readonly<{
    kind: "wallet_sendCalls";
    support: WalletCallBatchSupport;
    calls: readonly PreparedWalletCall[];
    containsApproval: boolean;
    request: WalletSendCallsRequest;
}> | Readonly<{
    kind: "sequential";
    reason: "single-call" | "wallet-batching-unavailable";
    support: WalletCallBatchSupport;
    calls: readonly PreparedWalletCall[];
    containsApproval: boolean;
}> | Readonly<{
    kind: "unavailable";
    reason: "atomicity-unavailable";
    support: WalletCallBatchSupport;
    calls: readonly PreparedWalletCall[];
    containsApproval: boolean;
}>;
export type WalletCallReceiptStatus = "success" | "reverted";
export type WalletCallReceipt = Readonly<{
    status: WalletCallReceiptStatus;
    blockHash: string;
    blockNumber: string;
    gasUsed: string;
    transactionHash: string;
}>;
export type WalletCallBatchState = "pending" | "confirmed" | "offchain-failed" | "reverted" | "partially-reverted";
export type WalletCallBatchStatus = Readonly<{
    version: string;
    id: string;
    chainId: string;
    code: number;
    state: WalletCallBatchState;
    atomic: boolean;
    terminal: boolean;
    succeeded: boolean;
    safeForSequentialFallback: boolean;
    allowanceMayBeActive: boolean;
    requiresAllowanceReview: boolean;
    receipts: readonly WalletCallReceipt[];
    transactionHashes: readonly string[];
}>;
/**
 * Parses the live wallet_getCapabilities response for one chain. Per EIP-5792,
 * absence of the atomic capability means batching is not advertised.
 */
export declare function getWalletCallBatchSupport(capabilities: unknown, chainId: bigint | number | string): WalletCallBatchSupport;
export declare function buildWalletCapabilitiesRequest(from: string, chainId: bigint | number | string): WalletGetCapabilitiesRequest;
/**
 * Prepares an optional EIP-5792 execution plan from live wallet capabilities.
 * It never invokes a provider. Unsupported wallets retain the reviewed ordered
 * calls for the existing sequential frontend fallback.
 */
export declare function prepareWalletCallExecution(input: Readonly<{
    chainId: bigint | number | string;
    from: string;
    steps: readonly WalletCallStep[];
    calls: readonly WalletCallInput[];
    capabilities: unknown;
    preference?: WalletCallBatchPreference;
    id?: string;
}>): WalletCallExecutionPlan;
export declare function parseWalletSendCallsResult(value: unknown): Readonly<{
    id: string;
}>;
export declare function buildWalletCallsStatusRequest(id: string): Readonly<{
    method: typeof WALLET_CALL_STATUS_METHOD;
    params: readonly [string];
}>;
/**
 * Validates and normalizes wallet_getCallsStatus without assuming one receipt
 * per call. Partial non-atomic batches involving approvals are surfaced for
 * explicit allowance recovery instead of being treated as ordinary failures.
 */
export declare function normalizeWalletCallsStatus(value: unknown, context: Readonly<{
    expectedId: string;
    expectedChainId: bigint | number | string;
    containsApproval: boolean;
}>): WalletCallBatchStatus;
