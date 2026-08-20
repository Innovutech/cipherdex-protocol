import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { Wallet } from "ethers";
import { ethers } from "../hardhat/runtime.js";

import {
  validateFundedDeploymentBinding,
  type FundedDeploymentBinding,
} from "./funded-deployment-binding";
import { writePreparedFundedRunEvidence } from "./funded-run-evidence";
import {
  openFundedRecoveryJournal,
} from "./funded-transaction-wallet";
import { requiredFundedRecoveryDirectory } from "./funded-runtime-state";
import { requiredTestnetDeploymentRecordPath } from "./testnet-deployment-provenance";
import {
  trustedGitArguments,
  trustedGitEnvironment,
  trustedGitExecutable,
} from "./trusted-git";

const EXPECTED_CHAIN_ID = 7_082_400;
const COMMIT = /^[0-9a-f]{40}$/u;
const RECORD_PATH = /^deployments\/coti-testnet-([0-9a-f]{40})\.json$/u;
const RUNNERS = Object.freeze([
  ["best-execution-feasibility", "scripts/testnet-best-execution-feasibility.ts"],
  ["best-execution", "scripts/testnet-best-execution.ts"],
  ["fee-collection", "scripts/testnet-fee-collection.ts"],
  ["launchpad", "scripts/testnet-launchpad.ts"],
] as const);

function gitBuffer(arguments_: readonly string[]): Buffer {
  const git = trustedGitExecutable(process.env, process.cwd());
  return execFileSync(git, trustedGitArguments(arguments_), {
    cwd: process.cwd(),
    env: trustedGitEnvironment(),
    encoding: "buffer",
    maxBuffer: 10_000_000,
    windowsHide: true,
  });
}

function gitText(arguments_: readonly string[]): string {
  return gitBuffer(arguments_).toString("utf8").trim();
}

function deploymentBinding(): FundedDeploymentBinding {
  const configured = requiredTestnetDeploymentRecordPath().replaceAll("\\", "/");
  const match = RECORD_PATH.exec(configured);
  if (!match) {
    throw new Error("funded evidence recovery requires a canonical deployment record path");
  }
  const sourceCommit = match[1];
  const recordCommits = gitText([
    "log",
    "--diff-filter=A",
    "--format=%H",
    "--reverse",
    "--",
    configured,
  ]).split(/\r?\n/u).filter(Boolean);
  if (recordCommits.length !== 1 || !COMMIT.test(recordCommits[0])) {
    throw new Error("deployment record does not have one authenticated creation commit");
  }
  const manifestCommit = recordCommits[0].toLowerCase();
  gitBuffer(["merge-base", "--is-ancestor", sourceCommit, manifestCommit]);
  gitBuffer(["merge-base", "--is-ancestor", manifestCommit, "HEAD"]);
  const immutableRecord = gitBuffer(["show", `${manifestCommit}:${configured}`]);
  const headRecord = gitBuffer(["show", `HEAD:${configured}`]);
  if (!immutableRecord.equals(headRecord)) {
    throw new Error("deployment record changed after its authenticated creation commit");
  }
  const parsed = JSON.parse(immutableRecord.toString("utf8")) as Record<string, unknown>;
  if (
    parsed.schemaVersion !== 2 ||
    parsed.status !== "complete" ||
    parsed.network !== "cotiTestnet" ||
    parsed.chainId !== String(EXPECTED_CHAIN_ID) ||
    parsed.sourceCommit !== sourceCommit
  ) throw new Error("deployment record is not the expected complete COTI testnet manifest");

  for (const [, runnerSource] of RUNNERS) {
    const reviewedSource = gitBuffer(["show", `${sourceCommit}:${runnerSource}`]);
    const currentSource = readFileSync(resolve(runnerSource));
    if (!reviewedSource.equals(currentSource)) {
      throw new Error(`funded runner changed after deployment: ${runnerSource}`);
    }
  }

  return validateFundedDeploymentBinding({
    recordPath: configured,
    recordSha256: createHash("sha256").update(immutableRecord).digest("hex"),
    manifestCommit,
    sourceCommit,
  });
}

async function main(): Promise<void> {
  const privateKey = process.env.COTI_TESTNET_PRIVATE_KEY?.trim();
  if (!privateKey) throw new Error("COTI_TESTNET_PRIVATE_KEY is required");
  const network = await ethers.provider.getNetwork();
  if (Number(network.chainId) !== EXPECTED_CHAIN_ID) {
    throw new Error("funded evidence recovery requires COTI testnet");
  }
  const signer = new Wallet(privateKey, ethers.provider);
  const owner = await signer.getAddress();
  const deployment = deploymentBinding();
  const directory = requiredFundedRecoveryDirectory();

  for (const [runner] of RUNNERS) {
    const journal = openFundedRecoveryJournal(privateKey, {
      runner,
      sourceCommit: deployment.sourceCommit,
      chainId: EXPECTED_CHAIN_ID,
      owner,
      deployment,
      directory,
    });
    const unresolved = await journal.reconcileTransactions(ethers.provider);
    if (unresolved.length !== 0) {
      throw new Error(`funded evidence recovery found unresolved transactions: ${runner}`);
    }
    if (
      journal.activeResources.length !== 0 ||
      journal.activeAllowanceObligations.length !== 0 ||
      journal.evidencePlan === undefined ||
      !["passed", "evidence-pending", "evidence-failed"].includes(journal.runStatus)
    ) throw new Error(`funded journal is not terminal and evidence-ready: ${runner}`);
    if (journal.runStatus === "passed") journal.markRun("evidence-pending");
    await writePreparedFundedRunEvidence({
      journal,
      provider: ethers.provider,
      attestationSigner: signer,
    });
    console.log(`Rematerialized funded evidence: ${runner}`);
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "funded evidence recovery failed");
  process.exitCode = 1;
});
