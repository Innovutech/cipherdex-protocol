export const PUBLIC_ROUTE_CANDIDATE = Object.freeze({
    LOW_5_BPS: 1,
    STANDARD_30_BPS: 2,
    HIGH_100_BPS: 4,
    ALL: 7,
});
export const PUBLIC_LIMIT_ORDER_CREATED_TOPIC = "0x1ab8aeda179c2038ab835a8f7689b6016641946b9b9a3f129a893ab02a3bc78b";
export const PUBLIC_LIMIT_ORDER_AMENDED_TOPIC = "0xc8f1bf6a229ab9ac9ade2efc79c6f64ae0cc4eff57455c69f45a4f56f06e0106";
export const PUBLIC_LIMIT_ORDER_FILLED_TOPIC = "0x4eccc8a2abb5a0810b0765d135c8829316e4cd9bd2c00dc7362e4be54e54f0fc";
export const PUBLIC_LIMIT_ORDER_CANCELLED_TOPIC = "0x8cd7e382eb42bcc84841dacd15adda3bdd77aefce75edd49238bd47995b1f968";
const UINT256_MAX = (1n << 256n) - 1n;
const UINT64_MAX = (1n << 64n) - 1n;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = /^0x0{40}$/i;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const MAX_RECEIPT_LOGS = 256;
function assertAddress(value, label) {
    if (!ADDRESS.test(value) || ZERO_ADDRESS.test(value)) {
        throw new TypeError(`Invalid ${label} address`);
    }
}
function assertUint256(value, label, allowZero = false) {
    if (typeof value !== "bigint" ||
        value < 0n ||
        (!allowZero && value === 0n) ||
        value > UINT256_MAX)
        throw new TypeError(`Invalid ${label}`);
}
function assertCandidateBitmap(value) {
    if (!Number.isSafeInteger(value) ||
        value <= 0 ||
        value > PUBLIC_ROUTE_CANDIDATE.ALL) {
        throw new TypeError("Invalid public route candidate bitmap");
    }
}
function assertExpiry(value) {
    if (typeof value !== "bigint" || value <= 0n || value > UINT64_MAX) {
        throw new TypeError("Invalid public limit-order expiry");
    }
}
function snapshotCreateParams(params) {
    assertAddress(params.tokenIn, "public limit-order input token");
    assertAddress(params.tokenOut, "public limit-order output token");
    if (params.tokenIn.toLowerCase() === params.tokenOut.toLowerCase()) {
        throw new TypeError("Invalid public limit-order token pair");
    }
    assertAddress(params.recipient, "public limit-order recipient");
    assertUint256(params.amountIn, "public limit-order input amount");
    assertUint256(params.minAmountOut, "public limit-order minimum output");
    assertExpiry(params.expiry);
    assertCandidateBitmap(params.candidateBitmap);
    assertUint256(params.minimumFillAmount, "public limit-order minimum fill amount", !params.allowPartialFills);
    if (params.allowPartialFills
        ? params.minimumFillAmount > params.amountIn
        : params.minimumFillAmount !== 0n && params.minimumFillAmount !== params.amountIn)
        throw new TypeError("Invalid public limit-order partial-fill configuration");
    return Object.freeze({ ...params });
}
function snapshotAmendment(amendment) {
    assertAddress(amendment.recipient, "public limit-order recipient");
    assertUint256(amendment.minAmountOutForRemaining, "public limit-order minimum output");
    assertExpiry(amendment.expiry);
    assertCandidateBitmap(amendment.candidateBitmap);
    assertUint256(amendment.minimumFillAmount, "public limit-order minimum fill amount", !amendment.allowPartialFills);
    return Object.freeze({ ...amendment });
}
export function buildPublicLimitOrderCreateCall(params, executionBounty = 0n) {
    assertUint256(executionBounty, "public limit-order execution bounty", true);
    return Object.freeze({
        functionName: "createOrder",
        args: Object.freeze([snapshotCreateParams(params)]),
        value: executionBounty,
    });
}
export function buildPublicLimitOrderPermitCall(params, permit, executionBounty = 0n) {
    assertUint256(executionBounty, "public limit-order execution bounty", true);
    assertUint256(permit.deadline, "permit deadline");
    if ((permit.v !== 27 && permit.v !== 28) ||
        !BYTES32.test(permit.r) ||
        !BYTES32.test(permit.s))
        throw new TypeError("Invalid public limit-order permit signature");
    return Object.freeze({
        functionName: "createOrderWithPermit",
        args: Object.freeze([
            snapshotCreateParams(params),
            permit.deadline,
            permit.v,
            permit.r,
            permit.s,
        ]),
        value: executionBounty,
    });
}
export function buildPublicLimitOrderAmendCall(orderId, amendment, remainingAmountIn) {
    assertUint256(orderId, "public limit-order ID");
    assertUint256(remainingAmountIn, "public limit-order remaining input");
    if (amendment.allowPartialFills
        ? amendment.minimumFillAmount > remainingAmountIn
        : amendment.minimumFillAmount !== 0n &&
            amendment.minimumFillAmount !== remainingAmountIn)
        throw new TypeError("Invalid public limit-order partial-fill configuration");
    return Object.freeze({
        functionName: "amendOrder",
        args: Object.freeze([orderId, snapshotAmendment(amendment)]),
    });
}
export function buildPublicLimitOrderFillCall(orderId, amountInToFill) {
    assertUint256(orderId, "public limit-order ID");
    assertUint256(amountInToFill, "public limit-order fill amount");
    return Object.freeze({
        functionName: "fillOrder",
        args: Object.freeze([orderId, amountInToFill]),
    });
}
/** Mirrors the order book's full-precision ceiling price calculation. */
export function publicLimitOrderMinimumOutput(input) {
    assertUint256(input.amountInToFill, "public limit-order fill amount");
    assertUint256(input.priceNumerator, "public limit-order price numerator");
    assertUint256(input.priceDenominator, "public limit-order price denominator");
    const product = input.amountInToFill * input.priceNumerator;
    const result = product / input.priceDenominator +
        (product % input.priceDenominator === 0n ? 0n : 1n);
    if (result === 0n || result > UINT256_MAX) {
        throw new RangeError("Public limit-order minimum output exceeds protocol bounds");
    }
    return result;
}
/** Mirrors proportional floor payout, including the final-fill remainder rule. */
export function publicLimitOrderBountyForFill(input) {
    assertUint256(input.remainingBounty, "remaining execution bounty", true);
    assertUint256(input.amountInToFill, "public limit-order fill amount");
    assertUint256(input.remainingAmountIn, "public limit-order remaining input");
    if (input.amountInToFill > input.remainingAmountIn) {
        throw new RangeError("Public limit-order fill exceeds remaining input");
    }
    if (input.amountInToFill === input.remainingAmountIn)
        return input.remainingBounty;
    return input.remainingBounty * input.amountInToFill / input.remainingAmountIn;
}
function sameAddress(left, right) {
    return left.toLowerCase() === right.toLowerCase();
}
function assertTransactionHash(value) {
    if (!BYTES32.test(value) || /^0x0{64}$/i.test(value)) {
        throw new TypeError("Invalid public limit-order transaction hash");
    }
}
function receiptLogs(expectation, receipt) {
    assertTransactionHash(expectation.transactionHash);
    assertAddress(expectation.orderBook, "public limit-order book");
    if (receipt.transactionHash.toLowerCase() !== expectation.transactionHash.toLowerCase() ||
        !((typeof receipt.status === "number" && receipt.status === 1) ||
            (typeof receipt.status === "bigint" && receipt.status === 1n)) ||
        !Array.isArray(receipt.logs) ||
        receipt.logs.length > MAX_RECEIPT_LOGS)
        throw new TypeError("Invalid public limit-order receipt");
    return receipt.logs.map((log) => {
        if (!ADDRESS.test(log.address) ||
            !Array.isArray(log.topics) ||
            log.topics.length > 4 ||
            log.topics.some((topic) => typeof topic !== "string" || !BYTES32.test(topic)) ||
            !/^0x(?:[0-9a-fA-F]{2})*$/.test(log.data))
            throw new TypeError("Invalid public limit-order log");
        return Object.freeze({
            address: log.address,
            topics: Object.freeze([...log.topics]),
            data: log.data,
        });
    });
}
function uniqueLog(logs, emitter, topic, label) {
    const matches = logs.filter((log) => sameAddress(log.address, emitter) && log.topics[0]?.toLowerCase() === topic);
    if (matches.length !== 1)
        throw new TypeError(`${label} event is missing or ambiguous`);
    return matches[0];
}
function topicUint(topic) {
    return topic && BYTES32.test(topic) ? BigInt(topic) : undefined;
}
function topicAddress(topic) {
    if (!topic || !/^0x0{24}[0-9a-fA-F]{40}$/.test(topic))
        return undefined;
    const address = `0x${topic.slice(26)}`;
    return ZERO_ADDRESS.test(address) ? undefined : address;
}
function words(data, count) {
    if (!new RegExp(`^0x[0-9a-fA-F]{${count * 64}}$`).test(data))
        return undefined;
    return Array.from({ length: count }, (_, index) => data.slice(2 + index * 64, 2 + (index + 1) * 64));
}
function wordUint(word) {
    return word && /^[0-9a-fA-F]{64}$/.test(word) ? BigInt(`0x${word}`) : undefined;
}
function wordAddress(word) {
    if (!word || !/^0{24}[0-9a-fA-F]{40}$/.test(word))
        return undefined;
    const address = `0x${word.slice(24)}`;
    return ZERO_ADDRESS.test(address) ? undefined : address;
}
function wordBoolean(word) {
    if (!word || !/^0{63}[01]$/.test(word))
        return undefined;
    return word.endsWith("1");
}
export function parsePublicLimitOrderCreatedResult(expectation, receipt) {
    assertAddress(expectation.maker, "public limit-order maker");
    assertAddress(expectation.tokenIn, "public limit-order input token");
    const log = uniqueLog(receiptLogs(expectation, receipt), expectation.orderBook, PUBLIC_LIMIT_ORDER_CREATED_TOPIC, "OrderCreated");
    const orderId = topicUint(log.topics[1]);
    const maker = topicAddress(log.topics[2]);
    const tokenIn = topicAddress(log.topics[3]);
    const data = words(log.data, 9);
    const tokenOut = wordAddress(data?.[0]);
    const recipient = wordAddress(data?.[1]);
    const amountIn = wordUint(data?.[2]);
    const minAmountOut = wordUint(data?.[3]);
    const expiry = wordUint(data?.[4]);
    const candidateBitmap = wordUint(data?.[5]);
    const allowPartialFills = wordBoolean(data?.[6]);
    const minimumFillAmount = wordUint(data?.[7]);
    const executionBounty = wordUint(data?.[8]);
    if (log.topics.length !== 4 ||
        orderId === undefined || orderId === 0n ||
        !maker || !sameAddress(maker, expectation.maker) ||
        !tokenIn || !sameAddress(tokenIn, expectation.tokenIn) ||
        !tokenOut || !recipient ||
        amountIn === undefined || amountIn === 0n ||
        minAmountOut === undefined || minAmountOut === 0n ||
        expiry === undefined || expiry === 0n || expiry > UINT64_MAX ||
        candidateBitmap === undefined || candidateBitmap > 255n ||
        allowPartialFills === undefined ||
        minimumFillAmount === undefined || executionBounty === undefined)
        throw new TypeError("Invalid OrderCreated event encoding");
    assertCandidateBitmap(Number(candidateBitmap));
    return Object.freeze({
        transactionHash: expectation.transactionHash,
        orderId,
        maker,
        tokenIn,
        tokenOut,
        recipient,
        amountIn,
        minAmountOut,
        expiry,
        candidateBitmap: Number(candidateBitmap),
        allowPartialFills,
        minimumFillAmount,
        executionBounty,
    });
}
export function parsePublicLimitOrderAmendedResult(expectation, receipt) {
    assertUint256(expectation.orderId, "public limit-order ID");
    assertAddress(expectation.maker, "public limit-order maker");
    const log = uniqueLog(receiptLogs(expectation, receipt), expectation.orderBook, PUBLIC_LIMIT_ORDER_AMENDED_TOPIC, "OrderAmended");
    const orderId = topicUint(log.topics[1]);
    const maker = topicAddress(log.topics[2]);
    const data = words(log.data, 7);
    const revision = wordUint(data?.[0]);
    const recipient = wordAddress(data?.[1]);
    const minAmountOutForRemaining = wordUint(data?.[2]);
    const expiry = wordUint(data?.[3]);
    const candidateBitmap = wordUint(data?.[4]);
    const allowPartialFills = wordBoolean(data?.[5]);
    const minimumFillAmount = wordUint(data?.[6]);
    if (log.topics.length !== 3 ||
        orderId !== expectation.orderId ||
        !maker || !sameAddress(maker, expectation.maker) ||
        revision === undefined || revision > 0xffffffffn ||
        !recipient ||
        minAmountOutForRemaining === undefined || minAmountOutForRemaining === 0n ||
        expiry === undefined || expiry === 0n || expiry > UINT64_MAX ||
        candidateBitmap === undefined || candidateBitmap > 255n ||
        allowPartialFills === undefined || minimumFillAmount === undefined)
        throw new TypeError("Invalid OrderAmended event encoding");
    assertCandidateBitmap(Number(candidateBitmap));
    return Object.freeze({
        transactionHash: expectation.transactionHash,
        orderId,
        maker,
        revision,
        recipient,
        minAmountOutForRemaining,
        expiry,
        candidateBitmap: Number(candidateBitmap),
        allowPartialFills,
        minimumFillAmount,
    });
}
export function parsePublicLimitOrderFilledResult(expectation, receipt) {
    assertUint256(expectation.orderId, "public limit-order ID");
    assertAddress(expectation.maker, "public limit-order maker");
    const log = uniqueLog(receiptLogs(expectation, receipt), expectation.orderBook, PUBLIC_LIMIT_ORDER_FILLED_TOPIC, "OrderFilled");
    const orderId = topicUint(log.topics[1]);
    const maker = topicAddress(log.topics[2]);
    const filler = topicAddress(log.topics[3]);
    const data = words(log.data, 8);
    const recipient = wordAddress(data?.[0]);
    const selectedPool = wordAddress(data?.[1]);
    const selectedFeeBps = wordUint(data?.[2]);
    const amountIn = wordUint(data?.[3]);
    const amountOut = wordUint(data?.[4]);
    const minimumAmountOut = wordUint(data?.[5]);
    const remainingAmountIn = wordUint(data?.[6]);
    const executionBounty = wordUint(data?.[7]);
    if (log.topics.length !== 4 ||
        orderId !== expectation.orderId ||
        !maker || !sameAddress(maker, expectation.maker) ||
        !filler || !recipient || !selectedPool ||
        selectedFeeBps === undefined ||
        amountIn === undefined || amountIn === 0n ||
        amountOut === undefined || amountOut === 0n ||
        minimumAmountOut === undefined ||
        remainingAmountIn === undefined ||
        executionBounty === undefined)
        throw new TypeError("Invalid OrderFilled event encoding");
    return Object.freeze({
        transactionHash: expectation.transactionHash,
        orderId,
        maker,
        filler,
        recipient,
        selectedPool,
        selectedFeeBps,
        amountIn,
        amountOut,
        minimumAmountOut,
        remainingAmountIn,
        executionBounty,
    });
}
export function parsePublicLimitOrderCancelledResult(expectation, receipt) {
    assertUint256(expectation.orderId, "public limit-order ID");
    assertAddress(expectation.maker, "public limit-order maker");
    const log = uniqueLog(receiptLogs(expectation, receipt), expectation.orderBook, PUBLIC_LIMIT_ORDER_CANCELLED_TOPIC, "OrderCancelled");
    const orderId = topicUint(log.topics[1]);
    const maker = topicAddress(log.topics[2]);
    const data = words(log.data, 2);
    const returnedAmountIn = wordUint(data?.[0]);
    const returnedExecutionBounty = wordUint(data?.[1]);
    if (log.topics.length !== 3 ||
        orderId !== expectation.orderId ||
        !maker || !sameAddress(maker, expectation.maker) ||
        returnedAmountIn === undefined || returnedAmountIn === 0n ||
        returnedExecutionBounty === undefined)
        throw new TypeError("Invalid OrderCancelled event encoding");
    return Object.freeze({
        transactionHash: expectation.transactionHash,
        orderId,
        maker,
        returnedAmountIn,
        returnedExecutionBounty,
    });
}
