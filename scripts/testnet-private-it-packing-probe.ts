import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

import { Contract, type BaseContract, type TransactionReceipt } from "ethers";
import * as ethersLibrary from "ethers";
import { artifacts, ethers } from "../hardhat/runtime.js";

import { FIELD_MASK, packUint128Pair } from "./phase2d-it-packing";
import { decryptPrivateValue256 } from "./coti-testnet-values";
import type { FundedRecoveryJournal } from "./funded-recovery-journal";
import {
  FundedCotiWallet,
  openFundedRecoveryJournal,
  withFundedTransactionEvidence,
} from "./funded-transaction-wallet";
import { requiredFundedRecoveryDirectory } from "./funded-runtime-state";
import { verifyDeployedRuntimeArtifactWithProvenance } from "./runtime-artifact";
import {
  MinedTransactionStatusError,
  requireMinedFailure,
  requireMinedSuccess,
  safeTestnetErrorSummary,
  transactionHashFromError,
  UnknownBroadcastOutcomeError,
} from "./testnet-transaction-evidence";
import {
  trustedGitArguments,
  trustedGitEnvironment,
  trustedGitExecutable,
} from "./trusted-git";

const execFileAsync = promisify(execFile);
const EXPECTED_CHAIN_ID = 7_082_400n;
const GAS_LIMIT = 30_000_000n;
const SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}$/u;

type EncryptedInput = Readonly<{
  ciphertext: Readonly<{ ciphertextHigh: bigint; ciphertextLow: bigint }>;
  signature: string | Uint8Array;
}>;
type Submitted = Readonly<{
  hash: string;
  receipt: TransactionReceipt;
  gasUsed: bigint;
}>;
type SanitizedTransaction = Readonly<{
  label: string;
  transactionHash: string;
  blockNumber: number;
  receiptStatus: number;
  gasUsed: string;
}>;
type ProbeResult = Readonly<{
  high: bigint;
  low: bigint;
  result: bigint;
  operation: number;
  privacyMode: number;
  transaction: Submitted;
}>;

let stage = "configuration";
let recoveryJournal: FundedRecoveryJournal | undefined;
const submittedTransactions: SanitizedTransaction[] = [];

function journal(): FundedRecoveryJournal {
  if (!recoveryJournal) throw new Error("private IT packing journal is unavailable");
  return recoveryJournal;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredPrivateKey(name: string): string {
  const value = required(name);
  if (!/^0x[0-9a-f]{64}$/iu.test(value)) throw new Error(`${name} must be a private key`);
  return value;
}

function requiredAesKey(name: string): string {
  const value = required(name);
  if (!/^[0-9a-f]{32}$/iu.test(value)) throw new Error(`${name} must be an AES key`);
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
  const commit = head.stdout.trim().toLowerCase();
  if (!SOURCE_COMMIT_PATTERN.test(commit) || status.stdout.trim()) {
    throw new Error("private IT packing proof requires a clean committed source");
  }
  return commit;
}

function record(label: string, receipt: TransactionReceipt): Submitted {
  const value = Object.freeze({
    label,
    transactionHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    receiptStatus: Number(receipt.status),
    gasUsed: receipt.gasUsed.toString(),
  });
  submittedTransactions.push(value);
  console.log(`${label}: tx=${receipt.hash} status=${String(receipt.status)} gas=${receipt.gasUsed}`);
  return Object.freeze({ hash: receipt.hash, receipt, gasUsed: receipt.gasUsed });
}

async function submit(
  label: string,
  operation: () => Promise<{ hash: string; wait(): Promise<TransactionReceipt | null> }>,
): Promise<Submitted> {
  stage = label;
  try {
    const evidence = await withFundedTransactionEvidence(
      label,
      journal(),
      () => requireMinedSuccess(
        label,
        operation,
        (hash) => ethers.provider.getTransactionReceipt(hash),
      ),
    );
    journal().recordTransaction(evidence.transactionHash, "mined-success", evidence.receipt.blockNumber);
    return record(label, evidence.receipt);
  } catch (error) {
    const hash = transactionHashFromError(error);
    if (hash) {
      journal().recordTransaction(
        hash,
        error instanceof MinedTransactionStatusError ? "mined-failure" : "outcome-unknown",
      );
    }
    throw error;
  }
}

async function expectFailure(
  label: string,
  operation: () => Promise<{ hash: string; wait(): Promise<TransactionReceipt | null> }>,
): Promise<Submitted> {
  stage = label;
  const evidence = await withFundedTransactionEvidence(
    label,
    journal(),
    () => requireMinedFailure(
      label,
      operation,
      (hash) => ethers.provider.getTransactionReceipt(hash),
    ),
  );
  journal().recordTransaction(evidence.transactionHash, "mined-failure", evidence.receipt.blockNumber);
  return record(label, evidence.receipt);
}

async function deploy(wallet: FundedCotiWallet, label: string): Promise<{
  contract: BaseContract;
  address: string;
  transaction: Submitted;
}> {
  const factory = await ethers.getContractFactory("PrivateITPackingProbe", wallet);
  let contract: BaseContract | undefined;
  const transaction = await submit(label, async () => {
    contract = await factory.deploy({ gasLimit: GAS_LIMIT });
    const deployment = contract.deploymentTransaction();
    if (!deployment) throw new Error("packing probe deployment transaction unavailable");
    return deployment;
  });
  if (!contract) throw new Error("packing probe deployment handle unavailable");
  const address = ethersLibrary.getAddress(await contract.getAddress());
  await verifyDeployedRuntimeArtifactWithProvenance(
    "PrivateITPackingProbe",
    address,
    ethers.provider,
  );
  return Object.freeze({ contract, address, transaction });
}

async function encryptFor(
  wallet: FundedCotiWallet,
  value: bigint,
  contract: Contract,
  functionName: string,
): Promise<EncryptedInput> {
  const selector = contract.interface.getFunction(functionName)?.selector;
  if (!selector) throw new Error(`${functionName} selector unavailable`);
  return wallet.encryptValue256(value, await contract.getAddress(), selector);
}

function tamperSignature(input: EncryptedInput): EncryptedInput {
  const bytes = ethersLibrary.getBytes(input.signature);
  bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
  return Object.freeze({
    ciphertext: input.ciphertext,
    signature: ethersLibrary.hexlify(bytes),
  });
}

async function resultFrom(
  probe: Contract,
  wallet: FundedCotiWallet,
  transaction: Submitted,
): Promise<ProbeResult> {
  const events = transaction.receipt.logs.flatMap((log) => {
    if (log.address.toLowerCase() !== String(probe.target).toLowerCase()) return [];
    try {
      const parsed = probe.interface.parseLog(log);
      return parsed?.name === "PrivatePackingResult" ? [parsed] : [];
    } catch {
      return [];
    }
  });
  if (events.length !== 1) throw new Error("packing result event is missing or ambiguous");
  const event = events[0]!;
  const [high, low, result] = await Promise.all([
    decryptPrivateValue256(wallet, event.args.highField),
    decryptPrivateValue256(wallet, event.args.lowField),
    decryptPrivateValue256(wallet, event.args.result),
  ]);
  return Object.freeze({
    high,
    low,
    result,
    operation: Number(event.args.operation),
    privacyMode: Number(event.args.privacyMode),
    transaction,
  });
}

async function recoverProbes(): Promise<void> {
  if (!recoveryJournal) return;
  for (const resource of recoveryJournal.activeResources) {
    if (resource.kind !== "private-it-packing-probe") {
      throw new Error(`unsupported packing recovery resource ${resource.kind}`);
    }
    if (await ethers.provider.getBalance(resource.address) !== 0n) {
      throw new Error("packing probe unexpectedly holds native custody");
    }
    recoveryJournal.markRecovered(resource.id, [resource.creationTransactionHash]);
  }
}

function buildEvidence(input: Readonly<{
  sourceCommit: string;
  chainId: number;
  primaryProbe: string;
  secondaryProbe: string;
  gas: Readonly<Record<string, string>>;
}>): Readonly<Record<string, unknown>> {
  if (
    journal().runStatus !== "passed" ||
    journal().activeResources.length !== 0 ||
    journal().activeAllowanceObligations.length !== 0
  ) throw new Error("Phase 2D evidence requires terminal cleanup");
  const recorded = journal().transactions;
  if (
    recorded.length !== submittedTransactions.length ||
    submittedTransactions.some((transaction, index) => {
      const journaled = recorded[index];
      const expectedStatus = transaction.receiptStatus === 1 ? "mined-success" : "mined-failure";
      return !journaled ||
        journaled.hash.toLowerCase() !== transaction.transactionHash.toLowerCase() ||
        journaled.status !== expectedStatus ||
        journaled.blockNumber !== transaction.blockNumber;
    })
  ) throw new Error("Phase 2D evidence diverges from the recovery journal");
  const journalProjection = {
    runner: journal().identity.runner,
    sourceCommit: journal().identity.sourceCommit,
    chainId: journal().identity.chainId,
    deployment: journal().identity.deployment,
    transactions: recorded.map(({ label, hash, status, blockNumber }) => ({
      label, hash, status, blockNumber,
    })),
    resources: journal().resources.map((resource) => ({
      id: resource.id,
      kind: resource.kind,
      address: resource.address,
      creationTransactionHash: resource.creationTransactionHash,
      recovered: resource.recovered,
      recoveryTransactionHashes: resource.recoveryTransactionHashes,
    })),
    runStatus: journal().runStatus,
  };
  const evidence = Object.freeze({
    schema: "cipherdex.phase2d-private-it-packing-evidence/v1",
    runner: "phase2d-private-it-packing",
    sourceCommit: input.sourceCommit,
    chainId: input.chainId,
    runnerSourceSha256: createHash("sha256")
      .update(readFileSync(new URL(import.meta.url)))
      .digest("hex"),
    journalBinding: ethersLibrary.keccak256(
      ethersLibrary.toUtf8Bytes(JSON.stringify(journalProjection)),
    ),
    contracts: Object.freeze({
      primaryProbe: input.primaryProbe,
      secondaryProbe: input.secondaryProbe,
    }),
    transactions: Object.freeze([...submittedTransactions]),
    assertions: Object.freeze({
      separateAndPackedDecodeEqual: true,
      separateAndPackedSwapEqual: true,
      separateAndPackedLiquidityEqual: true,
      mixedAndMaximumFieldsDecoded: true,
      modeDisclosureShapeEqual: true,
      wrongSelectorRejected: true,
      wrongCallerRejected: true,
      wrongTargetRejected: true,
      tamperedSignatureRejected: true,
      exactReplayRejected: true,
      underflowPropagatedAndRolledBack: true,
      overflowPropagated: true,
      encryptedResultsEqual: true,
      zeroNativeCustody: true,
      zeroResidualAllowances: true,
      recoveryResourcesClosed: true,
    }),
    gas: Object.freeze({ ...input.gas }),
    generatedAt: new Date().toISOString(),
  });
  const serialized = JSON.stringify(evidence);
  if (
    /"(?:privateKey|aesKey|signature|ciphertext|encryptedInput|decryptedAmount|privateAmount|privateBalance|signedTransaction)"\s*:/iu
      .test(serialized)
  ) throw new Error("Phase 2D evidence contains a forbidden private field");
  return evidence;
}

async function main(): Promise<void> {
  const sourceCommit = await assertCleanCommittedSource();
  const primaryKey = requiredPrivateKey("COTI_TESTNET_PRIVATE_KEY");
  const primaryAes = requiredAesKey("COTI_AES_KEY");
  const secondKey = requiredPrivateKey("COTI_SECOND_LP_PRIVATE_KEY");
  const secondAes = requiredAesKey("COTI_SECOND_LP_AES_KEY");
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== EXPECTED_CHAIN_ID) throw new Error("wrong COTI testnet chain");

  const primary = new FundedCotiWallet(primaryKey, ethers.provider, { aesKey: primaryAes });
  primary.setAesKey(primaryAes);
  const second = new FundedCotiWallet(secondKey, ethers.provider, { aesKey: secondAes });
  second.setAesKey(secondAes);
  const primaryAddress = ethersLibrary.getAddress(await primary.getAddress());
  const secondAddress = ethersLibrary.getAddress(await second.getAddress());
  if (primaryAddress === secondAddress) throw new Error("packing identities must differ");

  recoveryJournal = openFundedRecoveryJournal(primaryKey, {
    runner: "private-it-packing-probe",
    sourceCommit,
    chainId: Number(network.chainId),
    owner: primaryAddress,
    directory: requiredFundedRecoveryDirectory(),
    deployment: {
      recordPath: `deployments/coti-testnet-${sourceCommit}.json`,
      recordSha256: "0".repeat(64),
      manifestCommit: sourceCommit,
      sourceCommit,
    },
  });
  const unresolved = await journal().reconcileTransactions(ethers.provider);
  if (unresolved.length > 0) throw new Error("packing proof has unresolved transactions");
  await recoverProbes();
  if (journal().runStatus === "passed") {
    console.log("Private IT packing funded proof already passed for this source.");
    return;
  }
  if (journal().transactions.length > 0 || journal().resources.length > 0) {
    throw new Error("prior packing evidence requires operator review");
  }

  const primaryDeployment = await deploy(primary, "primary packing probe deployment");
  const secondaryDeployment = await deploy(primary, "secondary packing probe deployment");
  const primaryProbe = new Contract(
    primaryDeployment.address,
    (await artifacts.readArtifact("PrivateITPackingProbe")).abi,
    primary,
  );
  const secondaryProbe = new Contract(
    secondaryDeployment.address,
    primaryProbe.interface,
    primary,
  );
  journal().recordResource({
    id: "primary-packing-probe",
    kind: "private-it-packing-probe",
    address: primaryDeployment.address,
    creationTransactionHash: primaryDeployment.transaction.hash,
    metadata: {},
  });
  journal().recordResource({
    id: "secondary-packing-probe",
    kind: "private-it-packing-probe",
    address: secondaryDeployment.address,
    creationTransactionHash: secondaryDeployment.transaction.hash,
    metadata: {},
  });

  const gas: Record<string, string> = {
    primaryDeployment: primaryDeployment.transaction.gasUsed.toString(),
    secondaryDeployment: secondaryDeployment.transaction.gasUsed.toString(),
  };
  const latest = await ethers.provider.getBlock("latest");
  if (!latest) throw new Error("latest block unavailable");
  const deadline = BigInt(latest.timestamp + 3_600);

  const decodeHigh = FIELD_MASK;
  const decodeLow = 1n;
  const decodeSeparateInputs = await Promise.all([
    encryptFor(primary, decodeHigh, primaryProbe, "decodeSeparate"),
    encryptFor(primary, decodeLow, primaryProbe, "decodeSeparate"),
  ]);
  const decodeSeparateTx = await submit("validate two separate IT fields", () =>
    primaryProbe.decodeSeparate(
      decodeSeparateInputs[0], decodeSeparateInputs[1], ethersLibrary.id("decode-separate"),
      { gasLimit: GAS_LIMIT },
    ));
  const decodeSeparate = await resultFrom(primaryProbe, primary, decodeSeparateTx);
  gas.decodeSeparate = decodeSeparateTx.gasUsed.toString();
  const decodePackedInput = await encryptFor(
    primary,
    packUint128Pair(decodeHigh, decodeLow),
    primaryProbe,
    "decodePacked",
  );
  const decodePackedTx = await submit("validate and unpack one packed IT", () =>
    primaryProbe.decodePacked(
      decodePackedInput, ethersLibrary.id("decode-packed"), { gasLimit: GAS_LIMIT },
    ));
  const decodePacked = await resultFrom(primaryProbe, primary, decodePackedTx);
  gas.decodePacked = decodePackedTx.gasUsed.toString();
  if (
    decodeSeparate.high !== decodePacked.high ||
    decodeSeparate.low !== decodePacked.low ||
    decodeSeparate.result !== decodePacked.result
  ) throw new Error("separate and packed decode diverged");

  const swapAmount = 17n;
  const swapMinimum = 20n;
  const swapSeparateInputs = await Promise.all([
    encryptFor(primary, swapAmount, primaryProbe, "swapSeparate"),
    encryptFor(primary, swapMinimum, primaryProbe, "swapSeparate"),
  ]);
  const swapSeparateTx = await submit("complete separate-IT swap-like call", () =>
    primaryProbe.swapSeparate(
      swapSeparateInputs[0], swapSeparateInputs[1], 1,
      ethersLibrary.id("swap-separate"), deadline, { gasLimit: GAS_LIMIT },
    ));
  const swapSeparate = await resultFrom(primaryProbe, primary, swapSeparateTx);
  gas.swapSeparate = swapSeparateTx.gasUsed.toString();
  const swapPackedInput = await encryptFor(
    primary,
    packUint128Pair(swapAmount, swapMinimum),
    primaryProbe,
    "swapPacked",
  );
  const swapPackedTx = await submit("complete packed-IT swap-like call", () =>
    primaryProbe.swapPacked(
      swapPackedInput, 1, ethersLibrary.id("swap-packed"), deadline,
      { gasLimit: GAS_LIMIT },
    ));
  const swapPacked = await resultFrom(primaryProbe, primary, swapPackedTx);
  gas.swapPacked = swapPackedTx.gasUsed.toString();
  if (
    swapSeparate.high !== swapPacked.high ||
    swapSeparate.low !== swapPacked.low ||
    swapSeparate.result !== swapPacked.result
  ) throw new Error("separate and packed swap diverged");
  const mode2Input = await encryptFor(
    primary,
    packUint128Pair(swapAmount, swapMinimum),
    primaryProbe,
    "swapPacked",
  );
  const mode2Tx = await submit("complete Mode 2 packed swap-like call", () =>
    primaryProbe.swapPacked(
      mode2Input, 2, ethersLibrary.id("swap-packed-mode2"), deadline,
      { gasLimit: GAS_LIMIT },
    ));
  const mode2 = await resultFrom(primaryProbe, primary, mode2Tx);
  gas.swapPackedMode2 = mode2Tx.gasUsed.toString();
  if (mode2.result !== swapPacked.result || mode2.privacyMode !== 2) {
    throw new Error("Mode 1/2 packed result shape diverged");
  }

  const liquiditySeparateInputs = await Promise.all([
    encryptFor(primary, FIELD_MASK, primaryProbe, "liquiditySeparate"),
    encryptFor(primary, 1n, primaryProbe, "liquiditySeparate"),
  ]);
  const liquiditySeparateTx = await submit("complete separate-IT liquidity-like call", () =>
    primaryProbe.liquiditySeparate(
      liquiditySeparateInputs[0], liquiditySeparateInputs[1], 1,
      ethersLibrary.id("liquidity-separate"), { gasLimit: GAS_LIMIT },
    ));
  const liquiditySeparate = await resultFrom(primaryProbe, primary, liquiditySeparateTx);
  gas.liquiditySeparate = liquiditySeparateTx.gasUsed.toString();
  const liquidityPackedInput = await encryptFor(
    primary,
    packUint128Pair(FIELD_MASK, 1n),
    primaryProbe,
    "liquidityPacked",
  );
  const liquidityPackedTx = await submit("complete packed-IT liquidity-like call", () =>
    primaryProbe.liquidityPacked(
      liquidityPackedInput, 1, ethersLibrary.id("liquidity-packed"),
      { gasLimit: GAS_LIMIT },
    ));
  const liquidityPacked = await resultFrom(primaryProbe, primary, liquidityPackedTx);
  gas.liquidityPacked = liquidityPackedTx.gasUsed.toString();
  if (
    liquiditySeparate.high !== liquidityPacked.high ||
    liquiditySeparate.low !== liquidityPacked.low ||
    liquiditySeparate.result !== liquidityPacked.result
  ) throw new Error("separate and packed liquidity diverged");
  const maximumInput = await encryptFor(
    primary,
    packUint128Pair(FIELD_MASK, FIELD_MASK),
    primaryProbe,
    "liquidityPacked",
  );
  const maximumTx = await submit("decode maximum packed boundary fields", () =>
    primaryProbe.liquidityPacked(
      maximumInput, 2, ethersLibrary.id("liquidity-packed-maximum"),
      { gasLimit: GAS_LIMIT },
    ));
  const maximum = await resultFrom(primaryProbe, primary, maximumTx);
  gas.maximumPacked = maximumTx.gasUsed.toString();
  if (maximum.high !== FIELD_MASK || maximum.low !== FIELD_MASK) {
    throw new Error("maximum packed fields diverged");
  }

  const wrongSelectorInput = await encryptFor(
    primary, packUint128Pair(2n, 1n), primaryProbe, "swapPacked",
  );
  gas.wrongSelector = (
    await expectFailure("reject selector-bound packed IT reuse", () =>
      primaryProbe.liquidityPacked(
        wrongSelectorInput, 1, ethersLibrary.id("wrong-selector"),
        { gasLimit: GAS_LIMIT },
      ))
  ).gasUsed.toString();
  const wrongCallerInput = await encryptFor(
    primary, packUint128Pair(2n, 1n), primaryProbe, "swapPacked",
  );
  gas.wrongCaller = (
    await expectFailure("reject caller-bound packed IT reuse", () =>
      (primaryProbe.connect(second) as Contract).swapPacked(
        wrongCallerInput, 1, ethersLibrary.id("wrong-caller"), deadline,
        { gasLimit: GAS_LIMIT },
      ))
  ).gasUsed.toString();
  const wrongTargetInput = await encryptFor(
    primary, packUint128Pair(2n, 1n), primaryProbe, "swapPacked",
  );
  gas.wrongTarget = (
    await expectFailure("reject target-bound packed IT reuse", () =>
      secondaryProbe.swapPacked(
        wrongTargetInput, 1, ethersLibrary.id("wrong-target"), deadline,
        { gasLimit: GAS_LIMIT },
      ))
  ).gasUsed.toString();
  const tamperInput = await encryptFor(
    primary, packUint128Pair(2n, 1n), primaryProbe, "swapPacked",
  );
  gas.tamperedSignature = (
    await expectFailure("reject tampered packed IT signature", () =>
      primaryProbe.swapPacked(
        tamperSignature(tamperInput), 1, ethersLibrary.id("tampered-signature"), deadline,
        { gasLimit: GAS_LIMIT },
      ))
  ).gasUsed.toString();
  gas.exactReplay = (
    await expectFailure("reject exact packed IT replay", () =>
      primaryProbe.swapPacked(
        swapPackedInput, 1, ethersLibrary.id("swap-packed"), deadline,
        { gasLimit: GAS_LIMIT },
      ))
  ).gasUsed.toString();

  const rollbackRequest = ethersLibrary.id("arithmetic-rollback");
  const underflowInput = await encryptFor(
    primary, packUint128Pair(1n, 2n), primaryProbe, "arithmeticPacked",
  );
  gas.underflow = (
    await expectFailure("propagate packed-field underflow", () =>
      primaryProbe.arithmeticPacked(
        underflowInput, 1n, true, rollbackRequest, { gasLimit: GAS_LIMIT },
      ))
  ).gasUsed.toString();
  const rollbackInput = await encryptFor(
    primary, packUint128Pair(2n, 1n), primaryProbe, "arithmeticPacked",
  );
  const rollbackTx = await submit("reuse request after atomic underflow rollback", () =>
    primaryProbe.arithmeticPacked(
      rollbackInput, 1n, true, rollbackRequest, { gasLimit: GAS_LIMIT },
    ));
  const rollback = await resultFrom(primaryProbe, primary, rollbackTx);
  gas.rollbackSuccess = rollbackTx.gasUsed.toString();
  if (rollback.result !== 1n) throw new Error("underflow rollback did not restore request state");
  const overflowInput = await encryptFor(
    primary, packUint128Pair(FIELD_MASK, 0n), primaryProbe, "arithmeticPacked",
  );
  gas.overflow = (
    await expectFailure("propagate packed-field overflow", () =>
      primaryProbe.arithmeticPacked(
        overflowInput, ethersLibrary.MaxUint256, false,
        ethersLibrary.id("arithmetic-overflow"), { gasLimit: GAS_LIMIT },
      ))
  ).gasUsed.toString();

  if (await primaryProbe.successfulCalls() !== 9n) {
    throw new Error("packing probe successful-call count diverged");
  }
  if (
    await ethers.provider.getBalance(primaryDeployment.address) !== 0n ||
    await ethers.provider.getBalance(secondaryDeployment.address) !== 0n
  ) throw new Error("packing probes retained native custody");
  await recoverProbes();
  journal().markRun("passed");
  gas.decodeGasSaved = (BigInt(gas.decodeSeparate!) - BigInt(gas.decodePacked!)).toString();
  gas.swapGasSaved = (BigInt(gas.swapSeparate!) - BigInt(gas.swapPacked!)).toString();
  gas.liquidityGasSaved =
    (BigInt(gas.liquiditySeparate!) - BigInt(gas.liquidityPacked!)).toString();
  const evidence = buildEvidence({
    sourceCommit,
    chainId: Number(network.chainId),
    primaryProbe: primaryDeployment.address,
    secondaryProbe: secondaryDeployment.address,
    gas,
  });
  console.log(`phase2dFundedEvidence=${JSON.stringify(evidence)}`);
}

void main().catch(async (error: unknown) => {
  const failedStage = stage;
  if (error instanceof UnknownBroadcastOutcomeError) {
    recoveryJournal?.markRun("failed");
    console.error(
      `Private IT packing proof paused with uncertain broadcast: stage=${stage} ` +
      `${safeTestnetErrorSummary(error)}; do not retry until reconciled.`,
    );
    process.exitCode = 1;
    return;
  }
  let reported = error;
  try {
    await recoverProbes();
    recoveryJournal?.markRun("failed");
  } catch (recoveryError) {
    reported = new AggregateError([error, recoveryError], "packing proof and recovery failed");
  }
  console.error(
    `Private IT packing proof failed: stage=${failedStage} ${safeTestnetErrorSummary(reported)}`,
  );
  process.exitCode = 1;
});
