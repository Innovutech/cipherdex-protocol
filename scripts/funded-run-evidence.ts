import { mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import {
  AbiCoder,
  ZeroAddress,
  concat,
  getAddress,
  getBytes,
  Interface,
  keccak256,
  TypedDataEncoder,
  toUtf8Bytes,
  verifyMessage,
  verifyTypedData,
} from "ethers";
import { artifacts } from "../hardhat/runtime.js";

import {
  CONFIDENTIAL_BEST_EXECUTION_ROUTER_ABI,
  CONFIDENTIAL_CPMM_ABI,
  CONFIDENTIAL_CPMM_FACTORY_ABI,
  CONFIDENTIAL_INITIALIZATION_STRATEGY_ABI,
  CONFIDENTIAL_LAUNCHPAD_MIGRATOR_ABI,
  LAUNCH_COMMITMENT_EIP712_TYPES,
  LAUNCH_INITIALIZATION_EIP712_DOMAIN,
  LAUNCHPAD_MIGRATION_EIP712_TYPES,
  LAUNCHPAD_MIGRATOR_EIP712_DOMAIN,
  LAUNCHPAD_MIGRATE_SELECTOR,
  LAUNCHPAD_MIGRATE_WITH_DISPOSITION_SELECTOR,
} from "../sdk/src/index";

import {
  FundedRecoveryJournal,
  isRecoveryResourceMetadata,
  normalizeFundedEvidenceConstructorArguments,
  verifyRecoveryResourceCreation,
  verifyRecoveryResourceTerminalState,
  type FundedEvidenceArtifactPlan,
  type FundedEvidenceConstructorValue,
  type RecoveryResource,
  type FundedEvidencePlan,
} from "./funded-recovery-journal";
import {
  sameFundedDeploymentBinding,
  validateFundedDeploymentBinding,
  type FundedDeploymentBinding,
} from "./funded-deployment-binding";
import {
  verifyDeployedRuntimeArtifactWithProvenance,
  type RuntimeArtifactProvenance,
} from "./runtime-artifact";
import { writeUtf8FileAtomic } from "./secure-atomic-file";

const SCHEMA = "cipherdex.funded-run-evidence/v6" as const;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const SOURCE_COMMIT = /^[0-9a-f]{40}$/;
const LABEL = /^[a-zA-Z0-9][a-zA-Z0-9 .:_+\-/()]{0,159}$/;
const NESTED_CREATION_CONTRACTS = new Set([
  "ConfidentialCPMM",
  "PrivateLPToken",
  "ConfidentialLaunchpadMigrator",
]);
const RUNNER_SOURCES = Object.freeze<Record<string, string>>({
  "best-execution-feasibility": "scripts/testnet-best-execution-feasibility.ts",
  "best-execution": "scripts/testnet-best-execution.ts",
  "configured-compatibility": "scripts/testnet-best-execution.ts",
  "fee-collection": "scripts/testnet-fee-collection.ts",
  "launchpad": "scripts/testnet-launchpad.ts",
  "configured-launchpad": "scripts/testnet-launchpad.ts",
  "evidence-test": "test/unit/FundedRunEvidence.spec.ts",
});
function requireSelector(abi: readonly string[], functionName: string): string {
  const fragment = new Interface(abi).getFunction(functionName);
  if (!fragment) throw new Error(`Canonical ABI omits ${functionName}`);
  return fragment.selector;
}

const SELECTOR = Object.freeze({
  probeQuote: "0x0b6f808f",
  probeSwap: "0x7cbe798d",
  closeAndRecover: "0xcb9648a1",
  bestQuote: requireSelector(
    CONFIDENTIAL_BEST_EXECUTION_ROUTER_ABI,
    "requestBestQuoteExactInputWithCandidates",
  ),
  bestSwap: requireSelector(
    CONFIDENTIAL_BEST_EXECUTION_ROUTER_ABI,
    "swapBestExactInputWithCandidates",
  ),
  createConfidentialPool: requireSelector(CONFIDENTIAL_CPMM_FACTORY_ABI, "createPool"),
  addLiquidity: requireSelector(CONFIDENTIAL_CPMM_ABI, "addLiquidity"),
  directQuote: requireSelector(CONFIDENTIAL_CPMM_ABI, "requestQuoteExactInput"),
  collectProtocolFees: requireSelector(CONFIDENTIAL_CPMM_ABI, "collectProtocolFees"),
  confidentialSwap: requireSelector(CONFIDENTIAL_CPMM_ABI, "swapExactInput"),
  removeLiquidity: requireSelector(CONFIDENTIAL_CPMM_ABI, "removeLiquidity"),
  commitLaunch: requireSelector(
    CONFIDENTIAL_INITIALIZATION_STRATEGY_ABI,
    "commitLaunch",
  ),
  launchpadMigrate: LAUNCHPAD_MIGRATE_SELECTOR,
  launchpadMigrateWithDisposition: LAUNCHPAD_MIGRATE_WITH_DISPOSITION_SELECTOR,
  mockDeployment: "0x60a06040",
} as const);
const BEST_EXECUTION_INTERFACE = new Interface(CONFIDENTIAL_BEST_EXECUTION_ROUTER_ABI);
const INITIALIZATION_STRATEGY_INTERFACE = new Interface(
  CONFIDENTIAL_INITIALIZATION_STRATEGY_ABI,
);
const LAUNCHPAD_INTERFACE = new Interface(CONFIDENTIAL_LAUNCHPAD_MIGRATOR_ABI);
const PROBE_CONFIGURATION_INTERFACE = new Interface([
  "function configureRouter(address router)",
]);

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

export const BEST_EXECUTION_FUNDED_ASSERTIONS = Object.freeze([
  "canonical candidates resolved from factory",
  "signed launch commitment initialized the protected 30 bps candidate",
  "bounded mixed standard and launch-protected candidate bitmap exercised",
  "protected candidate selected and settled through the shared router",
  "paid quote selected best encrypted output",
  "deterministic lower-tier tie break enforced",
  "quote-only pool state remained unchanged",
  "quote and settlement output parity enforced",
  "both swap directions exercised",
  "all approved fee tiers exercised",
  "request replay caller and deadline guards enforced",
  "failed encrypted-minimum transactions were correlated with successful controls",
  "router escrow and allowances returned to zero",
  "full LP exits used positive modeled minima",
  "disposable pools recovered with zero residue",
]);

export const BEST_EXECUTION_FEASIBILITY_ROUTER_BINDING_LABELS = Object.freeze([
  "pool probe 0 router binding",
  "pool probe 1 router binding",
] as const);

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
      { label: new RegExp(`^${BEST_EXECUTION_FEASIBILITY_ROUTER_BINDING_LABELS[0]}$`), status: 1, targetArtifactLabel: "GT pool probe 0", selectors: [PROBE_CONFIGURATION_INTERFACE.getFunction("configureRouter")!.selector] },
      { label: new RegExp(`^${BEST_EXECUTION_FEASIBILITY_ROUTER_BINDING_LABELS[1]}$`), status: 1, targetArtifactLabel: "GT pool probe 1", selectors: [PROBE_CONFIGURATION_INTERFACE.getFunction("configureRouter")!.selector] },
      { label: /^cross-contract GT quote and private selection$/, status: 1, targetArtifactLabel: "GT router probe", selectors: [SELECTOR.probeQuote] },
      { label: /^atomic selected-pool settlement$/, status: 1, targetArtifactLabel: "GT router probe", selectors: [SELECTOR.probeSwap] },
      { label: /^pool probe 0 closure and recovery$/, status: 1, targetArtifactLabel: "GT pool probe 0", selectors: [SELECTOR.closeAndRecover] },
      { label: /^pool probe 1 closure and recovery$/, status: 1, targetArtifactLabel: "GT pool probe 1", selectors: [SELECTOR.closeAndRecover] },
      { label: /^router probe closure and recovery$/, status: 1, targetArtifactLabel: "GT router probe", selectors: [SELECTOR.closeAndRecover] },
    ],
  },
  "best-execution": {
    configurationKeys: [
      "candidateBitmap", "candidateStrategyClasses", "candidateTiers", "chainId",
      "confidentialPoolVersion", "feeBeneficiary", "privacyMode", "quoteTransport",
      "routerVersion", "tokenA", "tokenB",
    ],
    assertions: BEST_EXECUTION_FUNDED_ASSERTIONS,
    artifacts: {
      CipherDEXFeeVault: 1,
      PrivateLPTokenFactory: 1,
      ConfidentialCPMMDeployer: 1,
      ConfidentialInitializationStrategyRegistry: 1,
      ConfidentialCPMMFactory: 1,
      ConfidentialLaunchInitializationStrategy: 1,
      ConfidentialLaunchpadMigrator: 1,
      ConfidentialBestExecutionRouter: 1,
      ConfidentialCPMM: 3,
      PrivateLPToken: 3,
    },
    requiredTransactions: [
      { label: /^commit protected 30 bps launch$/, status: 1, targetArtifactLabel: "disposable launch initialization strategy", selectors: [SELECTOR.commitLaunch] },
      { label: /^best quote request-id replay$/, status: 0, targetArtifactLabel: "disposable best execution router", selectors: [SELECTOR.bestQuote] },
      { label: /^best quote ciphertext replay$/, status: 0, targetArtifactLabel: "disposable best execution router", selectors: [SELECTOR.bestQuote] },
      { label: /^best quote expired deadline$/, status: 0, targetArtifactLabel: "disposable best execution router", selectors: [SELECTOR.bestQuote] },
      { label: /^caller-bound ciphertext isolation$/, status: 0, targetArtifactLabel: "disposable best execution router", selectors: [SELECTOR.bestQuote] },
      { label: /^caller-bound ciphertext primary control$/, status: 1, targetArtifactLabel: "disposable best execution router", selectors: [SELECTOR.bestQuote] },
      { label: / encrypted slippage rollback$/, status: 0, targetArtifactLabel: "disposable best execution router", selectors: [SELECTOR.bestSwap] },
      { label: /^two-candidate quote with absent tier$/, status: 1, targetArtifactLabel: "disposable best execution router", selectors: [SELECTOR.bestQuote] },
      { label: /^two-candidate quote with uninitialized tier$/, status: 1, targetArtifactLabel: "disposable best execution router", selectors: [SELECTOR.bestQuote] },
      { label: /^two-candidate quote-plus-swap$/, status: 1, targetArtifactLabel: "disposable best execution router", selectors: [SELECTOR.bestSwap] },
      { label: /^three-candidate quote$/, status: 1, targetArtifactLabel: "disposable best execution router", selectors: [SELECTOR.bestQuote] },
      { label: /^three-candidate quote-plus-swap$/, status: 1, targetArtifactLabel: "disposable best execution router", selectors: [SELECTOR.bestSwap] },
      { label: /^post-tie 30 bps selection quote$/, status: 1, targetArtifactLabel: "disposable best execution router", selectors: [SELECTOR.bestQuote] },
      { label: /^post-tie 30 bps quote-plus-swap$/, status: 1, targetArtifactLabel: "disposable best execution router", selectors: [SELECTOR.bestSwap] },
      { label: /^encrypted-invalid candidate isolation quote$/, status: 1, targetArtifactLabel: "disposable best execution router", selectors: [SELECTOR.bestQuote] },
      { label: /^reverse three-candidate quote$/, status: 1, targetArtifactLabel: "disposable best execution router", selectors: [SELECTOR.bestQuote] },
      { label: /^reverse three-candidate quote-plus-swap$/, status: 1, targetArtifactLabel: "disposable best execution router", selectors: [SELECTOR.bestSwap] },
    ],
  },
  "configured-compatibility": {
    configurationKeys: [
      "chainId", "factory", "router", "tokenA", "tokenB", "tokenACodehash",
      "tokenBCodehash", "referenceToken", "referenceTokenCodehash", "maximumBalanceBps",
    ],
    assertions: [
      "reference and differing runtime tokens passed structural compatibility",
      "configured factory created canonical pools without token approval",
      "balance-derived liquidity stayed within one tenth of one percent",
      "configured router quote and atomic swap preserved parity",
      "router escrow and pool allowances returned to zero",
      "configured compatibility pools exited with zero residue",
    ],
    artifacts: {
      PrivateLPTokenFactory: 1,
      ConfidentialCPMMFactory: 1,
      ConfidentialBestExecutionRouter: 1,
      ConfidentialCPMM: 2,
      PrivateLPToken: 2,
    },
    requiredTransactions: [
      { label: /^create canonical 100 bps pool$/, status: 1, targetArtifactLabel: "configured confidential factory", selectors: [SELECTOR.createConfidentialPool] },
      { label: /^duplicate canonical reference pool$/, status: 0, targetArtifactLabel: "configured confidential factory", selectors: [SELECTOR.createConfidentialPool] },
      { label: /^create canonical 30 bps pool$/, status: 1, targetArtifactLabel: "configured confidential factory", selectors: [SELECTOR.createConfidentialPool] },
      { label: /^initialize canonical 30 bps pool$/, status: 1, targetArtifactLabel: "configured compatibility pool", selectors: [SELECTOR.addLiquidity] },
      { label: /^configured compatibility best quote$/, status: 1, targetArtifactLabel: "configured best-execution router", selectors: [SELECTOR.bestQuote] },
      { label: /^configured compatibility best swap$/, status: 1, targetArtifactLabel: "configured best-execution router", selectors: [SELECTOR.bestSwap] },
      { label: /^full cleanup exit for 30 bps pool$/, status: 1, targetArtifactLabel: "configured compatibility pool", selectors: [SELECTOR.removeLiquidity] },
    ],
  },
  "fee-collection": {
    configurationKeys: [
      "chainId", "collectionDelaySeconds", "collectionReadyAt", "confidentialPoolVersion", "feeBeneficiary",
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
      ConfidentialCPMMDeployer: 1,
      ConfidentialInitializationStrategyRegistry: 1,
      ConfidentialCPMMFactory: 1,
      ConfidentialCPMM: 1,
      PrivateLPToken: 1,
    },
    requiredTransactions: [
      { label: /^premature confidential protocol fee collection$/, status: 0, targetArtifactLabel: "disposable confidential fee pool", selectors: [SELECTOR.collectProtocolFees] },
      { label: /^mature confidential protocol fee collection$/, status: 1, targetArtifactLabel: "disposable confidential fee pool", selectors: [SELECTOR.collectProtocolFees] },
      { label: /^terminal sub-threshold fee swap$/, status: 1, targetArtifactLabel: "disposable confidential fee pool", selectors: [SELECTOR.confidentialSwap] },
      { label: /^full disposable fee-pool exit$/, status: 1, targetArtifactLabel: "disposable confidential fee pool", selectors: [SELECTOR.removeLiquidity] },
    ],
  },
  "launchpad": {
    configurationKeys: [
      "chainId", "confidentialPoolVersion", "disposition", "feeBeneficiary", "feeBps",
      "initializationStrategyVersion", "launchpadMigratorVersion", "privacyMode", "tokenA", "tokenB",
    ],
    assertions: [
      "empty protected pool slot verified",
      "dual-authorized launch commitment created one uninitialized protected pool",
      "failed signed alternate-bound launch request rolled back atomically",
      "launchpad migration used canonical pool",
      "LP disposition and lock state verified",
      "replay protection rolled back atomically",
      "direct private quote and swap preserved exact balance and allowance deltas",
      "partial and full LP removal succeeded",
      "completed protected pool remained permissionless after a full exit and ordinary re-seed",
      "private balances and allowances recovered",
      "disposable launchpad pool recovered with zero residue",
    ],
    artifacts: {
      CipherDEXFeeVault: 1,
      PrivateLPTokenFactory: 1,
      ConfidentialCPMMDeployer: 1,
      ConfidentialInitializationStrategyRegistry: 1,
      ConfidentialCPMMFactory: 1,
      ConfidentialLaunchInitializationStrategy: 1,
      ConfidentialLaunchpadMigrator: 1,
      ConfidentialCPMM: 1,
      PrivateLPToken: 1,
    },
    requiredTransactions: [
      { label: /^launch commitment$/, status: 1, targetArtifactLabel: "disposable launch initialization strategy", selectors: [SELECTOR.commitLaunch] },
      { label: /^rejected launchpad price-bound probe$/, status: 0, targetArtifactLabel: "disposable launchpad migrator", selectors: [SELECTOR.launchpadMigrate, SELECTOR.launchpadMigrateWithDisposition] },
      { label: /^atomic launchpad migration$/, status: 1, targetArtifactLabel: "disposable launchpad migrator", selectors: [SELECTOR.launchpadMigrate, SELECTOR.launchpadMigrateWithDisposition] },
      { label: /^launchpad replay probe$/, status: 0, targetArtifactLabel: "disposable launchpad migrator", selectors: [SELECTOR.launchpadMigrate, SELECTOR.launchpadMigrateWithDisposition] },
      { label: /^launchpad pool direct paid quote$/, status: 1, targetArtifactLabel: "disposable launchpad pool", selectors: [SELECTOR.directQuote] },
      { label: /^launchpad pool direct private swap$/, status: 1, targetArtifactLabel: "disposable launchpad pool", selectors: [SELECTOR.confidentialSwap] },
      { label: /^protected launchpad pool partial exit$/, status: 1, targetArtifactLabel: "disposable launchpad pool", selectors: [SELECTOR.removeLiquidity] },
      { label: /^protected launchpad pool first full exit$/, status: 1, targetArtifactLabel: "disposable launchpad pool", selectors: [SELECTOR.removeLiquidity] },
      { label: /^protected pool ordinary re-seed$/, status: 1, targetArtifactLabel: "disposable launchpad pool", selectors: [SELECTOR.addLiquidity] },
      { label: /^full disposable launchpad-pool exit$/, status: 1, targetArtifactLabel: "disposable launchpad pool", selectors: [SELECTOR.removeLiquidity] },
    ],
  },
  "configured-launchpad": {
    configurationKeys: [
      "chainId", "confidentialPoolVersion", "disposition", "factory", "feeBeneficiary",
      "feeBps", "initializationStrategy", "initializationStrategyVersion",
      "launchpadMigrator", "launchpadMigratorVersion", "maximumBalanceBps", "privacyMode",
      "tokenA", "tokenACodehash", "tokenB", "tokenBCodehash",
    ],
    assertions: [
      "empty protected pool slot verified",
      "dual-authorized launch commitment created one uninitialized protected pool",
      "failed signed alternate-bound launch request rolled back atomically",
      "launchpad migration used canonical pool",
      "LP disposition and lock state verified",
      "replay protection rolled back atomically",
      "direct private quote and swap preserved exact balance and allowance deltas",
      "partial and full LP removal succeeded",
      "completed protected pool remained permissionless after a full exit and ordinary re-seed",
      "private balances and allowances recovered",
      "configured launchpad pool recovered with zero residue",
    ],
    artifacts: {
      CipherDEXFeeVault: 1,
      PrivateLPTokenFactory: 1,
      ConfidentialCPMMFactory: 1,
      ConfidentialLaunchInitializationStrategy: 1,
      ConfidentialLaunchpadMigrator: 1,
      ConfidentialCPMM: 1,
      PrivateLPToken: 1,
    },
    requiredTransactions: [
      { label: /^launch commitment$/, status: 1, targetArtifactLabel: "configured launch initialization strategy", selectors: [SELECTOR.commitLaunch] },
      { label: /^rejected launchpad price-bound probe$/, status: 0, targetArtifactLabel: "configured launchpad migrator", selectors: [SELECTOR.launchpadMigrate, SELECTOR.launchpadMigrateWithDisposition] },
      { label: /^atomic launchpad migration$/, status: 1, targetArtifactLabel: "configured launchpad migrator", selectors: [SELECTOR.launchpadMigrate, SELECTOR.launchpadMigrateWithDisposition] },
      { label: /^launchpad replay probe$/, status: 0, targetArtifactLabel: "configured launchpad migrator", selectors: [SELECTOR.launchpadMigrate, SELECTOR.launchpadMigrateWithDisposition] },
      { label: /^launchpad pool direct paid quote$/, status: 1, targetArtifactLabel: "configured launchpad pool", selectors: [SELECTOR.directQuote] },
      { label: /^launchpad pool direct private swap$/, status: 1, targetArtifactLabel: "configured launchpad pool", selectors: [SELECTOR.confidentialSwap] },
      { label: /^protected launchpad pool partial exit$/, status: 1, targetArtifactLabel: "configured launchpad pool", selectors: [SELECTOR.removeLiquidity] },
      { label: /^protected launchpad pool first full exit$/, status: 1, targetArtifactLabel: "configured launchpad pool", selectors: [SELECTOR.removeLiquidity] },
      { label: /^protected pool ordinary re-seed$/, status: 1, targetArtifactLabel: "configured launchpad pool", selectors: [SELECTOR.addLiquidity] },
      { label: /^full configured launchpad-pool exit$/, status: 1, targetArtifactLabel: "configured launchpad pool", selectors: [SELECTOR.removeLiquidity] },
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
  call(transaction: Readonly<{ to: string; data: string }>): Promise<string>;
  getCode(address: string): Promise<string>;
  getTransactionReceipt(hash: string): Promise<null | {
    hash: string;
    status: number | bigint | null;
    blockNumber: number;
    index?: number;
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
  getBlock(block: number | string): Promise<null | {
    hash: string | null;
    timestamp: number;
  }>;
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
    creationTransactionHash?: string;
    constructorArguments?: readonly FundedEvidenceConstructorValue[];
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
    recoveryTransactionHashes: readonly string[];
    metadata: Readonly<Record<string, string | number | boolean>>;
  }>[];
  assertions: readonly string[];
  outcome: "passed";
  attestation: Readonly<{
    scheme: "eip191";
    digest: string;
    signer: string;
    signature: string;
  }>;
}>;

export type FundedEvidenceAttestationSigner = Readonly<{
  getAddress(): Promise<string>;
  signMessage(message: Uint8Array): Promise<string>;
}>;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(object[key])}`
  ).join(",")}}`;
}

function attestationDigest(
  evidence: Omit<FundedRunEvidence, "attestation"> | FundedRunEvidence,
): string {
  const { attestation: _attestation, ...unsigned } = evidence as FundedRunEvidence;
  return keccak256(toUtf8Bytes(canonicalJson(unsigned)));
}

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

export function preflightFundedRunConfiguration(
  runner: string,
  configuration: PublicConfiguration,
): PublicConfiguration {
  const canonical = canonicalConfiguration(configuration);
  const policy = RUNNER_POLICIES[runner];
  if (!policy) throw new Error("funded runner has no semantic evidence policy");
  const actualKeys = Object.keys(canonical).sort();
  const expectedKeys = [...policy.configurationKeys].sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error("funded evidence configuration does not match runner policy");
  }
  return canonical;
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
  preflightFundedRunConfiguration(runner, configuration);
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

export type ActualSemanticTransaction = Readonly<{
  label: string;
  hash: string;
  status: 0 | 1;
  from: string;
  to: string | null;
  data: string;
  contractAddress: string | null;
  blockNumber: number;
  transactionIndex: number;
  blockTimestamp: number;
  logs: readonly Readonly<{ address: string; topics: readonly string[]; data: string }>[];
}>;

function isStrictlyAfter(
  later: ActualSemanticTransaction,
  earlier: ActualSemanticTransaction,
): boolean {
  return later.blockNumber > earlier.blockNumber ||
    (later.blockNumber === earlier.blockNumber &&
      later.transactionIndex > earlier.transactionIndex);
}

type BestExecutionCall = Readonly<{
  transaction: ActualSemanticTransaction;
  selector: string;
  tokenIn: string;
  tokenOut: string;
  inputCommitment: string;
  minimumCommitment: string | null;
  candidateBitmap: number;
  requestId: string;
  deadline: bigint;
}>;

function encryptedInputCommitment(input: unknown): string {
  const tuple = input as readonly unknown[];
  const ciphertext = tuple[0] as readonly unknown[];
  const signature = String(tuple[1]);
  return keccak256(AbiCoder.defaultAbiCoder().encode(
    ["uint256", "uint256", "bytes32"],
    [BigInt(ciphertext[0] as bigint), BigInt(ciphertext[1] as bigint), keccak256(signature)],
  ));
}

function requireUniqueTransaction(
  transactions: readonly ActualSemanticTransaction[],
  label: string,
  status: 0 | 1,
): ActualSemanticTransaction {
  const matches = transactions.filter((transaction) =>
    transaction.label === label && transaction.status === status
  );
  if (matches.length !== 1) {
    throw new Error(`funded evidence lacks unique ${label} transaction`);
  }
  return matches[0];
}

function decodeBestExecutionCall(
  transaction: ActualSemanticTransaction,
): BestExecutionCall | null {
  const selector = transaction.data.slice(0, 10).toLowerCase();
  if (selector !== SELECTOR.bestQuote && selector !== SELECTOR.bestSwap) return null;
  const isQuote = selector === SELECTOR.bestQuote;
  const functionName = isQuote
    ? "requestBestQuoteExactInputWithCandidates"
    : "swapBestExactInputWithCandidates";
  const decoded = BEST_EXECUTION_INTERFACE.decodeFunctionData(functionName, transaction.data);
  return Object.freeze({
    transaction,
    selector,
    tokenIn: getAddress(String(decoded[0])).toLowerCase(),
    tokenOut: getAddress(String(decoded[1])).toLowerCase(),
    inputCommitment: encryptedInputCommitment(decoded[2]),
    minimumCommitment: isQuote ? null : encryptedInputCommitment(decoded[3]),
    candidateBitmap: Number(decoded[isQuote ? 3 : 4]),
    requestId: String(decoded[isQuote ? 4 : 5]).toLowerCase(),
    deadline: BigInt(decoded[isQuote ? 5 : 6]),
  });
}

function sameBestExecutionEnvelope(
  left: BestExecutionCall,
  right: BestExecutionCall,
): boolean {
  return left.selector === right.selector &&
    left.transaction.to === right.transaction.to &&
    left.tokenIn === right.tokenIn &&
    left.tokenOut === right.tokenOut &&
    left.candidateBitmap === right.candidateBitmap;
}

function artifactAddress(
  artifacts: readonly Readonly<{ label: string; address: string }>[],
  label: string,
): string {
  const matches = artifacts.filter((artifact) => artifact.label === label);
  if (matches.length !== 1) throw new Error(`funded evidence artifact ${label} is ambiguous`);
  return getAddress(matches[0].address);
}

type EvidenceArtifact = FundedRunEvidence["artifacts"][number];

function artifactByContractName(
  artifactsToSearch: readonly EvidenceArtifact[],
  contractName: string,
): EvidenceArtifact {
  const matches = artifactsToSearch.filter((artifact) =>
    artifact.contractName === contractName
  );
  if (matches.length !== 1) {
    throw new Error(`funded evidence requires one ${contractName} artifact`);
  }
  return matches[0];
}

async function readArtifactState(
  provider: FundedEvidenceProvider,
  contractName: string,
  address: string,
  functionName: string,
  args: readonly unknown[] = [],
): Promise<unknown> {
  const artifact = await artifacts.readArtifact(contractName);
  const contractInterface = new Interface(artifact.abi);
  const result = await provider.call({
    to: address,
    data: contractInterface.encodeFunctionData(functionName, args),
  });
  return contractInterface.decodeFunctionResult(functionName, result)[0];
}

async function requireDirectCreationBindings(
  evidenceArtifacts: readonly EvidenceArtifact[],
  transactions: readonly ActualSemanticTransaction[],
): Promise<void> {
  for (const artifact of evidenceArtifacts) {
    if (artifact.creationTransactionHash === undefined) continue;
    const matches = transactions.filter((transaction) =>
      transaction.hash.toLowerCase() === artifact.creationTransactionHash!.toLowerCase() &&
      transaction.status === 1
    );
    if (matches.length !== 1) {
      throw new Error(`funded artifact lacks one successful creation transaction: ${artifact.label}`);
    }
    const transaction = matches[0];
    if (
      transaction.to !== null ||
      transaction.contractAddress === null ||
      getAddress(transaction.contractAddress) !== getAddress(artifact.address)
    ) {
      throw new Error(`funded artifact creation receipt is invalid: ${artifact.label}`);
    }
    const compiled = await artifacts.readArtifact(artifact.contractName);
    const expectedData = concat([
      compiled.bytecode,
      new Interface(compiled.abi).encodeDeploy(artifact.constructorArguments ?? []),
    ]);
    if (transaction.data.toLowerCase() !== expectedData.toLowerCase()) {
      throw new Error(`funded artifact constructor calldata is invalid: ${artifact.label}`);
    }
  }
}

async function requireFactoryChildBindings(
  provider: FundedEvidenceProvider,
  evidenceArtifacts: readonly EvidenceArtifact[],
  transactions: readonly ActualSemanticTransaction[],
): Promise<void> {
  const poolArtifacts = evidenceArtifacts.filter((artifact) =>
    artifact.contractName === "ConfidentialCPMM"
  );
  const lpArtifacts = evidenceArtifacts.filter((artifact) =>
    artifact.contractName === "PrivateLPToken"
  );
  if (poolArtifacts.length === 0 && lpArtifacts.length === 0) return;
  if (poolArtifacts.length !== lpArtifacts.length) {
    throw new Error("funded confidential pools and LP tokens are not one-to-one");
  }
  const factory = artifactByContractName(evidenceArtifacts, "ConfidentialCPMMFactory");
  const lpFactory = artifactByContractName(evidenceArtifacts, "PrivateLPTokenFactory");
  const [factoryArtifact, lpFactoryArtifact] = await Promise.all([
    artifacts.readArtifact("ConfidentialCPMMFactory"),
    artifacts.readArtifact("PrivateLPTokenFactory"),
  ]);
  const factoryInterface = new Interface(factoryArtifact.abi);
  const lpFactoryInterface = new Interface(lpFactoryArtifact.abi);
  type ParsedEvent = Readonly<{
    transaction: ActualSemanticTransaction;
    name: string;
    args: NonNullable<ReturnType<Interface["parseLog"]>>["args"];
  }>;
  const events: ParsedEvent[] = [];
  for (const transaction of transactions.filter((candidate) => candidate.status === 1)) {
    for (const log of transaction.logs) {
      const logAddress = getAddress(log.address);
      const parser = logAddress === getAddress(factory.address)
        ? factoryInterface
        : logAddress === getAddress(lpFactory.address)
          ? lpFactoryInterface
          : null;
      if (!parser) continue;
      try {
        const parsed = parser.parseLog({ topics: [...log.topics], data: log.data });
        if (parsed) events.push({ transaction, name: parsed.name, args: parsed.args });
      } catch {
        // Other logs from a reviewed factory are not creation evidence.
      }
    }
  }
  const configuredLpFactory = getAddress(String(await readArtifactState(
    provider,
    "ConfidentialCPMMFactory",
    factory.address,
    "lpTokenFactory",
  )));
  const configuredFeeVault = getAddress(String(await readArtifactState(
    provider,
    "ConfidentialCPMMFactory",
    factory.address,
    "feeVault",
  )));
  if (configuredLpFactory !== getAddress(lpFactory.address)) {
    throw new Error("funded factory does not bind the reviewed LP-token factory");
  }

  const matchedLpAddresses = new Set<string>();
  for (const poolArtifact of poolArtifacts) {
    const poolAddress = getAddress(poolArtifact.address);
    const poolCreated = events.filter((event) =>
      event.name === "PoolCreated" &&
      getAddress(String(event.args.pool)) === poolAddress
    );
    if (poolCreated.length !== 1) {
      throw new Error(`funded pool lacks one canonical creation event: ${poolArtifact.label}`);
    }
    const event = poolCreated[0];
    const token0 = getAddress(String(event.args.token0));
    const token1 = getAddress(String(event.args.token1));
    const decimals0 = Number(event.args.token0Decimals);
    const decimals1 = Number(event.args.token1Decimals);
    const feeBps = BigInt(event.args.feeBps);
    const strategy = getAddress(String(event.args.initializationStrategy));
    const [actualToken0, actualToken1, actualDecimals0, actualDecimals1, actualFee,
      actualStrategy, actualBootstrapper, actualFeeVault, lpToken, isPool] = await Promise.all([
      readArtifactState(provider, "ConfidentialCPMM", poolAddress, "token0"),
      readArtifactState(provider, "ConfidentialCPMM", poolAddress, "token1"),
      readArtifactState(provider, "ConfidentialCPMM", poolAddress, "token0Decimals"),
      readArtifactState(provider, "ConfidentialCPMM", poolAddress, "token1Decimals"),
      readArtifactState(provider, "ConfidentialCPMM", poolAddress, "feeBps"),
      readArtifactState(provider, "ConfidentialCPMM", poolAddress, "initializationStrategy"),
      readArtifactState(provider, "ConfidentialCPMM", poolAddress, "bootstrapper"),
      readArtifactState(provider, "ConfidentialCPMM", poolAddress, "feeVault"),
      readArtifactState(provider, "ConfidentialCPMM", poolAddress, "lpToken"),
      readArtifactState(provider, "ConfidentialCPMMFactory", factory.address, "isPool", [poolAddress]),
    ]);
    const lpTokenAddress = getAddress(String(lpToken));
    if (
      getAddress(String(actualToken0)) !== token0 ||
      getAddress(String(actualToken1)) !== token1 ||
      Number(actualDecimals0) !== decimals0 ||
      Number(actualDecimals1) !== decimals1 ||
      BigInt(actualFee as bigint) !== feeBps ||
      getAddress(String(actualStrategy)) !== strategy ||
      getAddress(String(actualBootstrapper)) !== getAddress(factory.address) ||
      getAddress(String(actualFeeVault)) !== configuredFeeVault ||
      isPool !== true
    ) throw new Error(`funded pool immutable state does not match its creation event: ${poolArtifact.label}`);

    const key = await readArtifactState(
      provider,
      "ConfidentialCPMMFactory",
      factory.address,
      "poolKey",
      [token0, token1, decimals0, decimals1, feeBps, strategy],
    );
    const canonicalPool = getAddress(String(await readArtifactState(
      provider,
      "ConfidentialCPMMFactory",
      factory.address,
      "getPool",
      [key],
    )));
    if (canonicalPool !== poolAddress) {
      throw new Error(`funded pool is not canonical for its complete key: ${poolArtifact.label}`);
    }
    const lpArtifact = lpArtifacts.filter((candidate) =>
      getAddress(candidate.address) === lpTokenAddress
    );
    if (lpArtifact.length !== 1 || matchedLpAddresses.has(lpTokenAddress.toLowerCase())) {
      throw new Error(`funded pool LP token is missing or ambiguous: ${poolArtifact.label}`);
    }
    matchedLpAddresses.add(lpTokenAddress.toLowerCase());
    const lpCreated = events.filter((candidate) =>
      candidate.transaction.hash === event.transaction.hash &&
      candidate.name === "PrivateLPTokenCreated" &&
      getAddress(String(candidate.args.pool)) === poolAddress &&
      getAddress(String(candidate.args.token)) === lpTokenAddress
    );
    const lpIssued = events.filter((candidate) =>
      candidate.transaction.hash === event.transaction.hash &&
      candidate.name === "PrivateLPTokenIssued" &&
      getAddress(String(candidate.args.pool)) === poolAddress &&
      getAddress(String(candidate.args.token)) === lpTokenAddress &&
      getAddress(String(candidate.args.issuer)) === getAddress(factory.address)
    );
    const [lpPool, issued] = await Promise.all([
      readArtifactState(provider, "PrivateLPToken", lpTokenAddress, "pool"),
      readArtifactState(
        provider,
        "PrivateLPTokenFactory",
        lpFactory.address,
        "isIssuedToken",
        [poolAddress, lpTokenAddress, factory.address],
      ),
    ]);
    if (
      lpCreated.length !== 1 ||
      lpIssued.length !== 1 ||
      getAddress(String(lpPool)) !== poolAddress ||
      issued !== true
    ) throw new Error(`funded LP token lacks canonical factory provenance: ${lpArtifact[0].label}`);
  }
  if (matchedLpAddresses.size !== lpArtifacts.length) {
    throw new Error("funded evidence contains an unbound private LP token");
  }
}

async function requireMigratorConstructorChildBinding(
  provider: FundedEvidenceProvider,
  evidenceArtifacts: readonly EvidenceArtifact[],
  transactions: readonly ActualSemanticTransaction[],
): Promise<void> {
  const migrators = evidenceArtifacts.filter((artifact) =>
    artifact.contractName === "ConfidentialLaunchpadMigrator"
  );
  if (migrators.length === 0) return;
  if (migrators.length !== 1) throw new Error("funded evidence has ambiguous launchpad migrators");
  const migrator = migrators[0];
  const strategy = artifactByContractName(
    evidenceArtifacts,
    "ConfidentialLaunchInitializationStrategy",
  );
  const factory = artifactByContractName(evidenceArtifacts, "ConfidentialCPMMFactory");
  if (!strategy.creationTransactionHash) {
    throw new Error("funded launch strategy lacks direct constructor provenance");
  }
  const creation = transactions.filter((transaction) =>
    transaction.hash === strategy.creationTransactionHash && transaction.status === 1
  );
  if (creation.length !== 1) throw new Error("funded launch strategy creation is unavailable");
  const strategyArtifact = await artifacts.readArtifact(
    "ConfidentialLaunchInitializationStrategy",
  );
  const strategyInterface = new Interface(strategyArtifact.abi);
  const configured = creation[0].logs.flatMap((log) => {
    if (getAddress(log.address) !== getAddress(strategy.address)) return [];
    try {
      const parsed = strategyInterface.parseLog({ topics: [...log.topics], data: log.data });
      return parsed?.name === "MigratorConfigured" ? [parsed] : [];
    } catch {
      return [];
    }
  }).filter((event) =>
    getAddress(String(event.args.migrator)) === getAddress(migrator.address) &&
    String(event.args.runtimeCodehash).toLowerCase() === migrator.runtimeCodehash.toLowerCase()
  );
  const [strategyMigrator, strategyFactory, migratorFactory, migratorStrategy] = await Promise.all([
    readArtifactState(provider, strategy.contractName, strategy.address, "migrator"),
    readArtifactState(provider, strategy.contractName, strategy.address, "factory"),
    readArtifactState(provider, migrator.contractName, migrator.address, "factory"),
    readArtifactState(provider, migrator.contractName, migrator.address, "initializationStrategy"),
  ]);
  if (
    configured.length !== 1 ||
    getAddress(String(strategyMigrator)) !== getAddress(migrator.address) ||
    getAddress(String(strategyFactory)) !== getAddress(factory.address) ||
    getAddress(String(migratorFactory)) !== getAddress(factory.address) ||
    getAddress(String(migratorStrategy)) !== getAddress(strategy.address)
  ) throw new Error("funded launchpad migrator lacks constructor-child provenance");
}

async function requireBestExecutionFeasibilityBindings(
  provider: FundedEvidenceProvider,
  configuration: PublicConfiguration,
  evidenceArtifacts: readonly EvidenceArtifact[],
  transactions: readonly ActualSemanticTransaction[],
): Promise<void> {
  const pool0 = evidenceArtifacts.find((artifact) => artifact.label === "GT pool probe 0");
  const pool1 = evidenceArtifacts.find((artifact) => artifact.label === "GT pool probe 1");
  const router = evidenceArtifacts.find((artifact) => artifact.label === "GT router probe");
  if (!pool0 || !pool1 || !router) {
    throw new Error("funded feasibility probe artifacts are incomplete");
  }
  const [poolArtifact, routerArtifact] = await Promise.all([
    artifacts.readArtifact("MpcBestExecutionPoolProbe"),
    artifacts.readArtifact("MpcBestExecutionRouterProbe"),
  ]);
  const poolInterface = new Interface(poolArtifact.abi);
  const routerInterface = new Interface(routerArtifact.abi);
  const quote = requireUniqueTransaction(
    transactions,
    "cross-contract GT quote and private selection",
    1,
  );
  const swap = requireUniqueTransaction(
    transactions,
    "atomic selected-pool settlement",
    1,
  );
  if (
    quote.to !== getAddress(router.address) ||
    swap.to !== getAddress(router.address) ||
    !isStrictlyAfter(swap, quote)
  ) throw new Error("funded feasibility quote and swap are not ordered through the router");
  const quoteCall = routerInterface.decodeFunctionData(
    "requestBestQuoteExactInput",
    quote.data,
  );
  const swapCall = routerInterface.decodeFunctionData("swapBestExactInput", swap.data);
  const quoteRequestId = String(quoteCall[1]).toLowerCase();
  const swapRequestId = String(swapCall[2]).toLowerCase();
  if (
    quoteRequestId === `0x${"00".repeat(32)}` ||
    swapRequestId === `0x${"00".repeat(32)}` ||
    quoteRequestId === swapRequestId ||
    BigInt(swapCall[3]) < BigInt(swap.blockTimestamp)
  ) throw new Error("funded feasibility requests are not independently replay-bound");

  const expectedInput = getAddress(String(configuration.tokenIn));
  const expectedOutput = getAddress(String(configuration.tokenOut));
  const [routerToken, routerPool0, routerPool1, routerConfigurator, authorizedCaller,
    routerClosed] = await Promise.all([
      readArtifactState(provider, router.contractName, router.address, "tokenIn"),
      readArtifactState(provider, router.contractName, router.address, "pool0"),
      readArtifactState(provider, router.contractName, router.address, "pool1"),
      readArtifactState(provider, router.contractName, router.address, "configurator"),
      readArtifactState(provider, router.contractName, router.address, "authorizedCaller"),
      readArtifactState(provider, router.contractName, router.address, "closed"),
    ]);
  const caller = getAddress(String(authorizedCaller));
  if (
    getAddress(String(routerToken)) !== expectedInput ||
    getAddress(String(routerPool0)) !== getAddress(pool0.address) ||
    getAddress(String(routerPool1)) !== getAddress(pool1.address) ||
    getAddress(String(routerConfigurator)) !== caller ||
    quote.from !== caller ||
    swap.from !== caller ||
    routerClosed !== true
  ) throw new Error("funded feasibility router state is not bound to the funded caller and probes");

  for (const [index, pool, numerator] of [
    [0, pool0, 2n],
    [1, pool1, 3n],
  ] as const) {
    const [tokenIn, tokenOut, actualNumerator, denominator, configurator,
      configuredRouter, closed] = await Promise.all([
        readArtifactState(provider, pool.contractName, pool.address, "tokenIn"),
        readArtifactState(provider, pool.contractName, pool.address, "tokenOut"),
        readArtifactState(provider, pool.contractName, pool.address, "numerator"),
        readArtifactState(provider, pool.contractName, pool.address, "denominator"),
        readArtifactState(provider, pool.contractName, pool.address, "configurator"),
        readArtifactState(provider, pool.contractName, pool.address, "router"),
        readArtifactState(provider, pool.contractName, pool.address, "closed"),
      ]);
    if (
      getAddress(String(tokenIn)) !== expectedInput ||
      getAddress(String(tokenOut)) !== expectedOutput ||
      BigInt(actualNumerator as bigint) !== numerator ||
      BigInt(denominator as bigint) !== 1n ||
      getAddress(String(configurator)) !== caller ||
      getAddress(String(configuredRouter)) !== getAddress(router.address) ||
      closed !== true
    ) throw new Error(`funded feasibility pool ${index} state is not provenance-bound`);
    const configure = requireUniqueTransaction(
      transactions,
      BEST_EXECUTION_FEASIBILITY_ROUTER_BINDING_LABELS[index],
      1,
    );
    const decoded = poolInterface.decodeFunctionData("configureRouter", configure.data);
    if (
      configure.to !== getAddress(pool.address) ||
      configure.from !== caller ||
      getAddress(String(decoded[0])) !== getAddress(router.address) ||
      !isStrictlyAfter(quote, configure)
    ) throw new Error(`funded feasibility pool ${index} router configuration is invalid`);
  }

  for (const [transaction, eventName, requestId] of [
    [quote, "ProbeBestQuote", quoteRequestId],
    [swap, "ProbeBestSwap", swapRequestId],
  ] as const) {
    const matching = transaction.logs.flatMap((log) => {
      if (getAddress(log.address) !== getAddress(router.address)) return [];
      try {
        const parsed = routerInterface.parseLog({ topics: [...log.topics], data: log.data });
        return parsed?.name === eventName ? [parsed] : [];
      } catch {
        return [];
      }
    }).filter((event) =>
      getAddress(String(event.args.caller)) === caller &&
      String(event.args.requestId).toLowerCase() === requestId &&
      getAddress(String(event.args.selectedPool)) === getAddress(pool1.address)
    );
    if (matching.length !== 1) {
      throw new Error(`funded feasibility ${eventName} event is missing or ambiguous`);
    }
  }

  for (const [label, artifact] of [
    ["pool probe 0 closure and recovery", pool0],
    ["pool probe 1 closure and recovery", pool1],
    ["router probe closure and recovery", router],
  ] as const) {
    const closure = requireUniqueTransaction(transactions, label, 1);
    const contractInterface = artifact.contractName === "MpcBestExecutionRouterProbe"
      ? routerInterface
      : poolInterface;
    const decoded = contractInterface.decodeFunctionData("closeAndRecover", closure.data);
    if (
      closure.to !== getAddress(artifact.address) ||
      closure.from !== caller ||
      getAddress(String(decoded[0])) !== caller ||
      !isStrictlyAfter(closure, swap)
    ) throw new Error(`funded feasibility closure is not ordered and caller-bound: ${label}`);
  }
}

async function requireFeeCollectionBindings(
  provider: FundedEvidenceProvider,
  configuration: PublicConfiguration,
  evidenceArtifacts: readonly EvidenceArtifact[],
  transactions: readonly ActualSemanticTransaction[],
): Promise<void> {
  const pool = evidenceArtifacts.find((artifact) =>
    artifact.label === "disposable confidential fee pool"
  );
  const vault = evidenceArtifacts.find((artifact) =>
    artifact.label === "disposable fee vault"
  );
  if (!pool || !vault) throw new Error("funded fee-collection artifacts are incomplete");
  const [poolArtifact, vaultArtifact] = await Promise.all([
    artifacts.readArtifact("ConfidentialCPMM"),
    artifacts.readArtifact("CipherDEXFeeVault"),
  ]);
  const poolInterface = new Interface(poolArtifact.abi);
  const vaultInterface = new Interface(vaultArtifact.abi);
  const prematureCollection = requireUniqueTransaction(
    transactions,
    "premature confidential protocol fee collection",
    0,
  );
  const collection = requireUniqueTransaction(
    transactions,
    "mature confidential protocol fee collection",
    1,
  );
  const terminalSwap = requireUniqueTransaction(
    transactions,
    "terminal sub-threshold fee swap",
    1,
  );
  const terminalExit = requireUniqueTransaction(
    transactions,
    "full disposable fee-pool exit",
    1,
  );
  requireFeeCollectionMaturityEvidence(
    configuration,
    pool.address,
    prematureCollection,
    collection,
  );
  if (
    collection.to !== getAddress(pool.address) ||
    terminalSwap.to !== getAddress(pool.address) ||
    terminalExit.to !== getAddress(pool.address) ||
    !isStrictlyAfter(terminalSwap, collection) ||
    !isStrictlyAfter(terminalExit, terminalSwap)
  ) throw new Error("funded fee maturity rejection, collection, terminal swap, and full exit are not strictly ordered");
  const collectionCall = poolInterface.decodeFunctionData(
    "collectProtocolFees",
    collection.data,
  );
  const terminalSwapCall = poolInterface.decodeFunctionData(
    "swapExactInput",
    terminalSwap.data,
  );
  if (
    collectionCall[0] !== true ||
    collectionCall[1] !== true ||
    terminalSwapCall[2] !== true
  ) {
    throw new Error("funded fee collection calldata does not exercise both batches and token0 terminal accrual");
  }
  const [token0, token1, feeVault, feeBps, initialized, count0, count1,
    beneficiary] = await Promise.all([
      readArtifactState(provider, pool.contractName, pool.address, "token0"),
      readArtifactState(provider, pool.contractName, pool.address, "token1"),
      readArtifactState(provider, pool.contractName, pool.address, "feeVault"),
      readArtifactState(provider, pool.contractName, pool.address, "feeBps"),
      readArtifactState(provider, pool.contractName, pool.address, "initialized"),
      readArtifactState(provider, pool.contractName, pool.address, "protocolFeeSwapCount0"),
      readArtifactState(provider, pool.contractName, pool.address, "protocolFeeSwapCount1"),
      readArtifactState(provider, vault.contractName, vault.address, "beneficiary"),
    ]);
  const tokens = new Set([getAddress(String(token0)), getAddress(String(token1))]);
  const configuredTokens = new Set([
    getAddress(String(configuration.tokenA)),
    getAddress(String(configuration.tokenB)),
  ]);
  if (
    tokens.size !== 2 ||
    [...tokens].some((token) => !configuredTokens.has(token)) ||
    getAddress(String(feeVault)) !== getAddress(vault.address) ||
    BigInt(feeBps as bigint) !== BigInt(Number(configuration.totalFeeBps)) ||
    initialized !== false ||
    BigInt(count0 as bigint) !== 0n ||
    BigInt(count1 as bigint) !== 0n ||
    getAddress(String(beneficiary)) !== getAddress(String(configuration.feeBeneficiary))
  ) throw new Error("funded fee collection terminal state is inconsistent");

  const parseEvents = (
    transaction: ActualSemanticTransaction,
    address: string,
    contractInterface: Interface,
    eventName: string,
  ) => transaction.logs.flatMap((log) => {
    if (getAddress(log.address) !== getAddress(address)) return [];
    try {
      const parsed = contractInterface.parseLog({ topics: [...log.topics], data: log.data });
      return parsed?.name === eventName ? [parsed] : [];
    } catch {
      return [];
    }
  });
  const targetCount = BigInt(Number(configuration.targetSwapCountPerDirection));
  const collected = parseEvents(
    collection,
    pool.address,
    poolInterface,
    "ConfidentialProtocolFeesCollected",
  );
  const deposits = parseEvents(
    collection,
    vault.address,
    vaultInterface,
    "ConfidentialFeesDeposited",
  );
  if (
    collected.length !== 2 ||
    deposits.length !== 2 ||
    collected.some((event) =>
      !tokens.has(getAddress(String(event.args.token))) ||
      getAddress(String(event.args.feeVault)) !== getAddress(vault.address) ||
      BigInt(event.args.aggregatedSwapCount) !== targetCount
    ) ||
    deposits.some((event) =>
      !tokens.has(getAddress(String(event.args.token))) ||
      getAddress(String(event.args.pool)) !== getAddress(pool.address) ||
      BigInt(event.args.aggregatedSwapCount) !== targetCount
    )
  ) throw new Error("funded mature fee collection lacks two correlated aggregate deposits");
  const swapEvents = parseEvents(terminalSwap, pool.address, poolInterface, "SwapExecuted");
  const exitEvents = parseEvents(terminalExit, pool.address, poolInterface, "LiquidityRemoved");
  const terminalCollected = parseEvents(
    terminalExit,
    pool.address,
    poolInterface,
    "ConfidentialProtocolFeesCollected",
  );
  const terminalDeposits = parseEvents(
    terminalExit,
    vault.address,
    vaultInterface,
    "ConfidentialFeesDeposited",
  );
  if (
    swapEvents.length !== 1 ||
    getAddress(String(swapEvents[0].args.trader)) !== terminalSwap.from ||
    swapEvents[0].args.zeroForOne !== true ||
    exitEvents.length !== 1 ||
    getAddress(String(exitEvents[0].args.provider)) !== terminalExit.from ||
    terminalCollected.length !== 1 ||
    getAddress(String(terminalCollected[0].args.token)) !== getAddress(String(token0)) ||
    BigInt(terminalCollected[0].args.aggregatedSwapCount) !== 1n ||
    terminalDeposits.length !== 1 ||
    getAddress(String(terminalDeposits[0].args.token)) !== getAddress(String(token0)) ||
    getAddress(String(terminalDeposits[0].args.pool)) !== getAddress(pool.address) ||
    BigInt(terminalDeposits[0].args.aggregatedSwapCount) !== 1n
  ) throw new Error("funded terminal protocol fee is not correlated to the final swap and full exit");
  const expectedCountsByEpoch = new Map<string, {
    token: string;
    epoch: bigint;
    count: bigint;
  }>();
  for (const deposit of [...deposits, ...terminalDeposits]) {
    const token = getAddress(String(deposit.args.token));
    const epoch = BigInt(deposit.args.epoch);
    const key = `${token.toLowerCase()}:${epoch.toString()}`;
    const prior = expectedCountsByEpoch.get(key);
    expectedCountsByEpoch.set(key, {
      token,
      epoch,
      count: (prior?.count ?? 0n) + BigInt(deposit.args.aggregatedSwapCount),
    });
  }
  for (const expected of expectedCountsByEpoch.values()) {
    const recordedCount = await readArtifactState(
      provider,
      vault.contractName,
      vault.address,
      "confidentialSwapCountByEpoch",
      [expected.token, expected.epoch],
    );
    if (BigInt(recordedCount as bigint) !== expected.count) {
      throw new Error("funded vault epoch does not match the correlated aggregate deposits");
    }
  }
}

export function requireFeeCollectionMaturityEvidence(
  configuration: PublicConfiguration,
  poolAddress: string,
  prematureCollection: ActualSemanticTransaction,
  matureCollection: ActualSemanticTransaction,
): void {
  const poolInterface = new Interface(CONFIDENTIAL_CPMM_ABI);
  const prematureCall = poolInterface.decodeFunctionData(
    "collectProtocolFees",
    prematureCollection.data,
  );
  const matureCall = poolInterface.decodeFunctionData(
    "collectProtocolFees",
    matureCollection.data,
  );
  const collectionReadyAt = Number(configuration.collectionReadyAt);
  if (
    prematureCollection.status !== 0 ||
    matureCollection.status !== 1 ||
    prematureCollection.to !== getAddress(poolAddress) ||
    matureCollection.to !== getAddress(poolAddress) ||
    prematureCall[0] !== true ||
    prematureCall[1] !== true ||
    matureCall[0] !== true ||
    matureCall[1] !== true ||
    !Number.isSafeInteger(collectionReadyAt) ||
    collectionReadyAt <= 0 ||
    prematureCollection.blockTimestamp >= collectionReadyAt ||
    matureCollection.blockTimestamp < collectionReadyAt ||
    !isStrictlyAfter(matureCollection, prematureCollection)
  ) throw new Error("funded fee maturity rejection and successful collection are not chain-ordered around readyAt");
}

async function requireArtifactCreationBindings(
  provider: FundedEvidenceProvider,
  runner: string,
  configuration: PublicConfiguration,
  evidenceArtifacts: readonly EvidenceArtifact[],
  transactions: readonly ActualSemanticTransaction[],
): Promise<void> {
  await requireDirectCreationBindings(evidenceArtifacts, transactions);
  await requireFactoryChildBindings(provider, evidenceArtifacts, transactions);
  await requireMigratorConstructorChildBinding(provider, evidenceArtifacts, transactions);
  if (runner === "best-execution-feasibility") {
    await requireBestExecutionFeasibilityBindings(
      provider,
      configuration,
      evidenceArtifacts,
      transactions,
    );
  }
  if (runner === "fee-collection") {
    await requireFeeCollectionBindings(
      provider,
      configuration,
      evidenceArtifacts,
      transactions,
    );
  }
}

type LaunchpadCall = Readonly<{
  transaction: ActualSemanticTransaction;
  selector: string;
  request: ReturnType<Interface["decodeFunctionData"]>[number];
  withDisposition: boolean;
  disposition: number;
  unlockTime: bigint;
}>;

function decodeLaunchpadCall(transaction: ActualSemanticTransaction): LaunchpadCall | null {
  const selector = transaction.data.slice(0, 10).toLowerCase();
  if (selector !== SELECTOR.launchpadMigrate && selector !== SELECTOR.launchpadMigrateWithDisposition) {
    return null;
  }
  const withDisposition = selector === SELECTOR.launchpadMigrateWithDisposition;
  const decoded = LAUNCHPAD_INTERFACE.decodeFunctionData(
    withDisposition ? "migrateWithDisposition" : "migrate",
    transaction.data,
  );
  return Object.freeze({
    transaction,
    selector,
    request: decoded[0],
    withDisposition,
    disposition: withDisposition ? Number(decoded[1]) : 0,
    unlockTime: withDisposition ? BigInt(decoded[2]) : 0n,
  });
}

function launchpadPublicEnvelope(call: LaunchpadCall): string {
  const request = call.request;
  return JSON.stringify([
    call.selector,
    call.transaction.from.toLowerCase(),
    call.transaction.to?.toLowerCase(),
    ...[0, 1, 2, 3, 4, 5, 6, 12].map((index) => String(request[index]).toLowerCase()),
    call.withDisposition,
    call.disposition,
    call.unlockTime.toString(),
  ]);
}

function requireLaunchpadAuthorization(
  call: LaunchpadCall,
  chainId: number,
  initializationStrategy: string,
): void {
  if (call.transaction.to === null) throw new Error("funded launchpad target is missing");
  const request = call.request;
  const recovered = verifyTypedData(
    {
      ...LAUNCHPAD_MIGRATOR_EIP712_DOMAIN,
      chainId,
      verifyingContract: call.transaction.to,
    },
    { Migration: [...LAUNCHPAD_MIGRATION_EIP712_TYPES] },
    {
      launchId: request[0],
      launchCommitmentHash: request[1],
      initializationStrategy,
      creator: call.transaction.from,
      tokenA: request[2],
      tokenB: request[3],
      decimalsA: request[4],
      decimalsB: request[5],
      feeBps: request[6],
      encryptedInputsHash: keccak256(AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "bytes32", "bytes32", "bytes32", "bytes32"],
        [7, 8, 9, 10, 11].map((index) => encryptedInputCommitment(request[index])),
      )),
      deadline: request[12],
      withDisposition: call.withDisposition,
      disposition: call.disposition,
      unlockTime: call.unlockTime,
    },
    String(request[13]),
  );
  if (getAddress(recovered) !== getAddress(call.transaction.from)) {
    throw new Error("funded launchpad authorization is not bound to its caller");
  }
}

type ParsedSemanticEvent = NonNullable<ReturnType<Interface["parseLog"]>>;

function requireBestExecutionResultEvent(
  call: BestExecutionCall,
  poolsByFee: ReadonlyMap<number, string>,
  launchStrategy: string,
): ParsedSemanticEvent {
  const { transaction, selector, candidateBitmap, requestId } = call;
  const eventName = selector === SELECTOR.bestQuote
    ? "ConfidentialBestQuoteResult"
    : "ConfidentialBestSwapResult";
  const matches = transaction.logs.flatMap((log) => {
    if (transaction.to === null || getAddress(log.address) !== getAddress(transaction.to)) {
      return [];
    }
    try {
      const parsed = BEST_EXECUTION_INTERFACE.parseLog({
        topics: [...log.topics],
        data: log.data,
      });
      return parsed?.name === eventName ? [parsed] : [];
    } catch {
      return [];
    }
  }).filter((event) =>
    getAddress(String(event.args.caller)) === getAddress(transaction.from) &&
    String(event.args.requestId).toLowerCase() === requestId &&
    Number(event.args.candidateBitmap) === candidateBitmap &&
    poolsByFee.get(Number(event.args.selectedFeeBps)) ===
      getAddress(String(event.args.selectedPool)) &&
    getAddress(String(event.args.selectedInitializationStrategy)) ===
      (Number(event.args.selectedFeeBps) === 30 ? launchStrategy : ZeroAddress) &&
    Boolean(event.args.zeroForOne) === (BigInt(call.tokenIn) < BigInt(call.tokenOut))
  );
  if (matches.length !== 1) {
    throw new Error("funded best-execution result event is missing or ambiguous");
  }
  return matches[0];
}

type LaunchCommitmentBinding = Readonly<{
  transaction: ActualSemanticTransaction;
  launchId: string;
  commitmentHash: string;
  creator: string;
  launchAuthority: string;
  pool: string;
}>;

export function requireProtectedPoolLifecycleOrder(input: Readonly<{
  poolAddress: string;
  commitment: ActualSemanticTransaction;
  rejectedProbe: ActualSemanticTransaction;
  migration: ActualSemanticTransaction;
  replay: ActualSemanticTransaction;
  firstExit: ActualSemanticTransaction;
  reseed: ActualSemanticTransaction;
  finalExit: ActualSemanticTransaction;
}>): void {
  const poolAddress = getAddress(input.poolAddress);
  if (
    input.firstExit.to !== poolAddress ||
    input.reseed.to !== poolAddress ||
    input.finalExit.to !== poolAddress ||
    !isStrictlyAfter(input.rejectedProbe, input.commitment) ||
    !isStrictlyAfter(input.migration, input.rejectedProbe) ||
    !isStrictlyAfter(input.replay, input.migration) ||
    !isStrictlyAfter(input.firstExit, input.replay) ||
    !isStrictlyAfter(input.reseed, input.firstExit) ||
    !isStrictlyAfter(input.finalExit, input.reseed)
  ) {
    throw new Error(
      "funded protected-pool lifecycle is not strictly commit/reject/migrate/replay/exit/reseed/exit ordered",
    );
  }
}

function requireLaunchCommitmentBinding(input: Readonly<{
  transactionLabel: string;
  expectedFeeBps: number;
  expectedStrategyArtifactLabel: string;
  expectedFactoryArtifactLabel: string;
  expectedMigratorArtifactLabel: string;
  expectedPoolArtifactLabel: string;
  configuration: PublicConfiguration;
  transactions: readonly ActualSemanticTransaction[];
  artifacts: readonly Readonly<{ label: string; address: string }>[];
  participants: readonly string[];
}>): LaunchCommitmentBinding {
  const transaction = requireUniqueTransaction(
    input.transactions,
    input.transactionLabel,
    1,
  );
  const strategy = artifactAddress(
    input.artifacts,
    input.expectedStrategyArtifactLabel,
  );
  if (
    transaction.to !== strategy ||
    transaction.data.slice(0, 10).toLowerCase() !== SELECTOR.commitLaunch
  ) throw new Error("funded launch commitment does not target the reviewed strategy");

  const decoded = INITIALIZATION_STRATEGY_INTERFACE.decodeFunctionData(
    "commitLaunch",
    transaction.data,
  );
  const commitment = decoded[0] as readonly unknown[];
  const creatorAuthorization = String(decoded[1]);
  const authorityAuthorization = String(decoded[2]);
  const typedCommitment = {
    launchId: String(commitment[0]),
    creator: getAddress(String(commitment[1])),
    token0: getAddress(String(commitment[2])),
    token1: getAddress(String(commitment[3])),
    decimals0: Number(commitment[4]),
    decimals1: Number(commitment[5]),
    feeBps: BigInt(commitment[6] as bigint),
    privacyMode: Number(commitment[7]),
    poolVersion: BigInt(commitment[8] as bigint),
    factory: getAddress(String(commitment[9])),
    migrator: getAddress(String(commitment[10])),
    initializationStrategy: getAddress(String(commitment[11])),
    launchAuthority: getAddress(String(commitment[12])),
    chainId: BigInt(commitment[13] as bigint),
    authorizationDeadline: BigInt(commitment[14] as bigint),
    migrationDeadline: BigInt(commitment[15] as bigint),
  } as const;
  const expectedTokens = new Set([
    getAddress(String(input.configuration.tokenA)),
    getAddress(String(input.configuration.tokenB)),
  ]);
  const expectedFactory = artifactAddress(input.artifacts, input.expectedFactoryArtifactLabel);
  const expectedMigrator = artifactAddress(input.artifacts, input.expectedMigratorArtifactLabel);
  const expectedPool = artifactAddress(input.artifacts, input.expectedPoolArtifactLabel);
  const reviewedParticipants = new Set(
    input.participants.map((participant) => getAddress(participant)),
  );
  if (
    typedCommitment.launchId.toLowerCase() === `0x${"00".repeat(32)}` ||
    typedCommitment.token0.toLowerCase() >= typedCommitment.token1.toLowerCase() ||
    !expectedTokens.has(typedCommitment.token0) ||
    !expectedTokens.has(typedCommitment.token1) ||
    typedCommitment.decimals0 < 0 ||
    typedCommitment.decimals0 > 18 ||
    typedCommitment.decimals1 < 0 ||
    typedCommitment.decimals1 > 18 ||
    typedCommitment.feeBps !== BigInt(input.expectedFeeBps) ||
    typedCommitment.privacyMode !== Number(input.configuration.privacyMode) ||
    typedCommitment.poolVersion !== BigInt(Number(input.configuration.confidentialPoolVersion)) ||
    typedCommitment.factory !== expectedFactory ||
    typedCommitment.migrator !== expectedMigrator ||
    typedCommitment.initializationStrategy !== strategy ||
    typedCommitment.chainId !== BigInt(Number(input.configuration.chainId)) ||
    typedCommitment.authorizationDeadline < BigInt(transaction.blockTimestamp) ||
    typedCommitment.migrationDeadline < typedCommitment.authorizationDeadline ||
    typedCommitment.creator === typedCommitment.launchAuthority ||
    transaction.from !== typedCommitment.creator ||
    !reviewedParticipants.has(typedCommitment.creator) ||
    !reviewedParticipants.has(typedCommitment.launchAuthority)
  ) throw new Error("funded launch commitment tuple is not bound to reviewed configuration");

  const domain = {
    ...LAUNCH_INITIALIZATION_EIP712_DOMAIN,
    chainId: typedCommitment.chainId,
    verifyingContract: strategy,
  } as const;
  const types = { LaunchCommitment: [...LAUNCH_COMMITMENT_EIP712_TYPES] };
  const commitmentHash = TypedDataEncoder.hash(domain, types, typedCommitment);
  const recoveredCreator = verifyTypedData(
    domain,
    types,
    typedCommitment,
    creatorAuthorization,
  );
  const recoveredAuthority = verifyTypedData(
    domain,
    types,
    typedCommitment,
    authorityAuthorization,
  );
  if (
    getAddress(recoveredCreator) !== typedCommitment.creator ||
    getAddress(recoveredAuthority) !== typedCommitment.launchAuthority
  ) throw new Error("funded launch commitment lacks independent creator and authority signatures");

  const events = transaction.logs.flatMap((log) => {
    if (getAddress(log.address) !== strategy) return [];
    try {
      const parsed = INITIALIZATION_STRATEGY_INTERFACE.parseLog({
        topics: [...log.topics],
        data: log.data,
      });
      return parsed?.name === "LaunchCommitted" ? [parsed] : [];
    } catch {
      return [];
    }
  }).filter((event) =>
    String(event.args.launchId).toLowerCase() === typedCommitment.launchId.toLowerCase() &&
    String(event.args.poolKey).toLowerCase() !== `0x${"00".repeat(32)}` &&
    getAddress(String(event.args.pool)) === expectedPool &&
    getAddress(String(event.args.creator)) === typedCommitment.creator &&
    BigInt(event.args.migrationDeadline) === typedCommitment.migrationDeadline &&
    String(event.args.commitmentHash).toLowerCase() === commitmentHash.toLowerCase()
  );
  if (events.length !== 1) {
    throw new Error("funded launch commitment event is missing or not signature-bound");
  }
  return Object.freeze({
    transaction,
    launchId: typedCommitment.launchId.toLowerCase(),
    commitmentHash: commitmentHash.toLowerCase(),
    creator: typedCommitment.creator,
    launchAuthority: typedCommitment.launchAuthority,
    pool: expectedPool,
  });
}

export function requireOnchainSemanticBindings(
  runner: string,
  configuration: PublicConfiguration,
  transactions: readonly ActualSemanticTransaction[],
  artifacts: readonly Readonly<{ label: string; address: string }>[],
  participants: readonly string[],
): void {
  if (runner === "best-execution") {
    const expectedBitmap = Number(configuration.candidateBitmap);
    const allowedBitmaps = new Set([expectedBitmap, expectedBitmap & ~1]);
    const expectedTokens = new Set([
      getAddress(String(configuration.tokenA)).toLowerCase(),
      getAddress(String(configuration.tokenB)).toLowerCase(),
    ]);
    const calls = transactions.flatMap((transaction) => {
      const call = decodeBestExecutionCall(transaction);
      return call === null ? [] : [call];
    });
    const poolsByFee = new Map([
      [5, artifactAddress(artifacts, "5 bps standard canonical pool")],
      [30, artifactAddress(artifacts, "30 bps launch-protected canonical pool")],
      [100, artifactAddress(artifacts, "100 bps standard canonical pool")],
    ]);
    const launchStrategy = artifactAddress(
      artifacts,
      "disposable launch initialization strategy",
    );
    for (const call of calls) {
      const { transaction, selector, tokenIn, tokenOut, candidateBitmap, requestId, deadline } = call;
      if (
        tokenIn === tokenOut ||
        !expectedTokens.has(tokenIn) ||
        !expectedTokens.has(tokenOut) ||
        !allowedBitmaps.has(candidateBitmap) ||
        requestId === `0x${"00".repeat(32)}` ||
        deadline <= 0n ||
        (transaction.status === 1 && deadline < BigInt(transaction.blockTimestamp))
      ) throw new Error("funded best-execution calldata does not match reviewed semantics");

      if (transaction.status === 1) {
        requireBestExecutionResultEvent(call, poolsByFee, launchStrategy);
      }
    }

    if (configuration.confidentialPoolVersion !== undefined) {
      const tokenA = getAddress(String(configuration.tokenA)).toLowerCase();
      const tokenB = getAddress(String(configuration.tokenB)).toLowerCase();
      const mixedTwoBitmap = expectedBitmap & ~1;
    const requireSelection = (
      label: string,
      selector: string,
      expectedFeeBps: number | undefined,
      bitmap: number,
      tokenIn: string,
      tokenOut: string,
    ) => {
      const call = decodeBestExecutionCall(requireUniqueTransaction(transactions, label, 1));
      if (
        !call ||
        call.selector !== selector ||
        call.candidateBitmap !== bitmap ||
        call.tokenIn !== tokenIn ||
        call.tokenOut !== tokenOut
      ) throw new Error(`funded best-execution path is not exact: ${label}`);
      const event = requireBestExecutionResultEvent(call, poolsByFee, launchStrategy);
      if (
        expectedFeeBps !== undefined &&
        Number(event.args.selectedFeeBps) !== expectedFeeBps
      ) throw new Error(`funded best-execution selected the wrong tier: ${label}`);
      return Object.freeze({ call, event });
    };
    requireLaunchCommitmentBinding({
      transactionLabel: "commit protected 30 bps launch",
      expectedFeeBps: 30,
      expectedStrategyArtifactLabel: "disposable launch initialization strategy",
      expectedFactoryArtifactLabel: "disposable confidential factory",
      expectedMigratorArtifactLabel: "disposable launchpad migrator",
      expectedPoolArtifactLabel: "30 bps launch-protected canonical pool",
      configuration,
      transactions,
      artifacts,
      participants,
    });
    requireSelection(
      "two-candidate quote with absent tier",
      SELECTOR.bestQuote,
      100,
      mixedTwoBitmap,
      tokenB,
      tokenA,
    );
    const twoCandidateQuote = requireSelection(
      "two-candidate quote with uninitialized tier",
      SELECTOR.bestQuote,
      100,
      expectedBitmap,
      tokenB,
      tokenA,
    );
    const twoCandidateSwap = requireSelection(
      "two-candidate quote-plus-swap",
      SELECTOR.bestSwap,
      100,
      expectedBitmap,
      tokenB,
      tokenA,
    );
    const threeCandidateQuote = requireSelection(
      "three-candidate quote",
      SELECTOR.bestQuote,
      5,
      expectedBitmap,
      tokenB,
      tokenA,
    );
    const threeCandidateSwap = requireSelection(
      "three-candidate quote-plus-swap",
      SELECTOR.bestSwap,
      5,
      expectedBitmap,
      tokenB,
      tokenA,
    );
    const protectedQuote = requireSelection(
      "post-tie 30 bps selection quote",
      SELECTOR.bestQuote,
      30,
      expectedBitmap,
      tokenB,
      tokenA,
    );
    const protectedSwap = requireSelection(
      "post-tie 30 bps quote-plus-swap",
      SELECTOR.bestSwap,
      30,
      expectedBitmap,
      tokenB,
      tokenA,
    );
    requireSelection(
      "encrypted-invalid candidate isolation quote",
      SELECTOR.bestQuote,
      100,
      expectedBitmap,
      tokenB,
      tokenA,
    );
    const reverseQuote = requireSelection(
      "reverse three-candidate quote",
      SELECTOR.bestQuote,
      undefined,
      expectedBitmap,
      tokenA,
      tokenB,
    );
    const reverseSwap = requireSelection(
      "reverse three-candidate quote-plus-swap",
      SELECTOR.bestSwap,
      undefined,
      expectedBitmap,
      tokenA,
      tokenB,
    );
      for (const [quote, swap, label] of [
        [twoCandidateQuote, twoCandidateSwap, "100 bps"],
        [threeCandidateQuote, threeCandidateSwap, "5 bps"],
        [protectedQuote, protectedSwap, "protected 30 bps"],
        [reverseQuote, reverseSwap, "reverse"],
      ] as const) {
        if (
          getAddress(String(quote.event.args.selectedPool)) !==
            getAddress(String(swap.event.args.selectedPool)) ||
          Number(quote.event.args.selectedFeeBps) !== Number(swap.event.args.selectedFeeBps) ||
          getAddress(String(quote.event.args.selectedInitializationStrategy)) !==
            getAddress(String(swap.event.args.selectedInitializationStrategy)) ||
          !isStrictlyAfter(swap.call.transaction, quote.call.transaction)
        ) throw new Error(`funded ${label} quote and settlement are not correlated`);
      }
    }

    const reference = decodeBestExecutionCall(requireUniqueTransaction(
      transactions,
      "two-candidate quote with uninitialized tier",
      1,
    ))!;
    const requestReplay = decodeBestExecutionCall(requireUniqueTransaction(
      transactions,
      "best quote request-id replay",
      0,
    ))!;
    if (
      !sameBestExecutionEnvelope(reference, requestReplay) ||
      reference.transaction.from !== requestReplay.transaction.from ||
      reference.requestId !== requestReplay.requestId ||
      reference.inputCommitment === requestReplay.inputCommitment ||
      !isStrictlyAfter(requestReplay.transaction, reference.transaction)
    ) throw new Error("funded request-id replay is not correlated to its successful reference");

    const ciphertextReplay = decodeBestExecutionCall(requireUniqueTransaction(
      transactions,
      "best quote ciphertext replay",
      0,
    ))!;
    if (
      !sameBestExecutionEnvelope(reference, ciphertextReplay) ||
      reference.transaction.from !== ciphertextReplay.transaction.from ||
      reference.inputCommitment !== ciphertextReplay.inputCommitment ||
      reference.requestId === ciphertextReplay.requestId ||
      !isStrictlyAfter(ciphertextReplay.transaction, reference.transaction)
    ) throw new Error("funded ciphertext replay is not correlated to its successful reference");

    const expired = decodeBestExecutionCall(requireUniqueTransaction(
      transactions,
      "best quote expired deadline",
      0,
    ))!;
    if (
      !sameBestExecutionEnvelope(reference, expired) ||
      expired.deadline > BigInt(expired.transaction.blockTimestamp)
    ) throw new Error("funded expired-deadline rejection is not chain-proven");

    const callerFailure = decodeBestExecutionCall(requireUniqueTransaction(
      transactions,
      "caller-bound ciphertext isolation",
      0,
    ))!;
    const callerControl = decodeBestExecutionCall(requireUniqueTransaction(
      transactions,
      "caller-bound ciphertext primary control",
      1,
    ))!;
    if (
      !sameBestExecutionEnvelope(callerFailure, callerControl) ||
      callerFailure.inputCommitment !== callerControl.inputCommitment ||
      callerFailure.requestId !== callerControl.requestId ||
      callerFailure.deadline !== callerControl.deadline ||
      callerFailure.transaction.from === callerControl.transaction.from ||
      !isStrictlyAfter(callerControl.transaction, callerFailure.transaction)
    ) throw new Error("funded caller-bound ciphertext isolation lacks its successful control");

    for (const failed of calls.filter((call) =>
      call.transaction.status === 0 && call.transaction.label.endsWith(" encrypted slippage rollback")
    )) {
      const successLabel = failed.transaction.label.replace(/ encrypted slippage rollback$/u, "");
      const successful = decodeBestExecutionCall(requireUniqueTransaction(
        transactions,
        successLabel,
        1,
      ))!;
      if (
        !sameBestExecutionEnvelope(failed, successful) ||
        failed.transaction.from !== successful.transaction.from ||
        failed.inputCommitment !== successful.inputCommitment ||
        failed.requestId !== successful.requestId ||
        failed.minimumCommitment === successful.minimumCommitment ||
        !isStrictlyAfter(successful.transaction, failed.transaction)
      ) throw new Error("funded encrypted-minimum rollback lacks a correlated successful control");
    }
  }

  if (runner === "launchpad" || runner === "configured-launchpad") {
    const configuredLaunchpad = runner === "configured-launchpad";
    const strategyArtifactLabel = configuredLaunchpad
      ? "configured launch initialization strategy"
      : "disposable launch initialization strategy";
    const factoryArtifactLabel = configuredLaunchpad
      ? "configured launchpad confidential factory"
      : "disposable launchpad confidential factory";
    const migratorArtifactLabel = configuredLaunchpad
      ? "configured launchpad migrator"
      : "disposable launchpad migrator";
    const poolArtifactLabel = configuredLaunchpad
      ? "configured launchpad pool"
      : "disposable launchpad pool";
    const expectedTokens = new Set([
      getAddress(String(configuration.tokenA)).toLowerCase(),
      getAddress(String(configuration.tokenB)).toLowerCase(),
    ]);
    const calls = transactions.flatMap((transaction) => {
      const call = decodeLaunchpadCall(transaction);
      return call === null ? [] : [call];
    });
    const initializationStrategy = artifactAddress(
      artifacts,
      strategyArtifactLabel,
    );
    const commitment = requireLaunchCommitmentBinding({
      transactionLabel: "launch commitment",
      expectedFeeBps: Number(configuration.feeBps),
      expectedStrategyArtifactLabel: strategyArtifactLabel,
      expectedFactoryArtifactLabel: factoryArtifactLabel,
      expectedMigratorArtifactLabel: migratorArtifactLabel,
      expectedPoolArtifactLabel: poolArtifactLabel,
      configuration,
      transactions,
      artifacts,
      participants,
    });
    for (const call of calls) {
      const { transaction, request } = call;
      const requestTokens = new Set([
        getAddress(String(request[2])).toLowerCase(),
        getAddress(String(request[3])).toLowerCase(),
      ]);
      if (
        requestTokens.size !== 2 ||
        [...requestTokens].some((token) => !expectedTokens.has(token)) ||
        Number(request[6]) !== Number(configuration.feeBps) ||
        BigInt(request[12]) <= 0n ||
        String(request[0]).toLowerCase() === `0x${"00".repeat(32)}`
      ) throw new Error("funded launchpad calldata does not match reviewed semantics");
      requireLaunchpadAuthorization(call, Number(configuration.chainId), initializationStrategy);
    }

    const rejected = decodeLaunchpadCall(requireUniqueTransaction(
      transactions,
      "rejected launchpad price-bound probe",
      0,
    ))!;
    const migrated = decodeLaunchpadCall(requireUniqueTransaction(
      transactions,
      "atomic launchpad migration",
      1,
    ))!;
    const replay = decodeLaunchpadCall(requireUniqueTransaction(
      transactions,
      "launchpad replay probe",
      0,
    ))!;
    if (
      launchpadPublicEnvelope(rejected) !== launchpadPublicEnvelope(migrated) ||
      rejected.transaction.data === migrated.transaction.data ||
      BigInt(rejected.request[12]) < BigInt(rejected.transaction.blockTimestamp) ||
      BigInt(migrated.request[12]) < BigInt(migrated.transaction.blockTimestamp)
    ) throw new Error("funded alternate-bound launch rejection is not correlated to migration");
    if (
      replay.transaction.data !== migrated.transaction.data ||
      replay.transaction.from !== migrated.transaction.from ||
      replay.transaction.to !== migrated.transaction.to
    ) throw new Error("funded launchpad replay is not an exact replay of migration");

    const directQuote = requireUniqueTransaction(
      transactions,
      "launchpad pool direct paid quote",
      1,
    );
    const directSwap = requireUniqueTransaction(
      transactions,
      "launchpad pool direct private swap",
      1,
    );
    const partialExit = requireUniqueTransaction(
      transactions,
      "protected launchpad pool partial exit",
      1,
    );

    const firstExit = requireUniqueTransaction(
      transactions,
      "protected launchpad pool first full exit",
      1,
    );
    const reseed = requireUniqueTransaction(
      transactions,
      "protected pool ordinary re-seed",
      1,
    );
    const finalExitLabel = configuredLaunchpad
      ? "full configured launchpad-pool exit"
      : "full disposable launchpad-pool exit";
    const finalExit = requireUniqueTransaction(
      transactions,
      finalExitLabel,
      1,
    );
    const poolAddress = artifactAddress(artifacts, poolArtifactLabel);
    if (
      commitment.launchId !== String(migrated.request[0]).toLowerCase() ||
      commitment.commitmentHash !== String(migrated.request[1]).toLowerCase() ||
      commitment.creator !== migrated.transaction.from ||
      commitment.pool !== poolAddress ||
      directQuote.to !== poolAddress ||
      directSwap.to !== poolAddress ||
      partialExit.to !== poolAddress ||
      firstExit.to !== poolAddress ||
      reseed.to !== poolAddress ||
      finalExit.to !== poolAddress ||
      !isStrictlyAfter(directQuote, replay.transaction) ||
      !isStrictlyAfter(directSwap, directQuote) ||
      !isStrictlyAfter(partialExit, directSwap) ||
      !isStrictlyAfter(firstExit, partialExit)
    ) throw new Error("funded protected-pool lifecycle is not bound to the committed pool");
    requireProtectedPoolLifecycleOrder({
      poolAddress,
      commitment: commitment.transaction,
      rejectedProbe: rejected.transaction,
      migration: migrated.transaction,
      replay: replay.transaction,
      firstExit,
      reseed,
      finalExit,
    });

    const events = migrated.transaction.logs.flatMap((log) => {
      if (migrated.transaction.to === null || getAddress(log.address) !== getAddress(migrated.transaction.to)) {
        return [];
      }
      try {
        const parsed = LAUNCHPAD_INTERFACE.parseLog({ topics: [...log.topics], data: log.data });
        return parsed?.name === "LaunchpadMigration" ? [parsed] : [];
      } catch {
        return [];
      }
    }).filter((event) =>
      String(event.args.launchId).toLowerCase() === String(migrated.request[0]).toLowerCase() &&
      getAddress(String(event.args.creator)) === getAddress(migrated.transaction.from) &&
      getAddress(String(event.args.pool)) === poolAddress &&
      getAddress(String(event.args.initializationStrategy)) === initializationStrategy &&
      String(event.args.launchCommitmentHash).toLowerCase() === String(migrated.request[1]).toLowerCase()
    );
    if (events.length !== 1) throw new Error("funded launchpad migration event is missing or ambiguous");
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
    record.outcome !== "passed" ||
    !record.attestation ||
    record.attestation.scheme !== "eip191" ||
    typeof record.attestation.digest !== "string" ||
    !HASH.test(record.attestation.digest) ||
    typeof record.attestation.signer !== "string" ||
    typeof record.attestation.signature !== "string" ||
    !/^0x[0-9a-fA-F]{130}$/.test(record.attestation.signature)
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
  const directCreationHashes = new Set<string>();
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
      !Number.isSafeInteger(artifact.immutableReferenceCount) ||
      artifact.immutableReferenceCount < 0 ||
      !artifact.settings ||
      typeof artifact.settings.viaIR !== "boolean" ||
      !artifact.settings.optimizer ||
      typeof artifact.settings.optimizer.enabled !== "boolean"
    ) throw new Error("funded run evidence has an invalid artifact");
    requireLabel(artifact.label, "artifact label");
    getAddress(artifact.address);
    requireHash(artifact.runtimeCodehash, "runtime code hash");
    requireHash(artifact.compilerInputHash, "compiler input hash");
    const hasCreationHash = artifact.creationTransactionHash !== undefined;
    const hasConstructorArguments = artifact.constructorArguments !== undefined;
    if (hasCreationHash !== hasConstructorArguments) {
      throw new Error("funded artifact direct creation binding is incomplete");
    }
    if (hasCreationHash) {
      if (NESTED_CREATION_CONTRACTS.has(artifact.contractName)) {
        throw new Error("funded nested artifact cannot claim a direct creation transaction");
      }
      const creationHash = requireHash(
        String(artifact.creationTransactionHash),
        "artifact creation transaction",
      );
      normalizeFundedEvidenceConstructorArguments(artifact.constructorArguments);
      if (directCreationHashes.has(creationHash)) {
        throw new Error("funded artifacts repeat a direct creation transaction");
      }
      directCreationHashes.add(creationHash);
    } else if (!NESTED_CREATION_CONTRACTS.has(artifact.contractName)) {
      throw new Error("funded directly deployed artifact lacks constructor provenance");
    }
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
      || typeof resource.creationTransactionHash !== "string" ||
      !Array.isArray(resource.recoveryTransactionHashes) ||
      resource.recoveryTransactionHashes.length === 0 ||
      !isRecoveryResourceMetadata(resource.metadata)
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
    for (const recoveryHash of resource.recoveryTransactionHashes) {
      const normalizedHash = requireHash(recoveryHash, "resource recovery transaction");
      const recovery = record.transactions.find((transaction) =>
        transaction.hash.toLowerCase() === normalizedHash
      );
      if (!recovery || recovery.status !== 1) {
        throw new Error("funded evidence resource lacks successful recovery transactions");
      }
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

  const signer = getAddress(record.attestation.signer);
  if (signer !== normalizedOwner) {
    throw new Error("funded evidence attestation signer is not the funded owner");
  }
  const digest = attestationDigest(record as FundedRunEvidence);
  if (digest !== record.attestation.digest.toLowerCase()) {
    throw new Error("funded evidence attestation digest does not match its payload");
  }
  let recoveredSigner: string;
  try {
    recoveredSigner = verifyMessage(getBytes(digest), record.attestation.signature);
  } catch (error) {
    throw new Error("funded evidence owner attestation is invalid", { cause: error });
  }
  if (recoveredSigner !== normalizedOwner) {
    throw new Error("funded evidence owner attestation is invalid");
  }

  return Object.freeze({
    ...(record as FundedRunEvidence),
    owner: normalizedOwner,
    participants: Object.freeze(participants),
    deployment,
    configuration: canonical,
    attestation: Object.freeze({
      ...record.attestation,
      digest,
      signer,
    }),
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
  const semanticTransactions: ActualSemanticTransaction[] = [];
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
      immutableReferenceCount: artifact.immutableReferenceCount,
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
      !Number.isSafeInteger(block.timestamp) ||
      block.timestamp < 0 ||
      block.hash.toLowerCase() !== transaction.blockHash.toLowerCase()
    ) throw new Error(`funded evidence receipt changed: ${transaction.label}`);
    semanticTransactions.push(Object.freeze({
      label: transaction.label,
      hash: transaction.hash,
      status: transaction.status,
      from: getAddress(actualTransaction.from),
      to: actualTransaction.to === null ? null : getAddress(actualTransaction.to),
      data: actualTransaction.data,
      contractAddress: receipt.contractAddress === null
        ? null
        : getAddress(receipt.contractAddress),
      blockNumber: receipt.blockNumber,
      transactionIndex: (() => {
        const index = Number(receipt.index);
        if (!Number.isSafeInteger(index) || index < 0) {
          throw new Error(`funded receipt transaction index is invalid: ${transaction.label}`);
        }
        return index;
      })(),
      blockTimestamp: block.timestamp,
      logs: receipt.logs,
    }));
  }
  requireOnchainSemanticBindings(
    parsed.runner,
    parsed.configuration,
    semanticTransactions,
    parsed.artifacts,
    parsed.participants,
  );
  await requireArtifactCreationBindings(
    provider,
    parsed.runner,
    parsed.configuration,
    parsed.artifacts,
    semanticTransactions,
  );
  for (const resource of parsed.recoveredResources) {
    await verifyRecoveryResourceCreation(
      {
        identity: { owner: parsed.owner, chainId: parsed.chainId },
        transactions: parsed.transactions.map((transaction) => ({
          label: transaction.label,
          hash: transaction.hash,
          status: transaction.status === 1 ? "mined-success" : "mined-failure",
          blockNumber: transaction.blockNumber,
        })),
      },
      { ...resource, recovered: true } satisfies RecoveryResource,
      provider,
    );
    await verifyRecoveryResourceTerminalState(
      {
        identity: { owner: parsed.owner, chainId: parsed.chainId },
        transactions: parsed.transactions.map((transaction) => ({
          label: transaction.label,
          hash: transaction.hash,
          status: transaction.status === 1 ? "mined-success" : "mined-failure",
          blockNumber: transaction.blockNumber,
        })),
      },
      { ...resource, recovered: true } satisfies RecoveryResource,
      provider,
    );
  }
}

export async function writeFundedRunEvidence(input: Readonly<{
  journal: FundedRecoveryJournal;
  provider: FundedEvidenceProvider;
  attestationSigner: FundedEvidenceAttestationSigner;
  configuration: PublicConfiguration;
  artifacts: readonly FundedEvidenceArtifactPlan[];
  assertions: readonly string[];
  participants: readonly string[];
  directory?: string;
}>): Promise<Readonly<{ path: string; evidence: FundedRunEvidence }>> {
  if (
    input.journal.runStatus !== "evidence-pending" &&
    input.journal.runStatus !== "evidence-failed"
  ) {
    throw new Error("funded run must have a durable pending evidence plan");
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
    artifacts.push(Object.freeze({
      label: artifact.label,
      address,
      ...provenance,
      ...(artifact.creationTransactionHash === undefined
        ? {}
        : {
            creationTransactionHash: requireHash(
              artifact.creationTransactionHash,
              "artifact creation transaction",
            ),
            constructorArguments: normalizeFundedEvidenceConstructorArguments(
              artifact.constructorArguments,
            ),
          }),
    }));
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
  for (const resource of input.journal.resources) {
    await verifyRecoveryResourceCreation(input.journal, resource, input.provider);
    await verifyRecoveryResourceTerminalState(input.journal, resource, input.provider);
  }
  requireRunnerPolicy(identity.runner, configuration, artifacts, assertions, transactions);
  const unsignedEvidence = {
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
      recoveryTransactionHashes: resource.recoveryTransactionHashes,
      metadata: resource.metadata,
    })),
    assertions,
    outcome: "passed",
  } as const;
  const attestationSigner = getAddress(await input.attestationSigner.getAddress());
  if (attestationSigner !== getAddress(identity.owner)) {
    throw new Error("funded evidence signer is not the funded owner");
  }
  const digest = attestationDigest(unsignedEvidence);
  const signature = await input.attestationSigner.signMessage(getBytes(digest));
  const evidence = parseEvidence({
    ...unsignedEvidence,
    attestation: {
      scheme: "eip191",
      digest,
      signer: attestationSigner,
      signature,
    },
  });
  await verifyFundedRunEvidence(evidence, input.provider);

  const path = resolve(
    input.directory ?? ".testnet-state/evidence",
    `${identity.runner}-${identity.sourceCommit}.json`,
  );
  mkdirSync(dirname(path), { recursive: true });
  writeUtf8FileAtomic(path, `${JSON.stringify(evidence, null, 2)}\n`);
  input.journal.markRun("passed");
  return Object.freeze({ path, evidence });
}

export async function writePreparedFundedRunEvidence(input: Readonly<{
  journal: FundedRecoveryJournal;
  provider: FundedEvidenceProvider;
  attestationSigner: FundedEvidenceAttestationSigner;
  directory?: string;
}>): Promise<Readonly<{ path: string; evidence: FundedRunEvidence }>> {
  const plan: FundedEvidencePlan | undefined = input.journal.evidencePlan;
  if (!plan) throw new Error("funded recovery journal has no durable evidence plan");
  try {
    return await writeFundedRunEvidence({
      journal: input.journal,
      provider: input.provider,
      attestationSigner: input.attestationSigner,
      configuration: plan.configuration,
      artifacts: plan.artifacts,
      assertions: plan.assertions,
      participants: plan.participants,
      ...(input.directory === undefined ? {} : { directory: input.directory }),
    });
  } catch (error) {
    input.journal.markRun("evidence-failed");
    throw error;
  }
}
