import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { Interface, getAddress } from "ethers";

import {
  sameFundedDeploymentBinding,
  validateFundedDeploymentBinding,
  type FundedDeploymentBinding,
} from "./funded-deployment-binding";

const SCHEMA = "cipherdex.funded-recovery/v3" as const;
const POOL_FACTORY_INTERFACE = new Interface([
  "event PoolCreated(address indexed token0,address indexed token1,uint8 token0Decimals,uint8 token1Decimals,uint256 feeBps,address pool)",
]);
const LAUNCHPAD_MIGRATOR_INTERFACE = new Interface([
  "event LaunchpadMigration(address indexed creator,address indexed pool)",
]);

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

export type PendingSubmission = Readonly<{
  label: string;
  startedAt: string;
}>;

export type RecoveryResource = Readonly<{
  id: string;
  kind: string;
  address: string;
  creationTransactionHash: string;
  recovered: boolean;
  metadata: Readonly<Record<string, string | number | boolean>>;
}>;

export type RecoveryJournalProvenance = Readonly<{
  identity: Readonly<{ owner: string; chainId: number }>;
  transactions: readonly RecoveryTransaction[];
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
  pendingSubmissions: PendingSubmission[];
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
      getAddress(String(event.args.pool)) === getAddress(resource.address)
    );
    if (matches.length !== 1) {
      throw new Error("funded recovery pool creation event is missing or ambiguous");
    }
    return;
  }

  if (resource.kind === "launchpad-pool") {
    const migratorAddress = requiredMetadataAddress(resource, "migratorAddress");
    if (transaction.to === null || getAddress(transaction.to) !== migratorAddress) {
      throw new Error("funded recovery launchpad creator is not the bound migrator");
    }
    const matches = (receipt.logs ?? []).flatMap((log) => {
      if (getAddress(log.address) !== migratorAddress) return [];
      try {
        const parsed = LAUNCHPAD_MIGRATOR_INTERFACE.parseLog({
          topics: [...log.topics],
          data: log.data,
        });
        return parsed?.name === "LaunchpadMigration" ? [parsed] : [];
      } catch {
        return [];
      }
    }).filter((event) =>
      getAddress(String(event.args.creator)) === getAddress(journal.identity.owner) &&
      getAddress(String(event.args.pool)) === getAddress(resource.address)
    );
    if (matches.length !== 1) {
      throw new Error("funded recovery launchpad migration event is missing or ambiguous");
    }
    return;
  }

  throw new Error(`unsupported funded recovery resource kind: ${resource.kind}`);
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
    !Array.isArray(state.pendingSubmissions) ||
    !Array.isArray(state.transactions) ||
    !Array.isArray(state.resources)
  ) {
    throw new Error("funded recovery journal has invalid provenance");
  }
  const deployment = validateFundedDeploymentBinding(state.deployment);
  if (deployment.sourceCommit !== state.sourceCommit.toLowerCase()) {
    throw new Error("funded recovery journal deployment source mismatch");
  }
  for (const submission of state.pendingSubmissions) {
    if (
      !submission ||
      typeof submission.label !== "string" ||
      submission.label.length === 0 ||
      !isIsoTimestamp(submission.startedAt)
    ) throw new Error("funded recovery journal has an invalid pending submission");
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
      !isRecoveryResourceMetadata(resource.metadata)
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
      if (existing.pendingSubmissions.length > 0) {
        throw new Error(
          "funded recovery journal contains an uncertain hashless submission; manual recovery is required",
        );
      }
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
      pendingSubmissions: [],
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

  get pendingSubmissions(): readonly PendingSubmission[] {
    return this.state.pendingSubmissions.map((submission) => Object.freeze({ ...submission }));
  }

  get activeResources(): readonly RecoveryResource[] {
    return this.resources.filter((resource) => !resource.recovered);
  }

  get runStatus(): RecoveryState["runStatus"] {
    return this.state.runStatus;
  }

  recordSubmission(label: string): void {
    if (!label) throw new Error("invalid funded submission label");
    if (this.state.pendingSubmissions.some((submission) => submission.label === label)) {
      throw new Error("funded submission is already pending");
    }
    this.state.pendingSubmissions.push({ label, startedAt: new Date().toISOString() });
    this.persist();
  }

  recordBroadcast(label: string, hash: string): void {
    if (!label || !isHash(hash)) throw new Error("invalid funded transaction evidence");
    const pendingIndex = this.state.pendingSubmissions.findIndex(
      (submission) => submission.label === label,
    );
    if (pendingIndex < 0) {
      throw new Error("funded transaction was broadcast without a pending submission marker");
    }
    const existing = this.state.transactions.find(
      (transaction) => transaction.hash.toLowerCase() === hash.toLowerCase(),
    );
    if (existing && existing.label !== label) {
      throw new Error("funded transaction hash belongs to a different operation");
    }
    if (!existing) this.state.transactions.push({ label, hash, status: "broadcast" });
    this.state.pendingSubmissions.splice(pendingIndex, 1);
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
    };
    this.persist();
  }

  recordResource(resource: Omit<RecoveryResource, "recovered">): void {
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
