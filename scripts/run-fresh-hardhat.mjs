import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const ALLOWED_TARGETS = new Map([
  ["scripts/deploy-testnet.ts", ["--network", "cotiTestnet"]],
  ["scripts/measure-deployment-gas.ts", []],
  ["scripts/testnet-best-execution-feasibility.ts", ["--network", "cotiTestnet"]],
  ["scripts/testnet-best-execution.ts", ["--network", "cotiTestnet"]],
  ["scripts/testnet-fee-collection.ts", ["--network", "cotiTestnet"]],
  ["scripts/testnet-preflight.ts", ["--network", "cotiTestnet"]],
]);

const [target, ...targetArguments] = process.argv.slice(2);
const expectedArguments = target ? ALLOWED_TARGETS.get(target) : undefined;
if (
  !target ||
  !expectedArguments ||
  JSON.stringify(targetArguments) !== JSON.stringify(expectedArguments)
) {
  throw new Error("unsupported fresh Hardhat target or arguments");
}

const require = createRequire(import.meta.url);
const hardhatCli = require.resolve("hardhat/internal/cli/cli.js");

function runHardhat(arguments_) {
  const result = spawnSync(process.execPath, [hardhatCli, ...arguments_], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    throw new Error(`Hardhat ${arguments_[0]} failed`);
  }
}

// Process isolation prevents target imports from observing pre-compile artifacts.
runHardhat(["clean"]);
runHardhat(["compile"]);
runHardhat(["run", "--no-compile", target, ...targetArguments]);
