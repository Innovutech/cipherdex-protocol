import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { Interface, Transaction, getAddress, keccak256 } from "ethers";

import {
  sameFundedDeploymentBinding,
  validateFundedDeploymentBinding,
  type FundedDeploymentBinding,
} from "./funded-deployment-binding";
import {
  appendUtf8RecordIfUnchanged,
  readLatestUtf8Record,
} from "./durable-append-log.mjs";
import {
  inspectFundedTransaction,
  type FundedRpcConfirmationProvider,
  type FundedRpcTransactionIdentity,
} from "./funded-rpc-confirmation.mjs";

const SCHEMA = "cipherdex.funded-recovery/v7" as const;
const ENVELOPE_SCHEMA = "cipherdex.funded-recovery-envelope/v1" as const;
const POOL_FACTORY_INTERFACE = new Interface([
  "event PoolCreated(address indexed token0,address indexed token1,uint8 token0Decimals,uint8 token1Decimals,uint256 feeBps,address initializationStrategy,address pool)",
]);
const POOL_TERMINAL_INTERFACE = new Interface([
  "function initialized() view returns (bool)",
  "function removeLiquidity(((uint256,uint256),bytes),((uint256,uint256),bytes),((uint256,uint256),bytes),uint64)",
]);
const PROBE_TERMINAL_INTERFACE = new Interface([
  "function closed() view returns (bool)",
  "function closeAndRecover(address)",
]);
const PRIVATE_APPROVAL_INTERFACE = new Interface([
  "function approve(address,((uint256,uint256),bytes))",
]);

export type RecoveryTransactionStatus =
  | "prepared"
  | "broadcast"
  | "mined-success"
  | "mined-failure"
  | "outcome-unknown";

export type RecoveryTransaction = Readonly<{
  label: string;
  hash: string;
  status: RecoveryTransactionStatus;
  blockNumber?: number;
}>;

export type RecoveryResource = Readonly<{
  id: string;
  kind: string;
  address: string;
  creationTransactionHash: string;
  recovered: boolean;
  recoveryTransactionHashes: readonly string[];
  metadata: Readonly<Record<string, string | number | boolean>>;
}>;

export type RecoveryAllowanceObligation = Readonly<{
  id: string;
  owner: string;
  token: string;
  spender: string;
  active: boolean;
  openedAt: string;
  cleanupTransactionHashes: readonly string[];
}>;

export type RecoveryJournalProvenance = Readonly<{
  identity: Readonly<{ owner: string; chainId: number }>;
  transactions: readonly RecoveryTransaction[];
}>;

export type FundedEvidenceConstructorValue =
  | string
  | number
  | boolean
  | readonly FundedEvidenceConstructorValue[];

export type FundedEvidenceArtifactPlan = Readonly<{
  label: string;
  contractName: string;
  address: string;
  creationTransactionHash?: string;
  constructorArguments?: readonly FundedEvidenceConstructorValue[];
}>;

export type FundedEvidencePlan = Readonly<{
  configuration: Readonly<Record<string, string | number | boolean>>;
  artifacts: readonly FundedEvidenceArtifactPlan[];
  assertions: readonly string[];
  participants: readonly string[];
}>;

type RecoveryState = {
  schema: typeof SCHEMA;
  runner: string;
  sourceCommit: string;
  chainId: number;
  owner: string;
  deployment: FundedDeploymentBinding;
  startedAt: string;
  updatedAt: string;
  runStatus:
    | "active"
    | "awaiting-maturity"
    | "evidence-pending"
    | "evidence-failed"
    | "passed"
    | "failed"
    | "recovery-failed";
  transactions: StoredRecoveryTransaction[];
  resources: RecoveryResource[];
  allowanceObligations: RecoveryAllowanceObligation[];
  evidencePlan?: FundedEvidencePlan;
};

type StoredRecoveryTransaction = RecoveryTransaction & Readonly<{
  signedTransaction?: string;
}>;

type RecoveryEnvelope = Readonly<{
  schema: typeof ENVELOPE_SCHEMA;
  iv: string;
  tag: string;
  ciphertext: string;
}>;

const RUN_STATUSES = [
  "active",
  "awaiting-maturity",
  "evidence-pending",
  "evidence-failed",
  "passed",
  "failed",
  "recovery-failed",
] as const;

const TRANSACTION_HASH = /^0x[0-9a-fA-F]{64}$/u;

function parseConstructorValue(
  value: unknown,
  depth = 0,
): FundedEvidenceConstructorValue {
  if (depth > 4) throw new Error("funded constructor arguments are too deeply nested");
  if (typeof value === "string") {
    if (value.length > 2_048) throw new Error("funded constructor string is too long");
    return value;
  }
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (Array.isArray(value)) {
    if (value.length > 128) throw new Error("funded constructor array is too large");
    return Object.freeze(value.map((entry) => parseConstructorValue(entry, depth + 1)));
  }
  throw new Error("funded constructor argument is not JSON-safe");
}

export function normalizeFundedEvidenceConstructorArguments(
  value: unknown,
): readonly FundedEvidenceConstructorValue[] {
  if (!Array.isArray(value)) throw new Error("funded constructor arguments are invalid");
  return Object.freeze(value.map((entry) => parseConstructorValue(entry)));
}

function parseEvidenceArtifact(value: unknown): FundedEvidenceArtifactPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("funded recovery evidence artifact is invalid");
  }
  const artifact = value as Partial<FundedEvidenceArtifactPlan>;
  if (
    typeof artifact.label !== "string" ||
    artifact.label.length === 0 ||
    typeof artifact.contractName !== "string" ||
    artifact.contractName.length === 0 ||
    !isAddress(artifact.address)
  ) throw new Error("funded recovery evidence artifact is invalid");
  const hasHash = artifact.creationTransactionHash !== undefined;
  const hasArguments = artifact.constructorArguments !== undefined;
  if (hasHash !== hasArguments) {
    throw new Error("funded direct creation requires both transaction hash and constructor arguments");
  }
  if (hasHash) {
    if (
      typeof artifact.creationTransactionHash !== "string" ||
      !TRANSACTION_HASH.test(artifact.creationTransactionHash) ||
      !Array.isArray(artifact.constructorArguments)
    ) throw new Error("funded direct creation is invalid");
    return Object.freeze({
      label: artifact.label,
      contractName: artifact.contractName,
      address: getAddress(artifact.address),
      creationTransactionHash: artifact.creationTransactionHash.toLowerCase(),
      constructorArguments: normalizeFundedEvidenceConstructorArguments(
        artifact.constructorArguments,
      ),
    });
  }
  return Object.freeze({
    label: artifact.label,
    contractName: artifact.contractName,
    address: getAddress(artifact.address),
  });
}

function parseEvidencePlan(value: unknown): FundedEvidencePlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("funded recovery evidence plan is invalid");
  }
  const plan = value as Partial<FundedEvidencePlan>;
  if (
    !isRecoveryResourceMetadata(plan.configuration) ||
    !Array.isArray(plan.artifacts) ||
    plan.artifacts.length === 0 ||
    !Array.isArray(plan.assertions) ||
    plan.assertions.length === 0 ||
    plan.assertions.some((assertion) => typeof assertion !== "string" || assertion.length === 0) ||
    !Array.isArray(plan.participants) ||
    plan.participants.length === 0 ||
    plan.participants.some((participant) => !isAddress(participant))
  ) throw new Error("funded recovery evidence plan is invalid");
  return Object.freeze({
    configuration: Object.freeze({ ...plan.configuration }),
    artifacts: Object.freeze(plan.artifacts.map(parseEvidenceArtifact)),
    assertions: Object.freeze([...plan.assertions]),
    participants: Object.freeze(plan.participants.map((participant) => getAddress(participant))),
  });
}
const TRANSACTION_STATUSES = [
  "prepared",
  "broadcast",
  "mined-success",
  "mined-failure",
  "outcome-unknown",
] as const;

export type ReceiptLookup = FundedRpcConfirmationProvider;

export type RecoveryBroadcastProvider = ReceiptLookup & Readonly<{
  broadcastTransaction(signedTransaction: string): Promise<{ hash: string }>;
}>;

export type RecoveryProvenanceLookup = Readonly<{
  getCode(address: string): Promise<string>;
  getTransaction(hash: string): Promise<null | {
    from: string;
    to: string | null;
    chainId: bigint | number | string;
  }>;
  getTransactionReceipt(hash: string): Promise<null | {
    status: number | bigint | null;
    blockNumber: number;
    contractAddress?: string | null;
    logs?: readonly Readonly<{ address: string; topics: readonly string[]; data: string }>[];
  }>;
}>;

export type RecoveryTerminalLookup = Readonly<{
  call(transaction: Readonly<{ to: string; data: string }>): Promise<string>;
  getTransaction(hash: string): Promise<null | {
    from: string;
    to: string | null;
    chainId: bigint | number | string;
    data: string;
  }>;
  getTransactionReceipt(hash: string): Promise<null | {
    status: number | bigint | null;
    blockNumber: number;
  }>;
}>;

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function isAddress(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function preparedTransactionIdentity(
  transaction: StoredRecoveryTransaction,
  state: Pick<RecoveryState, "owner" | "chainId">,
): FundedRpcTransactionIdentity | undefined {
  if (!transaction.signedTransaction) return undefined;
  let parsed: Transaction;
  try {
    if (keccak256(transaction.signedTransaction).toLowerCase() !== transaction.hash.toLowerCase()) {
      return undefined;
    }
    parsed = Transaction.from(transaction.signedTransaction);
  } catch {
    return undefined;
  }
  const signer = parsed.from;
  const chainId = Number(parsed.chainId);
  if (
    !signer ||
    !Number.isSafeInteger(chainId) ||
    chainId !== state.chainId ||
    getAddress(signer) !== getAddress(state.owner) ||
    !Number.isSafeInteger(parsed.nonce) ||
    parsed.nonce < 0
  ) return undefined;
  return Object.freeze({
    chainId,
    signer,
    nonce: parsed.nonce,
    hash: transaction.hash,
  });
}

export async function verifyRecoveryResourceCreation(
  journal: RecoveryJournalProvenance,
  resource: RecoveryResource,
  provider: RecoveryProvenanceLookup,
): Promise<void> {
  const transactionRecord = journal.transactions.find((transaction) =>
    transaction.hash.toLowerCase() === resource.creationTransactionHash.toLowerCase()
  );
  if (!transactionRecord || transactionRecord.status !== "mined-success") {
    throw new Error("funded recovery resource has no successful creation transaction");
  }
  const [transaction, receipt, code] = await Promise.all([
    provider.getTransaction(resource.creationTransactionHash),
    provider.getTransactionReceipt(resource.creationTransactionHash),
    provider.getCode(resource.address),
  ]);
  if (
    !transaction ||
    !receipt ||
    BigInt(receipt.status ?? 0) !== 1n ||
    transaction.from.toLowerCase() !== journal.identity.owner.toLowerCase() ||
    Number(transaction.chainId) !== journal.identity.chainId ||
    code === "0x"
  ) throw new Error("funded recovery resource creation provenance is invalid");

  if (
    resource.kind === "best-execution-probe" ||
    resource.kind === "launchpad-stack" ||
    resource.kind === "disposable-contract"
  ) {
    if (
      transaction.to !== null ||
      receipt.contractAddress === undefined ||
      receipt.contractAddress === null ||
      getAddress(receipt.contractAddress) !== getAddress(resource.address)
    ) {
      throw new Error("funded recovery direct deployment provenance is invalid");
    }
    return;
  }

  if (resource.kind === "confidential-pool" || resource.kind === "fee-collection-pool") {
    const factoryAddress = requiredMetadataAddress(resource, "factoryAddress");
    if (transaction.to === null || getAddress(transaction.to) !== factoryAddress) {
      throw new Error("funded recovery pool creator is not the bound factory");
    }
    const matches = (receipt.logs ?? []).flatMap((log) => {
      if (getAddress(log.address) !== factoryAddress) return [];
      try {
        const parsed = POOL_FACTORY_INTERFACE.parseLog({ topics: [...log.topics], data: log.data });
        return parsed?.name === "PoolCreated" ? [parsed] : [];
      } catch {
        return [];
      }
    }).filter((event) =>
      getAddress(String(event.args.token0)) === requiredMetadataAddress(resource, "token0Address") &&
      getAddress(String(event.args.token1)) === requiredMetadataAddress(resource, "token1Address") &&
      Number(event.args.token0Decimals) === requiredMetadataInteger(resource, "decimals0") &&
      Number(event.args.token1Decimals) === requiredMetadataInteger(resource, "decimals1") &&
      Number(event.args.feeBps) === requiredMetadataInteger(resource, "feeBps") &&
      getAddress(String(event.args.initializationStrategy)) ===
        "0x0000000000000000000000000000000000000000" &&
      getAddress(String(event.args.pool)) === getAddress(resource.address)
    );
    if (matches.length !== 1) {
      throw new Error("funded recovery pool creation event is missing or ambiguous");
    }
    return;
  }

  if (resource.kind === "launchpad-pool") {
    const factoryAddress = requiredMetadataAddress(resource, "factoryAddress");
    const initializationStrategyAddress = requiredMetadataAddress(
      resource,
      "initializationStrategyAddress",
    );
    if (
      transaction.to === null ||
      getAddress(transaction.to) !== initializationStrategyAddress
    ) {
      throw new Error("funded recovery protected-pool creator is not the bound strategy");
    }
    const matches = (receipt.logs ?? []).flatMap((log) => {
      if (getAddress(log.address) !== factoryAddress) return [];
      try {
        const parsed = POOL_FACTORY_INTERFACE.parseLog({
          topics: [...log.topics],
          data: log.data,
        });
        return parsed?.name === "PoolCreated" ? [parsed] : [];
      } catch {
        return [];
      }
    }).filter((event) =>
      getAddress(String(event.args.token0)) === requiredMetadataAddress(resource, "token0Address") &&
      getAddress(String(event.args.token1)) === requiredMetadataAddress(resource, "token1Address") &&
      Number(event.args.token0Decimals) === requiredMetadataInteger(resource, "decimals0") &&
      Number(event.args.token1Decimals) === requiredMetadataInteger(resource, "decimals1") &&
      Number(event.args.feeBps) === requiredMetadataInteger(resource, "feeBps") &&
      getAddress(String(event.args.initializationStrategy)) === initializationStrategyAddress &&
      getAddress(String(event.args.pool)) === getAddress(resource.address)
    );
    if (matches.length !== 1) {
      throw new Error("funded recovery protected-pool creation event is missing or ambiguous");
    }
    return;
  }

  throw new Error(`unsupported funded recovery resource kind: ${resource.kind}`);
}

export async function verifyRecoveryResourceTerminalState(
  journal: RecoveryJournalProvenance,
  resource: RecoveryResource,
  provider: RecoveryTerminalLookup,
): Promise<void> {
  if (!resource.recovered || resource.recoveryTransactionHashes.length === 0) {
    throw new Error("funded recovery resource has no terminal transaction evidence");
  }
  const transactions = await Promise.all(resource.recoveryTransactionHashes.map(async (hash) => {
    const journaled = journal.transactions.find((candidate) =>
      candidate.hash.toLowerCase() === hash.toLowerCase()
    );
    if (!journaled || journaled.status !== "mined-success") {
      throw new Error("funded recovery terminal transaction is not journaled as successful");
    }
    const [transaction, receipt] = await Promise.all([
      provider.getTransaction(hash),
      provider.getTransactionReceipt(hash),
    ]);
    if (
      !transaction ||
      !receipt ||
      BigInt(receipt.status ?? 0) !== 1n ||
      getAddress(transaction.from) !== getAddress(journal.identity.owner) ||
      Number(transaction.chainId) !== journal.identity.chainId
    ) throw new Error("funded recovery terminal transaction provenance is invalid");
    return transaction;
  }));

  if (
    resource.kind === "confidential-pool" ||
    resource.kind === "fee-collection-pool" ||
    resource.kind === "launchpad-pool"
  ) {
    const removeSelector = POOL_TERMINAL_INTERFACE.getFunction("removeLiquidity")!.selector;
    const hasTerminalCall = transactions.some((transaction) =>
      transaction.to !== null &&
      getAddress(transaction.to) === getAddress(resource.address) &&
      transaction.data.slice(0, 10).toLowerCase() === removeSelector.toLowerCase()
    );
    const creationOnlyEmptyPool = resource.recoveryTransactionHashes.length === 1 &&
      resource.recoveryTransactionHashes[0].toLowerCase() ===
        resource.creationTransactionHash.toLowerCase();
    if (!hasTerminalCall && !creationOnlyEmptyPool) {
      throw new Error("funded pool recovery lacks a terminal full-exit transaction");
    }
    const result = await provider.call({
      to: resource.address,
      data: POOL_TERMINAL_INTERFACE.encodeFunctionData("initialized"),
    });
    const [initialized] = POOL_TERMINAL_INTERFACE.decodeFunctionResult("initialized", result);
    if (Boolean(initialized)) throw new Error("funded pool recovery is not terminal onchain");
    return;
  }

  if (resource.kind === "best-execution-probe") {
    const closeSelector = PROBE_TERMINAL_INTERFACE.getFunction("closeAndRecover")!.selector;
    if (!transactions.some((transaction) =>
      transaction.to !== null &&
      getAddress(transaction.to) === getAddress(resource.address) &&
      transaction.data.slice(0, 10).toLowerCase() === closeSelector.toLowerCase()
    )) throw new Error("funded probe recovery lacks its close transaction");
    const result = await provider.call({
      to: resource.address,
      data: PROBE_TERMINAL_INTERFACE.encodeFunctionData("closed"),
    });
    const [closed] = PROBE_TERMINAL_INTERFACE.decodeFunctionResult("closed", result);
    if (!Boolean(closed)) throw new Error("funded probe recovery is not terminal onchain");
    return;
  }

  if (resource.kind === "launchpad-stack") {
    const tokenAddresses = [
      requiredMetadataAddress(resource, "token0Address"),
      requiredMetadataAddress(resource, "token1Address"),
    ];
    const migratorAddress = requiredMetadataAddress(resource, "migratorAddress");
    const approveSelector = PRIVATE_APPROVAL_INTERFACE.getFunction("approve")!.selector;
    const cleanupTransactions = transactions.filter((transaction) =>
      transaction.to !== null &&
      tokenAddresses.some((address) => getAddress(transaction.to!) === address) &&
      transaction.data.slice(0, 10).toLowerCase() === approveSelector.toLowerCase()
    );
    const creationOnlyUnusedStack = resource.recoveryTransactionHashes.length === 1 &&
      resource.recoveryTransactionHashes[0].toLowerCase() ===
        resource.creationTransactionHash.toLowerCase();
    if (!creationOnlyUnusedStack) {
      for (const tokenAddress of tokenAddresses) {
        const matching = cleanupTransactions.filter((transaction) => {
          if (transaction.to === null || getAddress(transaction.to) !== tokenAddress) return false;
          try {
            const [spender] = PRIVATE_APPROVAL_INTERFACE.decodeFunctionData(
              "approve",
              transaction.data,
            );
            return getAddress(String(spender)) === migratorAddress;
          } catch {
            return false;
          }
        });
        if (matching.length === 0) {
          throw new Error(
            "funded launchpad recovery lacks a token-specific migrator allowance reset",
          );
        }
      }
    }
    return;
  }

  if (resource.kind !== "disposable-contract") {
    throw new Error(`unsupported funded recovery terminal resource ${resource.kind}`);
  }
}

function requiredMetadataAddress(resource: RecoveryResource, key: string): string {
  const value = resource.metadata[key];
  if (!isAddress(value)) throw new Error(`funded recovery resource lacks ${key}`);
  return getAddress(value);
}

function requiredMetadataInteger(resource: RecoveryResource, key: string): number {
  const value = resource.metadata[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`funded recovery resource lacks ${key}`);
  }
  return value;
}

export function isRecoveryResourceMetadata(
  value: unknown,
): value is Readonly<Record<string, string | number | boolean>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, entry]) =>
    /^[a-zA-Z][a-zA-Z0-9]*$/.test(key) &&
    (typeof entry === "string" ||
      typeof entry === "boolean" ||
      (typeof entry === "number" && Number.isSafeInteger(entry)))
  );
}

function parseState(value: unknown): RecoveryState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("funded recovery journal is not an object");
  }
  const state = value as Partial<RecoveryState>;
  if (
    state.schema !== SCHEMA ||
    typeof state.runner !== "string" ||
    !/^[a-z0-9-]+$/.test(state.runner) ||
    typeof state.sourceCommit !== "string" ||
    !/^[0-9a-f]{40}$/i.test(state.sourceCommit) ||
    !Number.isSafeInteger(state.chainId) ||
    Number(state.chainId) <= 0 ||
    !isAddress(state.owner) ||
    !state.deployment ||
    !isIsoTimestamp(state.startedAt) ||
    !isIsoTimestamp(state.updatedAt) ||
    !RUN_STATUSES.includes(state.runStatus as (typeof RUN_STATUSES)[number]) ||
    !Array.isArray(state.transactions) ||
    !Array.isArray(state.resources) ||
    !Array.isArray(state.allowanceObligations)
  ) {
    throw new Error("funded recovery journal has invalid provenance");
  }
  const deployment = validateFundedDeploymentBinding(state.deployment);
  if (deployment.sourceCommit !== state.sourceCommit.toLowerCase()) {
    throw new Error("funded recovery journal deployment source mismatch");
  }
  for (const transaction of state.transactions) {
    if (
      !transaction ||
      typeof transaction.label !== "string" ||
      transaction.label.length === 0 ||
      !isHash(transaction.hash) ||
      !TRANSACTION_STATUSES.includes(
        transaction.status as (typeof TRANSACTION_STATUSES)[number],
      ) ||
      (transaction.blockNumber !== undefined &&
        (!Number.isSafeInteger(transaction.blockNumber) || transaction.blockNumber < 0)) ||
      (transaction.signedTransaction !== undefined && (
        typeof transaction.signedTransaction !== "string" ||
        !/^0x[0-9a-fA-F]+$/.test(transaction.signedTransaction) ||
        keccak256(transaction.signedTransaction).toLowerCase() !== transaction.hash.toLowerCase()
      )) ||
      ((transaction.status === "prepared" || transaction.status === "outcome-unknown") &&
        transaction.signedTransaction === undefined)
    ) throw new Error("funded recovery journal has an invalid transaction");
  }
  for (const resource of state.resources) {
    if (
      !resource ||
      typeof resource.id !== "string" ||
      typeof resource.kind !== "string" ||
      resource.id.length === 0 ||
      resource.kind.length === 0 ||
      !isAddress(resource.address) ||
      !isHash(resource.creationTransactionHash) ||
      typeof resource.recovered !== "boolean" ||
      !Array.isArray(resource.recoveryTransactionHashes) ||
      resource.recoveryTransactionHashes.some((hash) => !isHash(hash)) ||
      (resource.recovered && resource.recoveryTransactionHashes.length === 0) ||
      !isRecoveryResourceMetadata(resource.metadata)
    ) throw new Error("funded recovery journal has an invalid resource");
    const creationTransaction = state.transactions.find((transaction) =>
      transaction.hash.toLowerCase() === resource.creationTransactionHash.toLowerCase()
    );
    if (!creationTransaction || creationTransaction.status !== "mined-success") {
      throw new Error("funded recovery resource lacks a successful creation transaction");
    }
  }
  for (const obligation of state.allowanceObligations) {
    if (
      !obligation ||
      typeof obligation.id !== "string" ||
      obligation.id.length === 0 ||
      !isAddress(obligation.owner) ||
      !isAddress(obligation.token) ||
      !isAddress(obligation.spender) ||
      typeof obligation.active !== "boolean" ||
      !isIsoTimestamp(obligation.openedAt) ||
      !Array.isArray(obligation.cleanupTransactionHashes) ||
      obligation.cleanupTransactionHashes.some((hash) => !isHash(hash))
    ) throw new Error("funded recovery journal has an invalid allowance obligation");
  }
  const evidencePlan = state.evidencePlan === undefined
    ? undefined
    : parseEvidencePlan(state.evidencePlan);
  if (
    (state.runStatus === "evidence-pending" || state.runStatus === "evidence-failed") &&
    evidencePlan === undefined
  ) throw new Error("funded recovery evidence status lacks its durable plan");
  return { ...(state as RecoveryState), deployment, evidencePlan };
}

function assertSafeJournalDirectory(directory: string): string {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("funded recovery journal directory must be a real directory");
  }
  const canonical = realpathSync(directory);
  if (realpathSync(dirname(directory)) !== dirname(canonical)) {
    throw new Error("funded recovery journal directory escapes its reviewed parent");
  }
  return canonical;
}

function normalizeRecoveryKey(value: string | Uint8Array): Buffer {
  const key = typeof value === "string"
    ? Buffer.from(value.startsWith("0x") ? value.slice(2) : value, "hex")
    : Buffer.from(value);
  if (key.length !== 32) throw new Error("funded recovery key must contain 32 bytes");
  return key;
}

function serializeEncryptedState(state: RecoveryState, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(ENVELOPE_SCHEMA, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(state), "utf8"),
    cipher.final(),
  ]);
  const envelope: RecoveryEnvelope = Object.freeze({
    schema: ENVELOPE_SCHEMA,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  });
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

function parseEncryptedState(raw: string, key: Buffer): RecoveryState {
  const value = JSON.parse(raw) as Partial<RecoveryEnvelope>;
  if (
    value.schema !== ENVELOPE_SCHEMA ||
    typeof value.iv !== "string" ||
    typeof value.tag !== "string" ||
    typeof value.ciphertext !== "string"
  ) throw new Error("funded recovery journal envelope is invalid");
  const iv = Buffer.from(value.iv, "base64");
  const tag = Buffer.from(value.tag, "base64");
  const ciphertext = Buffer.from(value.ciphertext, "base64");
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
    throw new Error("funded recovery journal envelope is invalid");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(ENVELOPE_SCHEMA, "utf8"));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return parseState(JSON.parse(plaintext.toString("utf8")));
  } catch (error) {
    throw new Error("funded recovery journal authentication failed", { cause: error });
  }
}

export class FundedRecoveryJournal {
  readonly path: string;
  private state: RecoveryState;
  private readonly recoveryKey: Buffer;
  private persistedEnvelope: string | undefined;

  private constructor(
    path: string,
    state: RecoveryState,
    recoveryKey: Buffer,
    persistedEnvelope?: string,
  ) {
    this.path = path;
    this.state = state;
    this.recoveryKey = recoveryKey;
    this.persistedEnvelope = persistedEnvelope;
  }

  static open(input: Readonly<{
    runner: string;
    sourceCommit: string;
    chainId: number;
    owner: string;
    deployment: FundedDeploymentBinding;
    recoveryKey: string | Uint8Array;
    directory?: string;
  }>): FundedRecoveryJournal {
    if (
      !/^[a-z0-9-]+$/.test(input.runner) ||
      !/^[0-9a-f]{40}$/i.test(input.sourceCommit) ||
      !Number.isSafeInteger(input.chainId) ||
      input.chainId <= 0 ||
      !isAddress(input.owner)
    ) throw new Error("invalid funded recovery journal identity");

    const deployment = validateFundedDeploymentBinding(input.deployment);
    if (deployment.sourceCommit !== input.sourceCommit.toLowerCase()) {
      throw new Error("funded recovery journal source does not match deployment");
    }
    const recoveryKey = normalizeRecoveryKey(input.recoveryKey);
    const directory = assertSafeJournalDirectory(
      resolve(input.directory ?? ".testnet-state"),
    );
    const path = resolve(
      directory,
      `${input.runner}-${input.sourceCommit.toLowerCase()}-${deployment.recordSha256.slice(0, 16)}.json`,
    );
    if (existsSync(path)) {
      const persistedEnvelope = readLatestUtf8Record(path);
      if (persistedEnvelope === undefined) {
        throw new Error("funded recovery journal contains no durable record");
      }
      const existing = parseEncryptedState(persistedEnvelope, recoveryKey);
      if (
        existing.runner !== input.runner ||
        existing.sourceCommit.toLowerCase() !== input.sourceCommit.toLowerCase() ||
        existing.chainId !== input.chainId ||
        existing.owner.toLowerCase() !== input.owner.toLowerCase() ||
        !sameFundedDeploymentBinding(existing.deployment, deployment)
      ) throw new Error("funded recovery journal identity mismatch");
      return new FundedRecoveryJournal(path, existing, recoveryKey, persistedEnvelope);
    }

    const now = new Date().toISOString();
    const state: RecoveryState = {
      schema: SCHEMA,
      runner: input.runner,
      sourceCommit: input.sourceCommit.toLowerCase(),
      chainId: input.chainId,
      owner: input.owner,
      deployment,
      startedAt: now,
      updatedAt: now,
      runStatus: "active",
      transactions: [],
      resources: [],
      allowanceObligations: [],
    };
    const journal = new FundedRecoveryJournal(path, state, recoveryKey);
    journal.persist();
    return journal;
  }

  get resources(): readonly RecoveryResource[] {
    return this.state.resources.map((resource) => Object.freeze({
      ...resource,
      metadata: Object.freeze({ ...resource.metadata }),
    }));
  }

  get identity(): Readonly<{
    runner: string;
    sourceCommit: string;
    chainId: number;
    owner: string;
    startedAt: string;
    deployment: FundedDeploymentBinding;
  }> {
    return Object.freeze({
      runner: this.state.runner,
      sourceCommit: this.state.sourceCommit,
      chainId: this.state.chainId,
      owner: this.state.owner,
      startedAt: this.state.startedAt,
      deployment: this.state.deployment,
    });
  }

  get transactions(): readonly RecoveryTransaction[] {
    return this.state.transactions.map(({ signedTransaction: _signedTransaction, ...transaction }) =>
      Object.freeze({ ...transaction })
    );
  }

  get activeResources(): readonly RecoveryResource[] {
    return this.resources.filter((resource) => !resource.recovered);
  }

  get allowanceObligations(): readonly RecoveryAllowanceObligation[] {
    return this.state.allowanceObligations.map((obligation) => Object.freeze({
      ...obligation,
      cleanupTransactionHashes: Object.freeze([...obligation.cleanupTransactionHashes]),
    }));
  }

  get activeAllowanceObligations(): readonly RecoveryAllowanceObligation[] {
    return this.allowanceObligations.filter((obligation) => obligation.active);
  }

  get runStatus(): RecoveryState["runStatus"] {
    return this.state.runStatus;
  }

  get evidencePlan(): FundedEvidencePlan | undefined {
    return this.state.evidencePlan === undefined
      ? undefined
      : parseEvidencePlan(this.state.evidencePlan);
  }

  prepareEvidence(plan: FundedEvidencePlan): void {
    if (this.activeResources.length !== 0 || this.activeAllowanceObligations.length !== 0) {
      throw new Error("funded evidence plan requires terminal resources");
    }
    if (this.state.transactions.some((transaction) =>
      transaction.status !== "mined-success" && transaction.status !== "mined-failure"
    )) throw new Error("funded evidence plan requires terminal transactions");
    const parsed = parseEvidencePlan(plan);
    if (this.state.evidencePlan !== undefined) {
      if (JSON.stringify(this.state.evidencePlan) !== JSON.stringify(parsed)) {
        throw new Error("funded evidence plan changed after paid execution");
      }
    } else {
      this.state.evidencePlan = parsed;
    }
    this.state.runStatus = "evidence-pending";
    this.persist();
  }

  recordPreparedTransaction(label: string, hash: string, signedTransaction: string): void {
    if (
      (this.state.runStatus === "passed" ||
        this.state.runStatus === "failed" ||
        this.state.runStatus === "recovery-failed") &&
      this.activeResources.length === 0 &&
      this.activeAllowanceObligations.length === 0
    ) {
      throw new Error(
        "funded recovery run is terminal; use a new source commit or explicit run identity",
      );
    }
    if (
      !label ||
      !isHash(hash) ||
      !/^0x[0-9a-fA-F]+$/.test(signedTransaction) ||
      keccak256(signedTransaction).toLowerCase() !== hash.toLowerCase()
    ) throw new Error("invalid prepared funded transaction evidence");
    const existing = this.state.transactions.find(
      (transaction) => transaction.hash.toLowerCase() === hash.toLowerCase(),
    );
    if (existing && existing.label !== label) {
      throw new Error("funded transaction hash belongs to a different operation");
    }
    if (existing) {
      if (existing.signedTransaction !== signedTransaction) {
        throw new Error("funded transaction signed payload changed");
      }
      return;
    }
    if (this.state.transactions.some((transaction) => transaction.label === label)) {
      throw new Error("funded operation label is already journaled and cannot be re-signed");
    }
    this.state.transactions.push({
      label,
      hash,
      status: "prepared",
      signedTransaction,
    });
    this.persist();
  }

  recordBroadcast(label: string, hash: string): void {
    if (!label || !isHash(hash)) throw new Error("invalid funded transaction evidence");
    const index = this.state.transactions.findIndex(
      (transaction) => transaction.hash.toLowerCase() === hash.toLowerCase(),
    );
    if (index < 0 || this.state.transactions[index].label !== label) {
      throw new Error("funded transaction was broadcast without a locally signed record");
    }
    if (this.state.transactions[index].status !== "prepared") {
      throw new Error("funded transaction broadcast state is invalid");
    }
    this.state.transactions[index] = {
      ...this.state.transactions[index],
      status: "broadcast",
    };
    this.persist();
  }

  recordObservedMinedTransaction(label: string, hash: string, blockNumber: number): void {
    if (!label || !isHash(hash) || !Number.isSafeInteger(blockNumber) || blockNumber < 0) {
      throw new Error("invalid observed funded transaction evidence");
    }
    const existing = this.state.transactions.find(
      (transaction) => transaction.hash.toLowerCase() === hash.toLowerCase(),
    );
    if (existing) {
      if (
        existing.label !== label
        || existing.status !== "mined-success"
        || existing.blockNumber !== blockNumber
      ) {
        throw new Error("observed funded transaction conflicts with the journal");
      }
      return;
    }
    if (this.state.transactions.some((transaction) => transaction.label === label)) {
      throw new Error("funded operation label is already journaled with another transaction");
    }
    this.state.transactions.push({ label, hash, status: "mined-success", blockNumber });
    this.persist();
  }

  recordTransaction(
    hash: string,
    status: Exclude<RecoveryTransactionStatus, "broadcast">,
    blockNumber?: number,
  ): void {
    if (!isHash(hash) || (blockNumber !== undefined && !Number.isSafeInteger(blockNumber))) {
      throw new Error("invalid funded transaction outcome");
    }
    const index = this.state.transactions.findIndex(
      (transaction) => transaction.hash.toLowerCase() === hash.toLowerCase(),
    );
    if (index < 0) throw new Error("funded transaction was not journaled before its outcome");
    this.state.transactions[index] = {
      ...this.state.transactions[index],
      status,
      ...(blockNumber === undefined ? {} : { blockNumber }),
      ...(
        status === "mined-success" || status === "mined-failure"
          ? { signedTransaction: undefined }
          : {}
      ),
    };
    this.persist();
  }

  recordResource(
    resource: Omit<RecoveryResource, "recovered" | "recoveryTransactionHashes">,
  ): void {
    if (
      !resource.id ||
      !resource.kind ||
      !isAddress(resource.address) ||
      !isHash(resource.creationTransactionHash) ||
      !isRecoveryResourceMetadata(resource.metadata)
    ) {
      throw new Error("invalid funded recovery resource");
    }
    const creationTransaction = this.state.transactions.find((transaction) =>
      transaction.hash.toLowerCase() === resource.creationTransactionHash.toLowerCase()
    );
    if (!creationTransaction || creationTransaction.status !== "mined-success") {
      throw new Error("funded recovery resource creation transaction is not mined-success");
    }
    const existing = this.state.resources.find((candidate) => candidate.id === resource.id);
    if (existing) {
      if (
        existing.kind !== resource.kind ||
        existing.address.toLowerCase() !== resource.address.toLowerCase() ||
        existing.creationTransactionHash.toLowerCase() !==
          resource.creationTransactionHash.toLowerCase()
      ) throw new Error("funded recovery resource identity changed");
      return;
    }
    this.state.resources.push({
      ...resource,
      recovered: false,
      recoveryTransactionHashes: [],
      metadata: Object.freeze({ ...resource.metadata }),
    });
    this.persist();
  }

  recordAllowanceObligation(input: Readonly<{
    id: string;
    owner: string;
    token: string;
    spender: string;
  }>): void {
    if (!input.id || !isAddress(input.owner) || !isAddress(input.token) || !isAddress(input.spender)) {
      throw new Error("invalid funded allowance obligation");
    }
    const index = this.state.allowanceObligations.findIndex((entry) => entry.id === input.id);
    if (index >= 0) {
      const existing = this.state.allowanceObligations[index];
      if (
        getAddress(existing.owner) !== getAddress(input.owner) ||
        getAddress(existing.token) !== getAddress(input.token) ||
        getAddress(existing.spender) !== getAddress(input.spender)
      ) throw new Error("funded allowance obligation identity changed");
      if (existing.active) return;
      this.state.allowanceObligations[index] = {
        ...existing,
        active: true,
        openedAt: new Date().toISOString(),
        cleanupTransactionHashes: [],
      };
    } else {
      this.state.allowanceObligations.push({
        id: input.id,
        owner: getAddress(input.owner),
        token: getAddress(input.token),
        spender: getAddress(input.spender),
        active: true,
        openedAt: new Date().toISOString(),
        cleanupTransactionHashes: [],
      });
    }
    this.persist();
  }

  markAllowanceCleared(id: string, cleanupTransactionHashes: readonly string[]): void {
    const index = this.state.allowanceObligations.findIndex((entry) => entry.id === id);
    if (index < 0) throw new Error("unknown funded allowance obligation");
    for (const hash of cleanupTransactionHashes) {
      if (!isHash(hash)) throw new Error("invalid funded allowance cleanup hash");
      const transaction = this.state.transactions.find((entry) =>
        entry.hash.toLowerCase() === hash.toLowerCase()
      );
      if (!transaction || transaction.status !== "mined-success") {
        throw new Error("funded allowance cleanup transaction is not mined-success");
      }
    }
    this.state.allowanceObligations[index] = {
      ...this.state.allowanceObligations[index],
      active: false,
      cleanupTransactionHashes: Object.freeze([...new Set(cleanupTransactionHashes)]),
    };
    this.persist();
  }

  markRecovered(id: string, recoveryTransactionHashes: readonly string[]): void {
    const index = this.state.resources.findIndex((resource) => resource.id === id);
    if (index < 0) throw new Error("unknown funded recovery resource");
    if (
      recoveryTransactionHashes.length === 0 ||
      recoveryTransactionHashes.some((hash) => !isHash(hash))
    ) throw new Error("funded recovery requires transaction evidence");
    for (const hash of recoveryTransactionHashes) {
      const transaction = this.state.transactions.find((candidate) =>
        candidate.hash.toLowerCase() === hash.toLowerCase()
      );
      if (!transaction || transaction.status !== "mined-success") {
        throw new Error("funded recovery transaction is not mined-success");
      }
    }
    this.state.resources[index] = {
      ...this.state.resources[index],
      recovered: true,
      recoveryTransactionHashes: Object.freeze([...new Set(recoveryTransactionHashes)]),
    };
    this.persist();
  }

  updateResourceMetadata(
    id: string,
    metadata: Readonly<Record<string, string | number | boolean>>,
  ): void {
    if (!isRecoveryResourceMetadata(metadata)) {
      throw new Error("invalid funded recovery metadata update");
    }
    const index = this.state.resources.findIndex((resource) => resource.id === id);
    if (index < 0) throw new Error("unknown funded recovery resource");
    this.state.resources[index] = {
      ...this.state.resources[index],
      metadata: Object.freeze({
        ...this.state.resources[index].metadata,
        ...metadata,
      }),
    };
    this.persist();
  }

  markRun(status: RecoveryState["runStatus"]): void {
    this.state.runStatus = status;
    this.persist();
  }

  async reconcileTransactions(provider: ReceiptLookup): Promise<readonly string[]> {
    const unresolved: string[] = [];
    for (const transaction of this.state.transactions) {
      if (
        transaction.status !== "prepared" &&
        transaction.status !== "broadcast" &&
        transaction.status !== "outcome-unknown"
      ) continue;
      const identity = preparedTransactionIdentity(transaction, this.state);
      if (!identity) {
        unresolved.push(transaction.hash);
        if (transaction.status !== "outcome-unknown") {
          this.recordTransaction(transaction.hash, "outcome-unknown");
        }
        continue;
      }
      const inspection = await inspectFundedTransaction(provider, identity);
      if (inspection.state !== "confirmed") {
        unresolved.push(transaction.hash);
        if (inspection.state === "absent" && transaction.status !== "outcome-unknown") {
          this.recordTransaction(transaction.hash, "outcome-unknown");
        }
        continue;
      }
      this.recordTransaction(
        transaction.hash,
        inspection.status === 1 ? "mined-success" : "mined-failure",
        inspection.blockNumber,
      );
    }
    return Object.freeze(unresolved);
  }

  async rebroadcastIdenticalTransaction(
    hash: string,
    provider: RecoveryBroadcastProvider,
  ): Promise<void> {
    const index = this.state.transactions.findIndex((transaction) =>
      transaction.hash.toLowerCase() === hash.toLowerCase()
    );
    const transaction = index < 0 ? undefined : this.state.transactions[index];
    if (
      !transaction ||
      (transaction.status !== "prepared" && transaction.status !== "outcome-unknown") ||
      !transaction.signedTransaction
    ) throw new Error("funded transaction is not eligible for identical rebroadcast");
    const identity = preparedTransactionIdentity(transaction, this.state);
    if (!identity) throw new Error("funded transaction signed identity is invalid");
    const inspection = await inspectFundedTransaction(provider, identity);
    if (inspection.state === "confirmed") {
      this.recordTransaction(
        transaction.hash,
        inspection.status === 1 ? "mined-success" : "mined-failure",
        inspection.blockNumber,
      );
      return;
    }
    if (inspection.state === "pending" || inspection.state === "mined-unconfirmed") {
      return;
    }
    const response = await provider.broadcastTransaction(transaction.signedTransaction);
    if (response.hash.toLowerCase() !== transaction.hash.toLowerCase()) {
      throw new Error("funded identical rebroadcast returned a different transaction hash");
    }
    this.state.transactions[index] = { ...transaction, status: "broadcast" };
    this.persist();
  }

  private persist(): void {
    this.state.updatedAt = new Date().toISOString();
    const directory = assertSafeJournalDirectory(dirname(this.path));
    if (directory !== dirname(this.path)) {
      throw new Error("funded recovery journal path changed after opening");
    }
    const nextEnvelope = serializeEncryptedState(this.state, this.recoveryKey);
    appendUtf8RecordIfUnchanged(
      this.path,
      this.persistedEnvelope,
      nextEnvelope,
    );
    this.persistedEnvelope = nextEnvelope;
  }
}
