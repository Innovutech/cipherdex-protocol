import {
  Contract,
  ContractFactory,
  TransactionReceipt,
  ethers as ethersLibrary,
} from "ethers";
import { ethers } from "../hardhat/runtime.js";

import {
  CT_UINT256,
  IT_UINT256,
  PRIVATE_ERC20_TESTNET_ABI,
} from "./coti-testnet-abi";
import { decryptPrivateValue256 } from "./coti-testnet-values";
import {
  type FundedRecoveryJournal,
  verifyRecoveryResourceCreation,
} from "./funded-recovery-journal";
import { writePreparedFundedRunEvidence } from "./funded-run-evidence";
import { createFundedDeploymentBinding } from "./funded-deployment-binding";
import {
  FundedCotiWallet as CotiWallet,
  FundedWallet,
  openFundedRecoveryJournal,
  withFundedTransactionEvidence,
} from "./funded-transaction-wallet";
import { verifyDeployedRuntimeArtifact } from "./runtime-artifact";
import {
  assertReviewedPrivateTokens,
  requiredTestnetDeploymentRecordPath,
  verifyConfiguredTestnetDeployment,
} from "./testnet-deployment-provenance";
import {
  MinedTransactionStatusError,
  requireMinedSuccess,
  safeTestnetErrorSummary,
  transactionHashFromError,
  UnknownBroadcastOutcomeError,
} from "./testnet-transaction-evidence";

const EXPECTED_CHAIN_ID = 7_082_400n;
const CALL_GAS_LIMIT = 30_000_000n;
const DEFAULT_INPUT = 10_001n;
const MAX_PROBE_INPUT = 1_000_000n;
let stage = "configuration";
let recoveryJournal: FundedRecoveryJournal | undefined;
let recoveryWallet: CotiWallet | undefined;
let recoveryRecipient: string | undefined;

const ROUTER_ABI = [
  `function requestBestQuoteExactInput(${IT_UINT256} amountIn,bytes32 requestId) returns (${CT_UINT256} result)`,
  `function swapBestExactInput(${IT_UINT256} amountIn,${IT_UINT256} minimumOut,bytes32 requestId,uint64 deadline) returns (${CT_UINT256} result)`,
  "function closeAndRecover(address recipient)",
  "function closed() view returns (bool)",
  `event ProbeBestQuote(address indexed caller,bytes32 indexed requestId,address indexed selectedPool,${CT_UINT256} result)`,
  `event ProbeBestSwap(address indexed caller,bytes32 indexed requestId,address indexed selectedPool,${CT_UINT256} result)`,
] as const;

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

function requiredAddress(name: string): string {
  const value = process.env[name]?.trim();
  if (!value || !ethersLibrary.isAddress(value)) {
    throw new Error(`${name} must be a valid deployed address`);
  }
  return ethersLibrary.getAddress(value);
}

function journal(): FundedRecoveryJournal {
  if (!recoveryJournal) throw new Error("funded recovery journal is not initialized");
  return recoveryJournal;
}

function positiveAmount(): bigint {
  const raw = process.env.COTI_BEST_EXECUTION_TEST_AMOUNT_IN?.trim();
  if (raw && !/^\d+$/.test(raw)) {
    throw new Error("COTI_BEST_EXECUTION_TEST_AMOUNT_IN must be a safe positive uint256");
  }
  const value = raw ? BigInt(raw) : DEFAULT_INPUT;
  if (value <= 0n || value > MAX_PROBE_INPUT) {
    throw new Error(
      `COTI_BEST_EXECUTION_TEST_AMOUNT_IN must be between 1 and ${MAX_PROBE_INPUT}`,
    );
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
    journal().recordTransaction(
      evidence.transactionHash,
      "mined-success",
      evidence.receipt.blockNumber,
    );
    return evidence;
  } catch (error) {
    const hash = transactionHashFromError(error);
    if (hash) {
      if (!journal().transactions.some((transaction) =>
        transaction.hash.toLowerCase() === hash.toLowerCase()
      )) throw new Error("funded transaction was not locally signed and journaled", { cause: error });
      journal().recordTransaction(
        hash,
        error instanceof MinedTransactionStatusError ? "mined-failure" : "outcome-unknown",
      );
    }
    throw error;
  }
}

async function deployProbe(
  label: string,
  factory: ContractFactory,
  args: readonly unknown[],
  contractName: "MpcBestExecutionPoolProbe" | "MpcBestExecutionRouterProbe",
  resourceId: string,
  metadata: Readonly<Record<string, string | number | boolean>>,
): Promise<Readonly<{ contract: any; address: string; transactionHash: string }>> {
  let contract: any;
  const deployment = await submit(label, async () => {
    contract = await factory.deploy(...args, { gasLimit: CALL_GAS_LIMIT });
    const transaction = contract.deploymentTransaction();
    if (!transaction) throw new Error(`${label} transaction is unavailable`);
    return transaction;
  });
  if (!contract) {
    throw new Error(`${label} was mined but its contract handle is unavailable; do not retry automatically`);
  }
  const address = ethersLibrary.getAddress(await contract.getAddress());
  journal().recordResource({
    id: resourceId,
    kind: "best-execution-probe",
    address,
    creationTransactionHash: deployment.transactionHash,
    metadata: { contractName, ...metadata },
  });
  return Object.freeze({
    contract,
    address,
    transactionHash: deployment.transactionHash,
  });
}

async function recoverJournalProbes(): Promise<void> {
  if (!recoveryJournal || !recoveryWallet || !recoveryRecipient) return;
  const closableAbi = [
    "function configurator() view returns (address)",
    "function closed() view returns (bool)",
    "function closeAndRecover(address recipient)",
  ] as const;
  for (const resource of recoveryJournal.activeResources) {
    await verifyRecoveryResourceCreation(recoveryJournal, resource, ethers.provider);
    if (resource.kind !== "best-execution-probe") {
      throw new Error(`unsupported active recovery resource ${resource.kind}`);
    }
    const contractName = String(resource.metadata.contractName ?? "");
    const tokenInAddress = String(resource.metadata.tokenInAddress ?? "");
    const tokenOutAddress = String(resource.metadata.tokenOutAddress ?? "");
    if (
      !["MpcBestExecutionPoolProbe", "MpcBestExecutionRouterProbe"].includes(contractName) ||
      !ethersLibrary.isAddress(tokenInAddress) ||
      (tokenOutAddress !== "" && !ethersLibrary.isAddress(tokenOutAddress))
    ) throw new Error("funded probe recovery metadata is invalid");
    await verifyDeployedRuntimeArtifact(contractName, resource.address);
    const probe = new Contract(resource.address, closableAbi, recoveryWallet);
    if (
      String(await probe.configurator()).toLowerCase() !== recoveryRecipient.toLowerCase()
    ) throw new Error("funded probe recovery configurator changed");
    const recoveryLabel = `${resource.id} closure and recovery`;
    let recoveryTransactionHash: string;
    if (!Boolean(await probe.closed())) {
      const recovery = await submit(
        recoveryLabel,
        () => probe.closeAndRecover(recoveryRecipient, { gasLimit: CALL_GAS_LIMIT }),
      );
      recoveryTransactionHash = recovery.transactionHash;
    } else {
      const prior = recoveryJournal.transactions.filter((transaction) =>
        transaction.label === recoveryLabel && transaction.status === "mined-success"
      );
      if (prior.length !== 1) {
        throw new Error("closed funded probe lacks unique recovery transaction evidence");
      }
      recoveryTransactionHash = prior[0].hash;
    }
    for (const tokenAddress of [tokenInAddress, tokenOutAddress].filter(Boolean)) {
      const token = new Contract(tokenAddress, PRIVATE_ERC20_TESTNET_ABI, recoveryWallet);
      if (await encryptedBalance(token, recoveryWallet, resource.address) !== 0n) {
        throw new Error(`closed probe retained private-token residue at ${resource.address}`);
      }
    }
    recoveryJournal.markRecovered(resource.id, [recoveryTransactionHash]);
  }
}

async function encryptedBalance(
  token: Contract,
  wallet: CotiWallet,
  account: string,
): Promise<bigint> {
  return decryptPrivateValue256(wallet, await token.balanceOf.staticCall(account));
}

async function approveEncrypted(
  token: Contract,
  wallet: CotiWallet,
  tokenAddress: string,
  spender: string,
  amount: bigint,
): Promise<void> {
  const approve = token.getFunction("approve");
  const selector = token.interface.getFunction("approve")?.selector;
  if (!selector) {
    throw new Error("private token approve selector is unavailable");
  }
  const input = await wallet.encryptValue256(amount, tokenAddress, selector);
  await submit(
    "encrypted approval",
    () => approve(spender, input, { gasLimit: CALL_GAS_LIMIT }),
  );
}

async function transferEncrypted(
  label: string,
  token: Contract,
  wallet: CotiWallet,
  tokenAddress: string,
  recipient: string,
  amount: bigint,
): Promise<void> {
  const transfer = token.getFunction("transfer");
  const selector = token.interface.getFunction("transfer")?.selector;
  if (!selector) {
    throw new Error("private token transfer selector is unavailable");
  }
  const input = await wallet.encryptValue256(amount, tokenAddress, selector);
  await submit(
    label,
    () => transfer(recipient, input, { gasLimit: CALL_GAS_LIMIT }),
  );
}

function eventFromReceipt(
  router: Contract,
  receipt: TransactionReceipt | null,
  name: "ProbeBestQuote" | "ProbeBestSwap",
  caller: string,
  requestId: string,
): { selectedPool: string; result: unknown } {
  const routerAddress = String(router.target).toLowerCase();
  const matches: Array<{ selectedPool: string; result: unknown }> = [];
  for (const log of receipt?.logs ?? []) {
    if (log.address.toLowerCase() !== routerAddress) continue;
    try {
      const parsed = router.interface.parseLog(log);
      if (
        parsed?.name === name &&
        String(parsed.args.caller).toLowerCase() === caller.toLowerCase() &&
        String(parsed.args.requestId).toLowerCase() === requestId.toLowerCase()
      ) {
        matches.push({
          selectedPool: ethersLibrary.getAddress(String(parsed.args.selectedPool)),
          result: parsed.args.result,
        });
      }
    } catch {
      // Ignore logs from the private token and pool probes.
    }
  }
  if (matches.length !== 1) {
    throw new Error(`${name} event is missing or ambiguous`);
  }
  return matches[0]!;
}

async function main(): Promise<void> {
  stage = "current artifacts compiled";

  const privateKey = requiredPrivateKey("COTI_TESTNET_PRIVATE_KEY");
  const aesKey = requiredAesKey("COTI_AES_KEY");
  const tokenInAddress = requiredAddress("COTI_TOKEN0");
  const tokenOutAddress = requiredAddress("COTI_TOKEN1");
  const factoryAddress = requiredAddress("COTI_FACTORY");
  const feeVaultAddress = requiredAddress("COTI_FEE_VAULT");
  const bestExecutionRouterAddress = requiredAddress("COTI_BEST_EXECUTION_ROUTER");
  const amountIn = positiveAmount();
  const expectedBestOutput = amountIn * 3n;

  stage = "network and wallet initialization";
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(`expected COTI testnet ${EXPECTED_CHAIN_ID}, received ${network.chainId}`);
  }
  stage = "reviewed deployment provenance";
  const deploymentRecord = await verifyConfiguredTestnetDeployment(
    requiredTestnetDeploymentRecordPath(),
    ethers.provider,
    [
      {
        recordKey: "feeVault",
        contractName: "CipherDEXFeeVault",
        address: feeVaultAddress,
      },
      {
        recordKey: "confidentialFactory",
        contractName: "ConfidentialCPMMFactory",
        address: factoryAddress,
      },
      {
        recordKey: "confidentialBestExecutionRouter",
        contractName: "ConfidentialBestExecutionRouter",
        address: bestExecutionRouterAddress,
      },
    ],
  );
  assertReviewedPrivateTokens(deploymentRecord, [tokenInAddress, tokenOutAddress]);

  const wallet = new CotiWallet(privateKey, ethers.provider, { aesKey });
  wallet.setAesKey(aesKey);
  const caller = await wallet.getAddress();
  const sourceCommit = deploymentRecord.sourceCommit;
  recoveryJournal = openFundedRecoveryJournal(privateKey, {
    runner: "best-execution-feasibility",
    sourceCommit,
    chainId: Number(network.chainId),
    owner: caller,
    deployment: await createFundedDeploymentBinding(deploymentRecord),
  });
  recoveryWallet = wallet;
  recoveryRecipient = caller;
  const unresolved = await recoveryJournal.reconcileTransactions(ethers.provider);
  if (unresolved.length > 0) {
    throw new Error(
      `funded recovery has ${unresolved.length} transaction(s) with unknown outcome; do not retry`,
    );
  }
  await recoverJournalProbes();
  if (
    recoveryJournal.runStatus === "evidence-pending" ||
    recoveryJournal.runStatus === "evidence-failed"
  ) {
    const finalEvidence = await writePreparedFundedRunEvidence({
      journal: recoveryJournal,
      provider: ethers.provider,
      attestationSigner: wallet,
    });
    console.log(`fundedEvidence=${finalEvidence.path}`);
    return;
  }
  const deployer = new FundedWallet(privateKey, ethers.provider);
  const tokenIn = new Contract(tokenInAddress, PRIVATE_ERC20_TESTNET_ABI, wallet);
  const tokenOut = new Contract(tokenOutAddress, PRIVATE_ERC20_TESTNET_ABI, wallet);

  const [inputBalanceBefore, outputBalanceBefore] = await Promise.all([
    encryptedBalance(tokenIn, wallet, caller),
    encryptedBalance(tokenOut, wallet, caller),
  ]);
  if (inputBalanceBefore < amountIn || outputBalanceBefore < expectedBestOutput * 2n) {
    throw new Error("funded test wallet does not have enough private assets for the probe");
  }

  stage = "pool probe deployment";
  const poolFactory = await ethers.getContractFactory("MpcBestExecutionPoolProbe", deployer);
  const pool0Deployment = await deployProbe(
    "pool probe 0 deployment",
    poolFactory,
    [tokenInAddress, tokenOutAddress, 2n, 1n],
    "MpcBestExecutionPoolProbe",
    "pool-probe-0",
    { tokenInAddress, tokenOutAddress },
  );
  const pool1Deployment = await deployProbe(
    "pool probe 1 deployment",
    poolFactory,
    [tokenInAddress, tokenOutAddress, 3n, 1n],
    "MpcBestExecutionPoolProbe",
    "pool-probe-1",
    { tokenInAddress, tokenOutAddress },
  );
  const pool0 = pool0Deployment.contract;
  const pool1 = pool1Deployment.contract;
  const pool0Address = pool0Deployment.address;
  const pool1Address = pool1Deployment.address;
  await Promise.all([
    verifyDeployedRuntimeArtifact("MpcBestExecutionPoolProbe", pool0Address),
    verifyDeployedRuntimeArtifact("MpcBestExecutionPoolProbe", pool1Address),
  ]);

  stage = "router probe deployment and binding";
  const routerFactory = await ethers.getContractFactory("MpcBestExecutionRouterProbe", deployer);
  const routerProbeDeployment = await deployProbe(
    "router probe deployment",
    routerFactory,
    [tokenInAddress, pool0Address, pool1Address, caller],
    "MpcBestExecutionRouterProbe",
    "router-probe",
    { tokenInAddress, tokenOutAddress: "" },
  );
  const routerDeployment = routerProbeDeployment.contract;
  const routerAddress = routerProbeDeployment.address;
  await verifyDeployedRuntimeArtifact("MpcBestExecutionRouterProbe", routerAddress);
  await submit(
    "pool probe 0 router binding",
    () => pool0.configureRouter(routerAddress, { gasLimit: CALL_GAS_LIMIT }),
  );
  await submit(
    "pool probe 1 router binding",
    () => pool1.configureRouter(routerAddress, { gasLimit: CALL_GAS_LIMIT }),
  );

  stage = "pool output funding";
  const poolFunding = expectedBestOutput * 2n;
  await transferEncrypted(
    "pool probe 0 output funding",
    tokenOut,
    wallet,
    tokenOutAddress,
    pool0Address,
    poolFunding,
  );
  await transferEncrypted(
    "pool probe 1 output funding",
    tokenOut,
    wallet,
    tokenOutAddress,
    pool1Address,
    poolFunding,
  );

  const router = new Contract(routerAddress, ROUTER_ABI, wallet);
  const quoteRequestId = ethersLibrary.keccak256(
    ethersLibrary.toUtf8Bytes(`cipherdex-gt-quote-${Date.now()}`),
  );
  stage = "cross-contract GT quote and private selection";
  const quoteFunction = router.getFunction("requestBestQuoteExactInput");
  const quoteSelector = router.interface.getFunction("requestBestQuoteExactInput")?.selector;
  if (!quoteSelector) {
    throw new Error("best quote selector is unavailable");
  }
  const quoteInput = await wallet.encryptValue256(
    amountIn,
    routerAddress,
    quoteSelector,
  );
  const quoteEvidence = await submit(
    "cross-contract GT quote and private selection",
    () => quoteFunction(quoteInput, quoteRequestId, { gasLimit: CALL_GAS_LIMIT }),
  );
  const quoteReceipt = quoteEvidence.receipt;
  const quoteEvent = eventFromReceipt(
    router,
    quoteReceipt,
    "ProbeBestQuote",
    caller,
    quoteRequestId,
  );
  if (quoteEvent.selectedPool !== pool1Address) {
    throw new Error("private candidate selection did not choose the larger output");
  }
  if (await wallet.decryptValue256(quoteEvent.result as never) !== expectedBestOutput) {
    throw new Error("winning encrypted quote did not decrypt to the expected result");
  }
  const [inputAfterQuote, outputAfterQuote] = await Promise.all([
    encryptedBalance(tokenIn, wallet, caller),
    encryptedBalance(tokenOut, wallet, caller),
  ]);
  if (inputAfterQuote !== inputBalanceBefore || outputAfterQuote !== outputBalanceBefore - poolFunding * 2n) {
    throw new Error("quote-only probe changed private token balances");
  }

  stage = "router escrow allowance";
  await approveEncrypted(tokenIn, wallet, tokenInAddress, routerAddress, amountIn);

  stage = "atomic selected-pool settlement";
  const swapRequestId = ethersLibrary.keccak256(
    ethersLibrary.toUtf8Bytes(`cipherdex-gt-swap-${Date.now()}`),
  );
  const swapFunction = router.getFunction("swapBestExactInput");
  const swapSelector = router.interface.getFunction("swapBestExactInput")?.selector;
  if (!swapSelector) {
    throw new Error("best swap selector is unavailable");
  }
  const [swapInput, minimumOutput] = await Promise.all([
    wallet.encryptValue256(amountIn, routerAddress, swapSelector),
    wallet.encryptValue256(expectedBestOutput, routerAddress, swapSelector),
  ]);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const swapEvidence = await submit(
    "atomic selected-pool settlement",
    () => swapFunction(
      swapInput,
      minimumOutput,
      swapRequestId,
      deadline,
      { gasLimit: CALL_GAS_LIMIT },
    ),
  );
  const swapReceipt = swapEvidence.receipt;
  const swapEvent = eventFromReceipt(
    router,
    swapReceipt,
    "ProbeBestSwap",
    caller,
    swapRequestId,
  );
  if (swapEvent.selectedPool !== pool1Address) {
    throw new Error("settlement did not use the privately selected pool");
  }
  if (await wallet.decryptValue256(swapEvent.result as never) !== expectedBestOutput) {
    throw new Error("settled encrypted output did not match the winning quote");
  }

  const [inputAfterSwap, outputAfterSwap] = await Promise.all([
    encryptedBalance(tokenIn, wallet, caller),
    encryptedBalance(tokenOut, wallet, caller),
  ]);
  if (inputAfterSwap !== inputBalanceBefore - amountIn) {
    throw new Error("atomic settlement did not debit the exact encrypted input");
  }
  if (outputAfterSwap !== outputBalanceBefore - poolFunding * 2n + expectedBestOutput) {
    throw new Error("atomic settlement did not credit the exact selected output");
  }
  const callerAllowance = await tokenIn.allowance.staticCall(caller, routerAddress);
  if (await wallet.decryptValue256(callerAllowance.ownerCiphertext) !== 0n) {
    throw new Error("atomic settlement left a caller-to-router allowance");
  }

  stage = "probe closure and private-asset recovery";
  const recoveryEvidence = [];
  for (const [label, resourceId, probe] of [
    ["pool probe 0", "pool-probe-0", pool0],
    ["pool probe 1", "pool-probe-1", pool1],
    ["router probe", "router-probe", routerDeployment],
  ] as const) {
    const recovery = await submit(
      `${label} closure and recovery`,
      () => probe.closeAndRecover(caller, { gasLimit: CALL_GAS_LIMIT }),
    );
    recoveryEvidence.push(recovery);
    if (!Boolean(await probe.closed())) {
      throw new Error(`${label} did not remain permanently closed`);
    }
    recoveryJournal.markRecovered(resourceId, [recovery.transactionHash]);
  }

  const probeAddresses = [pool0Address, pool1Address, routerAddress];
  for (const probeAddress of probeAddresses) {
    const [inputResidue, outputResidue] = await Promise.all([
      encryptedBalance(tokenIn, wallet, probeAddress),
      encryptedBalance(tokenOut, wallet, probeAddress),
    ]);
    if (inputResidue !== 0n || outputResidue !== 0n) {
      throw new Error(`closed probe retained private-token residue at ${probeAddress}`);
    }
  }
  const [inputAfterRecovery, outputAfterRecovery] = await Promise.all([
    encryptedBalance(tokenIn, wallet, caller),
    encryptedBalance(tokenOut, wallet, caller),
  ]);
  if (inputAfterRecovery !== inputBalanceBefore || outputAfterRecovery !== outputBalanceBefore) {
    throw new Error("probe cleanup did not restore the funded wallet's exact private-token balances");
  }

  console.log(`GT pool probe 0: ${pool0Address}`);
  console.log(`GT pool probe 1: ${pool1Address}`);
  console.log(`GT router probe: ${routerAddress}`);
  console.log(
    `quote-only tx=${quoteEvidence.transactionHash} gas=${quoteReceipt.gasUsed.toString()}`,
  );
  console.log(
    `quote-plus-swap tx=${swapEvidence.transactionHash} gas=${swapReceipt.gasUsed.toString()}`,
  );
  for (const evidence of recoveryEvidence) {
    console.log(
      `probe-recovery tx=${evidence.transactionHash} gas=${evidence.receipt.gasUsed.toString()}`,
    );
  }
  console.log(
    "COTI testnet GT feasibility passed: current runtime artifacts reused caller-bound GT across two contracts, selected privately, escrowed exactly, consumed allowances, restored the router's starting input balance, permanently closed every disposable probe, and recovered all private assets",
  );
  recoveryJournal.prepareEvidence({
    participants: [caller],
    configuration: {
      chainId: Number(network.chainId),
      protocolVersion: 1,
      quoteTransport: "paid-transaction",
      candidateCount: 2,
      tokenIn: tokenInAddress,
      tokenOut: tokenOutAddress,
      reviewedFactory: factoryAddress,
      reviewedFeeVault: feeVaultAddress,
      reviewedRouter: bestExecutionRouterAddress,
    },
    artifacts: [
      {
        label: "GT pool probe 0",
        contractName: "MpcBestExecutionPoolProbe",
        address: pool0Address,
        creationTransactionHash: pool0Deployment.transactionHash,
        constructorArguments: [tokenInAddress, tokenOutAddress, 2, 1],
      },
      {
        label: "GT pool probe 1",
        contractName: "MpcBestExecutionPoolProbe",
        address: pool1Address,
        creationTransactionHash: pool1Deployment.transactionHash,
        constructorArguments: [tokenInAddress, tokenOutAddress, 3, 1],
      },
      {
        label: "GT router probe",
        contractName: "MpcBestExecutionRouterProbe",
        address: routerAddress,
        creationTransactionHash: routerProbeDeployment.transactionHash,
        constructorArguments: [tokenInAddress, pool0Address, pool1Address, caller],
      },
    ],
    assertions: [
      "caller-bound GT reused across two pool contracts",
      "winning encrypted output privately selected",
      "quote-only path preserved private balances",
      "atomic escrow settled through selected pool",
      "temporary allowances cleared",
      "disposable probes closed with zero residue",
    ],
  });
  const finalEvidence = await writePreparedFundedRunEvidence({
    journal: recoveryJournal,
    provider: ethers.provider,
    attestationSigner: wallet,
  });
  console.log(`fundedEvidence=${finalEvidence.path}`);
}

void main().catch(async (error: unknown) => {
  if (recoveryJournal?.runStatus === "evidence-failed") {
    console.error(
      `COTI best-execution feasibility evidence generation failed: ` +
        `${safeTestnetErrorSummary(error)}; paid execution will not be repeated.`,
    );
    process.exitCode = 1;
    return;
  }
  if (error instanceof UnknownBroadcastOutcomeError) {
    recoveryJournal?.markRun("failed");
    console.error(
      `COTI best-execution feasibility paused with an uncertain broadcast: ` +
        `stage=${stage} ${safeTestnetErrorSummary(error)}; cleanup is deferred until receipt reconciliation.`,
    );
    process.exitCode = 1;
    return;
  }
  let reportedError = error;
  try {
    await recoverJournalProbes();
    recoveryJournal?.markRun("failed");
  } catch (recoveryError) {
    recoveryJournal?.markRun("recovery-failed");
    reportedError = new AggregateError(
      [error, recoveryError],
      "best-execution feasibility and funded recovery both failed",
    );
  }
  console.error(
    `COTI best-execution feasibility failed: stage=${stage} ` +
      safeTestnetErrorSummary(reportedError),
  );
  process.exitCode = 1;
});
