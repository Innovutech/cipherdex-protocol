export const WALLET_CALLS_VERSION = "2.0.0";
export const WALLET_CALL_CAPABILITIES_METHOD = "wallet_getCapabilities";
export const WALLET_CALL_BATCH_METHOD = "wallet_sendCalls";
export const WALLET_CALL_STATUS_METHOD = "wallet_getCallsStatus";
export const MAX_CIPHERDEX_WALLET_CALLS = 8;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = /^0x0{40}$/i;
const BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;
const STEP_ID = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_CALL_DATA_BYTES = 128 * 1_024;
function dataRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    try {
        const descriptors = Object.getOwnPropertyDescriptors(value);
        const record = Object.create(null);
        for (const [key, descriptor] of Object.entries(descriptors)) {
            if ("value" in descriptor && descriptor.enumerable)
                record[key] = descriptor.value;
        }
        return record;
    }
    catch {
        return undefined;
    }
}
function normalizedChainId(chainId) {
    let value;
    try {
        if (typeof chainId === "bigint")
            value = chainId;
        else if (typeof chainId === "number" && Number.isSafeInteger(chainId)) {
            value = BigInt(chainId);
        }
        else if (typeof chainId === "string" && QUANTITY.test(chainId)) {
            value = BigInt(chainId);
        }
        else
            throw new TypeError();
    }
    catch {
        throw new TypeError("Invalid wallet call chain ID");
    }
    if (value <= 0n)
        throw new TypeError("Invalid wallet call chain ID");
    return `0x${value.toString(16)}`;
}
function assertAddress(value, label) {
    if (!ADDRESS.test(value) || ZERO_ADDRESS.test(value)) {
        throw new TypeError(`Invalid wallet call ${label}`);
    }
}
function assertBatchId(value) {
    if (typeof value !== "string" ||
        value.length === 0 ||
        new TextEncoder().encode(value).length > 4_096) {
        throw new TypeError("Invalid wallet call batch ID");
    }
}
function capabilityForChain(capabilities, chainId) {
    const root = dataRecord(capabilities);
    if (!root)
        return undefined;
    const chainKey = Object.keys(root).find((key) => {
        try {
            return normalizedChainId(key) === chainId;
        }
        catch {
            return false;
        }
    });
    const chain = chainKey ? dataRecord(root[chainKey]) : undefined;
    if (chain && Object.prototype.hasOwnProperty.call(chain, "atomic")) {
        return { value: chain.atomic, source: "chain" };
    }
    const globalKey = Object.keys(root).find((key) => key.toLowerCase() === "0x0");
    const global = globalKey ? dataRecord(root[globalKey]) : undefined;
    if (global && Object.prototype.hasOwnProperty.call(global, "atomic")) {
        return { value: global.atomic, source: "global" };
    }
    return undefined;
}
/**
 * Parses the live wallet_getCapabilities response for one chain. Per EIP-5792,
 * absence of the atomic capability means batching is not advertised.
 */
export function getWalletCallBatchSupport(capabilities, chainId) {
    const normalized = normalizedChainId(chainId);
    const candidate = capabilityForChain(capabilities, normalized);
    if (!candidate) {
        return Object.freeze({
            batchingSupported: false,
            atomicStatus: "unknown",
            source: "none",
        });
    }
    const atomic = dataRecord(candidate.value);
    const status = atomic?.status;
    if (status !== "supported" &&
        status !== "ready" &&
        status !== "unsupported") {
        return Object.freeze({
            batchingSupported: false,
            atomicStatus: "unknown",
            source: candidate.source,
        });
    }
    return Object.freeze({
        batchingSupported: true,
        atomicStatus: status,
        source: candidate.source,
    });
}
export function buildWalletCapabilitiesRequest(from, chainId) {
    assertAddress(from, "sender");
    const chains = Object.freeze([normalizedChainId(chainId)]);
    return Object.freeze({
        method: WALLET_CALL_CAPABILITIES_METHOD,
        params: Object.freeze([from, chains]),
    });
}
function preparedCalls(steps, calls) {
    if (steps.length === 0 ||
        steps.length !== calls.length ||
        steps.length > MAX_CIPHERDEX_WALLET_CALLS) {
        throw new TypeError("Wallet calls do not match the reviewed operation steps");
    }
    const stepIds = new Set();
    return Object.freeze(steps.map((step, index) => {
        const call = calls[index];
        if (!STEP_ID.test(step.id) ||
            stepIds.has(step.id) ||
            call.stepId !== step.id ||
            typeof step.purpose !== "string" ||
            step.purpose.length === 0 ||
            step.purpose.length > 64 ||
            typeof step.label !== "string" ||
            step.label.length === 0 ||
            step.label.length > 256) {
            throw new TypeError("Wallet calls do not match the reviewed operation steps");
        }
        stepIds.add(step.id);
        assertAddress(call.to, "target");
        if (!BYTES.test(call.data) ||
            call.data.length > 2 + MAX_CALL_DATA_BYTES * 2)
            throw new TypeError("Invalid wallet call data");
        const value = call.value ?? 0n;
        if (typeof value !== "bigint" || value < 0n || value >= (1n << 256n)) {
            throw new TypeError("Invalid wallet call value");
        }
        return Object.freeze({
            stepId: step.id,
            purpose: step.purpose,
            label: step.label,
            to: call.to,
            data: call.data.toLowerCase(),
            value,
        });
    }));
}
function sendCallsRequest(input) {
    const calls = Object.freeze(input.calls.map((call) => Object.freeze({
        to: call.to,
        data: call.data,
        ...(call.value === 0n ? {} : { value: `0x${call.value.toString(16)}` }),
    })));
    const params = Object.freeze({
        version: WALLET_CALLS_VERSION,
        ...(input.id ? { id: input.id } : {}),
        from: input.from,
        chainId: input.chainId,
        atomicRequired: input.atomicRequired,
        calls,
    });
    return Object.freeze({
        method: WALLET_CALL_BATCH_METHOD,
        params: Object.freeze([params]),
    });
}
/**
 * Prepares an optional EIP-5792 execution plan from live wallet capabilities.
 * It never invokes a provider. Unsupported wallets retain the reviewed ordered
 * calls for the existing sequential frontend fallback.
 */
export function prepareWalletCallExecution(input) {
    const chainId = normalizedChainId(input.chainId);
    assertAddress(input.from, "sender");
    if (input.id !== undefined)
        assertBatchId(input.id);
    const calls = preparedCalls(input.steps, input.calls);
    const support = getWalletCallBatchSupport(input.capabilities, chainId);
    const containsApproval = calls.some((call) => call.purpose === "token-approval");
    const preference = input.preference ?? "prefer-atomic";
    if (preference !== "prefer-atomic" &&
        preference !== "allow-non-atomic" &&
        preference !== "require-atomic") {
        throw new TypeError("Invalid wallet call batch preference");
    }
    if (calls.length === 1) {
        return Object.freeze({
            kind: "sequential",
            reason: "single-call",
            support,
            calls,
            containsApproval,
        });
    }
    if (!support.batchingSupported) {
        return Object.freeze({
            kind: "sequential",
            reason: "wallet-batching-unavailable",
            support,
            calls,
            containsApproval,
        });
    }
    const canProvideAtomicity = support.atomicStatus === "supported" || support.atomicStatus === "ready";
    if (preference === "require-atomic" && !canProvideAtomicity) {
        return Object.freeze({
            kind: "unavailable",
            reason: "atomicity-unavailable",
            support,
            calls,
            containsApproval,
        });
    }
    const atomicRequired = preference !== "allow-non-atomic" && canProvideAtomicity;
    return Object.freeze({
        kind: "wallet_sendCalls",
        support,
        calls,
        containsApproval,
        request: sendCallsRequest({
            chainId,
            from: input.from,
            calls,
            atomicRequired,
            ...(input.id ? { id: input.id } : {}),
        }),
    });
}
export function parseWalletSendCallsResult(value) {
    const result = dataRecord(value);
    if (!result || typeof result.id !== "string") {
        throw new TypeError("Invalid wallet_sendCalls result");
    }
    assertBatchId(result.id);
    return Object.freeze({ id: result.id });
}
export function buildWalletCallsStatusRequest(id) {
    assertBatchId(id);
    return Object.freeze({
        method: WALLET_CALL_STATUS_METHOD,
        params: Object.freeze([id]),
    });
}
function parseReceipt(value) {
    const receipt = dataRecord(value);
    if (!receipt ||
        (receipt.status !== "0x0" && receipt.status !== "0x1") ||
        typeof receipt.blockHash !== "string" ||
        !HASH.test(receipt.blockHash) ||
        typeof receipt.blockNumber !== "string" ||
        !QUANTITY.test(receipt.blockNumber) ||
        typeof receipt.gasUsed !== "string" ||
        !QUANTITY.test(receipt.gasUsed) ||
        typeof receipt.transactionHash !== "string" ||
        !HASH.test(receipt.transactionHash) ||
        !Array.isArray(receipt.logs)) {
        throw new TypeError("Invalid wallet call receipt");
    }
    return Object.freeze({
        status: receipt.status === "0x1" ? "success" : "reverted",
        blockHash: receipt.blockHash.toLowerCase(),
        blockNumber: receipt.blockNumber.toLowerCase(),
        gasUsed: receipt.gasUsed.toLowerCase(),
        transactionHash: receipt.transactionHash.toLowerCase(),
    });
}
function stateForStatus(code) {
    switch (Math.trunc(code / 100)) {
        case 1:
            return "pending";
        case 2:
            return "confirmed";
        case 4:
            return "offchain-failed";
        case 5:
            return "reverted";
        case 6:
            return "partially-reverted";
        default:
            throw new TypeError("Unsupported wallet call status code");
    }
}
/**
 * Validates and normalizes wallet_getCallsStatus without assuming one receipt
 * per call. Partial non-atomic batches involving approvals are surfaced for
 * explicit allowance recovery instead of being treated as ordinary failures.
 */
export function normalizeWalletCallsStatus(value, context) {
    assertBatchId(context.expectedId);
    if (typeof context.containsApproval !== "boolean") {
        throw new TypeError("Invalid wallet call status context");
    }
    const expectedChainId = normalizedChainId(context.expectedChainId);
    const result = dataRecord(value);
    if (!result ||
        result.version !== WALLET_CALLS_VERSION ||
        result.id !== context.expectedId ||
        typeof result.chainId !== "string" ||
        normalizedChainId(result.chainId) !== expectedChainId ||
        typeof result.status !== "number" ||
        !Number.isSafeInteger(result.status) ||
        typeof result.atomic !== "boolean") {
        throw new TypeError("Invalid wallet call batch status");
    }
    const state = stateForStatus(result.status);
    const rawReceipts = result.receipts ?? [];
    if (!Array.isArray(rawReceipts)) {
        throw new TypeError("Invalid wallet call batch receipts");
    }
    const receipts = Object.freeze(rawReceipts.map(parseReceipt));
    if (new Set(receipts.map((receipt) => receipt.transactionHash)).size !==
        receipts.length) {
        throw new TypeError("Invalid wallet call batch receipts");
    }
    const successCount = receipts.filter((receipt) => receipt.status === "success").length;
    const revertedCount = receipts.length - successCount;
    if ((state === "confirmed" && (receipts.length === 0 || revertedCount !== 0)) ||
        (state === "offchain-failed" && receipts.length !== 0) ||
        (state === "reverted" && successCount !== 0) ||
        (state === "partially-reverted" &&
            (result.atomic || successCount === 0 || revertedCount === 0))) {
        throw new TypeError("Contradictory wallet call batch status");
    }
    const pendingIncludedApproval = state === "pending" && !result.atomic && successCount > 0;
    const partialApproval = state === "partially-reverted";
    const allowanceMayBeActive = context.containsApproval && (pendingIncludedApproval || partialApproval);
    const transactionHashes = Object.freeze(receipts.map((receipt) => receipt.transactionHash));
    return Object.freeze({
        version: result.version,
        id: context.expectedId,
        chainId: expectedChainId,
        code: result.status,
        state,
        atomic: result.atomic,
        terminal: state !== "pending",
        succeeded: state === "confirmed",
        safeForSequentialFallback: state === "offchain-failed",
        allowanceMayBeActive,
        requiresAllowanceReview: allowanceMayBeActive && state !== "pending",
        receipts,
        transactionHashes,
    });
}
