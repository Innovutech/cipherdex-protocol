import { strict as assert } from "node:assert";
import { test } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseCotiscanArguments,
  publicVerificationSummary,
  resolveCotiscanVerificationPlan,
  validateCotiscanReadback,
} from "../../scripts/cotiscan-verify.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const manifestPath =
  "deployments/coti-mainnet-03ee787585961b06033bb22421d720abc2e687ec.json";

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
  assert.equal(plan.address, "0xe90382343f895fDF0e0A28bCABa7c38f19Bb1FC3");
  assert.equal(plan.compilerVersion, "0.8.28+commit.7893614a");
  assert.equal(plan.compilerSettings.optimizer.runs, 200);
  assert.equal(plan.compilerSettings.viaIR, false);
  assert.equal(plan.compilerSettings.metadataBytecodeHash, "none");
  assert.equal(
    plan.compilerInputHash,
    "0xa9ce0dff778958e5aa03c55be7108ed58532fe281b6c60317aad9d09e4937088",
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
  assert.equal(plan.address, "0x294f0FA03D5eEC0457Aba77B95613546FCB22452");
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
