import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

import {
  sameFundedDeploymentBinding,
  validateFundedDeploymentBinding,
  type FundedDeploymentBinding,
} from "./funded-deployment-binding";

const SCHEMA = "cipherdex.funded-recovery/v2" as const;

export type RecoveryTransactionStatus =
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
  metadata: Readonly<Record<string, string | number | boolean>>;
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
  runStatus: "active" | "awaiting-maturity" | "passed" | "failed" | "recovery-failed";
  transactions: RecoveryTransaction[];
  resources: RecoveryResource[];
};

const RUN_STATUSES = [
  "active",
  "awaiting-maturity",
  "passed",
  "failed",
  "recovery-failed",
] as const;
const TRANSACTION_STATUSES = [
  "broadcast",
  "mined-success",
  "mined-failure",
  "outcome-unknown",
] as const;

export type ReceiptLookup = Readonly<{
  getTransactionReceipt(hash: string): Promise<null | {
    status: number | bigint | null;
    blockNumber: number;
  }>;
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

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function isAddress(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

export async function verifyRecoveryResourceCreation(
  journal: FundedRecoveryJournal,
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

  const directCreation = transaction.to === null &&
    receipt.contractAddress?.toLowerCase() === resource.address.toLowerCase();
  const addressFragment = resource.address.slice(2).toLowerCase();
  const logCreation = transaction.to !== null && (receipt.logs ?? []).some((log) =>
    log.address.toLowerCase() === transaction.to?.toLowerCase() &&
    [...log.topics, log.data].some((value) => value.toLowerCase().includes(addressFragment))
  );
  if (!directCreation && !logCreation) {
    throw new Error("funded recovery creation receipt does not identify the resource");
  }

  if (transaction.to !== null) {
    const allowedCreators = Object.entries(resource.metadata)
      .filter(([key, value]) =>
        typeof value === "string" &&
        isAddress(value) &&
        /(?:factory|migrator)Address$/i.test(key)
      )
      .map(([, value]) => String(value).toLowerCase());
    if (!allowedCreators.includes(transaction.to.toLowerCase())) {
      throw new Error("funded recovery resource was created by an unbound contract");
    }
  }
}

function isMetadata(
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
    !Array.isArray(state.resources)
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
        (!Number.isSafeInteger(transaction.blockNumber) || transaction.blockNumber < 0))
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
      !isMetadata(resource.metadata)
    ) throw new Error("funded recovery journal has an invalid resource");
    const creationTransaction = state.transactions.find((transaction) =>
      transaction.hash.toLowerCase() === resource.creationTransactionHash.toLowerCase()
    );
    if (!creationTransaction || creationTransaction.status !== "mined-success") {
      throw new Error("funded recovery resource lacks a successful creation transaction");
    }
  }
  return { ...(state as RecoveryState), deployment };
}

export class FundedRecoveryJournal {
  readonly path: string;
  private state: RecoveryState;

  private constructor(path: string, state: RecoveryState) {
    this.path = path;
    this.state = state;
  }

  static open(input: Readonly<{
    runner: string;
    sourceCommit: string;
    chainId: number;
    owner: string;
    deployment: FundedDeploymentBinding;
    directory?: string;
    resumeCompleted?: boolean;
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
    const directory = resolve(input.directory ?? ".testnet-state");
    const path = resolve(
      directory,
      `${input.runner}-${input.sourceCommit.toLowerCase()}-${deployment.recordSha256.slice(0, 16)}.json`,
    );
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      const existing = parseState(JSON.parse(readFileSync(path, "utf8")));
      if (
        existing.runner !== input.runner ||
        existing.sourceCommit.toLowerCase() !== input.sourceCommit.toLowerCase() ||
        existing.chainId !== input.chainId ||
        existing.owner.toLowerCase() !== input.owner.toLowerCase() ||
        !sameFundedDeploymentBinding(existing.deployment, deployment)
      ) throw new Error("funded recovery journal identity mismatch");
      const hasActiveResources = existing.resources.some((resource) => !resource.recovered);
      const hasUnresolvedTransactions = existing.transactions.some((transaction) =>
        transaction.status === "broadcast" || transaction.status === "outcome-unknown"
      );
      if (
        input.resumeCompleted ||
        existing.runStatus === "active" ||
        existing.runStatus === "awaiting-maturity" ||
        existing.runStatus === "recovery-failed" ||
        hasActiveResources ||
        hasUnresolvedTransactions
      ) {
        return new FundedRecoveryJournal(path, existing);
      }
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
    };
    const journal = new FundedRecoveryJournal(path, state);
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
    return this.state.transactions.map((transaction) => Object.freeze({ ...transaction }));
  }

  get activeResources(): readonly RecoveryResource[] {
    return this.resources.filter((resource) => !resource.recovered);
  }

  get runStatus(): RecoveryState["runStatus"] {
    return this.state.runStatus;
  }

  recordBroadcast(label: string, hash: string): void {
    if (!label || !isHash(hash)) throw new Error("invalid funded transaction evidence");
    const existing = this.state.transactions.find(
      (transaction) => transaction.hash.toLowerCase() === hash.toLowerCase(),
    );
    if (existing) return;
    this.state.transactions.push({ label, hash, status: "broadcast" });
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
    };
    this.persist();
  }

  recordResource(resource: Omit<RecoveryResource, "recovered">): void {
    if (
      !resource.id ||
      !resource.kind ||
      !isAddress(resource.address) ||
      !isHash(resource.creationTransactionHash) ||
      !isMetadata(resource.metadata)
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
      metadata: Object.freeze({ ...resource.metadata }),
    });
    this.persist();
  }

  markRecovered(id: string): void {
    const index = this.state.resources.findIndex((resource) => resource.id === id);
    if (index < 0) throw new Error("unknown funded recovery resource");
    this.state.resources[index] = { ...this.state.resources[index], recovered: true };
    this.persist();
  }

  updateResourceMetadata(
    id: string,
    metadata: Readonly<Record<string, string | number | boolean>>,
  ): void {
    if (!isMetadata(metadata)) throw new Error("invalid funded recovery metadata update");
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
      if (transaction.status !== "broadcast" && transaction.status !== "outcome-unknown") continue;
      const receipt = await provider.getTransactionReceipt(transaction.hash);
      if (!receipt) {
        unresolved.push(transaction.hash);
        if (transaction.status !== "outcome-unknown") {
          this.recordTransaction(transaction.hash, "outcome-unknown");
        }
        continue;
      }
      this.recordTransaction(
        transaction.hash,
        BigInt(receipt.status ?? 0) === 1n ? "mined-success" : "mined-failure",
        receipt.blockNumber,
      );
    }
    return Object.freeze(unresolved);
  }

  private persist(): void {
    this.state.updatedAt = new Date().toISOString();
    const temporaryPath = `${this.path}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporaryPath, this.path);
  }
}
