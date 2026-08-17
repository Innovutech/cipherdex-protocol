import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

const ALLOWED_TARGETS = new Map([
  ["scripts/deploy-testnet.ts", {
    arguments: ["--network", "cotiTestnet"],
    funded: true,
    environment: [
      "COTI_DEPLOYMENT_RECORD",
      "CIPHERDEX_FEE_BENEFICIARY",
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
      "COTI_BEST_EXECUTION_SWAP_AMOUNT",
      "COTI_BEST_EXECUTION_GAS_LIMIT",
      "COTI_DEPLOYMENT_RECORD",
      "CIPHERDEX_FEE_BENEFICIARY",
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
    environment: ["COTI_DEPLOYMENT_RECORD"],
  }],
  ["scripts/verify-funded-suite-evidence.ts", {
    arguments: ["--network", "cotiTestnet"],
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
    environment: ["COTI_QUOTE_PRIVATE_KEY", "COTI_QUOTE_AES_KEY"],
  }],
  ["scripts/testnet-launchpad.ts", {
    arguments: ["--network", "cotiTestnet"],
    funded: true,
    environment: [
      "COTI_AES_KEY",
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
]);

const [target, ...targetArguments] = process.argv.slice(2);
const targetPolicy = target ? ALLOWED_TARGETS.get(target) : undefined;
if (
  !target ||
  !targetPolicy ||
  JSON.stringify(targetArguments) !== JSON.stringify(targetPolicy.arguments)
) {
  throw new Error("unsupported fresh Hardhat target or arguments");
}

function selectedEnvironment(names, source = process.env) {
  const selected = { NODE_OPTIONS: "--max-old-space-size=8192" };
  for (const name of names) {
    const value = source[name];
    if (typeof value === "string" && value.length > 0) selected[name] = value;
  }
  return selected;
}

const systemEnvironment = selectedEnvironment(SYSTEM_ENVIRONMENT);

const TRUSTED_GIT_CANDIDATES = Object.freeze(
  process.platform === "win32"
    ? [
        "C:\\Program Files\\Git\\cmd\\git.exe",
        "C:\\Program Files (x86)\\Git\\cmd\\git.exe",
      ]
    : ["/usr/bin/git", "/bin/git"],
);
const trustedGitExecutable = TRUSTED_GIT_CANDIDATES.find((candidate) => existsSync(candidate));
if (!trustedGitExecutable) {
  throw new Error("Fresh Hardhat runner requires Git at a trusted system path");
}
const trustedGitRealpath = realpathSync(trustedGitExecutable);
const workingTreeRealpath = realpathSync(resolve(process.cwd()));
const pathComparison = process.platform === "win32"
  ? [trustedGitRealpath.toLowerCase(), workingTreeRealpath.toLowerCase()]
  : [trustedGitRealpath, workingTreeRealpath];
if (
  pathComparison[0] === pathComparison[1] ||
  pathComparison[0].startsWith(`${pathComparison[1]}${process.platform === "win32" ? "\\" : "/"}`)
) {
  throw new Error("Fresh Hardhat runner refuses a repository-controlled Git executable");
}

function runGit(arguments_) {
  const result = spawnSync(trustedGitRealpath, arguments_, {
    cwd: process.cwd(),
    env: systemEnvironment,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Unable to authenticate source with git ${arguments_.join(" ")}`);
  }
  return result.stdout.trim();
}

// Authenticate source before resolving Hardhat or loading any secret-bearing env file.
const repositoryRoot = runGit(["rev-parse", "--show-toplevel"]);
if (realpathSync(repositoryRoot) !== realpathSync(resolve(process.cwd()))) {
  throw new Error("Fresh Hardhat runner must execute from the repository root");
}
const sourceCommit = runGit(["rev-parse", "--verify", "HEAD"]);
if (!/^[0-9a-f]{40}$/i.test(sourceCommit)) {
  throw new Error("Fresh Hardhat runner requires a resolvable committed HEAD");
}
if (runGit(["status", "--porcelain=v1", "--untracked-files=all"]) !== "") {
  throw new Error("Fresh Hardhat runner requires a clean committed worktree");
}

const require = createRequire(import.meta.url);
const hardhatCli = require.resolve("hardhat/internal/cli/cli.js");

function runHardhat(arguments_, environment) {
  const result = spawnSync(process.execPath, [hardhatCli, ...arguments_], {
    cwd: process.cwd(),
    env: environment,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    throw new Error(`Hardhat ${arguments_[0]} failed`);
  }
}

// Build subprocesses receive no COTI/CipherDEX configuration or credentials.
runHardhat(["clean"], systemEnvironment);
runHardhat(["compile"], systemEnvironment);

if (existsSync(resolve(process.cwd(), ".env"))) {
  process.loadEnvFile(resolve(process.cwd(), ".env"));
}
const runtimeEnvironment = selectedEnvironment([
  ...SYSTEM_ENVIRONMENT,
  ...NETWORK_ENVIRONMENT,
  ...(targetPolicy.funded ? FUNDED_NETWORK_ENVIRONMENT : []),
  ...targetPolicy.environment,
]);
runtimeEnvironment.CIPHERDEX_TRUSTED_GIT = trustedGitRealpath;
runHardhat(["run", "--no-compile", target, ...targetArguments], runtimeEnvironment);
