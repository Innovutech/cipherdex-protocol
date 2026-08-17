import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { promisify } from "node:util";

import type { RuntimeCodeProvider } from "./runtime-artifact";
import {
  verifyDeployedRuntimeArtifactWithProvenance,
  type RuntimeArtifactProvenance,
} from "./runtime-artifact";

const execFileAsync = promisify(execFile);
const SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}$/i;
const RECORD_NAME_PATTERN = /^coti-testnet-([0-9a-f]{40})\.json$/i;
const HASH_PATTERN = /^0x[0-9a-f]{64}$/i;
const MAX_RECORD_BYTES = 1_000_000;

type JsonRecord = Record<string, unknown>;

export type TestnetDeploymentContractRequirement = Readonly<{
  recordKey: string;
  contractName: string;
  address: string;
}>;

export type VerifiedTestnetDeploymentRecord = Readonly<{
  path: string;
  sourceCommit: string;
  chainId: string;
  contracts: Readonly<Record<string, JsonRecord>>;
  compiler: Readonly<Record<string, JsonRecord>>;
}>;

type ProvenanceDependencies = Readonly<{
  readSourceState?: (
    cwd: string,
    allowedRecordPath: string,
  ) => Promise<Readonly<{ commit: string; dirty: boolean }>>;
  verifyRuntime?: (
    contractName: string,
    address: string,
    provider: RuntimeCodeProvider,
  ) => Promise<RuntimeArtifactProvenance>;
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
): Promise<Readonly<{ commit: string; dirty: boolean }>> {
  const [head, status] = await Promise.all([
    execFileAsync("git", ["rev-parse", "--verify", "HEAD"], { cwd }),
    execFileAsync(
      "git",
      [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--",
        ".",
        `:(exclude)${allowedRecordPath}`,
      ],
      { cwd },
    ),
  ]);
  return Object.freeze({
    commit: head.stdout.trim(),
    dirty: status.stdout.trim().length > 0,
  });
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
  const parsed = JSON.parse(await readFile(resolved.resolvedPath, "utf8")) as unknown;
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

  const sourceState = await (dependencies.readSourceState ?? defaultReadSourceState)(
    cwd,
    resolved.relativePath,
  );
  if (!SOURCE_COMMIT_PATTERN.test(sourceState.commit) || sourceState.commit.toLowerCase() !== sourceCommit) {
    throw new Error("deployment record source commit does not match the current HEAD");
  }
  if (sourceState.dirty) {
    throw new Error("configured deployment verification requires a clean source worktree");
  }

  const contracts = asRecord(record.contracts, "deployment record contracts");
  const compiler = asRecord(record.compiler, "deployment record compiler");
  const verifyRuntime = dependencies.verifyRuntime ?? verifyDeployedRuntimeArtifactWithProvenance;
  for (const requirement of requirements) {
    const contractRecord = asRecord(
      contracts[requirement.recordKey],
      `deployment record contracts.${requirement.recordKey}`,
    );
    const recordedAddress = requiredString(
      contractRecord,
      "address",
      `deployment record contracts.${requirement.recordKey}`,
    );
    if (!sameAddress(recordedAddress, requirement.address)) {
      throw new Error(`${requirement.recordKey} does not match the configured address`);
    }
    const actual = await verifyRuntime(
      requirement.contractName,
      requirement.address,
      provider,
    );
    const recordedCodehash = requiredString(
      contractRecord,
      "runtimeCodehash",
      `deployment record contracts.${requirement.recordKey}`,
    );
    if (!HASH_PATTERN.test(recordedCodehash) || recordedCodehash !== actual.runtimeCodehash) {
      throw new Error(`${requirement.recordKey} runtime codehash does not match the deployment record`);
    }
    assertCompilerProvenance(
      asRecord(compiler[requirement.contractName], `deployment compiler ${requirement.contractName}`),
      actual,
    );
  }

  return Object.freeze({
    path: resolved.resolvedPath,
    sourceCommit,
    chainId,
    contracts: contracts as Record<string, JsonRecord>,
    compiler: compiler as Record<string, JsonRecord>,
  });
}
