import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac } from "node:crypto";
import { isAbsolute } from "node:path";

import { Wallet as CotiWallet } from "@coti-io/coti-ethers";
import {
  Wallet as EthersWallet,
  Transaction,
  getBytes,
  getBigInt,
  keccak256,
  type Provider,
  type SigningKey,
  type TransactionRequest,
  type TransactionResponse,
} from "ethers";

import {
  FundedRecoveryJournal,
} from "./funded-recovery-journal";
import type { FundedDeploymentBinding } from "./funded-deployment-binding";
import {
  recordPreparedSignerTransaction,
  recordSignerTransactionStatus,
} from "./funded-process-coordinator.mjs";

type FundedTransactionContext = Readonly<{
  label: string;
  journal: FundedRecoveryJournal;
}>;

const transactionContext = new AsyncLocalStorage<FundedTransactionContext>();

const DEFAULT_MAX_FEE_PER_GAS_WEI = 10_000_000_000n;
const DEFAULT_MAX_PRIORITY_FEE_PER_GAS_WEI = 2_000_000_000n;
const DEFAULT_MAX_TRANSACTION_FEE_WEI = 300_000_000_000_000_000n;
const RECOVERY_KEY_DOMAIN = "cipherdex-funded-recovery-key/v1";

type FundedRecoveryIdentity = Readonly<{
  runner: string;
  sourceCommit: string;
  chainId: number;
  owner: string;
  deployment: FundedDeploymentBinding;
  directory: string;
}>;

export function deriveFundedRecoveryKey(
  privateKey: string | SigningKey,
  identity: FundedRecoveryIdentity,
): Buffer {
  const keyBytes = getBytes(
    typeof privateKey === "string" ? privateKey : privateKey.privateKey,
  );
  if (keyBytes.length !== 32) throw new Error("funded wallet private key must contain 32 bytes");
  const context = JSON.stringify({
    domain: RECOVERY_KEY_DOMAIN,
    runner: identity.runner,
    sourceCommit: identity.sourceCommit.toLowerCase(),
    chainId: identity.chainId,
    owner: identity.owner.toLowerCase(),
    deployment: identity.deployment,
  });
  return createHmac("sha256", keyBytes).update(context, "utf8").digest();
}

export function openFundedRecoveryJournal(
  privateKey: string | SigningKey,
  identity: FundedRecoveryIdentity,
): FundedRecoveryJournal {
  if (!identity.directory || !isAbsolute(identity.directory)) {
    throw new Error("funded recovery state requires an explicit absolute durable directory");
  }
  return FundedRecoveryJournal.open({
    runner: identity.runner,
    sourceCommit: identity.sourceCommit,
    chainId: identity.chainId,
    owner: identity.owner,
    deployment: identity.deployment,
    directory: identity.directory,
    recoveryKey: deriveFundedRecoveryKey(privateKey, identity),
  });
}

export type FundedFeePolicy = Readonly<{
  maxFeePerGasWei: bigint;
  maxPriorityFeePerGasWei: bigint;
  maxTransactionFeeWei: bigint;
}>;

export function reviewedFundedFeePolicy(): FundedFeePolicy {
  return Object.freeze({
    maxFeePerGasWei: DEFAULT_MAX_FEE_PER_GAS_WEI,
    maxPriorityFeePerGasWei: DEFAULT_MAX_PRIORITY_FEE_PER_GAS_WEI,
    maxTransactionFeeWei: DEFAULT_MAX_TRANSACTION_FEE_WEI,
  });
}

function optionalBigInt(value: unknown, field: string): bigint | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    return getBigInt(value as Parameters<typeof getBigInt>[0]);
  } catch (error) {
    throw new Error(`funded transaction has an invalid ${field}`, { cause: error });
  }
}

export function validateFundedTransactionFeePolicy(
  transaction: TransactionRequest,
  policy: FundedFeePolicy = reviewedFundedFeePolicy(),
): void {
  const gasLimit = optionalBigInt(transaction.gasLimit, "gas limit");
  if (gasLimit === undefined || gasLimit <= 0n) {
    throw new Error("funded transaction requires a populated positive gas limit");
  }
  const gasPrice = optionalBigInt(transaction.gasPrice, "gas price");
  const maxFeePerGas = optionalBigInt(transaction.maxFeePerGas, "max fee per gas");
  const maxPriorityFeePerGas = optionalBigInt(
    transaction.maxPriorityFeePerGas,
    "max priority fee per gas",
  );
  const hasLegacyFee = gasPrice !== undefined;
  const hasEip1559Fee = maxFeePerGas !== undefined || maxPriorityFeePerGas !== undefined;
  if (hasLegacyFee === hasEip1559Fee) {
    throw new Error("funded transaction must use exactly one reviewed fee model");
  }

  let feePerGas: bigint;
  if (hasLegacyFee) {
    feePerGas = gasPrice!;
  } else {
    if (maxFeePerGas === undefined || maxPriorityFeePerGas === undefined) {
      throw new Error("funded EIP-1559 transaction requires both fee fields");
    }
    if (maxPriorityFeePerGas > maxFeePerGas) {
      throw new Error("funded transaction priority fee exceeds its maximum fee");
    }
    if (maxPriorityFeePerGas > policy.maxPriorityFeePerGasWei) {
      throw new Error("funded transaction priority fee exceeds the reviewed cap");
    }
    feePerGas = maxFeePerGas;
  }
  if (feePerGas <= 0n || feePerGas > policy.maxFeePerGasWei) {
    throw new Error("funded transaction fee per gas exceeds the reviewed cap");
  }
  if (gasLimit * feePerGas > policy.maxTransactionFeeWei) {
    throw new Error("funded transaction maximum network fee exceeds the reviewed cap");
  }
}

class PreparedFundedBroadcastError extends Error {
  readonly transactionHash: string;

  constructor(label: string, transactionHash: string, cause: unknown) {
    super(
      `${label} broadcast outcome is unknown; transactionHash=${transactionHash}; ` +
        "do not retry or re-sign automatically",
      { cause },
    );
    this.name = "PreparedFundedBroadcastError";
    this.transactionHash = transactionHash;
  }
}

type LocalSigningWallet = Readonly<{
  provider: Provider | null;
  populateTransaction(transaction: TransactionRequest): Promise<TransactionRequest>;
  signTransaction(transaction: TransactionRequest): Promise<string>;
}>;

async function sendPreparedFundedTransaction(
  wallet: LocalSigningWallet,
  transaction: TransactionRequest,
): Promise<TransactionResponse> {
  const context = transactionContext.getStore();
  if (!context) {
    throw new Error("funded transaction attempted outside its journaled submission boundary");
  }
  if (!wallet.provider) throw new Error("funded transaction wallet has no provider");

  const populated = await wallet.populateTransaction(transaction);
  validateFundedTransactionFeePolicy(populated);
  delete populated.from;
  const signedTransaction = await wallet.signTransaction(populated);
  const localHash = keccak256(signedTransaction);
  const parsed = Transaction.from(signedTransaction);
  const signer = parsed.from;
  const chainId = Number(parsed.chainId);
  if (
    !signer ||
    !Number.isSafeInteger(chainId) ||
    chainId <= 0 ||
    !Number.isSafeInteger(parsed.nonce) ||
    parsed.nonce < 0 ||
    chainId !== context.journal.identity.chainId
  ) throw new Error("funded signed transaction identity is invalid");

  recordPreparedSignerTransaction({
    chainId,
    signer,
    nonce: parsed.nonce,
    hash: localHash,
  });

  // The signed payload is retained only in the mode-0600 recovery journal and is
  // deliberately excluded from public evidence. This write must complete before RPC submission.
  context.journal.recordPreparedTransaction(
    context.label,
    localHash,
    signedTransaction,
  );

  try {
    const response = await wallet.provider.broadcastTransaction(signedTransaction);
    if (response.hash.toLowerCase() !== localHash.toLowerCase()) {
      throw new Error("RPC returned a transaction hash that differs from the signed payload");
    }
    context.journal.recordBroadcast(context.label, localHash);
    recordSignerTransactionStatus(chainId, signer, localHash, "broadcast");
    return response;
  } catch (error) {
    context.journal.recordTransaction(localHash, "outcome-unknown");
    recordSignerTransactionStatus(chainId, signer, localHash, "outcome-unknown");
    throw new PreparedFundedBroadcastError(context.label, localHash, error);
  }
}

export class FundedWallet extends EthersWallet {
  constructor(privateKey: string | SigningKey, provider?: Provider | null) {
    super(privateKey, provider);
  }

  override sendTransaction(transaction: TransactionRequest): Promise<TransactionResponse> {
    return sendPreparedFundedTransaction(this, transaction);
  }
}

export class FundedCotiWallet extends CotiWallet {
  override sendTransaction(transaction: TransactionRequest): Promise<TransactionResponse> {
    return sendPreparedFundedTransaction(this, transaction);
  }
}

export async function withFundedTransactionEvidence<T>(
  label: string,
  journal: FundedRecoveryJournal,
  operation: () => Promise<T>,
): Promise<T> {
  if (!label) throw new Error("funded transaction label is required");
  if (transactionContext.getStore()) {
    throw new Error("nested funded transaction evidence boundaries are not supported");
  }
  return transactionContext.run(Object.freeze({ label, journal }), operation);
}
