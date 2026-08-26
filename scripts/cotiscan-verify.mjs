import { Interface, getAddress, isAddress, keccak256, toUtf8Bytes } from "ethers";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MAX_JSON_BYTES = 50_000_000;
const MAX_HTTP_BODY_BYTES = 2_000_000;
const REQUEST_TIMEOUT_MS = 20_000;
const READBACK_ATTEMPTS = 60;
const READBACK_INTERVAL_MS = 2_000;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const SOURCE_COMMIT = /^[0-9a-f]{40}$/;
const CONTRACT_KEY = /^[A-Za-z][A-Za-z0-9]*$/;
const CONTRACT_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const BUILD_INFO_ID = /^[A-Za-z0-9_-]+$/;

const COTI_NETWORKS = Object.freeze({
  "2632500": Object.freeze({
    network: "cotiMainnet",
    explorerUrl: "https://mainnet.cotiscan.io",
    rpcEnvironment: "COTI_MAINNET_RPC_URL",
    defaultRpcUrl: "https://mainnet.coti.io/rpc",
  }),
  "7082400": Object.freeze({
    network: "cotiTestnet",
    explorerUrl: "https://testnet.cotiscan.io",
    rpcEnvironment: "COTI_TESTNET_RPC_URL",
    defaultRpcUrl: "https://testnet.coti.io/rpc",
  }),
});

const LICENSE_TYPES = Object.freeze({
  MIT: "mit",
  UNLICENSED: "none",
  Unlicense: "unlicense",
  "GPL-2.0": "gnu_gpl_v2",
  "GPL-3.0": "gnu_gpl_v3",
  "LGPL-2.1": "gnu_lgpl_v2_1",
  "LGPL-3.0": "gnu_lgpl_v3",
  "BSD-2-Clause": "bsd_2_clause",
  "BSD-3-Clause": "bsd_3_clause",
  "MPL-2.0": "mpl_2_0",
  "Apache-2.0": "apache_2_0",
  "AGPL-3.0": "gnu_agpl_v3",
  "BUSL-1.1": "bsl_1_1",
});

function usage() {
  return [
    "Usage:",
    "  npm run verify:cotiscan -- --manifest deployments/<record>.json --contract <key>",
    "  npm run verify:cotiscan -- --manifest deployments/<record>.json --contract <key> --submit",
    "",
    "Dry-run is the default. --submit publishes the exact reviewed Standard JSON input.",
  ].join("\n");
}

export function parseCotiscanArguments(argv) {
  const result = { manifest: undefined, contract: undefined, submit: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--submit") {
      if (result.submit) throw new Error("--submit may be supplied only once");
      result.submit = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      result.help = true;
      continue;
    }
    if (argument === "--manifest" || argument === "--contract") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      const key = argument === "--manifest" ? "manifest" : "contract";
      if (result[key] !== undefined) throw new Error(`${argument} may be supplied only once`);
      result[key] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unsupported argument: ${argument}`);
  }
  if (!result.help && (!result.manifest || !result.contract)) {
    throw new Error("--manifest and --contract are required");
  }
  if (result.contract && !CONTRACT_KEY.test(result.contract)) {
    throw new Error("--contract must be a deployment-manifest key");
  }
  return Object.freeze(result);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readBoundedRegularFile(path, label) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_JSON_BYTES) {
    throw new Error(`${label} must be a bounded regular file`);
  }
  return readFile(path, "utf8");
}

async function readJsonFile(path, label) {
  const source = await readBoundedRegularFile(path, label);
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
}

function pathInside(root, candidate, label) {
  const child = relative(root, candidate);
  if (child === "" || child.startsWith("..") || child.includes(":") || resolve(root, child) !== candidate) {
    throw new Error(`${label} escaped its reviewed directory`);
  }
  return candidate;
}

function hasLinkReferences(references) {
  return Object.values(references ?? {}).some((byName) =>
    Object.values(byName ?? {}).some((entries) => Array.isArray(entries) && entries.length > 0),
  );
}

function normalizeImmutableRanges(bytecode, references) {
  const body = bytecode.startsWith("0x") ? bytecode.slice(2) : bytecode;
  if (!/^[0-9a-fA-F]*$/.test(body) || body.length % 2 !== 0) {
    throw new Error("compiled runtime bytecode is invalid");
  }
  const chars = body.split("");
  for (const entries of Object.values(references ?? {})) {
    for (const reference of entries) {
      const start = reference?.start;
      const length = reference?.length;
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(length) ||
        start < 0 ||
        length <= 0 ||
        (start + length) * 2 > chars.length
      ) {
        throw new Error("compiled artifact has an invalid immutable reference");
      }
      chars.fill("0", start * 2, (start + length) * 2);
    }
  }
  return `0x${chars.join("")}`;
}

function normalizedCompilerVersion(value) {
  return String(value ?? "").replace(/^v/, "");
}

function requiredHash(value, label) {
  if (typeof value !== "string" || !HASH.test(value)) throw new Error(`${label} is invalid`);
  return value.toLowerCase();
}

function requiredAddress(value, label) {
  if (typeof value !== "string" || !isAddress(value)) throw new Error(`${label} is invalid`);
  return getAddress(value);
}

function compareCompilerSettings(compiler, buildInfo) {
  const expected = compiler.settings;
  const actual = buildInfo.input.settings;
  const actualMetadata = isRecord(actual.metadata) ? actual.metadata : {};
  if (
    expected.evmVersion !== actual.evmVersion ||
    expected.viaIR !== (actual.viaIR === true) ||
    expected.optimizer?.enabled !== (actual.optimizer?.enabled === true) ||
    expected.optimizer?.runs !== actual.optimizer?.runs ||
    expected.metadataBytecodeHash !== actualMetadata.bytecodeHash
  ) {
    throw new Error("compiler settings do not match the reviewed deployment manifest");
  }
}

function inferLicense(input, compilerSourceName) {
  const content = input.sources?.[compilerSourceName]?.content;
  if (typeof content !== "string") throw new Error("primary compiler source is unavailable");
  const match = content.match(/SPDX-License-Identifier:\s*([^\s*]+)/u);
  const licenseType = match ? LICENSE_TYPES[match[1]] : undefined;
  if (!licenseType) throw new Error("primary source has an unsupported or missing SPDX license");
  return licenseType;
}

function encodeConstructorArguments(artifact, constructorArguments) {
  if (!Array.isArray(constructorArguments)) {
    throw new Error("deployment manifest constructor arguments are missing");
  }
  try {
    return new Interface(artifact.abi).encodeDeploy(constructorArguments);
  } catch (error) {
    throw new Error("deployment manifest constructor arguments do not match the artifact ABI", {
      cause: error,
    });
  }
}

export async function resolveCotiscanVerificationPlan({
  repositoryRoot,
  manifestPath,
  contractKey,
}) {
  const root = await realpath(resolve(repositoryRoot));
  const deploymentsRoot = await realpath(resolve(root, "deployments"));
  const resolvedManifest = pathInside(
    deploymentsRoot,
    resolve(root, manifestPath),
    "deployment manifest",
  );
  if (dirname(resolvedManifest) !== deploymentsRoot) {
    throw new Error("deployment manifest must be directly under deployments/");
  }
  const manifest = await readJsonFile(resolvedManifest, "deployment manifest");
  if (
    !isRecord(manifest) ||
    manifest.schemaVersion !== 2 ||
    manifest.status !== "complete" ||
    typeof manifest.sourceCommit !== "string" ||
    !SOURCE_COMMIT.test(manifest.sourceCommit) ||
    !isRecord(manifest.contracts) ||
    !isRecord(manifest.compiler)
  ) {
    throw new Error("deployment manifest is not a complete reviewed v2 record");
  }
  const chainId = String(manifest.chainId ?? "");
  const network = COTI_NETWORKS[chainId];
  if (!network || manifest.network !== network.network) {
    throw new Error("deployment manifest is not for a supported COTI network");
  }
  if (!CONTRACT_KEY.test(contractKey)) throw new Error("invalid deployment contract key");
  const deployment = manifest.contracts[contractKey];
  if (!isRecord(deployment)) throw new Error(`deployment contract key is unavailable: ${contractKey}`);
  const address = requiredAddress(deployment.address, "deployed contract address");
  const runtimeCodehash = requiredHash(
    deployment.runtimeCodehash,
    "deployed contract runtime codehash",
  );
  if (typeof deployment.deploymentTx !== "string" || !HASH.test(deployment.deploymentTx)) {
    throw new Error("deployed contract transaction hash is invalid");
  }
  const creationKind = deployment.creationKind ?? "transaction";
  if (creationKind !== "transaction") {
    throw new Error(
      `deployment contract key is not a direct deployment: ${contractKey} (${creationKind})`,
    );
  }

  const compilerMatches = Object.values(manifest.compiler).filter((candidate) =>
    isRecord(candidate) &&
    typeof candidate.runtimeCodehash === "string" &&
    candidate.runtimeCodehash.toLowerCase() === runtimeCodehash,
  );
  if (compilerMatches.length !== 1) {
    throw new Error("deployment compiler provenance is unavailable or ambiguous");
  }
  const compiler = compilerMatches[0];
  if (
    typeof compiler.contractName !== "string" ||
    !CONTRACT_NAME.test(compiler.contractName) ||
    typeof compiler.sourceName !== "string" ||
    compiler.sourceName.includes("..") ||
    !/^contracts\/[A-Za-z0-9_./-]+\.sol$/u.test(compiler.sourceName)
  ) {
    throw new Error("deployment compiler identity is invalid");
  }
  requiredHash(compiler.compilerInputHash, "compiler input hash");
  if (
    typeof compiler.solcVersion !== "string" ||
    typeof compiler.solcLongVersion !== "string"
  ) {
    throw new Error("deployment compiler version is invalid");
  }

  const artifactsRoot = await realpath(resolve(root, "artifacts"));
  const artifactPath = pathInside(
    artifactsRoot,
    resolve(artifactsRoot, compiler.sourceName, `${compiler.contractName}.json`),
    "contract artifact",
  );
  const artifact = await readJsonFile(artifactPath, "contract artifact");
  if (
    !isRecord(artifact) ||
    artifact.contractName !== compiler.contractName ||
    artifact.sourceName !== compiler.sourceName ||
    typeof artifact.buildInfoId !== "string" ||
    !BUILD_INFO_ID.test(artifact.buildInfoId) ||
    !Array.isArray(artifact.abi) ||
    typeof artifact.bytecode !== "string" ||
    !/^0x[0-9a-fA-F]+$/.test(artifact.bytecode) ||
    typeof artifact.deployedBytecode !== "string" ||
    !/^0x[0-9a-fA-F]+$/.test(artifact.deployedBytecode) ||
    hasLinkReferences(artifact.linkReferences) ||
    hasLinkReferences(artifact.deployedLinkReferences)
  ) {
    throw new Error("contract artifact does not match reviewed compiler identity");
  }

  const buildInfoPath = pathInside(
    artifactsRoot,
    resolve(artifactsRoot, "build-info", `${artifact.buildInfoId}.json`),
    "compiler build info",
  );
  const buildInfo = await readJsonFile(buildInfoPath, "compiler build info");
  if (
    !isRecord(buildInfo) ||
    !isRecord(buildInfo.input) ||
    !isRecord(buildInfo.input.settings) ||
    !isRecord(buildInfo.input.sources) ||
    buildInfo.solcVersion !== compiler.solcVersion ||
    buildInfo.solcLongVersion !== compiler.solcLongVersion ||
    !isRecord(buildInfo.userSourceNameMap)
  ) {
    throw new Error("compiler build info is invalid or does not match the manifest");
  }
  const compilerInputHash = keccak256(toUtf8Bytes(JSON.stringify(buildInfo.input)));
  if (compilerInputHash.toLowerCase() !== compiler.compilerInputHash.toLowerCase()) {
    throw new Error("compiler input hash does not match the reviewed deployment manifest");
  }
  compareCompilerSettings(compiler, buildInfo);
  const compilerSourceName = buildInfo.userSourceNameMap[compiler.sourceName];
  if (
    typeof compilerSourceName !== "string" ||
    !isRecord(buildInfo.input.sources[compilerSourceName])
  ) {
    throw new Error("primary source mapping is unavailable in compiler input");
  }
  const constructorArgs = encodeConstructorArguments(artifact, deployment.constructorArgs);
  const expectedCreationInput = `${artifact.bytecode}${constructorArgs.slice(2)}`;
  const licenseType = inferLicense(buildInfo.input, compilerSourceName);

  return Object.freeze({
    manifestPath: resolvedManifest,
    contractKey,
    sourceCommit: manifest.sourceCommit,
    chainId,
    network: manifest.network,
    explorerUrl: network.explorerUrl,
    rpcEnvironment: network.rpcEnvironment,
    defaultRpcUrl: network.defaultRpcUrl,
    address,
    deploymentTransactionHash: deployment.deploymentTx,
    creationKind,
    runtimeCodehash,
    contractName: compiler.contractName,
    sourceName: compiler.sourceName,
    compilerSourceName,
    compilerInputHash,
    compilerVersion: compiler.solcLongVersion,
    compilerSettings: Object.freeze({ ...compiler.settings }),
    constructorArgs,
    expectedCreationInput,
    compiledRuntime: artifact.deployedBytecode,
    immutableReferences: Object.freeze({ ...(artifact.immutableReferences ?? {}) }),
    standardJsonInput: Object.freeze(buildInfo.input),
    licenseType,
  });
}

async function boundedResponseText(response) {
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_HTTP_BODY_BYTES) {
    throw new Error("remote response exceeds the verification boundary");
  }
  return text;
}

async function requestJsonRpc(rpcUrl, method, params, fetchImplementation) {
  const response = await fetchImplementation(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await boundedResponseText(response);
  if (!response.ok) throw new Error(`RPC ${method} failed with HTTP ${response.status}`);
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error(`RPC ${method} returned invalid JSON`, { cause: error });
  }
  if (!isRecord(payload) || payload.id !== 1 || payload.error !== undefined) {
    throw new Error(`RPC ${method} returned an error`);
  }
  return payload.result;
}

export async function authenticateCotiscanVerificationPlan(
  plan,
  { rpcUrl, fetchImplementation = fetch } = {},
) {
  const selectedRpcUrl = rpcUrl?.trim() || plan.defaultRpcUrl;
  let parsedRpcUrl;
  try {
    parsedRpcUrl = new URL(selectedRpcUrl);
  } catch (error) {
    throw new Error(`${plan.rpcEnvironment} must be a valid URL`, { cause: error });
  }
  if (parsedRpcUrl.protocol !== "https:" && parsedRpcUrl.hostname !== "127.0.0.1") {
    throw new Error(`${plan.rpcEnvironment} must use HTTPS or local loopback`);
  }
  const [chainIdHex, code, transaction, receipt] = await Promise.all([
    requestJsonRpc(selectedRpcUrl, "eth_chainId", [], fetchImplementation),
    requestJsonRpc(selectedRpcUrl, "eth_getCode", [plan.address, "latest"], fetchImplementation),
    requestJsonRpc(
      selectedRpcUrl,
      "eth_getTransactionByHash",
      [plan.deploymentTransactionHash],
      fetchImplementation,
    ),
    requestJsonRpc(
      selectedRpcUrl,
      "eth_getTransactionReceipt",
      [plan.deploymentTransactionHash],
      fetchImplementation,
    ),
  ]);
  if (typeof chainIdHex !== "string" || BigInt(chainIdHex).toString() !== plan.chainId) {
    throw new Error("RPC chain ID does not match the deployment manifest");
  }
  if (typeof code !== "string" || !/^0x[0-9a-fA-F]+$/.test(code)) {
    throw new Error("deployed contract runtime is unavailable");
  }
  if (keccak256(code).toLowerCase() !== plan.runtimeCodehash) {
    throw new Error("live runtime codehash does not match the deployment manifest");
  }
  const normalizedActual = normalizeImmutableRanges(code, plan.immutableReferences);
  const normalizedExpected = normalizeImmutableRanges(
    plan.compiledRuntime,
    plan.immutableReferences,
  );
  if (normalizedActual.toLowerCase() !== normalizedExpected.toLowerCase()) {
    throw new Error("live runtime does not match the reviewed compiler artifact");
  }
  if (!isRecord(transaction) || !isRecord(receipt) || receipt.status !== "0x1") {
    throw new Error("deployment transaction is missing or unsuccessful");
  }
  if (plan.creationKind === "transaction") {
    if (
      transaction.to !== null ||
      typeof transaction.input !== "string" ||
      transaction.input.toLowerCase() !== plan.expectedCreationInput.toLowerCase() ||
      typeof receipt.contractAddress !== "string" ||
      receipt.contractAddress.toLowerCase() !== plan.address.toLowerCase()
    ) {
      throw new Error("deployment transaction does not match the reviewed creation input");
    }
  }
  return Object.freeze({ ...plan, rpcAuthenticated: true });
}

function compilerRunCount(readback) {
  return readback.optimizations_runs ?? readback.optimization_runs;
}

function validateCotiscanSources(plan, readback) {
  if (
    readback.file_path !== plan.compilerSourceName ||
    typeof readback.source_code !== "string"
  ) {
    throw new Error("Cotiscan primary source does not match the reviewed compiler input");
  }
  const actualSources = new Map([[readback.file_path, readback.source_code]]);
  if (!Array.isArray(readback.additional_sources)) {
    throw new Error("Cotiscan additional sources are unavailable");
  }
  for (const source of readback.additional_sources) {
    if (
      !isRecord(source) ||
      typeof source.file_path !== "string" ||
      typeof source.source_code !== "string" ||
      actualSources.has(source.file_path)
    ) {
      throw new Error("Cotiscan returned an invalid or duplicate source entry");
    }
    actualSources.set(source.file_path, source.source_code);
  }
  const expectedSources = Object.entries(plan.standardJsonInput.sources);
  if (actualSources.size !== expectedSources.length) {
    throw new Error("Cotiscan source set does not match the reviewed compiler input");
  }
  for (const [sourcePath, source] of expectedSources) {
    if (!isRecord(source) || actualSources.get(sourcePath) !== source.content) {
      throw new Error("Cotiscan source set does not match the reviewed compiler input");
    }
  }
}

export function validateCotiscanReadback(plan, readback) {
  if (
    !isRecord(readback) ||
    readback.is_verified !== true ||
    readback.is_changed_bytecode !== false ||
    readback.creation_status !== "success"
  ) {
    throw new Error("Cotiscan has not verified the exact deployed contract");
  }
  if (
    readback.name !== plan.contractName ||
    normalizedCompilerVersion(readback.compiler_version) !==
      normalizedCompilerVersion(plan.compilerVersion) ||
    readback.optimization_enabled !== plan.compilerSettings.optimizer.enabled ||
    compilerRunCount(readback) !== plan.compilerSettings.optimizer.runs ||
    readback.evm_version !== plan.compilerSettings.evmVersion
  ) {
    throw new Error("Cotiscan verification metadata does not match the reviewed compiler");
  }
  const settings = isRecord(readback.compiler_settings) ? readback.compiler_settings : {};
  if (
    isRecord(settings.optimizer) &&
    (
      settings.optimizer.enabled !== plan.compilerSettings.optimizer.enabled ||
      settings.optimizer.runs !== plan.compilerSettings.optimizer.runs
    )
  ) {
    throw new Error("Cotiscan compiler settings do not match the reviewed optimizer");
  }
  if (settings.viaIR !== undefined && settings.viaIR !== plan.compilerSettings.viaIR) {
    throw new Error("Cotiscan compiler settings do not match reviewed viaIR");
  }
  if (
    isRecord(settings.metadata) &&
    settings.metadata.bytecodeHash !== plan.compilerSettings.metadataBytecodeHash
  ) {
    throw new Error("Cotiscan compiler metadata settings do not match the reviewed build");
  }
  if (
    typeof readback.constructor_args !== "string" ||
    readback.constructor_args.replace(/^0x/, "").toLowerCase() !==
      plan.constructorArgs.slice(2).toLowerCase()
  ) {
    throw new Error("Cotiscan constructor arguments do not match the deployment manifest");
  }
  if (
    typeof readback.deployed_bytecode !== "string" ||
    keccak256(readback.deployed_bytecode).toLowerCase() !== plan.runtimeCodehash
  ) {
    throw new Error("Cotiscan deployed bytecode does not match the deployment manifest");
  }
  if (
    typeof readback.creation_bytecode !== "string" ||
    readback.creation_bytecode.toLowerCase() !== plan.expectedCreationInput.toLowerCase()
  ) {
    throw new Error("Cotiscan creation bytecode does not match the deployment transaction");
  }
  validateCotiscanSources(plan, readback);
  const fullyVerified = readback.is_fully_verified === true;
  return Object.freeze({
    address: plan.address,
    contractName: plan.contractName,
    compilerVersion: plan.compilerVersion,
    verifiedAt: typeof readback.verified_at === "string" ? readback.verified_at : null,
    explorerMatch: fullyVerified ? "full" : "partial",
    fullyVerified,
    exactManifestMatch: true,
  });
}

async function readCotiscanContract(plan, fetchImplementation) {
  const response = await fetchImplementation(
    `${plan.explorerUrl}/api/v2/smart-contracts/${plan.address}`,
    { headers: { accept: "application/json" }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  );
  const text = await boundedResponseText(response);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Cotiscan readback failed with HTTP ${response.status}`);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error("Cotiscan readback returned invalid JSON", { cause: error });
  }
}

async function wait(milliseconds) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

export async function submitCotiscanVerification(
  plan,
  { fetchImplementation = fetch, waitImplementation = wait } = {},
) {
  if (plan.rpcAuthenticated !== true) {
    throw new Error("Cotiscan submission requires an authenticated live deployment plan");
  }
  const existing = await readCotiscanContract(plan, fetchImplementation);
  if (existing?.is_verified === true) {
    return Object.freeze({ status: "already-verified", ...validateCotiscanReadback(plan, existing) });
  }
  const configuration = await fetchImplementation(
    `${plan.explorerUrl}/api/v2/smart-contracts/verification/config`,
    { headers: { accept: "application/json" }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  );
  await boundedResponseText(configuration);
  if (!configuration.ok) {
    throw new Error(`Cotiscan verification service is unavailable (HTTP ${configuration.status})`);
  }

  const form = new FormData();
  form.append("compiler_version", `v${normalizedCompilerVersion(plan.compilerVersion)}`);
  form.append("contract_name", plan.contractName);
  form.append(
    "files[0]",
    new Blob([JSON.stringify(plan.standardJsonInput)], { type: "application/json" }),
    "standard-input.json",
  );
  form.append("autodetect_constructor_args", "false");
  form.append("constructor_args", plan.constructorArgs.slice(2));
  form.append("license_type", plan.licenseType);
  const submission = await fetchImplementation(
    `${plan.explorerUrl}/api/v2/smart-contracts/${plan.address}/verification/via/standard-input`,
    {
      method: "POST",
      headers: { accept: "application/json" },
      body: form,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  const submissionBody = await boundedResponseText(submission);
  if (!submission.ok) {
    const suffix = submissionBody ? `: ${submissionBody.slice(0, 500)}` : "";
    throw new Error(`Cotiscan verification submission failed (HTTP ${submission.status})${suffix}`);
  }

  let latest = null;
  for (let attempt = 0; attempt < READBACK_ATTEMPTS; attempt += 1) {
    latest = await readCotiscanContract(plan, fetchImplementation);
    if (latest?.is_verified === true) {
      return Object.freeze({ status: "verified", ...validateCotiscanReadback(plan, latest) });
    }
    await waitImplementation(READBACK_INTERVAL_MS);
  }
  throw new Error("Cotiscan did not confirm exact source verification within the readback window");
}

export function publicVerificationSummary(plan, mode) {
  return Object.freeze({
    mode,
    network: plan.network,
    chainId: plan.chainId,
    explorer: plan.explorerUrl,
    manifest: plan.manifestPath,
    sourceCommit: plan.sourceCommit,
    contractKey: plan.contractKey,
    contractName: plan.contractName,
    sourceName: plan.sourceName,
    address: plan.address,
    deploymentTransactionHash: plan.deploymentTransactionHash,
    runtimeCodehash: plan.runtimeCodehash,
    compilerInputHash: plan.compilerInputHash,
    compilerVersion: plan.compilerVersion,
    compilerSettings: plan.compilerSettings,
    constructorArgs: plan.constructorArgs,
    licenseType: plan.licenseType,
  });
}

async function main() {
  let options;
  try {
    options = parseCotiscanArguments(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid arguments");
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(usage());
    return;
  }
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const plan = await resolveCotiscanVerificationPlan({
    repositoryRoot,
    manifestPath: options.manifest,
    contractKey: options.contract,
  });
  const authenticated = await authenticateCotiscanVerificationPlan(plan, {
    rpcUrl: process.env[plan.rpcEnvironment],
  });
  console.log(JSON.stringify(publicVerificationSummary(
    authenticated,
    options.submit ? "submit" : "dry-run",
  ), null, 2));
  if (!options.submit) {
    console.log("Dry-run complete; no source was submitted to Cotiscan.");
    return;
  }
  const result = await submitCotiscanVerification(authenticated);
  console.log(JSON.stringify(result, null, 2));
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Cotiscan verification failed");
    process.exitCode = 1;
  });
}
