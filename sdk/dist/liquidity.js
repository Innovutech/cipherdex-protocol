export const PUBLIC_LIQUIDITY_ROUTED_TOPIC = "0xf57701d662488466310aef8303deec83f9fbfa81b6327d4577152fbc12634d4b";
export const NATIVE_LIQUIDITY_ADDED_TOPIC = "0x6241df93d44bd96caf1d9efe1ba8da46b54ba15df7beea93efec7c360f756e0e";
export const CONFIDENTIAL_LIQUIDITY_QUOTE_RESULT_TOPIC = "0x4069fd369ee96a414b638a1f85119a2360ab4a7e05df9b1816582b1baf87a147";
const UINT256_MAX = (1n << 256n) - 1n;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = /^0x0{40}$/i;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const MAX_RECEIPT_LOGS = 256;
function assertLiquiditySide(side) {
    if (side !== "token0" && side !== "token1") {
        throw new TypeError("Invalid liquidity side");
    }
}
/** Converts the SDK's explicit side into the protocol's token0-side boolean. */
export function liquiditySideToContractBoolean(side) {
    assertLiquiditySide(side);
    return side === "token0";
}
function assertAddress(value, label) {
    if (!ADDRESS.test(value) || ZERO_ADDRESS.test(value)) {
        throw new TypeError(`Invalid ${label} address`);
    }
}
function assertPositiveUint256(value, label) {
    if (typeof value !== "bigint" || value <= 0n || value > UINT256_MAX) {
        throw new TypeError(`Invalid ${label}`);
    }
}
function assertTransactionHash(value) {
    if (!BYTES32.test(value) || /^0x0{64}$/i.test(value)) {
        throw new TypeError("Invalid liquidity transaction hash");
    }
}
function ceilDiv(numerator, denominator) {
    return numerator / denominator + (numerator % denominator === 0n ? 0n : 1n);
}
/**
 * Mirrors PublicCPMM's existing-pool liquidity rounding in raw token units:
 * shares round down, then both accepted amounts round up.
 */
export function previewPublicProportionalLiquidity(input) {
    assertPositiveUint256(input.reserve0, "public liquidity reserve0");
    assertPositiveUint256(input.reserve1, "public liquidity reserve1");
    assertPositiveUint256(input.totalLpShares, "public liquidity total LP shares");
    assertPositiveUint256(input.specifiedAmount, "public liquidity specified amount");
    assertLiquiditySide(input.specifiedSide);
    const specifiedReserve = input.specifiedSide === "token0"
        ? input.reserve0
        : input.reserve1;
    const expectedLpShares = input.specifiedAmount * input.totalLpShares / specifiedReserve;
    if (expectedLpShares === 0n || expectedLpShares > UINT256_MAX) {
        throw new RangeError("Public liquidity amount is too small or overflows LP shares");
    }
    const acceptedAmount0 = ceilDiv(expectedLpShares * input.reserve0, input.totalLpShares);
    const acceptedAmount1 = ceilDiv(expectedLpShares * input.reserve1, input.totalLpShares);
    if (acceptedAmount0 === 0n ||
        acceptedAmount1 === 0n ||
        acceptedAmount0 > UINT256_MAX ||
        acceptedAmount1 > UINT256_MAX ||
        (input.specifiedSide === "token0"
            ? acceptedAmount0 > input.specifiedAmount
            : acceptedAmount1 > input.specifiedAmount)) {
        throw new RangeError("Public liquidity preview exceeds protocol bounds");
    }
    return Object.freeze({ acceptedAmount0, acceptedAmount1, expectedLpShares });
}
function snapshotLogs(receipt) {
    assertTransactionHash(receipt.transactionHash);
    if (!((typeof receipt.status === "number" && receipt.status === 1) ||
        (typeof receipt.status === "bigint" && receipt.status === 1n))) {
        throw new TypeError("Liquidity transaction receipt is not successful");
    }
    if (!Array.isArray(receipt.logs) || receipt.logs.length > MAX_RECEIPT_LOGS) {
        throw new TypeError("Invalid liquidity transaction receipt logs");
    }
    const logs = [];
    for (const log of receipt.logs) {
        if (!log ||
            typeof log !== "object" ||
            !ADDRESS.test(log.address) ||
            !Array.isArray(log.topics) ||
            log.topics.length > 4 ||
            log.topics.some((topic) => typeof topic !== "string" || !BYTES32.test(topic)) ||
            !/^0x(?:[0-9a-fA-F]{2})*$/.test(log.data)) {
            throw new TypeError("Invalid liquidity transaction log");
        }
        logs.push(Object.freeze({
            address: log.address,
            topics: Object.freeze([...log.topics]),
            data: log.data,
        }));
    }
    return Object.freeze(logs);
}
function sameAddress(left, right) {
    return left.toLowerCase() === right.toLowerCase();
}
function uniqueEventLog(logs, emitter, topic, label) {
    const matches = logs.filter((log) => sameAddress(log.address, emitter) && log.topics[0]?.toLowerCase() === topic);
    if (matches.length !== 1) {
        throw new TypeError(`${label} event is missing or ambiguous`);
    }
    return matches[0];
}
function topicAddress(topic) {
    if (!topic || !/^0x0{24}[0-9a-fA-F]{40}$/.test(topic))
        return undefined;
    const address = `0x${topic.slice(26)}`;
    return ZERO_ADDRESS.test(address) ? undefined : address;
}
function topicBoolean(topic) {
    if (!topic || !/^0x0{63}[01]$/.test(topic))
        return undefined;
    return topic.endsWith("1");
}
function dataWords(data, expectedWords) {
    if (!new RegExp(`^0x[0-9a-fA-F]{${expectedWords * 64}}$`).test(data))
        return undefined;
    const words = [];
    for (let index = 0; index < expectedWords; index += 1) {
        words.push(data.slice(2 + index * 64, 2 + (index + 1) * 64));
    }
    return words;
}
function wordAddress(word) {
    if (!word || !/^0{24}[0-9a-fA-F]{40}$/.test(word))
        return undefined;
    const address = `0x${word.slice(24)}`;
    return ZERO_ADDRESS.test(address) ? undefined : address;
}
function wordUint256(word) {
    if (!word || !/^[0-9a-fA-F]{64}$/.test(word))
        return undefined;
    return BigInt(`0x${word}`);
}
function assertReceiptTransaction(receipt, transactionHash) {
    assertTransactionHash(transactionHash);
    if (receipt.transactionHash.toLowerCase() !== transactionHash.toLowerCase()) {
        throw new TypeError("Liquidity receipt transaction hash mismatch");
    }
    return snapshotLogs(receipt);
}
function decodePublicLiquidityLog(log) {
    const provider = topicAddress(log.topics[1]);
    const pool = topicAddress(log.topics[2]);
    const poolCreated = topicBoolean(log.topics[3]);
    const words = dataWords(log.data, 3);
    const amount0 = wordUint256(words?.[0]);
    const amount1 = wordUint256(words?.[1]);
    const shares = wordUint256(words?.[2]);
    if (log.topics.length !== 4 ||
        !provider ||
        !pool ||
        poolCreated === undefined ||
        amount0 === undefined || amount0 === 0n ||
        amount1 === undefined || amount1 === 0n ||
        shares === undefined || shares === 0n) {
        throw new TypeError("Invalid PublicLiquidityRouted event encoding");
    }
    return Object.freeze({ provider, pool, poolCreated, amount0, amount1, shares });
}
/** Authenticates the unique liquidity-router result in a successful receipt. */
export function parsePublicLiquidityRoutedResult(expectation, receipt) {
    assertAddress(expectation.liquidityRouter, "public liquidity router");
    assertAddress(expectation.provider, "public liquidity provider");
    assertPositiveUint256(expectation.maximumAmount0, "public liquidity maximum amount0");
    assertPositiveUint256(expectation.maximumAmount1, "public liquidity maximum amount1");
    const logs = assertReceiptTransaction(receipt, expectation.transactionHash);
    const decoded = decodePublicLiquidityLog(uniqueEventLog(logs, expectation.liquidityRouter, PUBLIC_LIQUIDITY_ROUTED_TOPIC, "PublicLiquidityRouted"));
    if (!sameAddress(decoded.provider, expectation.provider) ||
        decoded.amount0 > expectation.maximumAmount0 ||
        decoded.amount1 > expectation.maximumAmount1) {
        throw new TypeError("PublicLiquidityRouted event violates the reviewed liquidity request");
    }
    return Object.freeze({
        transactionHash: expectation.transactionHash,
        provider: decoded.provider,
        pool: decoded.pool,
        poolCreated: decoded.poolCreated,
        amount0Used: decoded.amount0,
        amount1Used: decoded.amount1,
        mintedLpShares: decoded.shares,
        amount0Refunded: expectation.maximumAmount0 - decoded.amount0,
        amount1Refunded: expectation.maximumAmount1 - decoded.amount1,
    });
}
/**
 * Authenticates NativeLiquidityAdded and its nested PublicLiquidityRouted event,
 * including the canonical WCOTI/token ordering used to derive pool creation.
 */
export function parseNativeLiquidityAddedResult(expectation, receipt) {
    for (const [value, label] of [
        [expectation.nativeRouter, "native router"],
        [expectation.liquidityRouter, "public liquidity router"],
        [expectation.wrappedNative, "wrapped native token"],
        [expectation.provider, "native liquidity provider"],
        [expectation.recipient, "native liquidity recipient"],
        [expectation.pairedToken, "paired token"],
    ])
        assertAddress(value, label);
    if (sameAddress(expectation.wrappedNative, expectation.pairedToken)) {
        throw new TypeError("Invalid native liquidity token pair");
    }
    assertPositiveUint256(expectation.maximumNativeAmount, "maximum native amount");
    assertPositiveUint256(expectation.maximumTokenAmount, "maximum paired-token amount");
    const logs = assertReceiptTransaction(receipt, expectation.transactionHash);
    const nativeLog = uniqueEventLog(logs, expectation.nativeRouter, NATIVE_LIQUIDITY_ADDED_TOPIC, "NativeLiquidityAdded");
    const provider = topicAddress(nativeLog.topics[1]);
    const recipient = topicAddress(nativeLog.topics[2]);
    const pool = topicAddress(nativeLog.topics[3]);
    const nativeWords = dataWords(nativeLog.data, 4);
    const pairedToken = wordAddress(nativeWords?.[0]);
    const nativeAmount = wordUint256(nativeWords?.[1]);
    const tokenAmount = wordUint256(nativeWords?.[2]);
    const shares = wordUint256(nativeWords?.[3]);
    if (nativeLog.topics.length !== 4 ||
        !provider || !recipient || !pool || !pairedToken ||
        nativeAmount === undefined || nativeAmount === 0n ||
        tokenAmount === undefined || tokenAmount === 0n ||
        shares === undefined || shares === 0n ||
        !sameAddress(provider, expectation.provider) ||
        !sameAddress(recipient, expectation.recipient) ||
        !sameAddress(pairedToken, expectation.pairedToken) ||
        nativeAmount > expectation.maximumNativeAmount ||
        tokenAmount > expectation.maximumTokenAmount) {
        throw new TypeError("NativeLiquidityAdded event violates the reviewed liquidity request");
    }
    const routed = decodePublicLiquidityLog(uniqueEventLog(logs, expectation.liquidityRouter, PUBLIC_LIQUIDITY_ROUTED_TOPIC, "nested PublicLiquidityRouted"));
    const wrappedIsToken0 = expectation.wrappedNative.toLowerCase() < expectation.pairedToken.toLowerCase();
    const expectedAmount0 = wrappedIsToken0 ? nativeAmount : tokenAmount;
    const expectedAmount1 = wrappedIsToken0 ? tokenAmount : nativeAmount;
    if (!sameAddress(routed.provider, expectation.recipient) ||
        !sameAddress(routed.pool, pool) ||
        routed.amount0 !== expectedAmount0 ||
        routed.amount1 !== expectedAmount1 ||
        routed.shares !== shares) {
        throw new TypeError("Native liquidity router events do not agree");
    }
    return Object.freeze({
        transactionHash: expectation.transactionHash,
        provider,
        recipient,
        pool,
        poolCreated: routed.poolCreated,
        pairedToken,
        nativeAmountUsed: nativeAmount,
        tokenAmountUsed: tokenAmount,
        mintedLpShares: shares,
        nativeAmountRefunded: expectation.maximumNativeAmount - nativeAmount,
        tokenAmountRefunded: expectation.maximumTokenAmount - tokenAmount,
    });
}
/**
 * Authenticates and parses one confidential preview event without decrypting it.
 * Ciphertext decryption remains the connected wallet's responsibility.
 */
export function parseConfidentialAddLiquidityQuoteResult(expectation, receipt) {
    assertAddress(expectation.pool, "confidential pool");
    assertAddress(expectation.caller, "confidential liquidity caller");
    assertLiquiditySide(expectation.specifiedSide);
    if (!BYTES32.test(expectation.requestId) || /^0x0{64}$/i.test(expectation.requestId)) {
        throw new TypeError("Invalid confidential liquidity quote request ID");
    }
    const logs = assertReceiptTransaction(receipt, expectation.transactionHash);
    const log = uniqueEventLog(logs, expectation.pool, CONFIDENTIAL_LIQUIDITY_QUOTE_RESULT_TOPIC, "ConfidentialLiquidityQuoteResult");
    const caller = topicAddress(log.topics[1]);
    const token0Specified = topicBoolean(log.topics[3]);
    const words = dataWords(log.data, 6);
    if (log.topics.length !== 4 ||
        !caller ||
        !sameAddress(caller, expectation.caller) ||
        log.topics[2]?.toLowerCase() !== expectation.requestId.toLowerCase() ||
        token0Specified === undefined ||
        token0Specified !== liquiditySideToContractBoolean(expectation.specifiedSide) ||
        !words) {
        throw new TypeError("Confidential liquidity quote event does not match expectation");
    }
    const acceptedSpecified = Object.freeze({
        ciphertextHigh: wordUint256(words[0]),
        ciphertextLow: wordUint256(words[1]),
    });
    const counterpart = Object.freeze({
        ciphertextHigh: wordUint256(words[2]),
        ciphertextLow: wordUint256(words[3]),
    });
    const expectedLpShares = Object.freeze({
        ciphertextHigh: wordUint256(words[4]),
        ciphertextLow: wordUint256(words[5]),
    });
    for (const ciphertext of [acceptedSpecified, counterpart, expectedLpShares]) {
        if (ciphertext.ciphertextHigh === undefined ||
            ciphertext.ciphertextLow === undefined)
            throw new TypeError("Invalid confidential liquidity quote ciphertext encoding");
    }
    const acceptedAmount0 = expectation.specifiedSide === "token0"
        ? acceptedSpecified
        : counterpart;
    const acceptedAmount1 = expectation.specifiedSide === "token0"
        ? counterpart
        : acceptedSpecified;
    return Object.freeze({
        transactionHash: expectation.transactionHash,
        pool: expectation.pool,
        caller,
        requestId: expectation.requestId,
        specifiedSide: expectation.specifiedSide,
        acceptedAmount0,
        acceptedAmount1,
        expectedLpShares: expectedLpShares,
    });
}
