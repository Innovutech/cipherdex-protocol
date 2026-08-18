const HASH = /^0x[0-9a-f]{64}$/iu;
const ADDRESS = /^0x[0-9a-f]{40}$/iu;
const DEFAULT_MIN_CONFIRMATIONS = 2;

function normalizedHash(value, label) {
  if (typeof value !== "string" || !HASH.test(value)) {
    throw new Error(`funded RPC ${label} is invalid`);
  }
  return value.toLowerCase();
}

function normalizedAddress(value, label) {
  if (typeof value !== "string" || !ADDRESS.test(value)) {
    throw new Error(`funded RPC ${label} is invalid`);
  }
  return value.toLowerCase();
}

function safeNumber(value, label, { positive = false } = {}) {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (
    !Number.isSafeInteger(number) ||
    number < 0 ||
    (positive && number === 0)
  ) throw new Error(`funded RPC ${label} is invalid`);
  return number;
}

function transactionHash(value) {
  return value?.hash ?? value?.transactionHash;
}

function validateExpectedIdentity(expected) {
  return Object.freeze({
    chainId: safeNumber(expected?.chainId, "expected chain ID", { positive: true }),
    signer: normalizedAddress(expected?.signer, "expected signer"),
    nonce: safeNumber(expected?.nonce, "expected nonce"),
    hash: normalizedHash(expected?.hash, "expected transaction hash"),
  });
}

export function assertFundedRpcTransactionIdentity(transaction, expected) {
  const identity = validateExpectedIdentity(expected);
  if (!transaction || typeof transaction !== "object") {
    throw new Error("funded RPC transaction evidence is unavailable");
  }
  const chainId = safeNumber(transaction.chainId, "transaction chain ID", { positive: true });
  const nonce = safeNumber(transaction.nonce, "transaction nonce");
  if (
    normalizedHash(transactionHash(transaction), "transaction hash") !== identity.hash ||
    normalizedAddress(transaction.from, "transaction sender") !== identity.signer ||
    chainId !== identity.chainId ||
    nonce !== identity.nonce
  ) throw new Error("funded RPC transaction identity does not match the locally signed transaction");
  return identity;
}

export async function inspectFundedTransaction(provider, expected, options = {}) {
  const identity = validateExpectedIdentity(expected);
  const minimumConfirmations = options.minimumConfirmations ?? DEFAULT_MIN_CONFIRMATIONS;
  if (!Number.isSafeInteger(minimumConfirmations) || minimumConfirmations < 1) {
    throw new Error("funded RPC minimum confirmations is invalid");
  }
  if (
    !provider ||
    typeof provider.getNetwork !== "function" ||
    typeof provider.getTransaction !== "function" ||
    typeof provider.getTransactionReceipt !== "function" ||
    typeof provider.getBlock !== "function" ||
    typeof provider.getBlockNumber !== "function"
  ) throw new Error("funded RPC confirmation provider is incomplete");

  const network = await provider.getNetwork();
  if (safeNumber(network?.chainId, "network chain ID", { positive: true }) !== identity.chainId) {
    throw new Error("funded RPC provider is connected to the wrong chain");
  }

  const [transaction, receipt] = await Promise.all([
    provider.getTransaction(identity.hash),
    provider.getTransactionReceipt(identity.hash),
  ]);
  if (!transaction && !receipt) return Object.freeze({ state: "absent" });
  if (!transaction) {
    throw new Error("funded RPC returned a receipt without its transaction evidence");
  }
  assertFundedRpcTransactionIdentity(transaction, identity);
  if (!receipt) return Object.freeze({ state: "pending" });

  const receiptHash = normalizedHash(transactionHash(receipt), "receipt transaction hash");
  const receiptBlockHash = normalizedHash(receipt.blockHash, "receipt block hash");
  const receiptBlockNumber = safeNumber(receipt.blockNumber, "receipt block number", {
    positive: true,
  });
  const status = safeNumber(receipt.status, "receipt status");
  if (receiptHash !== identity.hash || (status !== 0 && status !== 1)) {
    throw new Error("funded RPC receipt does not match the locally signed transaction");
  }
  if (
    normalizedHash(transaction.blockHash, "transaction block hash") !== receiptBlockHash ||
    safeNumber(transaction.blockNumber, "transaction block number", { positive: true }) !==
      receiptBlockNumber
  ) throw new Error("funded RPC transaction and receipt disagree about inclusion");

  const [block, headBlockNumber] = await Promise.all([
    provider.getBlock(receiptBlockNumber),
    provider.getBlockNumber(),
  ]);
  if (
    !block ||
    normalizedHash(block.hash, "canonical block hash") !== receiptBlockHash ||
    safeNumber(block.number, "canonical block number", { positive: true }) !== receiptBlockNumber
  ) throw new Error("funded RPC receipt is not anchored to the canonical block");
  const head = safeNumber(headBlockNumber, "head block number", { positive: true });
  if (head < receiptBlockNumber) {
    throw new Error("funded RPC head predates the transaction receipt");
  }
  const confirmations = head - receiptBlockNumber + 1;
  if (confirmations < minimumConfirmations) {
    return Object.freeze({
      state: "mined-unconfirmed",
      status,
      blockNumber: receiptBlockNumber,
      blockHash: receiptBlockHash,
      confirmations,
    });
  }
  return Object.freeze({
    state: "confirmed",
    status,
    blockNumber: receiptBlockNumber,
    blockHash: receiptBlockHash,
    confirmations,
  });
}

export const FUNDED_TRANSACTION_MINIMUM_CONFIRMATIONS = DEFAULT_MIN_CONFIRMATIONS;
