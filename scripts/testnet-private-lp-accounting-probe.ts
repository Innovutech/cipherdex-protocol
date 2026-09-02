import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { Contract, type BaseContract, type TransactionReceipt } from "ethers";
import { artifacts, ethers } from "../hardhat/runtime.js";
import * as ethersLibrary from "ethers";

import { PRIVATE_ERC20_TESTNET_ABI } from "./coti-testnet-abi";
import { decryptPrivateValue256 } from "./coti-testnet-values";
import type { FundedRecoveryJournal } from "./funded-recovery-journal";
import {
  FundedCotiWallet,
  openFundedRecoveryJournal,
  withFundedTransactionEvidence,
} from "./funded-transaction-wallet";
import { requiredFundedRecoveryDirectory } from "./funded-runtime-state";
import {
  recoverPrivateAllowanceObligations,
  setRecoverablePrivateAllowance,
} from "./funded-private-allowance";
import {
  verifyDeployedRuntimeArtifactWithProvenance,
} from "./runtime-artifact";
import {
  MinedTransactionStatusError,
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
const SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const EXPECTED_CHAIN_ID = 7_082_400n;
const GAS_LIMIT = 30_000_000n;
const LOCK_SECONDS = 15;
const TOTAL_SHARES = 1_000n;
const DIRECT_TRANSFER = 300n;
const DELEGATED_TRANSFER = 200n;
const LOCKED_SHARES = 400n;
const FEE0_TOTAL = 3_000n;
const FEE1_TOTAL = 3_000n;

let stage = "configuration";
let recoveryJournal: FundedRecoveryJournal | undefined;
let recoveryWallets: readonly [FundedCotiWallet, FundedCotiWallet] | undefined;

type Submitted = Readonly<{
  receipt: TransactionReceipt;
  hash: string;
  gasUsed: bigint;
}>;

type Deployment = Readonly<{
  contract: BaseContract;
  transaction: Submitted;
}>;

type ProbeContext = Readonly<{
  probe: Contract;
  probeAddress: string;
  lpToken: Contract;
  lpTokenAddress: string;
  spender: Contract;
  spenderAddress: string;
  token0Primary: Contract;
  token0Second: Contract;
  token1Primary: Contract;
  token1Second: Contract;
  token0Address: string;
  token1Address: string;
  primary: FundedCotiWallet;
  second: FundedCotiWallet;
  primaryAddress: string;
  secondAddress: string;
}>;

function journal(): FundedRecoveryJournal {
  if (!recoveryJournal) throw new Error("private LP probe journal is unavailable");
  return recoveryJournal;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredPrivateKey(name: string): string {
  const value = required(name);
  if (!/^0x[0-9a-fA-F]{64}$/u.test(value)) {
    throw new Error(`${name} must be a 32-byte private key`);
  }
  return value;
}

function requiredAesKey(name: string): string {
  const value = required(name);
  if (!/^[0-9a-fA-F]{32}$/u.test(value)) {
    throw new Error(`${name} must be a 16-byte AES key`);
  }
  return value;
}

function requiredAddress(name: string): string {
  const value = required(name);
  if (!ethersLibrary.isAddress(value) || value === ethersLibrary.ZeroAddress) {
    throw new Error(`${name} must be a nonzero address`);
  }
  return ethersLibrary.getAddress(value);
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
  if (!SOURCE_COMMIT_PATTERN.test(sourceCommit) || status.stdout.trim().length > 0) {
    throw new Error("private LP funded probe requires a clean committed source revision");
  }
  return sourceCommit;
}

async function submit(
  label: string,
  operation: () => Promise<{
    hash: string;
    wait(): Promise<TransactionReceipt | null>;
  }>,
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
    journal().recordTransaction(
      evidence.transactionHash,
      "mined-success",
      evidence.receipt.blockNumber,
    );
    console.log(
      `${label}: tx=${evidence.transactionHash} gas=${evidence.receipt.gasUsed.toString()}`,
    );
    return Object.freeze({
      receipt: evidence.receipt,
      hash: evidence.transactionHash,
      gasUsed: evidence.receipt.gasUsed,
    });
  } catch (error) {
    const hash = transactionHashFromError(error);
    if (hash) {
      if (!journal().transactions.some((entry) =>
        entry.hash.toLowerCase() === hash.toLowerCase()
      )) throw new Error("funded transaction was not locally journaled", { cause: error });
      journal().recordTransaction(
        hash,
        error instanceof MinedTransactionStatusError ? "mined-failure" : "outcome-unknown",
      );
    }
    throw error;
  }
}

async function deploy(
  wallet: FundedCotiWallet,
  contractName: string,
  args: readonly unknown[],
): Promise<Deployment> {
  const factory = await ethers.getContractFactory(contractName, wallet);
  let contract: BaseContract | undefined;
  const transaction = await submit(`${contractName} deployment`, async () => {
    contract = await factory.deploy(...args, { gasLimit: GAS_LIMIT });
    const deployment = contract.deploymentTransaction();
    if (!deployment) throw new Error(`${contractName} deployment transaction unavailable`);
    return deployment;
  });
  if (!contract) throw new Error(`${contractName} deployment handle unavailable`);
  await verifyDeployedRuntimeArtifactWithProvenance(
    contractName,
    await contract.getAddress(),
    ethers.provider,
  );
  return Object.freeze({ contract, transaction });
}

async function privateBalance(
  token: Contract,
  wallet: FundedCotiWallet,
  account: string,
): Promise<bigint> {
  return decryptPrivateValue256(wallet, await token.balanceOf.staticCall(account));
}

async function encryptFor(
  wallet: FundedCotiWallet,
  value: bigint,
  contract: Contract,
  functionName: string,
): Promise<unknown> {
  const selector = contract.interface.getFunction(functionName)?.selector;
  if (!selector) throw new Error(`${functionName} selector is unavailable`);
  return wallet.encryptValue256(value, await contract.getAddress(), selector);
}

async function transferPrivate(
  token: Contract,
  wallet: FundedCotiWallet,
  recipient: string,
  amount: bigint,
  label: string,
): Promise<Submitted | undefined> {
  if (amount === 0n) return undefined;
  const input = await encryptFor(wallet, amount, token, "transfer");
  return submit(label, () => token.transfer(recipient, input, { gasLimit: GAS_LIMIT }));
}

async function accrue(
  context: ProbeContext,
  side: 0 | 1,
  lpFee: bigint,
  label: string,
): Promise<Submitted> {
  const inputs = await Promise.all([
    encryptFor(context.primary, 0n, context.probe, "accrue"),
    encryptFor(context.primary, 0n, context.probe, "accrue"),
    encryptFor(context.primary, lpFee, context.probe, "accrue"),
  ]);
  return submit(label, () => context.probe.accrue(
    side,
    inputs[0],
    inputs[1],
    inputs[2],
    { gasLimit: GAS_LIMIT },
  ));
}

async function claim(
  context: ProbeContext,
  wallet: FundedCotiWallet,
  side: 0 | 1,
  label: string,
): Promise<Submitted> {
  const probe = context.probe.connect(wallet) as Contract;
  return submit(label, () => probe.claim(side, { gasLimit: GAS_LIMIT }));
}

async function transferLp(
  context: ProbeContext,
  wallet: FundedCotiWallet,
  recipient: string,
  amount: bigint,
  label: string,
): Promise<Submitted | undefined> {
  if (amount === 0n) return undefined;
  const lpToken = new Contract(
    context.lpTokenAddress,
    PRIVATE_ERC20_TESTNET_ABI,
    wallet,
  );
  return transferPrivate(lpToken, wallet, recipient, amount, label);
}

async function burnShares(
  context: ProbeContext,
  wallet: FundedCotiWallet,
  amount: bigint,
  label: string,
): Promise<Submitted | undefined> {
  if (amount === 0n) return undefined;
  const probe = context.probe.connect(wallet) as Contract;
  const input = await encryptFor(wallet, amount, probe, "burnShares");
  return submit(label, () => probe.burnShares(input, { gasLimit: GAS_LIMIT }));
}

async function waitUntilUnlock(unlockAt: bigint): Promise<void> {
  const startedAt = Date.now();
  while (true) {
    const block = await ethers.provider.getBlock("latest");
    if (!block) throw new Error("latest COTI testnet block is unavailable");
    if (BigInt(block.timestamp) >= unlockAt) return;
    if (Date.now() - startedAt > 120_000) {
      throw new Error("private LP accounting probe lock did not mature");
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

async function expectRejected(label: string, operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch {
    return;
  }
  throw new Error(`${label} unexpectedly succeeded`);
}

async function conservation(
  context: ProbeContext,
  side: 0 | 1,
): Promise<readonly [bigint, bigint, bigint, bigint, bigint, bigint]> {
  const values = await context.probe.requestConservation.staticCall(side);
  return Promise.all([
    decryptPrivateValue256(context.primary, values[0]),
    decryptPrivateValue256(context.primary, values[1]),
    decryptPrivateValue256(context.primary, values[2]),
    decryptPrivateValue256(context.primary, values[3]),
    decryptPrivateValue256(context.primary, values[4]),
    decryptPrivateValue256(context.primary, values[5]),
  ]) as Promise<readonly [bigint, bigint, bigint, bigint, bigint, bigint]>;
}

function requireConservation(
  actual: readonly [bigint, bigint, bigint, bigint, bigint, bigint],
  expectedLiability: bigint,
  expectedShares: bigint,
  label: string,
): void {
  const [rawBalance, activeReserve, protocolFees, lpFeeLiability, totalShares] = actual;
  if (
    rawBalance !== expectedLiability ||
    activeReserve !== 0n ||
    protocolFees !== 0n ||
    lpFeeLiability !== expectedLiability ||
    totalShares !== expectedShares
  ) throw new Error(`${label} conservation diverged`);
}

async function buildContext(
  probeAddress: string,
  spenderAddress: string,
  token0Address: string,
  token1Address: string,
  primary: FundedCotiWallet,
  second: FundedCotiWallet,
): Promise<ProbeContext> {
  const [probeArtifact, lpTokenArtifact, spenderArtifact] = await Promise.all([
    artifacts.readArtifact("PrivateLPAccountingProbe"),
    artifacts.readArtifact("PrivateLPAccountingProbeToken"),
    artifacts.readArtifact("PrivateLPAccountingDelegatedSpenderProbe"),
  ]);
  const probe = new Contract(probeAddress, probeArtifact.abi, primary);
  const lpTokenAddress = ethersLibrary.getAddress(String(await probe.lpToken()));
  const primaryAddress = ethersLibrary.getAddress(await primary.getAddress());
  const secondAddress = ethersLibrary.getAddress(await second.getAddress());
  return Object.freeze({
    probe,
    probeAddress,
    lpToken: new Contract(lpTokenAddress, lpTokenArtifact.abi, primary),
    lpTokenAddress,
    spender: new Contract(spenderAddress, spenderArtifact.abi, primary),
    spenderAddress,
    token0Primary: new Contract(token0Address, PRIVATE_ERC20_TESTNET_ABI, primary),
    token0Second: new Contract(token0Address, PRIVATE_ERC20_TESTNET_ABI, second),
    token1Primary: new Contract(token1Address, PRIVATE_ERC20_TESTNET_ABI, primary),
    token1Second: new Contract(token1Address, PRIVATE_ERC20_TESTNET_ABI, second),
    token0Address,
    token1Address,
    primary,
    second,
    primaryAddress,
    secondAddress,
  });
}

async function recoverActiveProbe(): Promise<void> {
  if (!recoveryJournal || !recoveryWallets) return;
  const [primary, second] = recoveryWallets;
  for (const resource of recoveryJournal.activeResources) {
    if (resource.kind !== "private-lp-accounting-probe") {
      throw new Error(`unsupported private LP recovery resource ${resource.kind}`);
    }
    const spenderAddress = String(resource.metadata.spenderAddress ?? "");
    const token0Address = String(resource.metadata.token0Address ?? "");
    const token1Address = String(resource.metadata.token1Address ?? "");
    if (
      !ethersLibrary.isAddress(spenderAddress) ||
      !ethersLibrary.isAddress(token0Address) ||
      !ethersLibrary.isAddress(token1Address)
    ) throw new Error("private LP recovery metadata is invalid");
    const context = await buildContext(
      resource.address,
      spenderAddress,
      token0Address,
      token1Address,
      primary,
      second,
    );
    const recoveryHashes: string[] = [];
    const lockId = String(resource.metadata.lockId ?? "");
    if (/^0x[0-9a-fA-F]{64}$/u.test(lockId)) {
      const info = await context.lpToken.lockInfo(lockId);
      if (Boolean(info.active)) {
        if (Boolean(info.permanent)) throw new Error("recovery found a permanent probe lock");
        await waitUntilUnlock(BigInt(info.unlockAt));
        const unlocked = await submit(
          "recover private LP timed lock",
          () => context.probe.unlockShares(lockId, { gasLimit: GAS_LIMIT }),
        );
        recoveryHashes.push(unlocked.hash);
      }
    }
    for (const side of [0, 1] as const) {
      for (const [wallet, label] of [
        [primary, "primary"],
        [second, "second"],
      ] as const) {
        try {
          const recovered = await claim(
            context,
            wallet,
            side,
            `recover ${label} token${side} LP claim`,
          );
          recoveryHashes.push(recovered.hash);
        } catch {
          // A zero-value PrivateERC20 transfer may reject. A later exact raw-balance
          // check determines whether any real fee liability remains stranded.
        }
      }
    }
    const secondShares = await privateBalance(
      new Contract(context.lpTokenAddress, PRIVATE_ERC20_TESTNET_ABI, second),
      second,
      context.secondAddress,
    );
    const moved = await transferLp(
      context,
      second,
      context.primaryAddress,
      secondShares,
      "recover second LP shares",
    );
    if (moved) recoveryHashes.push(moved.hash);
    const primaryShares = await privateBalance(
      new Contract(context.lpTokenAddress, PRIVATE_ERC20_TESTNET_ABI, primary),
      primary,
      context.primaryAddress,
    );
    const burned = await burnShares(
      context,
      primary,
      primaryShares,
      "recover primary LP shares",
    );
    if (burned) recoveryHashes.push(burned.hash);
    for (const [tokenPrimary, tokenSecond, initialKey, label] of [
      [context.token0Primary, context.token0Second, "secondToken0Initial", "token0"],
      [context.token1Primary, context.token1Second, "secondToken1Initial", "token1"],
    ] as const) {
      const initial = BigInt(String(resource.metadata[initialKey] ?? "0"));
      const current = await privateBalance(tokenSecond, second, context.secondAddress);
      if (current > initial) {
        const restored = await transferPrivate(
          tokenSecond,
          second,
          context.primaryAddress,
          current - initial,
          `recover ${label} funded balance`,
        );
        if (restored) recoveryHashes.push(restored.hash);
      }
      const probeBalance = await privateBalance(tokenPrimary, primary, context.probeAddress);
      if (probeBalance !== 0n) throw new Error(`recovery left ${label} in the probe`);
    }
    recoveryJournal.markRecovered(
      resource.id,
      recoveryHashes.length === 0 ? [resource.creationTransactionHash] : recoveryHashes,
    );
  }
}

async function main(): Promise<void> {
  const sourceCommit = await assertCleanCommittedSource();
  const primaryKey = requiredPrivateKey("COTI_TESTNET_PRIVATE_KEY");
  const primaryAes = requiredAesKey("COTI_AES_KEY");
  const secondKey = requiredPrivateKey("COTI_SECOND_LP_PRIVATE_KEY");
  const secondAes = requiredAesKey("COTI_SECOND_LP_AES_KEY");
  const configuredToken0 = requiredAddress("COTI_TOKEN0");
  const configuredToken1 = requiredAddress("COTI_TOKEN1");
  if (configuredToken0 === configuredToken1) throw new Error("private probe tokens must differ");

  const network = await ethers.provider.getNetwork();
  if (network.chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(`expected COTI testnet ${EXPECTED_CHAIN_ID}, received ${network.chainId}`);
  }
  const primary = new FundedCotiWallet(primaryKey, ethers.provider, { aesKey: primaryAes });
  primary.setAesKey(primaryAes);
  const second = new FundedCotiWallet(secondKey, ethers.provider, { aesKey: secondAes });
  second.setAesKey(secondAes);
  const primaryAddress = ethersLibrary.getAddress(await primary.getAddress());
  const secondAddress = ethersLibrary.getAddress(await second.getAddress());
  if (primaryAddress === secondAddress) throw new Error("private probe identities must differ");

  recoveryJournal = openFundedRecoveryJournal(primaryKey, {
    runner: "private-lp-accounting-probe",
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
  recoveryWallets = [primary, second];
  const unresolved = await journal().reconcileTransactions(ethers.provider);
  if (unresolved.length > 0) {
    throw new Error("private LP funded probe has an unresolved transaction; do not retry");
  }
  await recoverPrivateAllowanceObligations({
    journal: journal(),
    wallets: [primary, second],
    overrides: { gasLimit: GAS_LIMIT },
    submit,
  });
  await recoverActiveProbe();
  if (journal().runStatus === "passed") {
    console.log("Private LP accounting funded probe already passed for this source.");
    return;
  }
  if (journal().transactions.length > 0 || journal().resources.length > 0) {
    throw new Error("prior private LP probe evidence requires operator review before rerun");
  }

  const token0Primary = new Contract(configuredToken0, PRIVATE_ERC20_TESTNET_ABI, primary);
  const token0Second = new Contract(configuredToken0, PRIVATE_ERC20_TESTNET_ABI, second);
  const token1Primary = new Contract(configuredToken1, PRIVATE_ERC20_TESTNET_ABI, primary);
  const token1Second = new Contract(configuredToken1, PRIVATE_ERC20_TESTNET_ABI, second);
  const [primaryToken0Initial, primaryToken1Initial, secondToken0Initial, secondToken1Initial] =
    await Promise.all([
      privateBalance(token0Primary, primary, primaryAddress),
      privateBalance(token1Primary, primary, primaryAddress),
      privateBalance(token0Second, second, secondAddress),
      privateBalance(token1Second, second, secondAddress),
    ]);
  if (primaryToken0Initial < FEE0_TOTAL || primaryToken1Initial < FEE1_TOTAL) {
    throw new Error("primary funded identity lacks the tiny private-token probe budget");
  }

  const probeDeployment = await deploy(
    primary,
    "PrivateLPAccountingProbe",
    [configuredToken0, configuredToken1],
  );
  const spenderDeployment = await deploy(
    primary,
    "PrivateLPAccountingDelegatedSpenderProbe",
    [],
  );
  const probeAddress = ethersLibrary.getAddress(await probeDeployment.contract.getAddress());
  const spenderAddress = ethersLibrary.getAddress(await spenderDeployment.contract.getAddress());
  const context = await buildContext(
    probeAddress,
    spenderAddress,
    configuredToken0,
    configuredToken1,
    primary,
    second,
  );
  journal().recordResource({
    id: "private-lp-accounting-probe",
    kind: "private-lp-accounting-probe",
    address: probeAddress,
    creationTransactionHash: probeDeployment.transaction.hash,
    metadata: {
      spenderAddress,
      lpTokenAddress: context.lpTokenAddress,
      token0Address: configuredToken0,
      token1Address: configuredToken1,
      primaryToken0Initial: primaryToken0Initial.toString(),
      primaryToken1Initial: primaryToken1Initial.toString(),
      secondToken0Initial: secondToken0Initial.toString(),
      secondToken1Initial: secondToken1Initial.toString(),
    },
  });

  await setRecoverablePrivateAllowance({
    journal: journal(),
    wallet: primary,
    token: token0Primary,
    tokenAddress: configuredToken0,
    spender: probeAddress,
    amount: FEE0_TOTAL,
    label: "private LP probe token0 approval",
    overrides: { gasLimit: GAS_LIMIT },
    submit,
  });
  await setRecoverablePrivateAllowance({
    journal: journal(),
    wallet: primary,
    token: token1Primary,
    tokenAddress: configuredToken1,
    spender: probeAddress,
    amount: FEE1_TOTAL,
    label: "private LP probe token1 approval",
    overrides: { gasLimit: GAS_LIMIT },
    submit,
  });

  const gas: Record<string, string> = {
    probeDeployment: probeDeployment.transaction.gasUsed.toString(),
    spenderDeployment: spenderDeployment.transaction.gasUsed.toString(),
  };
  const mintInput = await encryptFor(primary, TOTAL_SHARES, context.probe, "mintShares");
  const mint = await submit(
    "mint private LP probe shares",
    () => context.probe.mintShares(mintInput, { gasLimit: GAS_LIMIT }),
  );
  gas.mint = mint.gasUsed.toString();

  gas.accrue0BeforeTransfer = (
    await accrue(context, 0, 1_000n, "accrue token0 fees before transfer")
  ).gasUsed.toString();
  const direct = await transferLp(
    context,
    primary,
    secondAddress,
    DIRECT_TRANSFER,
    "direct private LP transfer",
  );
  gas.directTransfer = direct!.gasUsed.toString();
  gas.accrue0AfterTransfer = (
    await accrue(context, 0, 1_000n, "accrue token0 fees after direct transfer")
  ).gasUsed.toString();
  gas.accrue1BeforeDelegation = (
    await accrue(context, 1, 2_000n, "accrue token1 fees before delegated transfer")
  ).gasUsed.toString();

  const lpPrimary = new Contract(context.lpTokenAddress, PRIVATE_ERC20_TESTNET_ABI, primary);
  await setRecoverablePrivateAllowance({
    journal: journal(),
    wallet: primary,
    token: lpPrimary,
    tokenAddress: context.lpTokenAddress,
    spender: spenderAddress,
    amount: DELEGATED_TRANSFER,
    label: "private LP delegated-transfer approval",
    overrides: { gasLimit: GAS_LIMIT },
    submit,
  });
  const delegatedInput = await encryptFor(
    primary,
    DELEGATED_TRANSFER,
    context.spender,
    "transferFrom",
  );
  const delegated = await submit(
    "delegated private LP transfer",
    () => context.spender.transferFrom(
      context.lpTokenAddress,
      primaryAddress,
      secondAddress,
      delegatedInput,
      { gasLimit: GAS_LIMIT },
    ),
  );
  gas.delegatedTransfer = delegated.gasUsed.toString();
  await setRecoverablePrivateAllowance({
    journal: journal(),
    wallet: primary,
    token: lpPrimary,
    tokenAddress: context.lpTokenAddress,
    spender: spenderAddress,
    amount: 0n,
    label: "private LP delegated-transfer cleanup",
    overrides: { gasLimit: GAS_LIMIT },
    submit,
  });

  const block = await ethers.provider.getBlock("latest");
  if (!block) throw new Error("latest COTI testnet block is unavailable");
  const unlockAt = BigInt(block.timestamp + LOCK_SECONDS);
  const lockId = ethersLibrary.keccak256(
    ethersLibrary.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "uint256"],
      [probeAddress, primaryAddress, 0n],
    ),
  );
  journal().updateResourceMetadata("private-lp-accounting-probe", { lockId });
  const lockInput = await encryptFor(primary, LOCKED_SHARES, context.probe, "lockShares");
  const locked = await submit(
    "lock private LP principal",
    () => context.probe.lockShares(
      lockInput,
      unlockAt,
      false,
      { gasLimit: GAS_LIMIT },
    ),
  );
  gas.lock = locked.gasUsed.toString();

  gas.accrue0WhileLocked = (
    await accrue(context, 0, 1_000n, "accrue token0 fees while principal is locked")
  ).gasUsed.toString();
  gas.accrue1WhileLocked = (
    await accrue(context, 1, 1_000n, "accrue token1 fees while principal is locked")
  ).gasUsed.toString();

  const blockedTransferInput = await encryptFor(primary, 101n, lpPrimary, "transfer");
  await expectRejected(
    "locked principal transfer",
    () => lpPrimary.transfer.staticCall(secondAddress, blockedTransferInput),
  );
  const blockedBurnInput = await encryptFor(primary, 101n, context.probe, "burnShares");
  await expectRejected(
    "locked principal burn",
    () => context.probe.burnShares.staticCall(blockedBurnInput),
  );

  requireConservation(await conservation(context, 0), FEE0_TOTAL, TOTAL_SHARES, "token0");
  requireConservation(await conservation(context, 1), FEE1_TOTAL, TOTAL_SHARES, "token1");

  const primary0BeforeClaim = await privateBalance(token0Primary, primary, primaryAddress);
  const second0BeforeClaim = await privateBalance(token0Second, second, secondAddress);
  const primaryClaim0 = await claim(context, primary, 0, "consume primary token0 LP claim");
  const secondClaim0 = await claim(context, second, 0, "consume second token0 LP claim");
  gas.primaryClaim0 = primaryClaim0.gasUsed.toString();
  gas.secondClaim0 = secondClaim0.gasUsed.toString();
  const [primary0AfterClaim, second0AfterClaim] = await Promise.all([
    privateBalance(token0Primary, primary, primaryAddress),
    privateBalance(token0Second, second, secondAddress),
  ]);
  if (
    primary0AfterClaim - primary0BeforeClaim !== 2_200n ||
    second0AfterClaim - second0BeforeClaim !== 800n
  ) throw new Error("token0 claims do not match settled transfer ownership");
  const repeatBalance = primary0AfterClaim;
  const repeatedClaim = await claim(context, primary, 0, "repeat consumed token0 claim");
  gas.repeatedClaim = repeatedClaim.gasUsed.toString();
  if (await privateBalance(token0Primary, primary, primaryAddress) !== repeatBalance) {
    throw new Error("repeated claim double-paid token0 fees");
  }
  requireConservation(await conservation(context, 0), 0n, TOTAL_SHARES, "claimed token0");

  await waitUntilUnlock(unlockAt);
  const unlocked = await submit(
    "unlock timed private LP principal",
    () => context.probe.unlockShares(lockId, { gasLimit: GAS_LIMIT }),
  );
  gas.unlock = unlocked.gasUsed.toString();
  const movedBack = await transferLp(
    context,
    second,
    primaryAddress,
    500n,
    "consolidate private LP shares after unlock",
  );
  gas.consolidate = movedBack!.gasUsed.toString();
  const fullExit = await burnShares(
    context,
    primary,
    TOTAL_SHARES,
    "burn all private LP shares",
  );
  gas.fullExit = fullExit!.gasUsed.toString();
  requireConservation(await conservation(context, 1), FEE1_TOTAL, 0n, "post-exit token1");

  const primary1BeforeClaim = await privateBalance(token1Primary, primary, primaryAddress);
  const second1BeforeClaim = await privateBalance(token1Second, second, secondAddress);
  const primaryClaim1 = await claim(context, primary, 1, "consume post-exit primary token1 claim");
  const secondClaim1 = await claim(context, second, 1, "consume post-exit second token1 claim");
  gas.primaryClaim1 = primaryClaim1.gasUsed.toString();
  gas.secondClaim1 = secondClaim1.gasUsed.toString();
  const [primary1AfterClaim, second1AfterClaim] = await Promise.all([
    privateBalance(token1Primary, primary, primaryAddress),
    privateBalance(token1Second, second, secondAddress),
  ]);
  if (
    primary1AfterClaim - primary1BeforeClaim !== 1_900n ||
    second1AfterClaim - second1BeforeClaim !== 1_100n
  ) throw new Error("post-exit token1 claims were not preserved exactly");

  const reinitInput = await encryptFor(second, TOTAL_SHARES, context.probe.connect(second) as Contract, "mintShares");
  const reinitialized = await submit(
    "reinitialize private LP generation",
    () => (context.probe.connect(second) as Contract).mintShares(
      reinitInput,
      { gasLimit: GAS_LIMIT },
    ),
  );
  gas.reinitialize = reinitialized.gasUsed.toString();
  const reinitConservation0 = await conservation(context, 0);
  const reinitConservation1 = await conservation(context, 1);
  if (reinitConservation0[5] !== 0n || reinitConservation1[5] !== 0n) {
    throw new Error("an exact prior generation unexpectedly retired nonzero remainder");
  }
  const reinitBurn = await burnShares(
    context,
    second,
    TOTAL_SHARES,
    "burn reinitialized private LP generation",
  );
  gas.reinitializeBurn = reinitBurn!.gasUsed.toString();

  const restored0 = await transferPrivate(
    token0Second,
    second,
    primaryAddress,
    800n,
    "restore token0 funded balance",
  );
  const restored1 = await transferPrivate(
    token1Second,
    second,
    primaryAddress,
    1_100n,
    "restore token1 funded balance",
  );
  gas.restoreToken0 = restored0!.gasUsed.toString();
  gas.restoreToken1 = restored1!.gasUsed.toString();

  await recoverPrivateAllowanceObligations({
    journal: journal(),
    wallets: [primary, second],
    overrides: { gasLimit: GAS_LIMIT },
    submit,
  });
  const [primaryToken0Final, primaryToken1Final, secondToken0Final, secondToken1Final] =
    await Promise.all([
      privateBalance(token0Primary, primary, primaryAddress),
      privateBalance(token1Primary, primary, primaryAddress),
      privateBalance(token0Second, second, secondAddress),
      privateBalance(token1Second, second, secondAddress),
    ]);
  if (
    primaryToken0Final !== primaryToken0Initial ||
    primaryToken1Final !== primaryToken1Initial ||
    secondToken0Final !== secondToken0Initial ||
    secondToken1Final !== secondToken1Initial
  ) throw new Error("funded private-token balances were not restored exactly");
  requireConservation(await conservation(context, 0), 0n, 0n, "final token0");
  requireConservation(await conservation(context, 1), 0n, 0n, "final token1");

  journal().markRecovered("private-lp-accounting-probe", [reinitBurn!.hash]);
  journal().markRun("passed");
  console.log(`privateLpAccountingProbeResult=${JSON.stringify({
    sourceCommit,
    chainId: network.chainId.toString(),
    probe: probeAddress,
    lpToken: context.lpTokenAddress,
    delegatedSpender: spenderAddress,
    exactFundedBalancesRestored: true,
    gas,
  })}`);
}

void main().catch(async (error: unknown) => {
  if (error instanceof UnknownBroadcastOutcomeError) {
    recoveryJournal?.markRun("failed");
    console.error(
      `Private LP accounting funded probe paused with an uncertain broadcast: ` +
        `stage=${stage} ${safeTestnetErrorSummary(error)}; do not retry until reconciled.`,
    );
    process.exitCode = 1;
    return;
  }
  let reportedError = error;
  try {
    if (recoveryJournal) {
      await recoverPrivateAllowanceObligations({
        journal: recoveryJournal,
        wallets: recoveryWallets ?? [],
        overrides: { gasLimit: GAS_LIMIT },
        submit,
      });
      await recoverActiveProbe();
      recoveryJournal.markRun("failed");
    }
  } catch (recoveryError) {
    recoveryJournal?.markRun("recovery-failed");
    reportedError = new AggregateError(
      [error, recoveryError],
      "private LP probe and recovery both failed",
    );
  }
  console.error(
    `Private LP accounting funded probe failed: stage=${stage} ` +
      safeTestnetErrorSummary(reportedError),
  );
  process.exitCode = 1;
});
