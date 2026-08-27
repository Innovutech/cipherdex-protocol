import { strict as assert } from "node:assert";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, toUtf8Bytes } from "ethers";

import {
  parseCotiscanArguments,
  publicVerificationSummary,
  resolveCotiscanVerificationPlan,
  validateCotiscanReadback,
} from "../../scripts/cotiscan-verify.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const historicalManifestPath =
  "deployments/coti-mainnet-03ee787585961b06033bb22421d720abc2e687ec.json";
const manifestPath = `deployments/.cotiscan-current-build-${process.pid}.json`;
const manifestAbsolutePath = resolve(repositoryRoot, manifestPath);
const fixtureCommit = "1".repeat(40);
const fixtureEvidenceRoot = resolve(
  repositoryRoot,
  "deployments",
  "compiler-inputs",
  fixtureCommit,
);
const wrappedAddress = "0x1111111111111111111111111111111111111111";
const factoryAddress = "0x2222222222222222222222222222222222222222";
const vaultAddress = "0x3333333333333333333333333333333333333333";
const deploymentHash = (byte) => `0x${byte.repeat(64)}`;
let wrappedCompilerInputHash;

async function compilerFixture(sourceName, contractName) {
  const artifact = JSON.parse(await readFile(
    resolve(repositoryRoot, "artifacts", sourceName, `${contractName}.json`),
    "utf8",
  ));
  const buildInfo = JSON.parse(await readFile(
    resolve(repositoryRoot, "artifacts", "build-info", `${artifact.buildInfoId}.json`),
    "utf8",
  ));
  const runtimeCodehash = keccak256(artifact.deployedBytecode);
  const compilerInputHash = keccak256(toUtf8Bytes(JSON.stringify(buildInfo.input)));
  return {
    artifact,
    buildInfo,
    runtimeCodehash,
    compilerInputHash,
    compiler: {
      contractName,
      sourceName,
      runtimeCodehash,
      compilerInputHash,
      solcVersion: buildInfo.solcVersion,
      solcLongVersion: buildInfo.solcLongVersion,
      immutableReferenceCount: Object.values(artifact.immutableReferences ?? {})
        .flat().length,
      settings: {
        evmVersion: buildInfo.input.settings.evmVersion,
        viaIR: buildInfo.input.settings.viaIR ?? false,
        optimizer: {
          enabled: buildInfo.input.settings.optimizer.enabled,
          runs: buildInfo.input.settings.optimizer.runs,
        },
        metadataBytecodeHash: buildInfo.input.settings.metadata.bytecodeHash,
      },
    },
  };
}

before(async () => {
  const wrapped = await compilerFixture(
    "contracts/WrappedNativeToken.sol",
    "WrappedNativeToken",
  );
  const factory = await compilerFixture(
    "contracts/PublicCPMMFactory.sol",
    "PublicCPMMFactory",
  );
  wrappedCompilerInputHash = wrapped.compilerInputHash;
  await mkdir(fixtureEvidenceRoot, { recursive: true, mode: 0o700 });
  for (const fixture of [wrapped, factory]) {
    await writeFile(
      resolve(
        fixtureEvidenceRoot,
        `${fixture.compilerInputHash.slice(2).toLowerCase()}.json`,
      ),
      `${JSON.stringify({
        schema: "cipherdex.compiler-input/v1",
        sourceCommit: fixtureCommit,
        compilerInputHash: fixture.compilerInputHash,
        solcVersion: fixture.compiler.solcVersion,
        solcLongVersion: fixture.compiler.solcLongVersion,
        userSourceNameMap: fixture.buildInfo.userSourceNameMap,
        input: fixture.buildInfo.input,
      }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  }
  await writeFile(manifestAbsolutePath, `${JSON.stringify({
    schemaVersion: 2,
    status: "complete",
    sourceCommit: fixtureCommit,
    network: "cotiMainnet",
    chainId: "2632500",
    contracts: {
      wrappedNative: {
        address: wrappedAddress,
        runtimeCodehash: wrapped.runtimeCodehash,
        deploymentTx: deploymentHash("4"),
        constructorArgs: ["Wrapped COTI", "WCOTI"],
      },
      publicFactory: {
        address: factoryAddress,
        runtimeCodehash: factory.runtimeCodehash,
        deploymentTx: deploymentHash("5"),
        constructorArgs: [vaultAddress],
      },
      publicFeeVaultBinding: {
        address: factoryAddress,
        target: vaultAddress,
      },
      launchpadMigrator: {
        address: "0x6666666666666666666666666666666666666666",
        runtimeCodehash: deploymentHash("7"),
        deploymentTx: deploymentHash("8"),
        creationKind: "strategy-constructor-child",
        constructorArgs: [],
      },
    },
    compiler: {
      WrappedNativeToken: wrapped.compiler,
      PublicCPMMFactory: factory.compiler,
    },
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
});

after(async () => {
  await rm(manifestAbsolutePath, { force: true });
  await rm(fixtureEvidenceRoot, { force: true, recursive: true });
});

test("parses a manifest-bound dry-run and explicit submit mode", () => {
  assert.deepEqual(
    parseCotiscanArguments(["--manifest", manifestPath, "--contract", "wrappedNative"]),
    { manifest: manifestPath, contract: "wrappedNative", submit: false, help: false },
  );
  assert.equal(
    parseCotiscanArguments([
      "--manifest",
      manifestPath,
      "--contract",
      "wrappedNative",
      "--submit",
    ]).submit,
    true,
  );
  assert.throws(
    () => parseCotiscanArguments(["--contract", "wrappedNative"]),
    /--manifest and --contract are required/u,
  );
  assert.throws(
    () => parseCotiscanArguments([
      "--manifest",
      manifestPath,
      "--contract",
      "../wrappedNative",
    ]),
    /deployment-manifest key/u,
  );
});

test("resolves WCOTI only through reviewed manifest and compiler provenance", async () => {
  const plan = await resolveCotiscanVerificationPlan({
    repositoryRoot,
    manifestPath,
    contractKey: "wrappedNative",
  });
  assert.equal(plan.network, "cotiMainnet");
  assert.equal(plan.chainId, "2632500");
  assert.equal(plan.contractName, "WrappedNativeToken");
  assert.equal(plan.sourceName, "contracts/WrappedNativeToken.sol");
  assert.equal(plan.address, wrappedAddress);
  assert.equal(plan.compilerVersion, "0.8.28+commit.7893614a");
  assert.equal(plan.compilerSettings.optimizer.runs, 200);
  assert.equal(plan.compilerSettings.viaIR, false);
  assert.equal(plan.compilerSettings.metadataBytecodeHash, "none");
  assert.equal(plan.compilerInputHash, wrappedCompilerInputHash);
  assert.equal(
    plan.compilerEvidencePath,
    resolve(
      fixtureEvidenceRoot,
      `${wrappedCompilerInputHash.slice(2).toLowerCase()}.json`,
    ),
  );
  assert.equal(plan.licenseType, "mit");
  assert.match(plan.constructorArgs, /^0x[0-9a-f]+$/u);
  assert.match(plan.expectedCreationInput, /^0x[0-9a-f]+$/u);
  assert.equal(
    publicVerificationSummary(plan, "dry-run").standardJsonInput,
    undefined,
  );
});

test("selects another direct deployment without contract-specific logic", async () => {
  const plan = await resolveCotiscanVerificationPlan({
    repositoryRoot,
    manifestPath,
    contractKey: "publicFactory",
  });
  assert.equal(plan.contractKey, "publicFactory");
  assert.equal(plan.contractName, "PublicCPMMFactory");
  assert.equal(plan.sourceName, "contracts/PublicCPMMFactory.sol");
  assert.equal(plan.address, factoryAddress);
});

test("rejects a historical manifest after its compiler source changes", async () => {
  await assert.rejects(
    resolveCotiscanVerificationPlan({
      repositoryRoot,
      manifestPath: historicalManifestPath,
      contractKey: "wrappedNative",
    }),
    /compiler input hash/u,
  );
});

test("rejects non-deployment manifest keys and unavailable artifacts", async () => {
  await assert.rejects(
    resolveCotiscanVerificationPlan({
      repositoryRoot,
      manifestPath,
      contractKey: "publicFeeVaultBinding",
    }),
    /runtime codehash/u,
  );
  await assert.rejects(
    resolveCotiscanVerificationPlan({
      repositoryRoot,
      manifestPath,
      contractKey: "notRecorded",
    }),
    /unavailable/u,
  );
  await assert.rejects(
    resolveCotiscanVerificationPlan({
      repositoryRoot,
      manifestPath,
      contractKey: "launchpadMigrator",
    }),
    /not a direct deployment/u,
  );
});

test("requires verified explorer readback with exact reviewed provenance", async () => {
  const plan = await resolveCotiscanVerificationPlan({
    repositoryRoot,
    manifestPath,
    contractKey: "wrappedNative",
  });
  const sourceEntries = Object.entries(plan.standardJsonInput.sources);
  const [primaryPath, primarySource] = sourceEntries.find(
    ([sourcePath]) => sourcePath === plan.compilerSourceName,
  );
  const readback = {
    is_verified: true,
    is_fully_verified: false,
    is_partially_verified: true,
    is_changed_bytecode: false,
    creation_status: "success",
    name: "WrappedNativeToken",
    compiler_version: "v0.8.28+commit.7893614a",
    optimization_enabled: true,
    optimizations_runs: 200,
    evm_version: "paris",
    compiler_settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: false,
      metadata: { bytecodeHash: "none" },
    },
    constructor_args: plan.constructorArgs,
    deployed_bytecode: plan.compiledRuntime,
    creation_bytecode: plan.expectedCreationInput,
    file_path: primaryPath,
    source_code: primarySource.content,
    additional_sources: sourceEntries
      .filter(([sourcePath]) => sourcePath !== primaryPath)
      .map(([file_path, source]) => ({ file_path, source_code: source.content })),
    verified_at: "2026-08-26T00:00:00Z",
  };
  const result = validateCotiscanReadback(plan, readback);
  assert.equal(result.explorerMatch, "partial");
  assert.equal(result.exactManifestMatch, true);
  assert.throws(
    () => validateCotiscanReadback(plan, { ...readback, is_verified: false }),
    /not verified/u,
  );
  assert.throws(
    () => validateCotiscanReadback(plan, { ...readback, optimizations_runs: 201 }),
    /does not match/u,
  );
  assert.throws(
    () => validateCotiscanReadback(plan, { ...readback, constructor_args: "0x00" }),
    /constructor arguments/u,
  );
  assert.throws(
    () => validateCotiscanReadback(plan, { ...readback, source_code: `${readback.source_code}\n` }),
    /source set/u,
  );
  assert.throws(
    () => validateCotiscanReadback(plan, { ...readback, is_changed_bytecode: true }),
    /exact deployed contract/u,
  );
});
