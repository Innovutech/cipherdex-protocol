export const CONFIDENTIAL_OPERATION = Object.freeze({
    QUOTE: "quote",
    POSITION: "position",
    ADD_LIQUIDITY_QUOTE: "add-liquidity-quote",
    REMOVE_LIQUIDITY_QUOTE: "remove-liquidity-quote",
    LOCKED_POSITION: "locked-position",
    SWAP: "swap",
    ADD_LIQUIDITY: "add-liquidity",
    REMOVE_LIQUIDITY: "remove-liquidity",
    LOCK_LIQUIDITY: "lock-liquidity",
});
export const CONFIDENTIAL_SIGNATURE_PURPOSE = Object.freeze({
    TOKEN_APPROVAL: "token-approval",
    AMOUNT_IN: "amount-in",
    SPECIFIED_AMOUNT: "specified-amount",
    MINIMUM_OUT: "minimum-out",
    TOKEN0_AMOUNT: "token0-amount",
    TOKEN1_AMOUNT: "token1-amount",
    MINIMUM_SHARES: "minimum-shares",
    MINIMUM_PRICE: "minimum-price",
    MAXIMUM_PRICE: "maximum-price",
    SHARES: "shares",
    MINIMUM_TOKEN0: "minimum-token0",
    MINIMUM_TOKEN1: "minimum-token1",
});
function assertBoolean(value, label) {
    if (typeof value !== "boolean")
        throw new TypeError(`Invalid ${label}`);
}
function assertRoute(value) {
    if (value !== "direct" && value !== "best-execution") {
        throw new TypeError("Invalid confidential operation route");
    }
}
function buildOperationPlan(input) {
    const signatureIds = new Set(input.signatures.map((step) => step.id));
    const transactionIds = new Set(input.transactions.map((step) => step.id));
    if (signatureIds.size !== input.signatures.length ||
        transactionIds.size !== input.transactions.length ||
        input.transactions.length === 0) {
        throw new TypeError("Invalid confidential operation steps");
    }
    const signatures = Object.freeze(input.signatures.map((step, index) => Object.freeze({
        ...step,
        position: index + 1,
        total: input.signatures.length,
        kind: "coti-encrypted-input",
        sensitive: true,
    })));
    const transactions = Object.freeze(input.transactions.map((step, index) => {
        const dependsOn = Object.freeze([...(step.dependsOn ?? [])]);
        if (dependsOn.some((id) => !transactionIds.has(id))) {
            throw new TypeError("Invalid confidential transaction dependency");
        }
        return Object.freeze({
            id: step.id,
            position: index + 1,
            total: input.transactions.length,
            confidential: true,
            purpose: step.purpose,
            label: step.label,
            dependsOn,
        });
    }));
    const batchEligible = transactions.length > 1;
    const batchedTransactionConfirmations = batchEligible ? 1 : transactions.length;
    const prompts = Object.freeze({
        encryptedSignatures: signatures.length,
        sequentialTransactionConfirmations: transactions.length,
        batchedTransactionConfirmations,
        sequentialTotal: signatures.length + transactions.length,
        batchedTotal: signatures.length + batchedTransactionConfirmations,
    });
    return Object.freeze({
        version: 1,
        operation: input.operation,
        ...(input.route ? { route: input.route } : {}),
        signatures,
        transactions,
        batching: Object.freeze({
            eligible: batchEligible,
            ordered: true,
            atomicity: "preferred",
            sequentialFallback: true,
        }),
        prompts,
    });
}
function approvalSignature(id, field, assetRole, label) {
    return Object.freeze({
        id,
        purpose: CONFIDENTIAL_SIGNATURE_PURPOSE.TOKEN_APPROVAL,
        field,
        assetRole,
        label,
    });
}
function approvalTransaction(id, label) {
    return Object.freeze({
        id,
        purpose: "token-approval",
        label,
    });
}
export function buildConfidentialQuoteOperationPlan(input = {}) {
    const route = input.route ?? "direct";
    assertRoute(route);
    const candidateBatchCount = input.candidateBatchCount ?? 1;
    if (!Number.isSafeInteger(candidateBatchCount) ||
        candidateBatchCount <= 0 ||
        candidateBatchCount > 9 ||
        (route === "direct" && candidateBatchCount !== 1)) {
        throw new TypeError("Invalid confidential quote candidate batch count");
    }
    return buildOperationPlan({
        operation: CONFIDENTIAL_OPERATION.QUOTE,
        route,
        signatures: Array.from({ length: candidateBatchCount }, (_, index) => ({
            id: candidateBatchCount === 1 ? "quote-amount-in" : `quote-amount-in-${index + 1}`,
            purpose: CONFIDENTIAL_SIGNATURE_PURPOSE.AMOUNT_IN,
            field: candidateBatchCount === 1 ? "amountIn" : `amountInBatch${index + 1}`,
            assetRole: "input",
            label: candidateBatchCount === 1
                ? "Sign private quote amount"
                : `Sign private quote amount ${index + 1} of ${candidateBatchCount}`,
        })),
        transactions: Array.from({ length: candidateBatchCount }, (_, index) => ({
            id: candidateBatchCount === 1 ? "request-quote" : `request-quote-${index + 1}`,
            purpose: "quote",
            label: route === "best-execution"
                ? candidateBatchCount === 1
                    ? "Request private best quote"
                    : `Request private quote batch ${index + 1} of ${candidateBatchCount}`
                : "Request private quote",
        })),
    });
}
export function buildConfidentialAddLiquidityQuoteOperationPlan() {
    return buildOperationPlan({
        operation: CONFIDENTIAL_OPERATION.ADD_LIQUIDITY_QUOTE,
        signatures: [{
                id: "liquidity-quote-specified-amount",
                purpose: CONFIDENTIAL_SIGNATURE_PURPOSE.SPECIFIED_AMOUNT,
                field: "specifiedAmount",
                label: "Sign private liquidity amount",
            }],
        transactions: [{
                id: "request-liquidity-quote",
                purpose: "liquidity-quote",
                label: "Preview private liquidity ratio",
            }],
    });
}
export function buildConfidentialPositionOperationPlan() {
    return buildOperationPlan({
        operation: CONFIDENTIAL_OPERATION.POSITION,
        signatures: [],
        transactions: [{
                id: "request-position",
                purpose: "position",
                label: "Load private liquidity position",
            }],
    });
}
export function buildConfidentialRemoveLiquidityQuoteOperationPlan() {
    return buildOperationPlan({
        operation: CONFIDENTIAL_OPERATION.REMOVE_LIQUIDITY_QUOTE,
        signatures: [{
                id: "remove-quote-shares",
                purpose: CONFIDENTIAL_SIGNATURE_PURPOSE.SHARES,
                field: "shares",
                assetRole: "lp-token",
                label: "Sign private LP shares to preview",
            }],
        transactions: [{
                id: "request-remove-liquidity-quote",
                purpose: "remove-liquidity-quote",
                label: "Preview private liquidity withdrawal",
            }],
    });
}
export function buildConfidentialLockedPositionOperationPlan() {
    return buildOperationPlan({
        operation: CONFIDENTIAL_OPERATION.LOCKED_POSITION,
        signatures: [],
        transactions: [{
                id: "request-locked-position",
                purpose: "locked-position",
                label: "Load locked private liquidity position",
            }],
    });
}
export function buildConfidentialSwapOperationPlan(input = {}) {
    const approvalRequired = input.approvalRequired ?? true;
    assertBoolean(approvalRequired, "private swap approval requirement");
    const route = input.route ?? "direct";
    assertRoute(route);
    const signatures = [];
    const transactions = [];
    if (approvalRequired) {
        signatures.push(approvalSignature("approve-input-amount", "amountIn", "input", "Authorize private input-token spending"));
        transactions.push(approvalTransaction("approve-input-token", "Approve private input token"));
    }
    signatures.push({
        id: "swap-amount-in",
        purpose: CONFIDENTIAL_SIGNATURE_PURPOSE.AMOUNT_IN,
        field: "amountIn",
        assetRole: "input",
        label: "Sign private swap amount",
    }, {
        id: "swap-minimum-out",
        purpose: CONFIDENTIAL_SIGNATURE_PURPOSE.MINIMUM_OUT,
        field: "minimumOut",
        label: "Sign minimum private output",
    });
    transactions.push({
        id: "execute-swap",
        purpose: "swap",
        label: route === "best-execution"
            ? "Submit private best swap"
            : "Submit private swap",
        dependsOn: approvalRequired ? ["approve-input-token"] : [],
    });
    return buildOperationPlan({
        operation: CONFIDENTIAL_OPERATION.SWAP,
        route,
        signatures,
        transactions,
    });
}
export function buildConfidentialAddLiquidityOperationPlan(input = {}) {
    const token0ApprovalRequired = input.token0ApprovalRequired ?? true;
    const token1ApprovalRequired = input.token1ApprovalRequired ?? true;
    assertBoolean(token0ApprovalRequired, "token0 approval requirement");
    assertBoolean(token1ApprovalRequired, "token1 approval requirement");
    const signatures = [];
    const transactions = [];
    if (token0ApprovalRequired) {
        signatures.push(approvalSignature("approve-token0-amount", "amount0", "token0", "Authorize private token 0 spending"));
        transactions.push(approvalTransaction("approve-token0", "Approve private token 0"));
    }
    if (token1ApprovalRequired) {
        signatures.push(approvalSignature("approve-token1-amount", "amount1", "token1", "Authorize private token 1 spending"));
        transactions.push(approvalTransaction("approve-token1", "Approve private token 1"));
    }
    signatures.push({
        id: "liquidity-token0-amount",
        purpose: CONFIDENTIAL_SIGNATURE_PURPOSE.TOKEN0_AMOUNT,
        field: "amount0",
        assetRole: "token0",
        label: "Sign private token 0 amount",
    }, {
        id: "liquidity-token1-amount",
        purpose: CONFIDENTIAL_SIGNATURE_PURPOSE.TOKEN1_AMOUNT,
        field: "amount1",
        assetRole: "token1",
        label: "Sign private token 1 amount",
    }, {
        id: "liquidity-minimum-shares",
        purpose: CONFIDENTIAL_SIGNATURE_PURPOSE.MINIMUM_SHARES,
        field: "minimumShares",
        assetRole: "lp-token",
        label: "Sign minimum private LP shares",
    }, {
        id: "liquidity-minimum-price",
        purpose: CONFIDENTIAL_SIGNATURE_PURPOSE.MINIMUM_PRICE,
        field: "minimumPriceX18",
        label: "Sign minimum private pool price",
    }, {
        id: "liquidity-maximum-price",
        purpose: CONFIDENTIAL_SIGNATURE_PURPOSE.MAXIMUM_PRICE,
        field: "maximumPriceX18",
        label: "Sign maximum private pool price",
    });
    const approvalIds = transactions.map((step) => step.id);
    transactions.push({
        id: "add-liquidity",
        purpose: "add-liquidity",
        label: "Submit private liquidity",
        dependsOn: approvalIds,
    });
    return buildOperationPlan({
        operation: CONFIDENTIAL_OPERATION.ADD_LIQUIDITY,
        signatures,
        transactions,
    });
}
export function buildConfidentialRemoveLiquidityOperationPlan() {
    return buildOperationPlan({
        operation: CONFIDENTIAL_OPERATION.REMOVE_LIQUIDITY,
        signatures: [
            {
                id: "remove-shares",
                purpose: CONFIDENTIAL_SIGNATURE_PURPOSE.SHARES,
                field: "shares",
                assetRole: "lp-token",
                label: "Sign private LP shares",
            },
            {
                id: "remove-minimum-token0",
                purpose: CONFIDENTIAL_SIGNATURE_PURPOSE.MINIMUM_TOKEN0,
                field: "minimumAmount0",
                assetRole: "token0",
                label: "Sign minimum private token 0 output",
            },
            {
                id: "remove-minimum-token1",
                purpose: CONFIDENTIAL_SIGNATURE_PURPOSE.MINIMUM_TOKEN1,
                field: "minimumAmount1",
                assetRole: "token1",
                label: "Sign minimum private token 1 output",
            },
        ],
        transactions: [{
                id: "remove-liquidity",
                purpose: "remove-liquidity",
                label: "Remove private liquidity",
            }],
    });
}
export function buildConfidentialLockLiquidityOperationPlan() {
    return buildOperationPlan({
        operation: CONFIDENTIAL_OPERATION.LOCK_LIQUIDITY,
        signatures: [{
                id: "lock-shares",
                purpose: CONFIDENTIAL_SIGNATURE_PURPOSE.SHARES,
                field: "shares",
                assetRole: "lp-token",
                label: "Sign private LP shares to lock",
            }],
        transactions: [{
                id: "lock-liquidity",
                purpose: "lock-liquidity",
                label: "Lock private liquidity",
            }],
    });
}
