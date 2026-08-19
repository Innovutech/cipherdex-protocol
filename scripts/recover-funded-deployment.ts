import { Wallet } from "ethers";
import { ethers } from "../hardhat/runtime.js";

import {
  openFundedRecoveryJournal,
} from "./funded-transaction-wallet";
import {
  recordSignerTransactionStatus,
} from "./funded-process-coordinator.mjs";
import { requiredFundedRecoveryDirectory } from "./funded-runtime-state";

const CHAIN_ID = 7_082_400;
const POLL_INTERVAL_MILLIS = 2_000;
const POLL_ATTEMPTS = 150;

function requiredEnvironment(name: string, pattern: RegExp): string {
  const value = process.env[name]?.trim();
  if (!value || !pattern.test(value)) throw new Error(`${name} is invalid`);
  return value;
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
  if (!expected) throw new Error("deployment recovery journal does not contain the requested hash");

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
