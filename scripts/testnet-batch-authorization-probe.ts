import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { encryptUint256 } from "@coti-io/coti-sdk-typescript";
import { Contract, type TransactionReceipt } from "ethers";
import { ethers } from "../hardhat/runtime.js";
import {
  CIPHERDEX_INPUT_BATCH_DOMAIN_NAME,
  CIPHERDEX_INPUT_BATCH_DOMAIN_VERSION,
  buildCipherDexInputBatchTypedData,
  cipherDexInputSchemaHash,
  signCipherDexInputBatch,
  type CipherDexBatchCiphertext,
  type CipherDexInputBatchAuthorization,
} from "../sdk/src/inputBatch";
import { createFundedDeploymentBinding } from "./funded-deployment-binding";
import type { FundedRecoveryJournal } from "./funded-recovery-journal";
import {
  preflightFundedRunConfiguration,
  writePreparedFundedRunEvidence,
} from "./funded-run-evidence";
import { requiredFundedRecoveryDirectory } from "./funded-runtime-state";
import {
  FundedCotiWallet,
  openFundedRecoveryJournal,
  withFundedTransactionEvidence,
} from "./funded-transaction-wallet";
import {
  verifyDeployedRuntimeArtifactWithProvenance,
} from "./runtime-artifact";
import {
  requiredTestnetDeploymentRecordPath,
  verifyConfiguredTestnetDeployment,
} from "./testnet-deployment-provenance";
import {
  MinedTransactionStatusError,
  requireMinedFailure,
  requireMinedSuccess,
  safeTestnetErrorSummary,
  transactionHashFromError,
} from "./testnet-transaction-evidence";
import {
  trustedGitArguments,
  trustedGitEnvironment,
  trustedGitExecutable,
} from "./trusted-git";

const execFileAsync = promisify(execFile);
const COMMIT = /^[0-9a-f]{40}$/i;
const CHAIN_ID = 7_082_400n;
const PROTOCOL_VERSION = 1n;
const TWO_SLOT_SCHEMA = "CipherDEX.probeTwo(first,second)";
const FIVE_SLOT_SCHEMA = "CipherDEX.probeFive(first,second,third,fourth,fifth)";
const TWO_SLOT_SCHEMA_HASH = cipherDexInputSchemaHash(TWO_SLOT_SCHEMA);
const FIVE_SLOT_SCHEMA_HASH = cipherDexInputSchemaHash(FIVE_SLOT_SCHEMA);
const GAS_LIMIT = 30_000_000n;
const TWO_VALUES = [11n, 29n] as const;
const FIVE_VALUES = [3n, 5n, 7n, 11n, 13n] as const;

let stage = "configuration";
let recoveryJournal: FundedRecoveryJournal | undefined;

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
  const commit = head.stdout.trim();
  if (!COMMIT.test(commit) || status.stdout.trim().length > 0) {
    throw new Error("batch probe requires a clean committed source revision");
  }
  await execFileAsync(
    git,
    trustedGitArguments([
      "ls-files",
      "--error-unmatch",
      "--",
      "contracts/CipherDEXInputBatch.sol",
      "contracts/mocks/MpcBatchAuthorizationProbe.sol",
      "scripts/testnet-batch-authorization-probe.ts",
      "sdk/src/inputBatch.ts",
      "package-lock.json",
    ]),
    options,
  );
  return commit.toLowerCase();
}

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

async function submit(
  label: string,
  operation: () => Promise<{
    hash: string;
    wait(): Promise<TransactionReceipt | null>;
  }>,
): Promise<Readonly<{ transactionHash: string; receipt: TransactionReceipt }>> {
  stage = label;
  if (!recoveryJournal) throw new Error("batch probe journal is not initialized");
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
    console.log(
      `${label}: tx=${evidence.transactionHash} gas=${evidence.receipt.gasUsed.toString()}`,
    );
    return evidence;
  } catch (error) {
    const hash = transactionHashFromError(error);
    if (hash) {
      if (!recoveryJournal.transactions.some((transaction) =>
        transaction.hash.toLowerCase() === hash.toLowerCase()
      )) throw new Error("batch probe transaction was not locally signed and journaled", {
        cause: error,
      });
      recoveryJournal.recordTransaction(
        hash,
        error instanceof MinedTransactionStatusError ? "mined-failure" : "outcome-unknown",
      );
    }
    throw error;
  }
}

async function submitFailure(
  label: string,
  operation: () => Promise<{
    hash: string;
    wait(): Promise<TransactionReceipt | null>;
  }>,
): Promise<void> {
  stage = label;
  if (!recoveryJournal) throw new Error("batch probe journal is not initialized");
  const evidence = await withFundedTransactionEvidence(
    label,
    recoveryJournal,
    () => requireMinedFailure(
      label,
      operation,
      (hash) => ethers.provider.getTransactionReceipt(hash),
    ),
  );
  recoveryJournal.recordTransaction(
    evidence.transactionHash,
    "mined-failure",
    evidence.receipt.blockNumber,
  );
  console.log(`${label}: rejected tx=${evidence.transactionHash}`);
}

function encryptedValues(values: readonly bigint[], aesKey: string): CipherDexBatchCiphertext[] {
  return values.map((value) => {
    const ciphertext = encryptUint256(value, aesKey);
    return {
      ciphertextHigh: BigInt(ciphertext.ciphertextHigh),
      ciphertextLow: BigInt(ciphertext.ciphertextLow),
    };
  });
}

async function signedAuthorization(input: Readonly<{
  signer: FundedCotiWallet;
  caller: string;
  target: string;
  selector: string;
  schemaHash: string;
  ciphertexts: readonly CipherDexBatchCiphertext[];
  nonce: string;
  deadline: bigint;
}>): Promise<CipherDexInputBatchAuthorization> {
  const typedData = buildCipherDexInputBatchTypedData({
    chainId: CHAIN_ID,
    protocolVersion: PROTOCOL_VERSION,
    caller: input.caller,
    target: input.target,
    selector: input.selector,
    schemaHash: input.schemaHash,
    ciphertexts: input.ciphertexts,
    nonce: input.nonce,
    deadline: input.deadline,
  });
  return signCipherDexInputBatch(input.signer, typedData);
}

function resultFromReceipt(
  probe: Contract,
  receipt: TransactionReceipt,
  caller: string,
  nonce: string,
  slotCount: number,
): unknown {
  const matches: unknown[] = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== String(probe.target).toLowerCase()) continue;
    try {
      const parsed = probe.interface.parseLog({ topics: log.topics, data: log.data });
      if (
        parsed?.name === "MpcBatchProbeResult" &&
        String(parsed.args.caller).toLowerCase() === caller.toLowerCase() &&
        String(parsed.args.nonce).toLowerCase() === nonce.toLowerCase() &&
        Number(parsed.args.slotCount) === slotCount
      ) matches.push(parsed.args.result);
    } catch {
      // Ignore the authorization event and nested wallet logs.
    }
  }
  if (matches.length !== 1) throw new Error("batch probe result is missing or ambiguous");
  return matches[0];
}

async function main(): Promise<void> {
  stage = "source provenance";
  const evidenceCommit = await assertCleanCommittedSource();
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== CHAIN_ID) throw new Error("batch probe requires COTI testnet");

  const privateKey = requiredPrivateKey("COTI_QUOTE_PRIVATE_KEY");
  const aesKey = requiredAesKey("COTI_QUOTE_AES_KEY");
  const wallet = new FundedCotiWallet(privateKey, ethers.provider, { aesKey });
  wallet.setAesKey(aesKey);
  const owner = await wallet.getAddress();
  const factoryAddress = ethers.getAddress(process.env.COTI_FACTORY ?? "");
  const deployment = await verifyConfiguredTestnetDeployment(
    requiredTestnetDeploymentRecordPath(),
    ethers.provider,
    [{
      recordKey: "confidentialFactory",
      contractName: "ConfidentialCPMMFactory",
      address: factoryAddress,
    }],
  );
  if (deployment.evidenceCommit !== evidenceCommit) {
    throw new Error("batch probe evidence HEAD does not match the authenticated revision");
  }
  recoveryJournal = openFundedRecoveryJournal(privateKey, {
    runner: "batch-authorization-feasibility",
    sourceCommit: deployment.sourceCommit,
    chainId: Number(network.chainId),
    owner,
    directory: requiredFundedRecoveryDirectory(),
    deployment: await createFundedDeploymentBinding(deployment),
  });
  const unresolved = await recoveryJournal.reconcileTransactions(ethers.provider);
  if (unresolved.length > 0) {
    throw new Error("batch probe has unresolved transactions; do not retry");
  }
  if (
    recoveryJournal.runStatus === "evidence-pending" ||
    recoveryJournal.runStatus === "evidence-failed"
  ) {
    const evidence = await writePreparedFundedRunEvidence({
      journal: recoveryJournal,
      provider: ethers.provider,
      attestationSigner: wallet,
    });
    console.log(`fundedEvidence=${evidence.path}`);
    return;
  }
  if (recoveryJournal.transactions.length > 0 || recoveryJournal.resources.length > 0) {
    throw new Error("batch probe journal is incomplete; inspect it before rerun");
  }

  const probeFactory = await ethers.getContractFactory("MpcBatchAuthorizationProbe", wallet);
  let probe: any;
  const probeDeployment = await submit("batch authorization probe deployment", async () => {
    probe = await probeFactory.deploy({ gasLimit: 10_000_000n });
    const transaction = probe.deploymentTransaction();
    if (!transaction) throw new Error("batch probe deployment transaction unavailable");
    return transaction;
  });
  if (!probe) throw new Error("batch probe deployment handle unavailable");
  const probeAddress = ethers.getAddress(await probe.getAddress());
  await verifyDeployedRuntimeArtifactWithProvenance(
    "MpcBatchAuthorizationProbe",
    probeAddress,
    ethers.provider,
  );
  const boundProbe = new Contract(probeAddress, probe.interface, wallet);

  const walletFactory = await ethers.getContractFactory("MockERC1271Wallet", wallet);
  let contractWallet: any;
  const walletDeployment = await submit("batch authorization ERC-1271 wallet deployment", async () => {
    contractWallet = await walletFactory.deploy(owner, { gasLimit: 3_000_000n });
    const transaction = contractWallet.deploymentTransaction();
    if (!transaction) throw new Error("ERC-1271 wallet deployment transaction unavailable");
    return transaction;
  });
  if (!contractWallet) throw new Error("ERC-1271 wallet deployment handle unavailable");
  const contractWalletAddress = ethers.getAddress(await contractWallet.getAddress());
  await verifyDeployedRuntimeArtifactWithProvenance(
    "MockERC1271Wallet",
    contractWalletAddress,
    ethers.provider,
  );

  const block = await ethers.provider.getBlock("latest");
  if (!block) throw new Error("latest COTI block unavailable");
  const deadline = BigInt(block.timestamp + 3_600);
  const twoSelector = probe.interface.getFunction("probeTwo")!.selector;
  const fiveSelector = probe.interface.getFunction("probeFive")!.selector;

  const twoCiphertexts = encryptedValues(TWO_VALUES, aesKey);
  const twoNonce = ethers.keccak256(ethers.randomBytes(32));
  const twoAuthorization = await signedAuthorization({
    signer: wallet,
    caller: owner,
    target: probeAddress,
    selector: twoSelector,
    schemaHash: TWO_SLOT_SCHEMA_HASH,
    ciphertexts: twoCiphertexts,
    nonce: twoNonce,
    deadline,
  });
  const modifiedCiphertexts = [
    twoCiphertexts[0],
    ...encryptedValues([31n], aesKey),
  ];
  await submitFailure(
    "modified EOA two-slot batch",
    () => boundProbe.probeTwo(
      modifiedCiphertexts,
      twoAuthorization,
      { gasLimit: GAS_LIMIT },
    ),
  );
  const twoEvidence = await submit(
    "EOA two-slot batch",
    () => boundProbe.probeTwo(
      twoCiphertexts,
      twoAuthorization,
      { gasLimit: GAS_LIMIT },
    ),
  );
  const twoResult = resultFromReceipt(
    boundProbe,
    twoEvidence.receipt,
    owner,
    twoNonce,
    2,
  );
  if (await wallet.decryptValue256(twoResult as never) !== TWO_VALUES[0] + TWO_VALUES[1]) {
    throw new Error("two-slot batch arithmetic result mismatch");
  }
  await submitFailure(
    "replayed EOA two-slot batch",
    () => boundProbe.probeTwo(
      twoCiphertexts,
      twoAuthorization,
      { gasLimit: GAS_LIMIT },
    ),
  );

  const fiveCiphertexts = encryptedValues(FIVE_VALUES, aesKey);
  const fiveNonce = ethers.keccak256(ethers.randomBytes(32));
  const fiveAuthorization = await signedAuthorization({
    signer: wallet,
    caller: owner,
    target: probeAddress,
    selector: fiveSelector,
    schemaHash: FIVE_SLOT_SCHEMA_HASH,
    ciphertexts: fiveCiphertexts,
    nonce: fiveNonce,
    deadline,
  });
  const fiveEvidence = await submit(
    "EOA five-slot batch",
    () => boundProbe.probeFive(
      fiveCiphertexts,
      fiveAuthorization,
      { gasLimit: GAS_LIMIT },
    ),
  );
  const fiveResult = resultFromReceipt(
    boundProbe,
    fiveEvidence.receipt,
    owner,
    fiveNonce,
    5,
  );
  const expectedFive = FIVE_VALUES.reduce((total, value) => total + value, 0n);
  if (await wallet.decryptValue256(fiveResult as never) !== expectedFive) {
    throw new Error("five-slot batch arithmetic result mismatch");
  }

  const contractCiphertexts = encryptedValues(TWO_VALUES, aesKey);
  const contractNonce = ethers.keccak256(ethers.randomBytes(32));
  const contractAuthorization = await signedAuthorization({
    signer: wallet,
    caller: contractWalletAddress,
    target: probeAddress,
    selector: twoSelector,
    schemaHash: TWO_SLOT_SCHEMA_HASH,
    ciphertexts: contractCiphertexts,
    nonce: contractNonce,
    deadline,
  });
  const contractCall = probe.interface.encodeFunctionData("probeTwo", [
    contractCiphertexts,
    contractAuthorization,
  ]);
  const contractEvidence = await submit(
    "ERC-1271 two-slot batch",
    () => contractWallet.execute(
      probeAddress,
      contractCall,
      { gasLimit: GAS_LIMIT },
    ),
  );
  resultFromReceipt(
    boundProbe,
    contractEvidence.receipt,
    contractWalletAddress,
    contractNonce,
    2,
  );

  const configuration = preflightFundedRunConfiguration(
    "batch-authorization-feasibility",
    {
      chainId: Number(CHAIN_ID),
      domainName: CIPHERDEX_INPUT_BATCH_DOMAIN_NAME,
      domainVersion: CIPHERDEX_INPUT_BATCH_DOMAIN_VERSION,
      protocolVersion: Number(PROTOCOL_VERSION),
      probe: probeAddress,
      twoSlotSchema: TWO_SLOT_SCHEMA_HASH,
      fiveSlotSchema: FIVE_SLOT_SCHEMA_HASH,
    },
  );
  recoveryJournal.prepareEvidence({
    participants: [owner, contractWalletAddress],
    configuration,
    artifacts: [
      {
        label: "batch authorization MPC probe",
        contractName: "MpcBatchAuthorizationProbe",
        address: probeAddress,
        creationTransactionHash: probeDeployment.transactionHash,
        constructorArguments: [],
      },
      {
        label: "batch authorization ERC-1271 wallet",
        contractName: "MockERC1271Wallet",
        address: contractWalletAddress,
        creationTransactionHash: walletDeployment.transactionHash,
        constructorArguments: [owner],
      },
    ],
    assertions: [
      "two raw ciphertext slots onboarded after one EOA batch signature",
      "five raw ciphertext slots onboarded after one EOA batch signature",
      "encrypted batch arithmetic decrypted to the expected EOA results",
      "modified ciphertext batch rejected before nonce consumption",
      "consumed batch nonce replay rejected",
      "ERC-1271 caller authorized one raw ciphertext batch",
    ],
  });
  const evidence = await writePreparedFundedRunEvidence({
    journal: recoveryJournal,
    provider: ethers.provider,
    attestationSigner: wallet,
  });
  console.log(`fundedEvidence=${evidence.path}`);
  console.log("COTI batch authorization MPC probe passed without printing private values.");
}

void main().catch((error: unknown) => {
  recoveryJournal?.markRun("failed");
  console.error(
    `COTI batch authorization probe failed during ${stage}: ` +
      `${safeTestnetErrorSummary(error)}; private payloads were suppressed.`,
  );
  process.exitCode = 1;
});
