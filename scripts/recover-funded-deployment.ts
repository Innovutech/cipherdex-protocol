import { execFileSync } from "node:child_process";
import { Wallet } from "ethers";
import { ethers } from "../hardhat/runtime.js";

import {
  openFundedRecoveryJournal,
} from "./funded-transaction-wallet";
import {
  readSignerTransactionState,
  recordPreparedSignerTransactionAbandoned,
  recordSignerTransactionStatus,
} from "./funded-process-coordinator.mjs";
import { inspectFundedTransaction } from "./funded-rpc-confirmation.mjs";
import { requiredFundedRecoveryDirectory } from "./funded-runtime-state";
import {
  trustedGitArguments,
  trustedGitEnvironment,
  trustedGitExecutable,
} from "./trusted-git";

const CHAIN_ID = 7_082_400;
const POLL_INTERVAL_MILLIS = 2_000;
const POLL_ATTEMPTS = 150;

function requiredEnvironment(name: string, pattern: RegExp): string {
  const value = process.env[name]?.trim();
  if (!value || !pattern.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function uniquePosition(source: string, marker: string): number {
  const position = source.indexOf(marker);
  if (position < 0 || position !== source.lastIndexOf(marker)) {
    throw new Error(`historical funded boundary marker is not unique: ${marker}`);
  }
  return position;
}

function assertHistoricalPrebroadcastOrder(sourceCommit: string, authenticatedCommit: string): void {
  const git = trustedGitExecutable(process.env, process.cwd());
  const options = {
    cwd: process.cwd(),
    env: trustedGitEnvironment(),
    encoding: "utf8" as const,
    maxBuffer: 5_000_000,
    windowsHide: true,
  };
  try {
    execFileSync(
      git,
      trustedGitArguments(["merge-base", "--is-ancestor", sourceCommit, authenticatedCommit]),
      options,
    );
  } catch {
    throw new Error("recovery source is not an ancestor of the authenticated runtime");
  }
  let source: string;
  try {
    source = execFileSync(
      git,
      trustedGitArguments([
        "show",
        `${sourceCommit}:scripts/funded-transaction-wallet.ts`,
      ]),
      options,
    );
  } catch {
    throw new Error("unable to authenticate the historical funded transaction boundary");
  }
  const signerPrepared = uniquePosition(source, "recordPreparedSignerTransaction({");
  const journalPrepared = uniquePosition(source, "context.journal.recordPreparedTransaction(");
  const broadcast = uniquePosition(
    source,
    "wallet.provider.broadcastTransaction(signedTransaction)",
  );
  if (!(signerPrepared < journalPrepared && journalPrepared < broadcast)) {
    throw new Error("historical funded transaction ordering does not prove pre-broadcast abandonment");
  }
}

async function main(): Promise<void> {
  const network = await ethers.provider.getNetwork();
  if (Number(network.chainId) !== CHAIN_ID) {
    throw new Error(`deployment recovery is restricted to COTI testnet (got ${network.chainId})`);
  }
  const privateKey = requiredEnvironment(
    "COTI_TESTNET_PRIVATE_KEY",
    /^0x[0-9a-f]{64}$/iu,
  );
  const sourceCommit = requiredEnvironment(
    "CIPHERDEX_RECOVERY_SOURCE_COMMIT",
    /^[0-9a-f]{40}$/iu,
  ).toLowerCase();
  const transactionHash = requiredEnvironment(
    "CIPHERDEX_RECOVERY_TRANSACTION_HASH",
    /^0x[0-9a-f]{64}$/iu,
  ).toLowerCase();
  const authenticatedCommit = requiredEnvironment(
    "CIPHERDEX_AUTHENTICATED_SOURCE_COMMIT",
    /^[0-9a-f]{40}$/iu,
  ).toLowerCase();
  const owner = new Wallet(privateKey).address;
  const journal = openFundedRecoveryJournal(privateKey, {
    runner: "deployment",
    sourceCommit,
    chainId: CHAIN_ID,
    owner,
    directory: requiredFundedRecoveryDirectory(),
    deployment: {
      recordPath: `deployments/coti-testnet-${sourceCommit}.json`,
      recordSha256: "0".repeat(64),
      manifestCommit: sourceCommit,
      sourceCommit,
    },
  });
  const expected = journal.transactions.find((transaction) =>
    transaction.hash.toLowerCase() === transactionHash
  );
  const signerTransaction = readSignerTransactionState(CHAIN_ID, owner).transactions.find(
    (transaction) => transaction.hash.toLowerCase() === transactionHash,
  );
  if (!signerTransaction) {
    throw new Error("deployment recovery signer state does not contain the requested hash");
  }
  if (!expected) {
    if (signerTransaction.status !== "prepared" || signerTransaction.blockNumber !== undefined) {
      throw new Error("missing recovery payload is not an unbroadcast prepared transaction");
    }
    assertHistoricalPrebroadcastOrder(sourceCommit, authenticatedCommit);
    const inspection = await inspectFundedTransaction(ethers.provider, {
      chainId: CHAIN_ID,
      signer: owner,
      nonce: signerTransaction.nonce,
      hash: transactionHash,
    });
    const [latestNonce, pendingNonce] = await Promise.all([
      ethers.provider.getTransactionCount(owner, "latest"),
      ethers.provider.getTransactionCount(owner, "pending"),
    ]);
    if (
      inspection.state !== "absent" ||
      latestNonce !== signerTransaction.nonce ||
      pendingNonce !== signerTransaction.nonce
    ) {
      throw new Error("chain state does not prove the prepared transaction remained unbroadcast");
    }
    recordPreparedSignerTransactionAbandoned(CHAIN_ID, owner, transactionHash);
    console.log(`Released unbroadcast deployment transaction ${transactionHash}.`);
    return;
  }

  let unresolved = await journal.reconcileTransactions(ethers.provider);
  if (unresolved.includes(transactionHash)) {
    await journal.rebroadcastIdenticalTransaction(transactionHash, ethers.provider);
  }

  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    unresolved = await journal.reconcileTransactions(ethers.provider);
    if (!unresolved.includes(transactionHash)) break;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MILLIS));
  }
  if (unresolved.includes(transactionHash)) {
    throw new Error(
      `deployment recovery remains unresolved; transactionHash=${transactionHash}`,
    );
  }
  const recovered = journal.transactions.find((transaction) =>
    transaction.hash.toLowerCase() === transactionHash
  );
  if (
    !recovered ||
    (recovered.status !== "mined-success" && recovered.status !== "mined-failure") ||
    recovered.blockNumber === undefined
  ) throw new Error("deployment recovery did not reach a canonical terminal state");

  recordSignerTransactionStatus(
    CHAIN_ID,
    owner,
    transactionHash,
    recovered.status,
    recovered.blockNumber,
  );
  console.log(
    `Recovered identical deployment transaction ${transactionHash} ` +
      `as ${recovered.status} at block ${recovered.blockNumber}.`,
  );
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown recovery failure";
  console.error(`Funded deployment recovery failed: ${message}`);
  process.exitCode = 1;
});
