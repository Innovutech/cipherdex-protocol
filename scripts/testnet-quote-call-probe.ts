import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { Contract, type TransactionReceipt } from "ethers";
import { ethers } from "../hardhat/runtime.js";
import {
  verifyDeployedRuntimeArtifactWithProvenance,
  type RuntimeArtifactProvenance,
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
import { createFundedDeploymentBinding } from "./funded-deployment-binding";
import {
  requiredTestnetDeploymentRecordPath,
  verifyConfiguredTestnetDeployment,
} from "./testnet-deployment-provenance";
import {
  trustedGitArguments,
  trustedGitEnvironment,
  trustedGitExecutable,
} from "./trusted-git";

const execFileAsync = promisify(execFile);
const SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}$/i;
const COTI_TESTNET_CHAIN_ID = 7_082_400n;
const RESERVE0 = 1_000_000n;
const RESERVE1 = 2_000_000n;
const INPUT = 10_000n;
const FEE_BPS = 30n;
const CALL_GAS_LIMIT = 30_000_000n;
let stage = "configuration";
let recoveryJournal: FundedRecoveryJournal | undefined;

type ProbeResult = {
  name: string;
  supported: boolean;
  reason?: string;
};

type MinedEvidence = Readonly<{
  transactionHash: string;
  receipt: TransactionReceipt;
}>;

async function assertCleanCommittedSource(): Promise<string> {
  const cwd = process.cwd();
  const git = trustedGitExecutable(process.env, cwd);
  const gitOptions = { cwd, env: trustedGitEnvironment(), encoding: "utf8" } as const;
  const [head, status] = await Promise.all([
    execFileAsync(
      git,
      trustedGitArguments(["rev-parse", "--verify", "HEAD"]),
      gitOptions,
    ),
    execFileAsync(
      git,
      trustedGitArguments(["status", "--porcelain=v1", "--untracked-files=all", "--", "."]),
      gitOptions,
    ),
  ]);
  const sourceCommit = head.stdout.trim();
  if (!SOURCE_COMMIT_PATTERN.test(sourceCommit)) {
    throw new Error("quote-call probe requires a committed source revision");
  }
  if (status.stdout.trim().length > 0) {
    throw new Error("quote-call probe requires a clean committed worktree");
  }
  await execFileAsync(
    git,
    trustedGitArguments([
      "ls-files",
      "--error-unmatch",
      "--",
      "scripts/testnet-quote-call-probe.ts",
      "contracts/mocks/MpcQuoteCallProbe.sol",
      "scripts/runtime-artifact.ts",
      "hardhat.config.ts",
      "package-lock.json",
    ]),
    gitOptions,
  );
  return sourceCommit.toLowerCase();
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
  if (!recoveryJournal) throw new Error("quote-call probe journal is not initialized");
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
      if (!recoveryJournal.transactions.some((transaction) =>
        transaction.hash.toLowerCase() === hash.toLowerCase()
      )) throw new Error("quote probe transaction was not locally signed and journaled", {
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

async function main(): Promise<void> {
  stage = "source provenance";
  const sourceCommit = await assertCleanCommittedSource();

  stage = "network provenance";
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== COTI_TESTNET_CHAIN_ID) {
    throw new Error(
      `quote-call probe requires COTI testnet chain ${COTI_TESTNET_CHAIN_ID.toString()}`,
    );
  }

  stage = "quote identity initialization";
  const quoteKey = requiredPrivateKey("COTI_QUOTE_PRIVATE_KEY");
  const quoteAesKey = requiredAesKey("COTI_QUOTE_AES_KEY");
  const quoteWallet = new FundedCotiWallet(quoteKey, ethers.provider, { aesKey: quoteAesKey });
  quoteWallet.setAesKey(quoteAesKey);
  const quoteAddress = await quoteWallet.getAddress();
  const factoryAddress = ethers.getAddress(process.env.COTI_FACTORY ?? "");
  const deploymentRecord = await verifyConfiguredTestnetDeployment(
    requiredTestnetDeploymentRecordPath(),
    ethers.provider,
    [{
      recordKey: "confidentialFactory",
      contractName: "ConfidentialCPMMFactory",
      address: factoryAddress,
    }],
  );
  if (deploymentRecord.sourceCommit !== sourceCommit) {
    throw new Error("quote-call probe source does not match the reviewed deployment source");
  }
  recoveryJournal = openFundedRecoveryJournal(quoteKey, {
    runner: "quote-call-probe",
    sourceCommit,
    chainId: Number(network.chainId),
    owner: quoteAddress,
    directory: requiredFundedRecoveryDirectory(),
    deployment: await createFundedDeploymentBinding(deploymentRecord),
  });
  const unresolved = await recoveryJournal.reconcileTransactions(ethers.provider);
  if (unresolved.length > 0) {
    throw new Error("quote-call probe has an unresolved transaction; do not retry");
  }
  if (recoveryJournal.runStatus === "passed") {
    console.log("COTI testnet MPC eth_call quote probe was already completed for this source.");
    return;
  }
  if (recoveryJournal.transactions.length > 0 || recoveryJournal.resources.length > 0) {
    throw new Error("quote-call probe journal is incomplete; inspect it before any rerun");
  }

  stage = "probe deployment";
  const factory = await ethers.getContractFactory("MpcQuoteCallProbe", quoteWallet);
  let probe: any;
  const deploymentEvidence = await submit("probe deployment", async () => {
    probe = await factory.deploy(RESERVE0, RESERVE1, quoteAddress, {
      gasLimit: 10_000_000n,
    });
    const transaction = probe.deploymentTransaction();
    if (!transaction) throw new Error("probe deployment transaction unavailable");
    return transaction;
  });
  if (!probe) {
    throw new Error("probe deployment mined without a contract handle; do not retry automatically");
  }
  const probeAddress = await probe.getAddress();
  recoveryJournal.recordResource({
    id: "mpc-quote-call-probe",
    kind: "disposable-contract",
    address: probeAddress,
    creationTransactionHash: deploymentEvidence.transactionHash,
    metadata: { contractName: "MpcQuoteCallProbe" },
  });
  stage = "probe runtime provenance";
  const runtimeProvenance = await verifyDeployedRuntimeArtifactWithProvenance(
    "MpcQuoteCallProbe",
    probeAddress,
    ethers.provider,
  );
  const quoteProbe = new Contract(probeAddress, probe.interface, quoteWallet);
  console.log(`MPC quote-call probe deployed: ${probeAddress}`);

  stage = "transactional MPC control";
  const controlEvidence = await submit(
    "transactional MPC control",
    () => quoteProbe.publicDecryptRoundTrip(7n, { gasLimit: CALL_GAS_LIMIT }),
  );
  console.log(
    `SetPublic + Decrypt transaction control: supported tx=${controlEvidence.transactionHash} ` +
      `gas=${controlEvidence.receipt.gasUsed.toString()}`,
  );

  const results: ProbeResult[] = [];
  async function check(
    name: string,
    operation: () => Promise<void>,
  ): Promise<boolean> {
    stage = name;
    try {
      await operation();
      results.push({ name, supported: true });
      console.log(`${name}: supported`);
      return true;
    } catch (error: unknown) {
      const reason = safeTestnetErrorSummary(error);
      results.push({ name, supported: false, reason });
      console.log(`${name}: unavailable (${reason})`);
      return false;
    }
  }

  async function expectDecrypted(
    ciphertext: unknown,
    expected: bigint,
  ): Promise<void> {
    const actual = await quoteWallet.decryptValue256(ciphertext as never);
    if (actual !== expected) throw new Error("decrypted probe value mismatch");
  }

  await check("stored user ciphertext read", async () => {
    await expectDecrypted(
      await quoteProbe.storedUserCiphertext.staticCall(),
      RESERVE0,
    );
  });

  await check("SetPublic + Decrypt eth_call", async () => {
    const value = await quoteProbe.publicDecryptRoundTrip.staticCall(7n, {
      gasLimit: CALL_GAS_LIMIT,
    });
    if (value !== 7n) throw new Error("public round-trip mismatch");
  });

  await check("raw SetPublic precompile eth_call", async () => {
    const result = await quoteProbe.rawSetPublic.staticCall(7n, {
      gasLimit: CALL_GAS_LIMIT,
    });
    if (!result.ok || ethers.getBytes(result.data).length === 0) {
      throw new Error("SetPublic precompile call returned false");
    }
  });

  await check("raw stored OnBoard precompile eth_call", async () => {
    const result = await quoteProbe.rawStoredOnBoard.staticCall({
      gasLimit: CALL_GAS_LIMIT,
    });
    if (!result.ok || ethers.getBytes(result.data).length === 0) {
      throw new Error("OnBoard precompile call returned false");
    }
  });

  await check("stored OnBoard + OffBoardToUser eth_call", async () => {
    await expectDecrypted(
      await quoteProbe.storedRoundTrip.staticCall({ gasLimit: CALL_GAS_LIMIT }),
      RESERVE0,
    );
  });

  const validatedSelector = quoteProbe.interface.getFunction("validatedRoundTrip")!.selector;
  const validatedInput = await quoteWallet.encryptValue256(
    INPUT,
    probeAddress,
    validatedSelector,
  );
  await check("ValidateCiphertext + OffBoardToUser eth_call", async () => {
    await expectDecrypted(
      await quoteProbe.validatedRoundTrip.staticCall(validatedInput, {
        gasLimit: CALL_GAS_LIMIT,
      }),
      INPUT,
    );
  });

  await check("stored Add + OffBoardToUser eth_call", async () => {
    await expectDecrypted(
      await quoteProbe.storedAddRoundTrip.staticCall({ gasLimit: CALL_GAS_LIMIT }),
      RESERVE0 + RESERVE1,
    );
  });

  await check("stored Mul/Div + OffBoardToUser eth_call", async () => {
    await expectDecrypted(
      await quoteProbe.storedMulDivRoundTrip.staticCall({ gasLimit: CALL_GAS_LIMIT }),
      RESERVE1,
    );
  });

  await check("stored Compare/Mux + OffBoardToUser eth_call", async () => {
    await expectDecrypted(
      await quoteProbe.storedCompareMuxRoundTrip.staticCall({ gasLimit: CALL_GAS_LIMIT }),
      RESERVE1,
    );
  });

  const netInput = (INPUT * (10_000n - FEE_BPS)) / 10_000n;
  const invariant = RESERVE0 * RESERVE1;
  const denominator = RESERVE0 + netInput;
  const expectedOutput = RESERVE1 - ((invariant + denominator - 1n) / denominator);

  const publicQuoteSupported = await check(
    "public input confidential-reserve quote eth_call",
    async () => {
      await expectDecrypted(
        await quoteProbe.quoteExactInputPublic.staticCall(INPUT, true, {
          gasLimit: CALL_GAS_LIMIT,
        }),
        expectedOutput,
      );
    },
  );

  const storedConstantQuoteSupported = await check(
    "public input stored-constant confidential-reserve quote eth_call",
    async () => {
      await expectDecrypted(
        await quoteProbe.quoteExactInputStoredConstants.staticCall(INPUT, true, {
          gasLimit: CALL_GAS_LIMIT,
        }),
        expectedOutput,
      );
    },
  );

  const encryptedSelector = quoteProbe.interface.getFunction(
    "quoteExactInputEncrypted",
  )!.selector;
  const encryptedInput = await quoteWallet.encryptValue256(
    INPUT,
    probeAddress,
    encryptedSelector,
  );
  const encryptedQuoteSupported = await check(
    "authenticated input confidential-reserve quote eth_call",
    async () => {
      await expectDecrypted(
        await quoteProbe.quoteExactInputEncrypted.staticCall(encryptedInput, true, {
          gasLimit: CALL_GAS_LIMIT,
        }),
        expectedOutput,
      );
    },
  );

  const ciphertextReadSupported = results.find(
    (result) => result.name === "stored user ciphertext read",
  )?.supported;
  if (!ciphertextReadSupported) {
    throw new Error("ciphertext-only storage reads unexpectedly failed");
  }

  const gaslessPublicInputQuoteSupported =
    publicQuoteSupported || storedConstantQuoteSupported;
  const gaslessEncryptedInputQuoteSupported = encryptedQuoteSupported;
  if (gaslessEncryptedInputQuoteSupported) {
    console.log(
      "COTI testnet probe passed: authenticated encrypted-input gasless quoting is viable",
    );
  } else if (gaslessPublicInputQuoteSupported) {
    console.log(
      "COTI testnet probe passed: only a plaintext-input quote path is viable; confidential gasless quoting remains unsupported",
    );
  } else {
    console.log(
      "COTI testnet probe passed: ciphertext storage reads work, but the isolated MPC quote paths are unavailable under eth_call",
    );
  }

  const serializeMinedEvidence = (evidence: MinedEvidence) => Object.freeze({
    transactionHash: evidence.transactionHash,
    blockNumber: evidence.receipt.blockNumber,
    gasUsed: evidence.receipt.gasUsed.toString(),
  });
  console.log(JSON.stringify(Object.freeze({
    schema: "cipherdex.testnet-quote-call-probe/v1",
    sourceCommit,
    chainId: network.chainId.toString(),
    probe: Object.freeze({
      address: probeAddress,
      runtime: runtimeProvenance satisfies RuntimeArtifactProvenance,
      deployment: serializeMinedEvidence(deploymentEvidence),
    }),
    transactionalControl: serializeMinedEvidence(controlEvidence),
    calls: Object.freeze(results.map((result) => Object.freeze({ ...result }))),
    conclusion: Object.freeze({
      ciphertextStorageReadSupported: ciphertextReadSupported === true,
      gaslessPublicInputQuoteSupported,
      gaslessEncryptedInputQuoteSupported,
      gaslessConfidentialQuoteSupported: gaslessEncryptedInputQuoteSupported,
      paidPerPoolQuoteIsOnlyProvenExactPath: true,
    }),
  }), null, 2));
  recoveryJournal.markRecovered("mpc-quote-call-probe", [deploymentEvidence.transactionHash]);
  recoveryJournal.markRun("passed");
}

void main().catch((error: unknown) => {
  console.error(
    `COTI testnet MPC eth_call quote probe failed: stage=${stage} ` +
      safeTestnetErrorSummary(error),
  );
  process.exitCode = 1;
});
