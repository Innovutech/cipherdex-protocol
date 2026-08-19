import { keccak256, toUtf8Bytes } from "ethers";
import { readFile } from "node:fs/promises";
import { artifacts, ethers as hardhatEthers } from "../hardhat/runtime.js";

type BytecodeReference = Readonly<{ start: number; length: number }>;
type ImmutableReferenceMap = Readonly<Record<string, readonly BytecodeReference[]>>;
type LinkReferenceMap = Readonly<
  Record<string, Readonly<Record<string, readonly BytecodeReference[]>>>
>;

type DeployedBytecodeOutput = Readonly<{
  object: string;
  immutableReferences?: ImmutableReferenceMap;
  linkReferences?: LinkReferenceMap;
}>;

type HardhatBuildInfo = Readonly<{
  userSourceNameMap?: Readonly<Record<string, string>>;
  input: Readonly<{
    settings: Readonly<{
      evmVersion?: unknown;
      metadata?: unknown;
      optimizer?: Readonly<{ enabled?: unknown; runs?: unknown }>;
      viaIR?: unknown;
      [key: string]: unknown;
    }>;
  }>;
  solcVersion: string;
  solcLongVersion: string;
}>;

type HardhatBuildOutput = Readonly<{
  output: Readonly<{
    contracts?: Readonly<
      Record<string, Readonly<Record<string, Readonly<{ evm?: { deployedBytecode?: unknown } }>>>>
    >;
  }>;
}>;

function compilerSourceNameForArtifact(
  buildInfo: HardhatBuildInfo,
  buildOutput: HardhatBuildOutput,
  artifact: Readonly<{ sourceName: string; contractName: string }>,
): string {
  const mappedSourceName = buildInfo.userSourceNameMap?.[artifact.sourceName];
  const matches = Object.entries(buildOutput.output.contracts ?? {}).filter(
    ([sourceName, contracts]) =>
      contracts[artifact.contractName] !== undefined &&
      (
        sourceName === mappedSourceName ||
        sourceName === artifact.sourceName ||
        sourceName.endsWith(`/${artifact.sourceName}`)
      ),
  );
  if (matches.length !== 1) {
    throw new Error(`${artifact.contractName} compiler source is unavailable or ambiguous`);
  }
  return matches[0][0];
}

export type RuntimeArtifactProvenance = Readonly<{
  contractName: string;
  sourceName: string;
  runtimeCodehash: string;
  compilerInputHash: string;
  solcVersion: string;
  solcLongVersion: string;
  immutableReferenceCount: number;
  settings: Readonly<{
    evmVersion: string | null;
    viaIR: boolean;
    optimizer: Readonly<{ enabled: boolean; runs: number | null }>;
    metadataBytecodeHash: string | null;
  }>;
}>;

export type RuntimeCodeProvider = Readonly<{
  getCode(address: string): Promise<string>;
}>;

const RUNTIME_BUILD_CONTEXTS: Readonly<Record<string, string>> = Object.freeze({
  // Pools are emitted from type(ConfidentialCPMM).creationCode in the deployer
  // compilation job, so the deployer build output is the canonical runtime.
  ConfidentialCPMM: "ConfidentialCPMMDeployer",
});

function runtimeBuildContext(contractName: string): string {
  return RUNTIME_BUILD_CONTEXTS[contractName] ?? contractName;
}

function hasReferences(references: LinkReferenceMap | undefined): boolean {
  return Object.values(references ?? {}).some((byName) =>
    Object.values(byName).some((entries) => entries.length > 0),
  );
}

function countImmutableReferences(references: ImmutableReferenceMap | undefined): number {
  return Object.values(references ?? {}).reduce(
    (total, entries) => total + entries.length,
    0,
  );
}

function normalizeImmutableRanges(
  bytecode: string,
  references: ImmutableReferenceMap | undefined,
): string {
  const body = bytecode.startsWith("0x") ? bytecode.slice(2) : bytecode;
  const chars = body.split("");
  for (const entries of Object.values(references ?? {})) {
    for (const { start, length } of entries) {
        if (
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(length) ||
          start < 0 ||
          length <= 0 ||
          (start + length) * 2 > chars.length
        ) {
          throw new Error("artifact contains an invalid immutable reference");
        }
        chars.fill("0", start * 2, (start + length) * 2);
    }
  }
  return `0x${chars.join("")}`;
}

export async function verifyDeployedRuntimeArtifactWithProvenance(
  contractName: string,
  address: string,
  provider: RuntimeCodeProvider = hardhatEthers.provider,
): Promise<RuntimeArtifactProvenance> {
  const artifact = await artifacts.readArtifact(contractName);
  const buildContextName = runtimeBuildContext(contractName);
  const buildContextArtifact = buildContextName === contractName
    ? artifact
    : await artifacts.readArtifact(buildContextName);
  const fullyQualifiedName = `${buildContextArtifact.sourceName}:${buildContextArtifact.contractName}`;
  const buildInfoId = await artifacts.getBuildInfoId(fullyQualifiedName);
  const buildInfoPath = buildInfoId
    ? await artifacts.getBuildInfoPath(buildInfoId)
    : undefined;
  const buildOutputPath = buildInfoId
    ? await artifacts.getBuildInfoOutputPath(buildInfoId)
    : undefined;
  if (!buildInfoPath || !buildOutputPath) {
    throw new Error(`${contractName} build provenance is unavailable`);
  }
  const [buildInfo, buildOutput] = await Promise.all([
    readFile(buildInfoPath, "utf8").then((raw) => JSON.parse(raw) as HardhatBuildInfo),
    readFile(buildOutputPath, "utf8").then((raw) => JSON.parse(raw) as HardhatBuildOutput),
  ]);
  const compilerSourceName = compilerSourceNameForArtifact(buildInfo, buildOutput, artifact);
  const deployedBytecode = buildOutput.output.contracts?.[compilerSourceName]?.[
    artifact.contractName
  ]?.evm?.deployedBytecode as DeployedBytecodeOutput | undefined;
  if (!deployedBytecode || !/^[0-9a-fA-F]+$/.test(deployedBytecode.object)) {
    throw new Error(`${contractName} deployed artifact is unavailable`);
  }
  if (hasReferences(deployedBytecode.linkReferences)) {
    throw new Error(`${contractName} runtime verification does not permit linked libraries`);
  }

  const actual = await provider.getCode(address);
  const expected = `0x${deployedBytecode.object}`;
  if (actual === "0x" || actual.length !== expected.length) {
    throw new Error(`${contractName} deployed runtime length does not match current artifacts`);
  }
  const normalizedActual = normalizeImmutableRanges(
    actual,
    deployedBytecode.immutableReferences,
  );
  const normalizedExpected = normalizeImmutableRanges(
    expected,
    deployedBytecode.immutableReferences,
  );
  if (normalizedActual.toLowerCase() !== normalizedExpected.toLowerCase()) {
    throw new Error(`${contractName} deployed runtime does not match current artifacts`);
  }
  const settings = buildInfo.input.settings;
  const metadata = settings.metadata as { bytecodeHash?: unknown } | undefined;
  return Object.freeze({
    contractName: artifact.contractName,
    sourceName: artifact.sourceName,
    runtimeCodehash: keccak256(actual),
    compilerInputHash: keccak256(
      toUtf8Bytes(JSON.stringify(buildInfo.input)),
    ),
    solcVersion: buildInfo.solcVersion,
    solcLongVersion: buildInfo.solcLongVersion,
    immutableReferenceCount: countImmutableReferences(
      deployedBytecode.immutableReferences,
    ),
    settings: Object.freeze({
      evmVersion: typeof settings.evmVersion === "string" ? settings.evmVersion : null,
      viaIR: settings.viaIR === true,
      optimizer: Object.freeze({
        enabled: settings.optimizer?.enabled === true,
        runs: Number.isSafeInteger(settings.optimizer?.runs)
          ? Number(settings.optimizer?.runs)
          : null,
      }),
      metadataBytecodeHash: typeof metadata?.bytecodeHash === "string"
        ? metadata.bytecodeHash
        : null,
    }),
  });
}

export async function verifyDeployedRuntimeArtifact(
  contractName: string,
  address: string,
  provider: RuntimeCodeProvider = hardhatEthers.provider,
): Promise<string> {
  return (await verifyDeployedRuntimeArtifactWithProvenance(contractName, address, provider))
    .runtimeCodehash;
}
