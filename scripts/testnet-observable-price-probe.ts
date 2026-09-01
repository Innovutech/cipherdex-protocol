import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { Contract, type TransactionReceipt } from "ethers";
import { ethers } from "../hardhat/runtime.js";
import {
  verifyDeployedRuntimeArtifactWithProvenance,
} from "./runtime-artifact";
import {
  MinedTransactionStatusError,
  requireMinedSuccess,
  safeTestnetErrorSummary,
  transactionHashFromError,
} from "./testnet-transaction-evidence";
import type { FundedRecoveryJournal } from "./funded-recovery-journal";
import {
  FundedCotiWallet,
  openFundedRecoveryJournal,
  withFundedTransactionEvidence,
} from "./funded-transaction-wallet";
import { requiredFundedRecoveryDirectory } from "./funded-runtime-state";
import {
  trustedGitArguments,
  trustedGitEnvironment,
  trustedGitExecutable,
} from "./trusted-git";
import {
  cpmmSwapExactInput,
  normalizedPriceX18,
  quantizePriceFloor,
  type Reserves,
} from "./observable-price-model";

const execFileAsync = promisify(execFile);
const SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}$/i;
const COTI_TESTNET_CHAIN_ID = 7_082_400n;
const GAS_LIMIT = 30_000_000n;
const RESERVE0 = 1_000_000n;
const RESERVE1 = 1_987_654n;
const SWAP_INPUT = 10_000n;
const FEE_BPS = 30n;
const PRICE_QUANTUM_X18 = 10n ** 16n;

let stage = "configuration";
let recoveryJournal: FundedRecoveryJournal | undefined;

type MinedEvidence = Readonly<{
  transactionHash: string;
  receipt: TransactionReceipt;
}>;

type GasObservation = Readonly<{
  label: string;
  transactionHash: string;
  gasUsed: string;
}>;

function requiredPrivateKey(name: string): string {
  const value = process.env[name]?.trim();
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${name} must be a 32-byte 0x-prefixed private key`);
  }
  return value;
}

function requiredAesKey(name: string): string {
  const value = process.env[name]?.trim();
  if (!value || !/^[0-9a-fA-F]{32}$/.test(value)) {
    throw new Error(`${name} must be a 16-byte hexadecimal AES key`);
  }
  return value;
}

async function assertCleanCommittedSource(): Promise<string> {
  const cwd = process.cwd();
  const git = trustedGitExecutable(process.env, cwd);
  const options = { cwd, env: trustedGitEnvironment(), encoding: "utf8" } as const;
  const [head, status] = await Promise.all([
    execFileAsync(git, trustedGitArguments(["rev-parse", "--verify", "HEAD"]), options),
    execFileAsync(
      git,
      trustedGitArguments(["status", "--porcelain=v1", "--untracked-files=all", "--", "."]),
      options,
    ),
  ]);
  const sourceCommit = head.stdout.trim().toLowerCase();
  if (!SOURCE_COMMIT_PATTERN.test(sourceCommit)) {
    throw new Error("observable-price probe requires a committed source revision");
  }
  if (status.stdout.trim().length > 0) {
    throw new Error("observable-price probe requires a clean committed worktree");
  }
  await execFileAsync(
    git,
    trustedGitArguments([
      "ls-files",
      "--error-unmatch",
      "--",
      "scripts/testnet-observable-price-probe.ts",
      "scripts/observable-price-model.ts",
      "contracts/mocks/MpcObservablePriceProbe.sol",
      "hardhat.config.ts",
      "package-lock.json",
    ]),
    options,
  );
  return sourceCommit;
}

async function submit(
  label: string,
  operation: () => Promise<{
    hash: string;
    wait(): Promise<TransactionReceipt | null>;
  }>,
): Promise<MinedEvidence> {
  stage = label;
  if (!recoveryJournal) throw new Error("observable-price recovery journal is unavailable");
  try {
    const evidence = await withFundedTransactionEvidence(
      label,
      recoveryJournal,
      () => requireMinedSuccess(
        label,
        operation,
        (hash) => ethers.provider.getTransactionReceipt(hash),
      ),
    );
    recoveryJournal.recordTransaction(
      evidence.transactionHash,
      "mined-success",
      evidence.receipt.blockNumber,
    );
    return evidence;
  } catch (error) {
    const hash = transactionHashFromError(error);
    if (hash) {
      if (!recoveryJournal.transactions.some((entry) =>
        entry.hash.toLowerCase() === hash.toLowerCase()
      )) throw new Error("probe transaction was not locally signed and journaled", { cause: error });
      recoveryJournal.recordTransaction(
        hash,
        error instanceof MinedTransactionStatusError ? "mined-failure" : "outcome-unknown",
      );
    }
    throw error;
  }
}

async function deployProbe(
  wallet: FundedCotiWallet,
  sourceCommit: string,
  id: string,
  mode: number,
  minimumOperations: number,
): Promise<Contract> {
  const factory = await ethers.getContractFactory("MpcObservablePriceProbe", wallet);
  let deployed: any;
  const evidence = await submit(`${id} deployment`, async () => {
    deployed = await factory.deploy(
      await wallet.getAddress(),
      RESERVE0,
      RESERVE1,
      6,
      6,
      FEE_BPS,
      PRICE_QUANTUM_X18,
      minimumOperations,
      0,
      mode,
      { gasLimit: GAS_LIMIT },
    );
    const transaction = deployed.deploymentTransaction();
    if (!transaction) throw new Error("probe deployment transaction unavailable");
    return transaction;
  });
  if (!deployed) throw new Error("probe deployment mined without a contract handle");
  const address = await deployed.getAddress();
  recoveryJournal!.recordResource({
    id,
    kind: "disposable-contract",
    address,
    creationTransactionHash: evidence.transactionHash,
    metadata: {
      contractName: "MpcObservablePriceProbe",
      mode,
      minimumOperations,
      sourceCommit,
    },
  });
  await verifyDeployedRuntimeArtifactWithProvenance(
    "MpcObservablePriceProbe",
    address,
    ethers.provider,
  );
  return new Contract(address, deployed.interface, wallet);
}

async function executeSwap(
  wallet: FundedCotiWallet,
  probe: Contract,
  label: string,
): Promise<GasObservation> {
  const address = String(probe.target);
  const selector = probe.interface.getFunction("executeSwapLike")!.selector;
  const encryptedInput = await wallet.encryptValue256(SWAP_INPUT, address, selector);
  const evidence = await submit(
    label,
    () => probe.executeSwapLike(encryptedInput, true, { gasLimit: GAS_LIMIT }),
  );
  return Object.freeze({
    label,
    transactionHash: evidence.transactionHash,
    gasUsed: evidence.receipt.gasUsed.toString(),
  });
}

async function closeProbe(
  probe: Contract,
  id: string,
  recipient: string,
): Promise<void> {
  const evidence = await submit(
    `${id} close`,
    () => probe.closeAndRecover(recipient, { gasLimit: 500_000n }),
  );
  recoveryJournal!.markRecovered(id, [evidence.transactionHash]);
}

async function recoverInterruptedProbes(
  wallet: FundedCotiWallet,
): Promise<boolean> {
  if (!recoveryJournal || recoveryJournal.resources.length === 0) return false;
  const factory = await ethers.getContractFactory("MpcObservablePriceProbe", wallet);
  const recipient = await wallet.getAddress();
  for (const resource of recoveryJournal.resources) {
    if (resource.recovered) continue;
    const probe = new Contract(resource.address, factory.interface, wallet);
    if (await probe.closed()) {
      const close = [...recoveryJournal.transactions].reverse().find((transaction) =>
        transaction.label === `${resource.id} close` && transaction.status === "mined-success"
      );
      if (!close) throw new Error(`closed ${resource.id} lacks recovery transaction evidence`);
      recoveryJournal.markRecovered(resource.id, [close.hash]);
    } else {
      await closeProbe(probe, resource.id, recipient);
    }
  }
  recoveryJournal.markRun("failed");
  console.log("Recovered an interrupted observable-price probe; use a new source commit to rerun.");
  return true;
}

async function main(): Promise<void> {
  stage = "source provenance";
  const sourceCommit = await assertCleanCommittedSource();
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== COTI_TESTNET_CHAIN_ID) {
    throw new Error(`observable-price probe requires COTI testnet ${COTI_TESTNET_CHAIN_ID}`);
  }

  const privateKey = requiredPrivateKey("COTI_TESTNET_PRIVATE_KEY");
  const aesKey = requiredAesKey("COTI_AES_KEY");
  const wallet = new FundedCotiWallet(privateKey, ethers.provider, { aesKey });
  wallet.setAesKey(aesKey);
  const owner = await wallet.getAddress();
  recoveryJournal = openFundedRecoveryJournal(privateKey, {
    runner: "observable-price-probe",
    sourceCommit,
    chainId: Number(network.chainId),
    owner,
    directory: requiredFundedRecoveryDirectory(),
    deployment: {
      recordPath: `deployments/coti-testnet-${sourceCommit}.json`,
      recordSha256: "0".repeat(64),
      manifestCommit: sourceCommit,
      sourceCommit,
    },
  });
  const unresolved = await recoveryJournal.reconcileTransactions(ethers.provider);
  if (unresolved.length > 0) {
    throw new Error("observable-price probe has an unresolved transaction; do not retry");
  }
  if (recoveryJournal.runStatus === "passed") {
    console.log("Observable-price probe already passed for this source commit.");
    return;
  }
  if (await recoverInterruptedProbes(wallet)) return;
  if (recoveryJournal.transactions.length > 0) {
    throw new Error("observable-price journal has incomplete deployment evidence; do not retry");
  }

  const baseline = await deployProbe(wallet, sourceCommit, "baseline", 0, 1);
  const immediate = await deployProbe(wallet, sourceCommit, "immediate", 1, 3);
  const delayed = await deployProbe(wallet, sourceCommit, "delayed", 2, 1);

  const gas: GasObservation[] = [];
  gas.push(await executeSwap(wallet, baseline, "baseline confidential transition"));
  gas.push(await executeSwap(wallet, immediate, "lazy immediate non-closing transition 1"));
  gas.push(await executeSwap(wallet, immediate, "lazy immediate non-closing transition 2"));
  gas.push(await executeSwap(wallet, immediate, "lazy immediate closing transition"));
  gas.push(await executeSwap(wallet, delayed, "delayed first closing transition"));
  if (await delayed.publicObservationAt() !== 0n) {
    throw new Error("delayed probe published its first observation without a full epoch delay");
  }
  gas.push(await executeSwap(wallet, delayed, "delayed publishing transition"));

  let immediateReserves: Reserves = { reserve0: RESERVE0, reserve1: RESERVE1 };
  for (let index = 0; index < 3; index += 1) {
    immediateReserves = cpmmSwapExactInput(immediateReserves, SWAP_INPUT, FEE_BPS, true);
  }
  const expectedImmediateBucket = quantizePriceFloor(
    normalizedPriceX18(immediateReserves, 6, 6),
    PRICE_QUANTUM_X18,
  );
  if (await immediate.publicPriceBucketX18() !== expectedImmediateBucket) {
    throw new Error("immediate public bucket does not match the reference CPMM model");
  }

  const firstDelayedReserves = cpmmSwapExactInput(
    { reserve0: RESERVE0, reserve1: RESERVE1 },
    SWAP_INPUT,
    FEE_BPS,
    true,
  );
  const expectedDelayedBucket = quantizePriceFloor(
    normalizedPriceX18(firstDelayedReserves, 6, 6),
    PRICE_QUANTUM_X18,
  );
  if (await delayed.publicPriceBucketX18() !== expectedDelayedBucket) {
    throw new Error("delayed public bucket does not match the prior reference state");
  }

  await closeProbe(baseline, "baseline", owner);
  await closeProbe(immediate, "immediate", owner);
  await closeProbe(delayed, "delayed", owner);
  recoveryJournal.markRun("passed");

  const byLabel = Object.fromEntries(gas.map((entry) => [entry.label, BigInt(entry.gasUsed)]));
  const baselineGas = byLabel["baseline confidential transition"]!;
  console.log(`observablePriceProbeResult=${JSON.stringify({
    sourceCommit,
    chainId: network.chainId.toString(),
    configuration: {
      minimumOperations: 3,
      priceQuantumX18: PRICE_QUANTUM_X18.toString(),
      delayedMinimumOperations: 1,
    },
    gas,
    deltas: {
      nonClosingVsBaseline: (
        byLabel["lazy immediate non-closing transition 1"]! - baselineGas
      ).toString(),
      immediateClosingVsBaseline: (
        byLabel["lazy immediate closing transition"]! - baselineGas
      ).toString(),
      delayedFirstCloseVsBaseline: (
        byLabel["delayed first closing transition"]! - baselineGas
      ).toString(),
      delayedPublishingVsBaseline: (
        byLabel["delayed publishing transition"]! - baselineGas
      ).toString(),
    },
    validatedBuckets: {
      immediate: expectedImmediateBucket.toString(),
      delayed: expectedDelayedBucket.toString(),
    },
  })}`);
}

void main().catch((error: unknown) => {
  recoveryJournal?.markRun("failed");
  console.error(`COTI observable-price probe failed during ${stage}: ${safeTestnetErrorSummary(error)}`);
  process.exitCode = 1;
});
