import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { promisify } from "node:util";

import type { RuntimeCodeProvider } from "./runtime-artifact";
import {
  CANONICAL_TESTNET_DEPLOYMENTS,
  verifyDeploymentTransactionEvidence,
  type DeploymentEvidenceProvider,
} from "./deployment-transaction-provenance";
import {
  verifyDeployedRuntimeArtifactWithProvenance,
  type RuntimeArtifactProvenance,
} from "./runtime-artifact";
import {
  trustedGitArguments,
  trustedGitEnvironment,
  trustedGitExecutable,
} from "./trusted-git";

const execFileAsync = promisify(execFile);
const SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}$/i;
const RECORD_NAME_PATTERN = /^coti-testnet-([0-9a-f]{40})\.json$/i;
const HASH_PATTERN = /^0x[0-9a-f]{64}$/i;
const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/i;
const MAX_RECORD_BYTES = 1_000_000;

type JsonRecord = Record<string, unknown>;

export type TestnetDeploymentContractRequirement = Readonly<{
  recordKey: string;
  contractName: string;
  address?: string;
}>;

export type VerifiedTestnetDeploymentRecord = Readonly<{
  path: string;
  recordPath: string;
  recordSha256: string;
  manifestCommit: string;
  sourceCommit: string;
  evidenceCommit: string;
  chainId: string;
  contracts: Readonly<Record<string, JsonRecord>>;
  compiler: Readonly<Record<string, JsonRecord>>;
}>;

type ProvenanceDependencies = Readonly<{
  readSourceState?: (
    cwd: string,
    allowedRecordPath: string,
    sourceCommit: string,
  ) => Promise<Readonly<{
    headCommit: string;
    recordCommit: string;
    dirty: boolean;
    recordTracked: boolean;
    recordMatchesHead: boolean;
    sourceCommitIsAncestor: boolean;
    changedPathsSinceSource: readonly string[];
  }>>;
  readImmutableRecord?: (
    cwd: string,
    allowedRecordPath: string,
    evidenceCommit: string,
  ) => Promise<string>;
  verifyRuntime?: (
    contractName: string,
    address: string,
    provider: RuntimeCodeProvider,
  ) => Promise<RuntimeArtifactProvenance>;
  verifyTransactions?: (
    record: JsonRecord,
    provider: DeploymentEvidenceProvider,
  ) => Promise<void>;
  canonicalDeployments?: readonly Readonly<{
    key: string;
    contractName: string;
  }>[];
}>;

function asRecord(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function requiredString(record: JsonRecord, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label}.${key} must be a non-empty string`);
  }
  return value;
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

type GitExecutor = (
  executable: string,
  args: readonly string[],
  options: Readonly<{ cwd: string; env: NodeJS.ProcessEnv }>,
) => Promise<Readonly<{ stdout: string }>>;

export async function listTouchedPathsAcrossCommitRange(
  cwd: string,
  sourceCommit: string,
  headCommit = "HEAD",
  execute: GitExecutor = execFileAsync as unknown as GitExecutor,
): Promise<readonly string[]> {
  if (!SOURCE_COMMIT_PATTERN.test(sourceCommit)) {
    throw new Error("source commit for history audit is invalid");
  }
  const git = trustedGitExecutable(process.env, cwd);
  const gitOptions = { cwd, env: trustedGitEnvironment() } as const;
  const commitsResult = await execute(
    git,
    trustedGitArguments([
      "rev-list",
      "--reverse",
      "--topo-order",
      "--ancestry-path",
      `${sourceCommit}..${headCommit}`,
    ]),
    gitOptions,
  );
  const commits = commitsResult.stdout
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (commits.some((commit) => !SOURCE_COMMIT_PATTERN.test(commit))) {
    throw new Error("commit history audit returned an invalid commit");
  }

  const touched = new Set<string>();
  for (const commit of commits) {
    const result = await execute(
      git,
      trustedGitArguments([
        "diff-tree",
        "--root",
        "-m",
        "--no-commit-id",
        "--name-only",
        "-r",
        "--diff-filter=ACDMRTUXB",
        commit,
        "--",
        ".",
      ]),
      gitOptions,
    );
    for (const entry of result.stdout.split(/\r?\n/u)) {
      const normalized = normalizePath(entry.trim());
      if (normalized.length > 0) touched.add(normalized);
    }
  }
  return Object.freeze([...touched].sort());
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function assertCompilerProvenance(
  recorded: JsonRecord,
  actual: RuntimeArtifactProvenance,
): void {
  for (const key of [
    "contractName",
    "sourceName",
    "runtimeCodehash",
    "compilerInputHash",
    "solcVersion",
    "solcLongVersion",
    "immutableReferenceCount",
  ] as const) {
    if (recorded[key] !== actual[key]) {
      throw new Error(`${actual.contractName} compiler provenance mismatch for ${key}`);
    }
  }
  if (JSON.stringify(recorded.settings) !== JSON.stringify(actual.settings)) {
    throw new Error(`${actual.contractName} compiler settings do not match the deployment record`);
  }
}

async function defaultReadSourceState(
  cwd: string,
  allowedRecordPath: string,
  sourceCommit: string,
): Promise<Readonly<{
  headCommit: string;
  recordCommit: string;
  dirty: boolean;
  recordTracked: boolean;
  recordMatchesHead: boolean;
  sourceCommitIsAncestor: boolean;
  changedPathsSinceSource: readonly string[];
}>> {
  const git = trustedGitExecutable(process.env, cwd);
  const gitOptions = { cwd, env: trustedGitEnvironment() } as const;
  const [head, status] = await Promise.all([
    execFileAsync(
      git,
      trustedGitArguments(["rev-parse", "--verify", "HEAD"]),
      gitOptions,
    ),
    execFileAsync(
      git,
      trustedGitArguments(["status", "--porcelain=v1", "--untracked-files=all", "--", "."]),
      gitOptions,
    ),
  ]);

  let recordTracked = true;
  try {
    await execFileAsync(
      git,
      trustedGitArguments(["ls-files", "--error-unmatch", "--", allowedRecordPath]),
      gitOptions,
    );
  } catch {
    recordTracked = false;
  }

  let recordCommit = "";
  if (recordTracked) {
    const result = await execFileAsync(
      git,
      trustedGitArguments([
        "log",
        "-1",
        "--format=%H",
        "HEAD",
        "--",
        allowedRecordPath,
      ]),
      gitOptions,
    );
    recordCommit = result.stdout.trim();
  }

  let recordMatchesHead = recordTracked;
  if (recordTracked) {
    try {
      await execFileAsync(
        git,
        trustedGitArguments([
          "diff",
          "--quiet",
          "--no-ext-diff",
          "HEAD",
          "--",
          allowedRecordPath,
        ]),
        gitOptions,
      );
    } catch {
      recordMatchesHead = false;
    }
  }

  let sourceCommitIsAncestor = true;
  try {
    await execFileAsync(
      git,
      trustedGitArguments(["merge-base", "--is-ancestor", sourceCommit, "HEAD"]),
      gitOptions,
    );
  } catch {
    sourceCommitIsAncestor = false;
  }

  let changedPathsSinceSource: string[] = [];
  if (sourceCommitIsAncestor) {
    changedPathsSinceSource = [...await listTouchedPathsAcrossCommitRange(
      cwd,
      sourceCommit,
    )];
  }

  return Object.freeze({
    headCommit: head.stdout.trim(),
    recordCommit,
    dirty: status.stdout.trim().length > 0,
    recordTracked,
    recordMatchesHead,
    sourceCommitIsAncestor,
    changedPathsSinceSource: Object.freeze(changedPathsSinceSource),
  });
}

async function defaultReadImmutableRecord(
  cwd: string,
  allowedRecordPath: string,
  evidenceCommit: string,
): Promise<string> {
  if (!SOURCE_COMMIT_PATTERN.test(evidenceCommit)) {
    throw new Error("deployment evidence commit is invalid");
  }
  const result = await execFileAsync(
    trustedGitExecutable(process.env, cwd),
    trustedGitArguments([
      "show",
      "--no-textconv",
      "--no-ext-diff",
      `${evidenceCommit}:${allowedRecordPath}`,
    ]),
    {
      cwd,
      env: trustedGitEnvironment(),
      maxBuffer: MAX_RECORD_BYTES + 1,
    },
  );
  if (
    result.stderr.trim().length > 0 ||
    Buffer.byteLength(result.stdout, "utf8") <= 0 ||
    Buffer.byteLength(result.stdout, "utf8") > MAX_RECORD_BYTES
  ) {
    throw new Error("deployment record Git object is invalid or oversized");
  }
  return result.stdout;
}

async function resolveRecordPath(
  configuredPath: string,
  cwd: string,
): Promise<Readonly<{ resolvedPath: string; relativePath: string; filenameCommit: string }>> {
  const normalized = normalizePath(configuredPath);
  if (!normalized.startsWith("deployments/")) {
    throw new Error("COTI_DEPLOYMENT_RECORD must stay under deployments/");
  }
  const deploymentRoot = resolve(cwd, "deployments");
  const resolvedPath = resolve(cwd, configuredPath);
  const relativePath = normalizePath(relative(deploymentRoot, resolvedPath));
  const match = RECORD_NAME_PATTERN.exec(relativePath);
  if (!match || relativePath.includes("/") || dirname(resolvedPath) !== deploymentRoot) {
    throw new Error(
      "COTI_DEPLOYMENT_RECORD must be deployments/coti-testnet-<commit>.json",
    );
  }
  const [rootStat, fileStat] = await Promise.all([
    lstat(deploymentRoot),
    lstat(resolvedPath),
  ]);
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    !fileStat.isFile() ||
    fileStat.isSymbolicLink() ||
    fileStat.size <= 0 ||
    fileStat.size > MAX_RECORD_BYTES
  ) {
    throw new Error("deployment record must be a bounded regular file in a real directory");
  }
  const [realRoot, realFile] = await Promise.all([
    realpath(deploymentRoot),
    realpath(resolvedPath),
  ]);
  if (dirname(realFile) !== realRoot) {
    throw new Error("deployment record escaped the deployments directory");
  }
  return Object.freeze({
    resolvedPath,
    relativePath: `deployments/${relativePath}`,
    filenameCommit: match[1].toLowerCase(),
  });
}

export function requiredTestnetDeploymentRecordPath(): string {
  const value = process.env.COTI_DEPLOYMENT_RECORD?.trim();
  if (!value) throw new Error("COTI_DEPLOYMENT_RECORD is required for configured testnet contracts");
  return value;
}

export function assertReviewedPrivateTokens(
  record: VerifiedTestnetDeploymentRecord,
  tokenAddresses: readonly string[],
): void {
  if (tokenAddresses.length === 0) {
    throw new Error("reviewed private-token verification requires at least one token");
  }
  const factoryRecord = asRecord(
    record.contracts.confidentialFactory,
    "deployment record contracts.confidentialFactory",
  );
  const reviewed = factoryRecord.reviewedPrivateTokens;
  if (
    !Array.isArray(reviewed) ||
    reviewed.length === 0 ||
    reviewed.some((entry) => typeof entry !== "string" || !ADDRESS_PATTERN.test(entry))
  ) {
    throw new Error("deployment record reviewedPrivateTokens must be a non-empty address list");
  }
  const reviewedAddresses = new Set(reviewed.map((entry) => entry.toLowerCase()));
  for (const tokenAddress of tokenAddresses) {
    if (!ADDRESS_PATTERN.test(tokenAddress) || !reviewedAddresses.has(tokenAddress.toLowerCase())) {
      throw new Error(`configured private token is absent from the reviewed deployment record: ${tokenAddress}`);
    }
  }
}

export async function verifyConfiguredTestnetDeployment(
  configuredPath: string,
  provider: RuntimeCodeProvider,
  requirements: readonly TestnetDeploymentContractRequirement[],
  cwd = process.cwd(),
  dependencies: ProvenanceDependencies = {},
): Promise<VerifiedTestnetDeploymentRecord> {
  if (requirements.length === 0) {
    throw new Error("deployment provenance verification requires at least one contract");
  }
  const resolved = await resolveRecordPath(configuredPath, cwd);
  const sourceState = await (dependencies.readSourceState ?? defaultReadSourceState)(
    cwd,
    resolved.relativePath,
    resolved.filenameCommit,
  );
  if (!SOURCE_COMMIT_PATTERN.test(sourceState.headCommit)) {
    throw new Error("deployment evidence HEAD is not a full Git commit");
  }
  if (sourceState.dirty) {
    throw new Error("configured deployment verification requires a completely clean worktree");
  }
  if (!sourceState.recordTracked || !sourceState.recordMatchesHead) {
    throw new Error("deployment record must exactly match the Git-tracked evidence at HEAD");
  }
  if (!SOURCE_COMMIT_PATTERN.test(sourceState.recordCommit)) {
    throw new Error("deployment manifest commit is not a full Git commit");
  }
  if (!sourceState.sourceCommitIsAncestor) {
    throw new Error("deployment record source commit is not an ancestor of the evidence HEAD");
  }
  const immutableRecord = await (
    dependencies.readImmutableRecord ?? defaultReadImmutableRecord
  )(cwd, resolved.relativePath, sourceState.recordCommit.toLowerCase());
  if (
    Buffer.byteLength(immutableRecord, "utf8") <= 0 ||
    Buffer.byteLength(immutableRecord, "utf8") > MAX_RECORD_BYTES
  ) {
    throw new Error("deployment record Git object is invalid or oversized");
  }
  const parsed = JSON.parse(immutableRecord) as unknown;
  const record = asRecord(parsed, "deployment record");
  const sourceCommit = requiredString(record, "sourceCommit", "deployment record").toLowerCase();
  const chainId = requiredString(record, "chainId", "deployment record");
  if (
    record.schemaVersion !== 2 ||
    record.status !== "complete" ||
    record.network !== "cotiTestnet" ||
    chainId !== "7082400" ||
    !SOURCE_COMMIT_PATTERN.test(sourceCommit) ||
    sourceCommit !== resolved.filenameCommit
  ) {
    throw new Error("deployment record is not a complete COTI testnet v2 manifest");
  }
  const permittedEvidencePaths = new Set([
    resolved.relativePath,
    "docs/VERIFICATION_REPORT.md",
  ]);
  const changedPaths = sourceState.changedPathsSinceSource.map(normalizePath);
  if (!changedPaths.includes(resolved.relativePath)) {
    throw new Error("deployment record was not added by a post-source evidence commit");
  }
  const expectedFundedEvidencePath = `evidence/coti-testnet-${sourceCommit}.json`;
  const unexpectedPath = changedPaths.find((path) =>
    !permittedEvidencePaths.has(path) && path !== expectedFundedEvidencePath
  );
  if (unexpectedPath) {
    throw new Error(
      `deployment evidence contains a post-source executable or unauthorized change: ${unexpectedPath}`,
    );
  }

  const contracts = asRecord(record.contracts, "deployment record contracts");
  const compiler = asRecord(record.compiler, "deployment record compiler");
  if (dependencies.verifyTransactions) {
    await dependencies.verifyTransactions(
      record,
      provider as unknown as DeploymentEvidenceProvider,
    );
  } else {
    const evidenceProvider = provider as unknown as Partial<DeploymentEvidenceProvider>;
    if (
      typeof evidenceProvider.getTransaction !== "function" ||
      typeof evidenceProvider.getTransactionReceipt !== "function" ||
      typeof evidenceProvider.getCode !== "function" ||
      typeof evidenceProvider.call !== "function"
    ) {
      throw new Error("deployment transaction evidence requires a transaction-capable provider");
    }
    await verifyDeploymentTransactionEvidence(record, evidenceProvider as DeploymentEvidenceProvider);
  }
  const verifyRuntime = dependencies.verifyRuntime ?? verifyDeployedRuntimeArtifactWithProvenance;
  const canonicalDeployments = dependencies.canonicalDeployments ?? CANONICAL_TESTNET_DEPLOYMENTS;
  for (const deployment of canonicalDeployments) {
    const contractRecord = asRecord(
      contracts[deployment.key],
      `deployment record contracts.${deployment.key}`,
    );
    const recordedAddress = requiredString(
      contractRecord,
      "address",
      `deployment record contracts.${deployment.key}`,
    );
    const actual = await verifyRuntime(
      deployment.contractName,
      recordedAddress,
      provider,
    );
    const recordedCodehash = requiredString(
      contractRecord,
      "runtimeCodehash",
      `deployment record contracts.${deployment.key}`,
    );
    if (!HASH_PATTERN.test(recordedCodehash) || recordedCodehash !== actual.runtimeCodehash) {
      throw new Error(`${deployment.key} runtime codehash does not match the deployment record`);
    }
    assertCompilerProvenance(
      asRecord(compiler[deployment.contractName], `deployment compiler ${deployment.contractName}`),
      actual,
    );
  }
  for (const requirement of requirements) {
    const canonical = canonicalDeployments.find((entry) => entry.key === requirement.recordKey);
    if (!canonical || canonical.contractName !== requirement.contractName) {
      throw new Error(`${requirement.recordKey} is not a canonical deployment requirement`);
    }
    const recordedAddress = requiredString(
      asRecord(contracts[requirement.recordKey], `deployment record contracts.${requirement.recordKey}`),
      "address",
      `deployment record contracts.${requirement.recordKey}`,
    );
    if (
      requirement.address !== undefined &&
      !sameAddress(recordedAddress, requirement.address)
    ) {
      throw new Error(`${requirement.recordKey} does not match the configured address`);
    }
  }

  return Object.freeze({
    path: resolved.resolvedPath,
    recordPath: resolved.relativePath,
    recordSha256: createHash("sha256").update(immutableRecord, "utf8").digest("hex"),
    manifestCommit: sourceState.recordCommit.toLowerCase(),
    sourceCommit,
    evidenceCommit: sourceState.headCommit.toLowerCase(),
    chainId,
    contracts: contracts as Record<string, JsonRecord>,
    compiler: compiler as Record<string, JsonRecord>,
  });
}
