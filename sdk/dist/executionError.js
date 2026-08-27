export const CIPHERDEX_TRANSFER_AMOUNT_MISMATCH_SELECTOR = "0xb0a6ea29";
export const CIPHERDEX_EXECUTION_ISSUE_CODE = Object.freeze({
    TOKEN_TRANSFER_AMOUNT_MISMATCH: "token-transfer-amount-mismatch",
});
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = /^0x0{40}$/i;
const BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;
const REVERT_DATA = /^0x(?:[0-9a-fA-F]{2}){4,}$/;
const UINT256_LIMIT = 1n << 256n;
const ERROR_LINK_KEYS = Object.freeze([
    "data",
    "error",
    "cause",
    "info",
    "revert",
    "result",
    "originalError",
]);
const MAX_ERROR_NODES = 32;
function ownDataProperty(value, key) {
    try {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor && "value" in descriptor ? descriptor.value : undefined;
    }
    catch {
        return undefined;
    }
}
function revertSelector(value) {
    const queue = [value];
    const seen = new Set();
    let visited = 0;
    while (queue.length > 0 && visited < MAX_ERROR_NODES) {
        const candidate = queue.shift();
        visited += 1;
        if (typeof candidate === "string") {
            if (REVERT_DATA.test(candidate))
                return candidate.slice(0, 10).toLowerCase();
            continue;
        }
        if (!candidate || typeof candidate !== "object" || seen.has(candidate))
            continue;
        seen.add(candidate);
        for (const key of ERROR_LINK_KEYS) {
            const nested = ownDataProperty(candidate, key);
            if (nested !== undefined)
                queue.push(nested);
        }
    }
    return undefined;
}
function assertAddress(value, label) {
    if (!ADDRESS.test(value) || ZERO_ADDRESS.test(value)) {
        throw new TypeError(`Invalid CipherDEX ${label}`);
    }
}
function assertQuantity(value, label, allowZero) {
    if (value !== undefined &&
        (typeof value !== "bigint" ||
            value < (allowZero ? 0n : 1n) ||
            value >= UINT256_LIMIT)) {
        throw new TypeError(`Invalid CipherDEX ${label}`);
    }
}
function normalizedContext(context) {
    if (context.operation !== "public-swap" &&
        context.operation !== "public-create-or-add-liquidity" &&
        context.operation !== "public-remove-liquidity" &&
        context.operation !== "public-native-swap" &&
        context.operation !== "public-native-create-or-add-liquidity" &&
        context.operation !== "public-native-remove-liquidity" &&
        context.operation !== "public-protocol-fee-collection") {
        throw new TypeError("Invalid CipherDEX execution operation");
    }
    const stage = context.stage ?? "execution";
    if (stage !== "preflight" && stage !== "execution") {
        throw new TypeError("Invalid CipherDEX execution stage");
    }
    if (context.tokenAddress !== undefined) {
        assertAddress(context.tokenAddress, "execution token address");
    }
    return Object.freeze({
        operation: context.operation,
        stage,
        ...(context.tokenAddress ? { tokenAddress: context.tokenAddress } : {}),
    });
}
export function classifyCipherDexExecutionError(error, context) {
    const normalized = normalizedContext(context);
    if (revertSelector(error) !== CIPHERDEX_TRANSFER_AMOUNT_MISMATCH_SELECTOR) {
        return null;
    }
    return Object.freeze({
        code: CIPHERDEX_EXECUTION_ISSUE_CODE.TOKEN_TRANSFER_AMOUNT_MISMATCH,
        kind: "token-transfer-semantics",
        selector: CIPHERDEX_TRANSFER_AMOUNT_MISMATCH_SELECTOR,
        operation: normalized.operation,
        stage: normalized.stage,
        ...(normalized.tokenAddress ? { tokenAddress: normalized.tokenAddress } : {}),
        retryableWithSameState: false,
        compatibilityMayChange: true,
    });
}
export async function preflightCipherDexTransaction(input) {
    if (!input.adapter || typeof input.adapter.estimateGas !== "function") {
        throw new TypeError("Invalid CipherDEX preflight adapter");
    }
    assertAddress(input.transaction.from, "preflight sender");
    assertAddress(input.transaction.to, "preflight target");
    if (!BYTES.test(input.transaction.data)) {
        throw new TypeError("Invalid CipherDEX preflight data");
    }
    assertQuantity(input.transaction.value, "preflight value", true);
    assertQuantity(input.transaction.gasLimit, "preflight gas limit", false);
    const transaction = Object.freeze({ ...input.transaction });
    let gasEstimate;
    try {
        gasEstimate = await input.adapter.estimateGas(transaction);
    }
    catch (error) {
        const issue = classifyCipherDexExecutionError(error, {
            ...input.context,
            stage: "preflight",
        });
        if (issue)
            return Object.freeze({ ok: false, issue });
        throw new TypeError("Unable to preflight CipherDEX transaction", { cause: error });
    }
    assertQuantity(gasEstimate, "preflight gas estimate", false);
    return Object.freeze({ ok: true, gasEstimate });
}
