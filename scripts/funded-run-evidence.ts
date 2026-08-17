import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { getAddress, keccak256, toUtf8Bytes } from "ethers";

import { FundedRecoveryJournal } from "./funded-recovery-journal";
import {
  sameFundedDeploymentBinding,
  validateFundedDeploymentBinding,
  type FundedDeploymentBinding,
} from "./funded-deployment-binding";
import {
  verifyDeployedRuntimeArtifactWithProvenance,
  type RuntimeArtifactProvenance,
} from "./runtime-artifact";

const SCHEMA = "cipherdex.funded-run-evidence/v2" as const;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const SOURCE_COMMIT = /^[0-9a-f]{40}$/;
const LABEL = /^[a-zA-Z0-9][a-zA-Z0-9 .:_+\-/()]{0,159}$/;
const RUNNER_SOURCES = Object.freeze<Record<string, string>>({
  "best-execution-feasibility": "scripts/testnet-best-execution-feasibility.ts",
  "best-execution": "scripts/testnet-best-execution.ts",
  "fee-collection": "scripts/testnet-fee-collection.ts",
  "launchpad": "scripts/testnet-launchpad.ts",
  "evidence-test": "test/unit/FundedRunEvidence.spec.ts",
});
const SELECTOR = Object.freeze({
  probeQuote: "0x0b6f808f",
  probeSwap: "0x7cbe798d",
  closeAndRecover: "0xcb9648a1",
  bestQuote: "0x440bde4a",
  bestSwap: "0x310481d3",
  collectProtocolFees: "0x1609fa07",
  confidentialSwap: "0xa33cffc4",
  removeLiquidity: "0x1928ed0a",
  launchpadMigrate: "0x97173c02",
  launchpadMigrateWithDisposition: "0xdd80f5fd",
  mockDeployment: "0x60a06040",
} as const);

type RequiredTransactionPolicy = Readonly<{
  label: RegExp;
  status: 0 | 1;
  targetArtifactLabel: string;
  selectors: readonly string[];
  minimumCount?: number;
}>;

type RunnerPolicy = Readonly<{
  configurationKeys: readonly string[];
  assertions: readonly string[];
  artifacts: Readonly<Record<string, number>>;
  requiredTransactions: readonly RequiredTransactionPolicy[];
}>;

const RUNNER_POLICIES = Object.freeze<Record<string, RunnerPolicy>>({
  "best-execution-feasibility": {
    configurationKeys: [
      "candidateCount", "chainId", "protocolVersion", "quoteTransport", "reviewedFactory",
      "reviewedFeeVault", "reviewedRouter", "tokenIn", "tokenOut",
    ],
    assertions: [
      "caller-bound GT reused across two pool contracts",
      "winning encrypted output privately selected",
      "quote-only path preserved private balances",
      "atomic escrow settled through selected pool",
      "temporary allowances cleared",
      "disposable probes closed with zero residue",
    ],
    artifacts: { MpcBestExecutionPoolProbe: 2, MpcBestExecutionRouterProbe: 1 },
    requiredTransactions: [
      { label: /^cross-contract GT quote and private selection$/, status: 1, targetArtifactLabel: "GT router probe", selectors: [SELECTOR.probeQuote] },
      { label: /^atomic selected-pool settlement$/, status: 1, targetArtifactLabel: "GT router probe", selectors: [SELECTOR.probeSwap] },
      { label: /^pool probe 0 closure and recovery$/, status: 1, targetArtifactLabel: "GT pool probe 0", selectors: [SELECTOR.closeAndRecover] },
      { label: /^pool probe 1 closure and recovery$/, status: 1, targetArtifactLabel: "GT pool probe 1", selectors: [SELECTOR.closeAndRecover] },
      { label: /^router probe closure and recovery$/, status: 1, targetArtifactLabel: "GT router probe", selectors: [SELECTOR.closeAndRecover] },
    ],
  },
  "best-execution": {
    configurationKeys: [
      "candidateTiers", "chainId", "confidentialPoolVersion", "feeBeneficiary",
      "privacyMode", "quoteTransport", "routerVersion", "tokenA", "tokenB",
    ],
    assertions: [
      "canonical candidates resolved from factory",
      "paid quote selected best encrypted output",
      "deterministic lower-tier tie break enforced",
      "quote-only pool state remained unchanged",
      "quote and settlement output parity enforced",
      "both swap directions exercised",
      "all approved fee tiers exercised",
      "request replay caller and deadline guards enforced",
      "slippage failure rolled back atomically",
      "router escrow and allowances returned to zero",
      "full LP exits used positive modeled minima",
      "disposable pools recovered with zero residue",
    ],
    artifacts: {
      CipherDEXFeeVault: 1,
      PrivateLPTokenFactory: 1,
      ConfidentialCPMMFactory: 1,
      ConfidentialBestExecutionRouter: 1,
      ConfidentialCPMM: 3,
      PrivateLPToken: 3,
    },
    requiredTransactions: [
      { label: /^best quote request-id replay$/, status: 0, targetArtifactLabel: "disposable best execution router", selectors: [SELECTOR.bestQuote] },
      { label: /^best quote ciphertext replay$/, status: 0, targetArtifactLabel: "disposable best execution router", selectors: [SELECTOR.bestQuote] },
      { label: /^best quote expired deadline$/, status: 0, targetArtifactLabel: "disposable best execution router", selectors: [SELECTOR.bestQuote] },
      { label: /^caller-bound ciphertext isolation$/, status: 0, targetArtifactLabel: "disposable best execution router", selectors: [SELECTOR.bestQuote] },
      { label: / encrypted slippage rollback$/, status: 0, targetArtifactLabel: "disposable best execution router", selectors: [SELECTOR.bestSwap] },
      { label: /^three-candidate quote$/, status: 1, targetArtifactLabel: "disposable best execution router", selectors: [SELECTOR.bestQuote] },
      { label: /^three-candidate quote-plus-swap$/, status: 1, targetArtifactLabel: "disposable best execution router", selectors: [SELECTOR.bestSwap] },
      { label: /^reverse three-candidate quote-plus-swap$/, status: 1, targetArtifactLabel: "disposable best execution router", selectors: [SELECTOR.bestSwap] },
    ],
  },
  "fee-collection": {
    configurationKeys: [
      "chainId", "collectionDelaySeconds", "confidentialPoolVersion", "feeBeneficiary",
      "privacyMode", "targetSwapCountPerDirection", "tokenA", "tokenB", "totalFeeBps",
    ],
    assertions: [
      "exact fee batches accrued in both input tokens",
      "maturity gate enforced before collection",
      "two aggregate protocol fee deposits verified",
      "terminal sub-threshold fee deposited on full exit",
      "protocol fees excluded from effective reserves",
      "full LP exit used positive modeled minima",
      "pool balances and owner allowances returned to zero",
      "reviewed deployment contracts were not mutated",
    ],
    artifacts: {
      CipherDEXFeeVault: 1,
      PrivateLPTokenFactory: 1,
      ConfidentialCPMMFactory: 1,
      ConfidentialCPMM: 1,
      PrivateLPToken: 1,
    },
    requiredTransactions: [
      { label: /^mature confidential protocol fee collection$/, status: 1, targetArtifactLabel: "disposable confidential fee pool", selectors: [SELECTOR.collectProtocolFees] },
      { label: /^terminal sub-threshold fee swap$/, status: 1, targetArtifactLabel: "disposable confidential fee pool", selectors: [SELECTOR.confidentialSwap] },
      { label: /^full disposable fee-pool exit$/, status: 1, targetArtifactLabel: "disposable confidential fee pool", selectors: [SELECTOR.removeLiquidity] },
    ],
  },
  "launchpad": {
    configurationKeys: [
      "chainId", "confidentialPoolVersion", "disposition", "feeBeneficiary", "feeBps",
      "launchpadMigratorVersion", "privacyMode", "tokenA", "tokenB",
    ],
    assertions: [
      "empty canonical pool slot verified",
      "price-bound failure rolled back atomically",
      "launchpad migration used canonical pool",
      "LP disposition and lock state verified",
      "replay protection rolled back atomically",
      "private balances and allowances recovered",
      "disposable launchpad pool recovered with zero residue",
    ],
    artifacts: {
      CipherDEXFeeVault: 1,
      PrivateLPTokenFactory: 1,
      ConfidentialCPMMFactory: 1,
      ConfidentialLaunchpadMigrator: 1,
      ConfidentialCPMM: 1,
      PrivateLPToken: 1,
    },
    requiredTransactions: [
      { label: /^rejected launchpad price-bound probe$/, status: 0, targetArtifactLabel: "disposable launchpad migrator", selectors: [SELECTOR.launchpadMigrate, SELECTOR.launchpadMigrateWithDisposition] },
      { label: /^atomic launchpad migration$/, status: 1, targetArtifactLabel: "disposable launchpad migrator", selectors: [SELECTOR.launchpadMigrate, SELECTOR.launchpadMigrateWithDisposition] },
      { label: /^launchpad replay probe$/, status: 0, targetArtifactLabel: "disposable launchpad migrator", selectors: [SELECTOR.launchpadMigrate, SELECTOR.launchpadMigrateWithDisposition] },
      { label: /^full disposable launchpad-pool exit$/, status: 1, targetArtifactLabel: "disposable launchpad pool", selectors: [SELECTOR.removeLiquidity] },
    ],
  },
  "evidence-test": {
    configurationKeys: ["chainId", "privacyMode", "protocolVersion"],
    assertions: ["deployment mined", "resource recovered"],
    artifacts: { MockERC20: 1 },
    requiredTransactions: [{ label: /^mock deployment$/, status: 1, targetArtifactLabel: "mock token", selectors: [SELECTOR.mockDeployment] }],
  },
});

type PublicConfigurationValue = string | number | boolean;
export type PublicConfiguration = Readonly<Record<string, PublicConfigurationValue>>;

export type FundedEvidenceProvider = Readonly<{
  getCode(address: string): Promise<string>;
  getTransactionReceipt(hash: string): Promise<null | {
    hash: string;
    status: number | bigint | null;
    blockNumber: number;
    blockHash: string;
    gasUsed: bigint | number | string;
    contractAddress: string | null;
    logs: readonly Readonly<{ address: string; topics: readonly string[]; data: string }>[];
  }>;
  getTransaction(hash: string): Promise<null | {
    hash: string;
    from: string;
    to: string | null;
    chainId: bigint | number | string;
    data: string;
    value: bigint | number | string;
  }>;
  getBlock(block: number | string): Promise<null | { hash: string | null }>;
}>;

export type FundedRunEvidence = Readonly<{
  schema: typeof SCHEMA;
  runner: string;
  runnerSource: string;
  runnerSourceSha256: string;
  sourceCommit: string;
  chainId: number;
  owner: string;
  participants: readonly string[];
  deployment: FundedDeploymentBinding;
  startedAt: string;
  generatedAt: string;
  configuration: PublicConfiguration;
  configurationHash: string;
  artifacts: readonly Readonly<RuntimeArtifactProvenance & {
    label: string;
    address: string;
  }>[];
  transactions: readonly Readonly<{
    label: string;
    hash: string;
    status: 0 | 1;
    blockNumber: number;
    blockHash: string;
    gasUsed: string;
    from: string;
    to: string | null;
    chainId: number;
    calldataHash: string;
    selector: string;
    value: string;
    contractAddress: string | null;
    logsHash: string;
    logCount: number;
  }>[];
  recoveredResources: readonly Readonly<{
    id: string;
    kind: string;
    address: string;
    creationTransactionHash: string;
  }>[];
  assertions: readonly string[];
  outcome: "passed";
}>;

function isPublicConfiguration(value: unknown): value is PublicConfiguration {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, entry]) =>
    /^[a-zA-Z][a-zA-Z0-9]*$/.test(key) &&
    (typeof entry === "string" ||
      typeof entry === "boolean" ||
      (typeof entry === "number" && Number.isSafeInteger(entry)))
  );
}

function canonicalConfiguration(configuration: PublicConfiguration): PublicConfiguration {
  if (!isPublicConfiguration(configuration)) {
    throw new Error("funded evidence contains invalid public configuration");
  }
  return Object.freeze(Object.fromEntries(
    Object.entries(configuration).sort(([left], [right]) => left.localeCompare(right)),
  ));
}

function configurationHash(configuration: PublicConfiguration): string {
  return keccak256(toUtf8Bytes(JSON.stringify(configuration)));
}

function receiptLogsHash(
  logs: readonly Readonly<{ address: string; topics: readonly string[]; data: string }>[],
): string {
  const canonical = logs.map((log) => ({
    address: getAddress(log.address),
    topics: log.topics.map((topic) => requireHash(topic, "log topic")),
    data: log.data.toLowerCase(),
  }));
  return keccak256(toUtf8Bytes(JSON.stringify(canonical)));
}

function requireRunnerPolicy(
  runner: string,
  configuration: PublicConfiguration,
  artifacts: readonly Readonly<{ label: string; contractName: string; address: string }>[],
  assertions: readonly string[],
  transactions: readonly Readonly<{
    label: string;
    status: 0 | 1;
    selector: string;
    to: string | null;
    contractAddress: string | null;
  }>[],
): void {
  const policy = RUNNER_POLICIES[runner];
  if (!policy) throw new Error("funded runner has no semantic evidence policy");
  const actualKeys = Object.keys(configuration).sort();
  const expectedKeys = [...policy.configurationKeys].sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error("funded evidence configuration does not match runner policy");
  }
  if (JSON.stringify(assertions) !== JSON.stringify(policy.assertions)) {
    throw new Error("funded evidence assertions do not match runner policy");
  }
  const counts: Record<string, number> = {};
  for (const artifact of artifacts) counts[artifact.contractName] = (counts[artifact.contractName] ?? 0) + 1;
  if (JSON.stringify(Object.entries(counts).sort()) !== JSON.stringify(Object.entries(policy.artifacts).sort())) {
    throw new Error("funded evidence artifacts do not match runner policy");
  }
  for (const requirement of policy.requiredTransactions) {
    const targets = artifacts.filter((artifact) =>
      artifact.label === requirement.targetArtifactLabel
    );
    if (targets.length !== 1) {
      throw new Error("funded evidence policy target is missing or ambiguous");
    }
    const expectedTarget = getAddress(targets[0].address).toLowerCase();
    const matches = transactions.filter((transaction) => {
      const actualTarget = transaction.to ?? transaction.contractAddress;
      return transaction.status === requirement.status &&
        requirement.label.test(transaction.label) &&
        requirement.selectors.includes(transaction.selector.toLowerCase()) &&
        actualTarget !== null &&
        getAddress(actualTarget).toLowerCase() === expectedTarget;
    });
    if (matches.length < (requirement.minimumCount ?? 1)) {
      throw new Error("funded evidence lacks a selector-bound semantic transaction");
    }
  }
}

function requireTransactionBindings(
  configuration: PublicConfiguration,
  artifacts: readonly Readonly<{ address: string }>[],
  transactions: readonly Readonly<{
    label: string;
    to: string | null;
    contractAddress: string | null;
  }>[],
): void {
  const artifactAddresses = new Set(
    artifacts.map((artifact) => getAddress(artifact.address).toLowerCase()),
  );
  const allowedTargets = new Set(artifactAddresses);
  for (const value of Object.values(configuration)) {
    if (typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)) {
      allowedTargets.add(getAddress(value).toLowerCase());
    }
  }
  for (const transaction of transactions) {
    if (transaction.to === null) {
      if (
        transaction.contractAddress === null ||
        !artifactAddresses.has(transaction.contractAddress.toLowerCase())
      ) throw new Error(`funded deployment is not bound to an artifact: ${transaction.label}`);
    } else if (!allowedTargets.has(transaction.to.toLowerCase())) {
      throw new Error(`funded transaction target is not reviewed: ${transaction.label}`);
    }
  }
}

function requireLabel(label: string, kind: string): string {
  if (!LABEL.test(label)) throw new Error(`invalid funded evidence ${kind}`);
  return label;
}

function requireHash(hash: string, kind: string): string {
  if (!HASH.test(hash)) throw new Error(`invalid funded evidence ${kind}`);
  return hash.toLowerCase();
}

function requireIsoTimestamp(value: string, kind: string): string {
  if (Number.isNaN(Date.parse(value))) throw new Error(`invalid funded evidence ${kind}`);
  return value;
}

function parseEvidence(value: unknown): FundedRunEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("funded run evidence is not an object");
  }
  const record = value as Partial<FundedRunEvidence>;
  if (
    record.schema !== SCHEMA ||
    typeof record.runner !== "string" ||
    !/^[a-z0-9-]+$/.test(record.runner) ||
    typeof record.runnerSource !== "string" ||
    !/^(?:scripts|test\/unit)\/[a-zA-Z0-9.-]+\.ts$/.test(
      record.runnerSource.replaceAll("\\", "/"),
    ) ||
    typeof record.runnerSourceSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.runnerSourceSha256) ||
    typeof record.sourceCommit !== "string" ||
    !SOURCE_COMMIT.test(record.sourceCommit) ||
    !Number.isSafeInteger(record.chainId) ||
    Number(record.chainId) <= 0 ||
    typeof record.owner !== "string" ||
    !Array.isArray(record.participants) ||
    !record.deployment ||
    typeof record.startedAt !== "string" ||
    typeof record.generatedAt !== "string" ||
    !isPublicConfiguration(record.configuration) ||
    typeof record.configurationHash !== "string" ||
    !HASH.test(record.configurationHash) ||
    !Array.isArray(record.artifacts) ||
    !Array.isArray(record.transactions) ||
    !Array.isArray(record.recoveredResources) ||
    !Array.isArray(record.assertions) ||
    record.outcome !== "passed"
  ) throw new Error("funded run evidence has invalid provenance");

  const normalizedOwner = getAddress(record.owner);
  const participants = record.participants.map((participant) => getAddress(participant));
  if (
    participants.length === 0 ||
    new Set(participants.map((participant) => participant.toLowerCase())).size !== participants.length ||
    !participants.some((participant) => participant.toLowerCase() === normalizedOwner.toLowerCase())
  ) throw new Error("funded evidence has invalid participants");
  const deployment = validateFundedDeploymentBinding(record.deployment);
  if (deployment.sourceCommit !== record.sourceCommit.toLowerCase()) {
    throw new Error("funded evidence deployment source mismatch");
  }
  requireIsoTimestamp(record.startedAt, "start timestamp");
  requireIsoTimestamp(record.generatedAt, "generation timestamp");
  const canonical = canonicalConfiguration(record.configuration);
  if (configurationHash(canonical) !== record.configurationHash.toLowerCase()) {
    throw new Error("funded evidence configuration hash does not match its public configuration");
  }

  const artifactKeys = new Set<string>();
  for (const artifact of record.artifacts) {
    if (
      !artifact ||
      typeof artifact.label !== "string" ||
      typeof artifact.contractName !== "string" ||
      typeof artifact.sourceName !== "string" ||
      typeof artifact.address !== "string" ||
      typeof artifact.runtimeCodehash !== "string" ||
      typeof artifact.compilerInputHash !== "string" ||
      typeof artifact.solcVersion !== "string" ||
      typeof artifact.solcLongVersion !== "string" ||
      !artifact.settings ||
      typeof artifact.settings.viaIR !== "boolean" ||
      !artifact.settings.optimizer ||
      typeof artifact.settings.optimizer.enabled !== "boolean"
    ) throw new Error("funded run evidence has an invalid artifact");
    requireLabel(artifact.label, "artifact label");
    getAddress(artifact.address);
    requireHash(artifact.runtimeCodehash, "runtime code hash");
    requireHash(artifact.compilerInputHash, "compiler input hash");
    const key = `${artifact.contractName}:${artifact.address.toLowerCase()}`;
    if (artifactKeys.has(key)) throw new Error("funded run evidence repeats an artifact");
    artifactKeys.add(key);
  }
  if (artifactKeys.size === 0) throw new Error("funded run evidence has no runtime artifacts");

  const transactionHashes = new Set<string>();
  for (const transaction of record.transactions) {
    if (
      !transaction ||
      typeof transaction.label !== "string" ||
      typeof transaction.hash !== "string" ||
      (transaction.status !== 0 && transaction.status !== 1) ||
      !Number.isSafeInteger(transaction.blockNumber) ||
      transaction.blockNumber < 0 ||
      typeof transaction.blockHash !== "string" ||
      typeof transaction.gasUsed !== "string" ||
      !/^\d+$/.test(transaction.gasUsed) ||
      typeof transaction.from !== "string" ||
      (transaction.to !== null && typeof transaction.to !== "string") ||
      !Number.isSafeInteger(transaction.chainId) ||
      transaction.chainId !== record.chainId ||
      typeof transaction.calldataHash !== "string" ||
      typeof transaction.selector !== "string" ||
      !/^(?:0x|0x[0-9a-fA-F]{8})$/.test(transaction.selector) ||
      typeof transaction.value !== "string" ||
      !/^\d+$/.test(transaction.value) ||
      (transaction.contractAddress !== null && typeof transaction.contractAddress !== "string") ||
      typeof transaction.logsHash !== "string" ||
      !Number.isSafeInteger(transaction.logCount) ||
      transaction.logCount < 0
    ) throw new Error("funded run evidence has an invalid transaction");
    requireLabel(transaction.label, "transaction label");
    const hash = requireHash(transaction.hash, "transaction hash");
    requireHash(transaction.blockHash, "block hash");
    getAddress(transaction.from);
    if (!participants.some((participant) =>
      participant.toLowerCase() === transaction.from.toLowerCase()
    )) throw new Error("funded evidence transaction sender is not a reviewed participant");
    if (transaction.to !== null) getAddress(transaction.to);
    if (transaction.contractAddress !== null) getAddress(transaction.contractAddress);
    requireHash(transaction.calldataHash, "calldata hash");
    requireHash(transaction.logsHash, "logs hash");
    if (transactionHashes.has(hash)) throw new Error("funded run evidence repeats a transaction");
    transactionHashes.add(hash);
  }
  if (transactionHashes.size === 0) throw new Error("funded run evidence has no transactions");

  for (const resource of record.recoveredResources) {
    if (
      !resource ||
      typeof resource.id !== "string" ||
      typeof resource.kind !== "string" ||
      typeof resource.address !== "string"
      || typeof resource.creationTransactionHash !== "string"
    ) throw new Error("funded run evidence has an invalid recovered resource");
    requireLabel(resource.id, "resource id");
    requireLabel(resource.kind, "resource kind");
    getAddress(resource.address);
    requireHash(resource.creationTransactionHash, "resource creation transaction");
    const creation = record.transactions.find((transaction) =>
      transaction.hash.toLowerCase() === resource.creationTransactionHash.toLowerCase()
    );
    if (!creation || creation.status !== 1) {
      throw new Error("funded evidence resource lacks a successful creation transaction");
    }
  }
  const assertions = record.assertions.map((assertion) =>
    requireLabel(assertion, "assertion label")
  );
  if (assertions.length === 0 || new Set(assertions).size !== assertions.length) {
    throw new Error("funded run evidence requires unique assertions");
  }
  requireRunnerPolicy(record.runner, canonical, record.artifacts, assertions, record.transactions);
  requireTransactionBindings(canonical, record.artifacts, record.transactions);

  return Object.freeze({
    ...(record as FundedRunEvidence),
    owner: normalizedOwner,
    participants: Object.freeze(participants),
    deployment,
    configuration: canonical,
  });
}

export function readFundedRunEvidence(path: string): FundedRunEvidence {
  return validateFundedRunEvidence(JSON.parse(readFileSync(resolve(path), "utf8")));
}

export function validateFundedRunEvidence(value: unknown): FundedRunEvidence {
  return parseEvidence(value);
}

export async function verifyFundedRunEvidence(
  evidence: FundedRunEvidence,
  provider: FundedEvidenceProvider,
): Promise<void> {
  const parsed = parseEvidence(evidence);
  const currentSourceHash = createHash("sha256")
    .update(readFileSync(resolve(parsed.runnerSource)))
    .digest("hex");
  if (currentSourceHash !== parsed.runnerSourceSha256) {
    throw new Error("funded evidence runner source changed");
  }
  for (const artifact of parsed.artifacts) {
    const actual = await verifyDeployedRuntimeArtifactWithProvenance(
      artifact.contractName,
      artifact.address,
      provider,
    );
    if (JSON.stringify(actual) !== JSON.stringify({
      contractName: artifact.contractName,
      sourceName: artifact.sourceName,
      runtimeCodehash: artifact.runtimeCodehash,
      compilerInputHash: artifact.compilerInputHash,
      solcVersion: artifact.solcVersion,
      solcLongVersion: artifact.solcLongVersion,
      settings: artifact.settings,
    })) throw new Error(`funded evidence artifact changed: ${artifact.label}`);
  }
  for (const transaction of parsed.transactions) {
    const [receipt, actualTransaction] = await Promise.all([
      provider.getTransactionReceipt(transaction.hash),
      provider.getTransaction(transaction.hash),
    ]);
    if (!receipt || !actualTransaction) {
      throw new Error(`funded evidence transaction is unavailable: ${transaction.label}`);
    }
    const receiptStatus = BigInt(receipt.status ?? -1);
    const block = await provider.getBlock(receipt.blockNumber);
    if (
      receipt.hash.toLowerCase() !== transaction.hash.toLowerCase() ||
      receiptStatus !== BigInt(transaction.status) ||
      receipt.blockNumber !== transaction.blockNumber ||
      receipt.blockHash.toLowerCase() !== transaction.blockHash.toLowerCase() ||
      BigInt(receipt.gasUsed).toString() !== transaction.gasUsed ||
      getAddress(actualTransaction.from) !== transaction.from ||
      (actualTransaction.to === null ? null : getAddress(actualTransaction.to)) !== transaction.to ||
      Number(actualTransaction.chainId) !== transaction.chainId ||
      keccak256(actualTransaction.data) !== transaction.calldataHash ||
      (actualTransaction.data.length >= 10 ? actualTransaction.data.slice(0, 10).toLowerCase() : "0x") !== transaction.selector ||
      BigInt(actualTransaction.value).toString() !== transaction.value ||
      (receipt.contractAddress === null ? null : getAddress(receipt.contractAddress)) !== transaction.contractAddress ||
      receiptLogsHash(receipt.logs) !== transaction.logsHash ||
      receipt.logs.length !== transaction.logCount ||
      !block?.hash ||
      block.hash.toLowerCase() !== transaction.blockHash.toLowerCase()
    ) throw new Error(`funded evidence receipt changed: ${transaction.label}`);
  }
  for (const resource of parsed.recoveredResources) {
    const transaction = parsed.transactions.find((candidate) =>
      candidate.hash === resource.creationTransactionHash.toLowerCase()
    );
    if (!transaction || transaction.status !== 1) {
      throw new Error(`funded resource creation is not proven: ${resource.id}`);
    }
    const addressFragment = resource.address.slice(2).toLowerCase();
    const receipt = await provider.getTransactionReceipt(transaction.hash);
    if (!receipt) throw new Error(`funded resource receipt is unavailable: ${resource.id}`);
    const createdDirectly = transaction.contractAddress?.toLowerCase() === resource.address.toLowerCase();
    const referencedByLogs = receipt.logs.some((log) =>
      [...log.topics, log.data].some((value) => value.toLowerCase().includes(addressFragment))
    );
    if (!createdDirectly && !referencedByLogs) {
      throw new Error(`funded resource creation receipt does not identify resource: ${resource.id}`);
    }
  }
}

export async function writeFundedRunEvidence(input: Readonly<{
  journal: FundedRecoveryJournal;
  provider: FundedEvidenceProvider;
  configuration: PublicConfiguration;
  artifacts: readonly Readonly<{
    label: string;
    contractName: string;
    address: string;
  }>[];
  assertions: readonly string[];
  participants: readonly string[];
  directory?: string;
}>): Promise<Readonly<{ path: string; evidence: FundedRunEvidence }>> {
  if (input.journal.runStatus !== "passed") {
    throw new Error("funded run must be marked passed before producing evidence");
  }
  if (input.journal.activeResources.length !== 0) {
    throw new Error("funded run cannot produce evidence before resource recovery");
  }
  if (input.journal.transactions.some((transaction) =>
    transaction.status !== "mined-success" && transaction.status !== "mined-failure"
  )) {
    throw new Error("funded run cannot produce evidence with unresolved transactions");
  }
  const identity = input.journal.identity;
  const runnerSource = RUNNER_SOURCES[identity.runner];
  if (!runnerSource) throw new Error("funded runner has no reviewed source binding");
  const runnerSourceSha256 = createHash("sha256")
    .update(readFileSync(resolve(runnerSource)))
    .digest("hex");
  const configuration = canonicalConfiguration(input.configuration);
  const participants = input.participants.map((participant) => getAddress(participant));
  if (
    participants.length === 0 ||
    new Set(participants.map((participant) => participant.toLowerCase())).size !== participants.length ||
    !participants.some((participant) => participant.toLowerCase() === identity.owner.toLowerCase())
  ) throw new Error("funded run participants are invalid");
  const artifacts = [];
  for (const artifact of input.artifacts) {
    requireLabel(artifact.label, "artifact label");
    const address = getAddress(artifact.address);
    const provenance = await verifyDeployedRuntimeArtifactWithProvenance(
      artifact.contractName,
      address,
      input.provider,
    );
    artifacts.push(Object.freeze({ label: artifact.label, address, ...provenance }));
  }

  const transactions = [];
  for (const transaction of input.journal.transactions) {
    if (transaction.status !== "mined-success" && transaction.status !== "mined-failure") continue;
    const [receipt, actualTransaction] = await Promise.all([
      input.provider.getTransactionReceipt(transaction.hash),
      input.provider.getTransaction(transaction.hash),
    ]);
    if (!receipt || !actualTransaction) {
      throw new Error(`funded transaction unavailable: ${transaction.label}`);
    }
    const status = transaction.status === "mined-success" ? 1 : 0;
    const block = await input.provider.getBlock(receipt.blockNumber);
    if (
      receipt.hash.toLowerCase() !== transaction.hash.toLowerCase() ||
      BigInt(receipt.status ?? -1) !== BigInt(status) ||
      (transaction.blockNumber !== undefined &&
        transaction.blockNumber !== receipt.blockNumber) ||
      !HASH.test(receipt.blockHash) ||
      !block?.hash ||
      block.hash.toLowerCase() !== receipt.blockHash.toLowerCase() ||
      !participants.some((participant) =>
        participant.toLowerCase() === actualTransaction.from.toLowerCase()
      ) ||
      Number(actualTransaction.chainId) !== identity.chainId
    ) throw new Error(`funded receipt provenance mismatch: ${transaction.label}`);
    transactions.push(Object.freeze({
      label: requireLabel(transaction.label, "transaction label"),
      hash: transaction.hash.toLowerCase(),
      status: status as 0 | 1,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash.toLowerCase(),
      gasUsed: BigInt(receipt.gasUsed).toString(),
      from: getAddress(actualTransaction.from),
      to: actualTransaction.to === null ? null : getAddress(actualTransaction.to),
      chainId: Number(actualTransaction.chainId),
      calldataHash: keccak256(actualTransaction.data),
      selector: actualTransaction.data.length >= 10
        ? actualTransaction.data.slice(0, 10).toLowerCase()
        : "0x",
      value: BigInt(actualTransaction.value).toString(),
      contractAddress: receipt.contractAddress === null
        ? null
        : getAddress(receipt.contractAddress),
      logsHash: receiptLogsHash(receipt.logs),
      logCount: receipt.logs.length,
    }));
  }

  const assertions = input.assertions.map((assertion) =>
    requireLabel(assertion, "assertion label")
  );
  if (assertions.length === 0 || new Set(assertions).size !== assertions.length) {
    throw new Error("funded evidence requires unique assertion labels");
  }
  requireRunnerPolicy(identity.runner, configuration, artifacts, assertions, transactions);
  const evidence = parseEvidence({
    schema: SCHEMA,
    ...identity,
    runnerSource,
    runnerSourceSha256,
    generatedAt: new Date().toISOString(),
    participants,
    deployment: identity.deployment,
    configuration,
    configurationHash: configurationHash(configuration),
    artifacts,
    transactions,
    recoveredResources: input.journal.resources.map((resource) => ({
      id: resource.id,
      kind: resource.kind,
      address: resource.address,
      creationTransactionHash: resource.creationTransactionHash,
    })),
    assertions,
    outcome: "passed",
  });
  await verifyFundedRunEvidence(evidence, input.provider);

  const path = resolve(
    input.directory ?? ".testnet-state/evidence",
    `${identity.runner}-${identity.sourceCommit}.json`,
  );
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporaryPath, path);
  return Object.freeze({ path, evidence });
}
