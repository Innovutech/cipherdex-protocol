import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

const ALLOWED_TARGETS = new Map([
  ["scripts/recover-funded-deployment.ts", {
    arguments: ["--network", "cotiTestnet"],
    funded: true,
    recovery: true,
    environment: [
      "CIPHERDEX_RECOVERY_SOURCE_COMMIT",
      "CIPHERDEX_RECOVERY_TRANSACTION_HASH",
    ],
  }],
  ["scripts/deploy-testnet.ts", {
    arguments: ["--network", "cotiTestnet"],
    funded: true,
    environment: [
      "COTI_DEPLOYMENT_RECORD",
      "CIPHERDEX_FEE_BENEFICIARY",
      "CIPHERDEX_LAUNCH_AUTHORITY",
      "COTI_TOKEN0",
      "COTI_TOKEN1",
      "CIPHERDEX_PRIVATE_TOKEN_CODEHASHES",
    ],
  }],
  ["scripts/measure-deployment-gas.ts", {
    arguments: [],
    environment: ["CIPHERDEX_PRIVATE_TOKEN_CODEHASHES"],
  }],
  ["scripts/testnet-best-execution-feasibility.ts", {
    arguments: ["--network", "cotiTestnet"],
    funded: true,
    environment: [
      "COTI_AES_KEY",
      "COTI_TOKEN0",
      "COTI_TOKEN1",
      "COTI_FACTORY",
      "COTI_FEE_VAULT",
      "COTI_BEST_EXECUTION_ROUTER",
      "COTI_BEST_EXECUTION_TEST_AMOUNT_IN",
      "COTI_DEPLOYMENT_RECORD",
      "CIPHERDEX_PRIVATE_TOKEN_CODEHASHES",
    ],
  }],
  ["scripts/testnet-best-execution.ts", {
    arguments: ["--network", "cotiTestnet"],
    funded: true,
    environment: [
      "COTI_AES_KEY",
      "COTI_SECOND_LP_PRIVATE_KEY",
      "COTI_SECOND_LP_AES_KEY",
      "COTI_QUOTE_PRIVATE_KEY",
      "COTI_QUOTE_AES_KEY",
      "COTI_TOKEN0",
      "COTI_TOKEN1",
      "COTI_FACTORY",
      "COTI_FEE_VAULT",
      "COTI_BEST_EXECUTION_ROUTER",
      "COTI_BEST_EXECUTION_SWAP_AMOUNT_TOKEN0",
      "COTI_BEST_EXECUTION_SWAP_AMOUNT_TOKEN1",
      "COTI_BEST_EXECUTION_MAX_PROTOCOL_FEE_TOKEN0",
      "COTI_BEST_EXECUTION_MAX_PROTOCOL_FEE_TOKEN1",
      "COTI_BEST_EXECUTION_GAS_LIMIT",
      "COTI_DEPLOYMENT_RECORD",
      "CIPHERDEX_PRIVATE_TOKEN_CODEHASHES",
    ],
  }],
  ["scripts/testnet-fee-collection.ts", {
    arguments: ["--network", "cotiTestnet"],
    funded: true,
    environment: [
      "COTI_AES_KEY",
      "COTI_TOKEN0",
      "COTI_TOKEN1",
      "COTI_FACTORY",
      "COTI_FEE_VAULT",
      "COTI_FEE_TEST_LIQUIDITY0",
      "COTI_FEE_TEST_LIQUIDITY1",
      "COTI_FEE_TEST_SWAP0",
      "COTI_FEE_TEST_SWAP1",
      "COTI_DEPLOYMENT_RECORD",
      "CIPHERDEX_PRIVATE_TOKEN_CODEHASHES",
    ],
  }],
  ["scripts/finalize-funded-evidence.ts", {
    arguments: ["--network", "cotiTestnet"],
    reviewedRuntime: true,
    environment: ["COTI_DEPLOYMENT_RECORD"],
  }],
  ["scripts/verify-funded-suite-evidence.ts", {
    arguments: ["--network", "cotiTestnet"],
    reviewedRuntime: true,
    environment: [
      "COTI_DEPLOYMENT_RECORD",
      "CIPHERDEX_FUNDED_EVIDENCE_RECORD",
    ],
  }],
  ["scripts/testnet-preflight.ts", {
    arguments: ["--network", "cotiTestnet"],
    funded: true,
    environment: [
      "COTI_AES_KEY",
      "COTI_SECOND_LP_PRIVATE_KEY",
      "COTI_SECOND_LP_AES_KEY",
      "COTI_QUOTE_PRIVATE_KEY",
      "COTI_QUOTE_AES_KEY",
      "COTI_TOKEN0",
      "COTI_TOKEN1",
      "COTI_TOKEN0_DECIMALS",
      "COTI_TOKEN1_DECIMALS",
    ],
  }],
  ["scripts/testnet-quote-call-probe.ts", {
    arguments: ["--network", "cotiTestnet"],
    funded: true,
    environment: [
      "COTI_QUOTE_PRIVATE_KEY",
      "COTI_QUOTE_AES_KEY",
      "COTI_FACTORY",
      "COTI_DEPLOYMENT_RECORD",
    ],
  }],
  ["scripts/testnet-launchpad.ts", {
    arguments: ["--network", "cotiTestnet"],
    funded: true,
    environment: [
      "COTI_AES_KEY",
      "COTI_QUOTE_PRIVATE_KEY",
      "COTI_TOKEN0",
      "COTI_TOKEN1",
      "COTI_TOKEN0_DECIMALS",
      "COTI_TOKEN1_DECIMALS",
      "COTI_FACTORY",
      "COTI_FEE_VAULT",
      "COTI_LAUNCHPAD_AMOUNT0",
      "COTI_LAUNCHPAD_AMOUNT1",
      "COTI_LAUNCHPAD_FEE_BPS",
      "COTI_LAUNCHPAD_MIN_SHARES",
      "COTI_LAUNCHPAD_MIN_PRICE_X18",
      "COTI_LAUNCHPAD_MAX_PRICE_X18",
      "COTI_LAUNCHPAD_DISPOSITION",
      "COTI_LAUNCHPAD_UNLOCK_TIME",
      "COTI_DEPLOYMENT_RECORD",
      "CIPHERDEX_PRIVATE_TOKEN_CODEHASHES",
    ],
  }],
  ["scripts/testnet-harness.ts", {
    arguments: ["--network", "cotiTestnet"],
    funded: true,
    environment: [
      "COTI_AES_KEY",
      "COTI_POOL",
      "COTI_FACTORY",
      "COTI_FEE_VAULT",
      "COTI_TOKEN0",
      "COTI_TOKEN1",
      "COTI_TOKEN0_DECIMALS",
      "COTI_TOKEN1_DECIMALS",
      "COTI_TEST_AMOUNT_IN",
      "COTI_TESTNET_SLIPPAGE_BPS",
      "COTI_DEPLOYMENT_RECORD",
      "CIPHERDEX_PRIVATE_TOKEN_CODEHASHES",
    ],
  }],
]);

const NETWORK_ENVIRONMENT = Object.freeze([
  "COTI_TESTNET_RPC_URL",
]);
const FUNDED_NETWORK_ENVIRONMENT = Object.freeze([
  "COTI_TESTNET_PRIVATE_KEY",
  "COTI_TESTNET_GAS_LIMIT",
]);
const SYSTEM_ENVIRONMENT = Object.freeze([
  "PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "ComSpec", "COMSPEC",
  "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
  "LANG", "LC_ALL", "CI", "GITHUB_ACTIONS",
  "CIPHERDEX_FUNDED_STATE_ROOT",
]);

const heldLeases = [];
function releaseHeldLeases() {
  let releaseError;
  for (const lease of heldLeases.reverse()) {
    try {
      lease.release();
    } catch (error) {
      releaseError ??= error;
    }
  }
  heldLeases.length = 0;
  if (releaseError) throw releaseError;
}
process.on("exit", () => {
  try {
    releaseHeldLeases();
  } catch {
    // The next process validates ownership and safely recovers a dead-owner lease.
  }
});

function selectedEnvironment(names, source = process.env) {
  const selected = { NODE_OPTIONS: "--max-old-space-size=8192" };
  for (const name of names) {
    const value = source[name];
    if (typeof value === "string" && value.length > 0) selected[name] = value;
  }
  return selected;
}

const systemEnvironment = selectedEnvironment(SYSTEM_ENVIRONMENT);

function requiredCanonicalDirectory(name) {
  const configured = process.env[name]?.trim();
  if (!configured || !isAbsolute(configured)) {
    throw new Error(`${name} must be an absolute directory`);
  }
  const original = lstatSync(configured);
  if (!original.isDirectory() || original.isSymbolicLink()) {
    throw new Error(`${name} must be a real directory`);
  }
  return realpathSync(configured);
}

function isInside(root, path) {
  const fromRoot = relative(root, path);
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}

function trustedGit() {
  const configured = process.env.CIPHERDEX_TRUSTED_GIT?.trim();
  if (!configured || !isAbsolute(configured)) {
    throw new Error("operator launcher did not provide an absolute trusted Git executable");
  }
  const original = lstatSync(configured);
  if (!original.isFile() || original.isSymbolicLink()) {
    throw new Error("operator launcher trusted Git path is invalid");
  }
  return realpathSync(configured);
}

function runGit(git, cwd, arguments_) {
  const gitEnvironment = {
    ...systemEnvironment,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "core.fsmonitor",
    GIT_CONFIG_VALUE_0: "false",
    GIT_CONFIG_KEY_1: "core.hooksPath",
    GIT_CONFIG_VALUE_1: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
  };
  const result = spawnSync(
    git,
    ["--no-replace-objects", "--no-pager", ...arguments_],
    {
      cwd,
      env: gitEnvironment,
      encoding: "utf8",
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(`Unable to authenticate source with git ${arguments_.join(" ")}`);
  }
  return result.stdout.trim();
}

async function main() {
  const [target, ...targetArguments] = process.argv.slice(2);
  const targetPolicy = target ? ALLOWED_TARGETS.get(target) : undefined;
  if (
    !target ||
    !targetPolicy ||
    JSON.stringify(targetArguments) !== JSON.stringify(targetPolicy.arguments)
  ) throw new Error("unsupported private funded Hardhat target or arguments");
  if (process.env.CIPHERDEX_OPERATOR_LAUNCHER_ACTIVE !== "1") {
    throw new Error(
      "funded targets may run only through the externally installed operator-funded launcher",
    );
  }

  const executionRoot = realpathSync(resolve(process.cwd()));
  const publicRepositoryRoot = requiredCanonicalDirectory("CIPHERDEX_PUBLIC_REPOSITORY_ROOT");
  const buildReceiptRoot = requiredCanonicalDirectory("CIPHERDEX_BUILD_RECEIPT_ROOT");
  const fundedStateRoot = targetPolicy.funded
    ? requiredCanonicalDirectory("CIPHERDEX_FUNDED_STATE_ROOT")
    : undefined;
  if (isInside(executionRoot, publicRepositoryRoot) || isInside(publicRepositoryRoot, executionRoot)) {
    throw new Error("private funded runtime and public repository must be separate trees");
  }
  if (buildReceiptRoot === executionRoot || !isInside(executionRoot, buildReceiptRoot)) {
    throw new Error("reviewed build receipt root must be a private runtime subdirectory");
  }
  if (
    fundedStateRoot !== undefined &&
    (isInside(executionRoot, fundedStateRoot) || isInside(publicRepositoryRoot, fundedStateRoot))
  ) {
    throw new Error("funded recovery state must remain outside runtime and public repository");
  }
  const sourceCommit = process.env.CIPHERDEX_AUTHENTICATED_SOURCE_COMMIT?.trim().toLowerCase();
  if (!sourceCommit || !/^[0-9a-f]{40}$/u.test(sourceCommit)) {
    throw new Error("operator launcher did not provide an authenticated source commit");
  }
  const git = trustedGit();
  if (isInside(executionRoot, git) || isInside(publicRepositoryRoot, git)) {
    throw new Error("funded runner refuses a repository-controlled Git executable");
  }

  const { assertPrivateFile, assertPrivateTree } = await import("./private-filesystem.mjs");
  assertPrivateTree(executionRoot);
  if (
    realpathSync(runGit(git, executionRoot, ["rev-parse", "--show-toplevel"])) !== executionRoot ||
    runGit(git, executionRoot, ["rev-parse", "--verify", "HEAD"]).toLowerCase() !== sourceCommit ||
    runGit(git, executionRoot, ["status", "--porcelain=v1", "--untracked-files=all"]) !== ""
  ) throw new Error("private funded runtime is not the clean authenticated source commit");
  if (existsSync(resolve(executionRoot, ".env")) || existsSync(resolve(publicRepositoryRoot, ".env"))) {
    throw new Error("funded execution refuses repository-local environment files");
  }

  const environmentConfigured = process.env.CIPHERDEX_FUNDED_ENV_FILE?.trim();
  if (!environmentConfigured || !isAbsolute(environmentConfigured)) {
    throw new Error("funded targets require an absolute external environment file");
  }
  const environmentPath = assertPrivateFile(environmentConfigured, "read");
  if (isInside(executionRoot, environmentPath) || isInside(publicRepositoryRoot, environmentPath)) {
    throw new Error("funded environment must remain outside runtime and public repository");
  }

  const trackedFiles = runGit(git, executionRoot, ["ls-files", "-z"])
    .split("\0")
    .filter(Boolean);
  const { verifyReviewedBuild } = await import("./reviewed-build-receipt.mjs");
  verifyReviewedBuild(executionRoot, sourceCommit, { trackedFiles, receiptRoot: buildReceiptRoot });

  const {
    ACTIVE_SIGNER_LEASES_ENVIRONMENT,
    acquireRepositoryExecutionLease,
    acquireSignerExecutionLeases,
    assertSoleRecoverableSignerTransaction,
    reconcileSignerExecutionLeases,
    signerLeaseEnvironment,
  } = await import("./funded-process-coordinator.mjs");
  heldLeases.push(acquireRepositoryExecutionLease(publicRepositoryRoot));

  const {
    buildReviewedRuntimeEnvironment,
    readReviewedEnvironment,
  } = await import("./fresh-runtime-environment.mjs");
  const runtimeEnvironment = buildReviewedRuntimeEnvironment({
    ambientEnvironment: process.env,
    fileEnvironment: readReviewedEnvironment(environmentPath),
    systemNames: SYSTEM_ENVIRONMENT,
    configurationNames: [
      ...NETWORK_ENVIRONMENT,
      ...(targetPolicy.funded ? FUNDED_NETWORK_ENVIRONMENT : []),
      ...targetPolicy.environment,
    ],
    allowAmbientConfiguration: false,
  });
  runtimeEnvironment.CIPHERDEX_TRUSTED_GIT = git;
  runtimeEnvironment.CIPHERDEX_OPERATOR_LAUNCHER_ACTIVE = "1";
  runtimeEnvironment.CIPHERDEX_AUTHENTICATED_SOURCE_COMMIT = sourceCommit;
  runtimeEnvironment.CIPHERDEX_PUBLIC_REPOSITORY_ROOT = publicRepositoryRoot;
  if (fundedStateRoot !== undefined) {
    runtimeEnvironment.CIPHERDEX_FUNDED_STATE_ROOT = fundedStateRoot;
  }

  if (targetPolicy.funded) {
    const { JsonRpcProvider, Wallet } = await import("ethers");
    const { inspectFundedTransaction } = await import("./funded-rpc-confirmation.mjs");
    const privateKeys = [
      runtimeEnvironment.COTI_TESTNET_PRIVATE_KEY,
      runtimeEnvironment.COTI_SECOND_LP_PRIVATE_KEY,
      runtimeEnvironment.COTI_QUOTE_PRIVATE_KEY,
    ].filter((value) => typeof value === "string" && value.length > 0);
    if (privateKeys.length === 0) throw new Error("funded target has no reviewed signer key");
    const signers = privateKeys.map((privateKey) => new Wallet(privateKey).address);
    const signerLeases = acquireSignerExecutionLeases(7_082_400, signers);
    heldLeases.push(...signerLeases);
    const provider = new JsonRpcProvider(
      runtimeEnvironment.COTI_TESTNET_RPC_URL ?? "https://testnet.coti.io/rpc",
      7_082_400,
      { staticNetwork: true },
    );
    try {
      if (targetPolicy.recovery === true) {
        const expectedHash = runtimeEnvironment.CIPHERDEX_RECOVERY_TRANSACTION_HASH?.toLowerCase();
        if (!expectedHash || !/^0x[0-9a-f]{64}$/u.test(expectedHash)) {
          throw new Error("funded recovery target requires one explicit transaction hash");
        }
        assertSoleRecoverableSignerTransaction(signerLeases, expectedHash);
      } else {
        await reconcileSignerExecutionLeases(
          signerLeases,
          async (lease, transaction) => inspectFundedTransaction(provider, {
            chainId: lease.chainId,
            signer: lease.signer,
            nonce: transaction.nonce,
            hash: transaction.hash,
          }),
        );
      }
    } finally {
      provider.destroy();
    }
    runtimeEnvironment[ACTIVE_SIGNER_LEASES_ENVIRONMENT] = signerLeaseEnvironment(signerLeases);
  }

  const { resolveHardhatCli } = await import("./resolve-hardhat-cli.mjs");
  const hardhatCli = resolveHardhatCli(executionRoot);
  const result = spawnSync(
    process.execPath,
    [hardhatCli, "run", "--no-compile", target, ...targetArguments],
    { cwd: executionRoot, env: runtimeEnvironment, stdio: "inherit", windowsHide: true },
  );
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(`reviewed funded target failed with status ${result.status}`);
  }

  // Detect mutation of authenticated source, dependencies or compiler outputs
  // before any generated JSON crosses back into the public checkout.
  verifyReviewedBuild(executionRoot, sourceCommit, { trackedFiles, receiptRoot: buildReceiptRoot });
  const { publishReviewedJson } = await import("./secure-publication.mjs");
  for (const directoryName of ["deployments", "evidence"]) {
    const sourceRoot = resolve(executionRoot, directoryName);
    if (!existsSync(sourceRoot)) continue;
    const sourceStat = lstatSync(sourceRoot);
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
      throw new Error(`reviewed runtime output directory is invalid: ${directoryName}`);
    }
    const destinationRoot = resolve(publicRepositoryRoot, directoryName);
    const destinationStat = lstatSync(destinationRoot);
    if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink()) {
      throw new Error(`public output directory is invalid: ${directoryName}`);
    }
    const expectedName = directoryName === "deployments"
      ? /^coti-testnet-(?:latest|[0-9a-f]{40})\.json$/u
      : /^coti-testnet-[0-9a-f]{40}\.json$/u;
    for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !expectedName.test(entry.name)) continue;
      publishReviewedJson(
        resolve(sourceRoot, entry.name),
        resolve(destinationRoot, entry.name),
      );
    }
  }
}

try {
  await main();
} finally {
  releaseHeldLeases();
}
