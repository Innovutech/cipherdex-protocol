import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { Contract, type BaseContract, type TransactionReceipt } from "ethers";
import { artifacts, ethers } from "../hardhat/runtime.js";
import * as ethersLibrary from "ethers";

import { PRIVATE_ERC20_TESTNET_ABI } from "./coti-testnet-abi";
import { decryptPrivateValue256 } from "./coti-testnet-values";
import { confidentialLiquidityBounds, minimumWithSlippage } from "./testnet-slippage";
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
  recoverPrivateAllowanceObligations,
  setRecoverablePrivateAllowance,
} from "./funded-private-allowance";
import {
  verifyDeployedRuntimeArtifact,
  verifyDeployedRuntimeArtifactWithProvenance,
} from "./runtime-artifact";
import {
  trustedGitArguments,
  trustedGitEnvironment,
  trustedGitExecutable,
} from "./trusted-git";

const execFileAsync = promisify(execFile);
const SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}$/iu;
const EXPECTED_CHAIN_ID = 7_082_400n;
const GAS_LIMIT = 30_000_000n;
const CREATE_POOL_GAS_LIMIT = 15_000_000n;
const SWAP_COUNT = 6;
const FEE_BPS = 30n;
const ZERO = 0n;
const OBSERVABLE_ROUTER_RUNTIME_CODEHASH =
  "0xedc7d19bbe720d6e1265e935ee9a30f3dc68b07f94821ea12b715fba43b9e46e";

let stage = "configuration";
let recoveryJournal: FundedRecoveryJournal | undefined;

type MinedEvidence = Readonly<{
  transactionHash: string;
  receipt: TransactionReceipt;
}>;

type PoolModel = {
  reserve0: bigint;
  reserve1: bigint;
};

function journal(): FundedRecoveryJournal {
  if (!recoveryJournal) throw new Error("observable test journal is unavailable");
  return recoveryJournal;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredPrivateKey(name: string): string {
  const value = required(name);
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${name} must be a 32-byte private key`);
  }
  return value;
}

function requiredAesKey(name: string): string {
  const value = required(name);
  if (!/^[0-9a-fA-F]{32}$/.test(value)) {
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

function requiredInteger(name: string, minimum: number, maximum: number): number {
  const value = required(name);
  if (!/^\d+$/u.test(value)) throw new Error(`${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} is outside the supported range`);
  }
  return parsed;
}

function requiredAmount(name: string): bigint {
  const value = required(name);
  if (!/^\d+$/u.test(value) || BigInt(value) <= 0n) {
    throw new Error(`${name} must be a positive integer`);
  }
  return BigInt(value);
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
    throw new Error("observable funded test requires a clean committed source revision");
  }
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
  gasLimit = GAS_LIMIT,
): Promise<BaseContract> {
  const factory = await ethers.getContractFactory(contractName, wallet);
  let contract: BaseContract | undefined;
  const evidence = await submit(`${contractName} deployment`, async () => {
    contract = await factory.deploy(...args, { gasLimit });
    const transaction = contract.deploymentTransaction();
    if (!transaction) throw new Error(`${contractName} deployment transaction unavailable`);
    return transaction;
  });
  if (!contract) throw new Error(`${contractName} deployment handle unavailable`);
  const address = await contract.getAddress();
  if (
    evidence.receipt.contractAddress &&
    ethersLibrary.getAddress(evidence.receipt.contractAddress) !==
      ethersLibrary.getAddress(address)
  ) throw new Error(`${contractName} deployment address mismatch`);
  await verifyDeployedRuntimeArtifactWithProvenance(
    contractName,
    address,
    ethers.provider,
  );
  return contract;
}

async function privateBalance(
  token: Contract,
  wallet: FundedCotiWallet,
  account: string,
): Promise<bigint> {
  return decryptPrivateValue256(
    wallet,
    await token.balanceOf.staticCall(account),
  );
}

function modeledSwap(model: PoolModel, amountIn: bigint): bigint {
  const netAmountIn = amountIn * (10_000n - FEE_BPS) / 10_000n;
  const totalFee = amountIn - netAmountIn;
  const protocolFee = totalFee / 6n;
  if (netAmountIn <= 0n || protocolFee <= 0n) {
    throw new Error("configured swap is too small for confidential fee rounding");
  }
  const denominator = model.reserve0 + netAmountIn;
  const invariant = model.reserve0 * model.reserve1;
  const retained = (invariant + denominator - 1n) / denominator;
  const output = model.reserve1 - retained;
  if (output <= 0n) throw new Error("modeled swap output is zero");
  model.reserve0 += amountIn - protocolFee;
  model.reserve1 -= output;
  return output;
}

function normalizedPriceX18(
  amount0: bigint,
  decimals0: number,
  amount1: bigint,
  decimals1: number,
): bigint {
  const normalized0 = amount0 * 10n ** BigInt(18 - decimals0);
  const normalized1 = amount1 * 10n ** BigInt(18 - decimals1);
  return normalized1 * 10n ** 18n / normalized0;
}

function deadline(): bigint {
  return BigInt(Math.floor(Date.now() / 1_000) + 900);
}

async function waitUntil(timestamp: bigint): Promise<void> {
  while (true) {
    const block = await ethers.provider.getBlock("latest");
    if (!block) throw new Error("latest testnet block unavailable");
    if (BigInt(block.timestamp) >= timestamp) return;
    const delayMs = Number(timestamp - BigInt(block.timestamp)) * 1_000;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(delayMs, 10_000)));
  }
}

async function main(): Promise<void> {
  const sourceCommit = await assertCleanCommittedSource();
  const privateKey = requiredPrivateKey("COTI_TESTNET_PRIVATE_KEY");
  const aesKey = requiredAesKey("COTI_AES_KEY");
  const tokenAAddress = requiredAddress("COTI_TOKEN0");
  const tokenBAddress = requiredAddress("COTI_TOKEN1");
  const decimalsA = requiredInteger("COTI_TOKEN0_DECIMALS", 0, 18);
  const decimalsB = requiredInteger("COTI_TOKEN1_DECIMALS", 0, 18);
  const liquidityA = requiredAmount("COTI_LIQUIDITY_AMOUNT0");
  const liquidityB = requiredAmount("COTI_LIQUIDITY_AMOUNT1");
  const swapAmount = requiredAmount("COTI_TEST_AMOUNT_IN");
  const existingFactoryAddress = requiredAddress("COTI_FACTORY");
  const existingVaultAddress = requiredAddress("COTI_FEE_VAULT");

  const network = await ethers.provider.getNetwork();
  if (network.chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(`expected COTI testnet ${EXPECTED_CHAIN_ID}`);
  }
  const wallet = new FundedCotiWallet(privateKey, ethers.provider, { aesKey });
  wallet.setAesKey(aesKey);
  const owner = ethersLibrary.getAddress(await wallet.getAddress());
  recoveryJournal = openFundedRecoveryJournal(privateKey, {
    runner: "observable-confidential",
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
  const unresolved = await journal().reconcileTransactions(ethers.provider);
  if (unresolved.length > 0) {
    throw new Error("observable funded test has an unresolved transaction; do not retry");
  }
  await recoverPrivateAllowanceObligations({
    journal: journal(),
    wallets: [wallet],
    overrides: { gasLimit: GAS_LIMIT },
    submit,
  });
  if (journal().runStatus === "passed") {
    console.log("Observable confidential funded test already passed for this source.");
    return;
  }
  if (journal().transactions.length > 0 || journal().resources.length > 0) {
    throw new Error("observable funded test has incomplete prior state; recover before rerun");
  }

  await Promise.all([
    verifyDeployedRuntimeArtifact("ConfidentialCPMMFactory", existingFactoryAddress),
    verifyDeployedRuntimeArtifact("CipherDEXFeeVault", existingVaultAddress),
  ]);
  const existingFactory = await ethers.getContractAt(
    "ConfidentialCPMMFactory",
    existingFactoryAddress,
    wallet,
  );
  const existingVault = await ethers.getContractAt(
    "CipherDEXFeeVault",
    existingVaultAddress,
    wallet,
  );
  const lpTokenFactoryAddress = ethersLibrary.getAddress(
    String(await existingFactory.lpTokenFactory()),
  );
  const beneficiary = ethersLibrary.getAddress(String(await existingVault.beneficiary()));
  await verifyDeployedRuntimeArtifact("PrivateLPTokenFactory", lpTokenFactoryAddress);

  const strategyArtifact = await artifacts.readArtifact(
    "ObservableConfidentialLaunchInitializationStrategy",
  );
  const routerArtifact = await artifacts.readArtifact(
    "ObservableConfidentialBestExecutionRouter",
  );
  const strategyCodehash = ethersLibrary.keccak256(strategyArtifact.deployedBytecode);
  const routerCodehash = ethersLibrary.keccak256(routerArtifact.deployedBytecode);
  if (routerCodehash !== OBSERVABLE_ROUTER_RUNTIME_CODEHASH) {
    throw new Error(`observable router artifact hash mismatch: ${routerCodehash}`);
  }

  const vault = await deploy(wallet, "CipherDEXConfidentialFeeVault", [beneficiary]);
  const poolDeployer = await deploy(wallet, "ObservableConfidentialCPMMDeployer", []);
  const registry = await deploy(
    wallet,
    "ObservableConfidentialInitializationStrategyRegistry",
    [[strategyCodehash]],
  );
  const poolDeployerCodehash = ethersLibrary.keccak256(
    await ethers.provider.getCode(await poolDeployer.getAddress()),
  );
  const registryCodehash = ethersLibrary.keccak256(
    await ethers.provider.getCode(await registry.getAddress()),
  );
  const factory = await deploy(wallet, "ObservableConfidentialCPMMFactory", [
    await vault.getAddress(),
    lpTokenFactoryAddress,
    await poolDeployer.getAddress(),
    poolDeployerCodehash,
    await registry.getAddress(),
    registryCodehash,
  ]);
  const factoryAddress = await factory.getAddress();
  await submit("observable vault binding", () =>
    vault.getFunction("setConfidentialFactory")(
      factoryAddress,
      { gasLimit: GAS_LIMIT },
    ));
  await submit("observable deployer binding", () =>
    poolDeployer.getFunction("bindFactory")(
      factoryAddress,
      { gasLimit: GAS_LIMIT },
    ));
  await submit("observable registry binding", () =>
    registry.getFunction("bindFactory")(
      factoryAddress,
      { gasLimit: GAS_LIMIT },
    ));
  const strategy = await deploy(
    wallet,
    "ObservableConfidentialLaunchInitializationStrategy",
    [factoryAddress, await registry.getAddress()],
  );
  const strategyAddress = await strategy.getAddress();
  await submit("observable strategy registration", () =>
    registry.getFunction("registerInitializationStrategy")(
      strategyAddress,
      { gasLimit: GAS_LIMIT },
    ));
  await submit("observable registry finalization", () =>
    registry.getFunction("finalize")({ gasLimit: GAS_LIMIT }));
  const router = await deploy(
    wallet,
    "ObservableConfidentialBestExecutionRouter",
    [factoryAddress],
  );
  const routerAddress = await router.getAddress();
  await submit("observable router binding", () =>
    factory.getFunction("setBestExecutionRouter")(
      routerAddress,
      { gasLimit: GAS_LIMIT },
    ));

  const tokenA = new Contract(tokenAAddress, PRIVATE_ERC20_TESTNET_ABI, wallet);
  const tokenB = new Contract(tokenBAddress, PRIVATE_ERC20_TESTNET_ABI, wallet);
  const [actualDecimalsA, actualDecimalsB, balanceA, balanceB] = await Promise.all([
    tokenA.decimals(),
    tokenB.decimals(),
    privateBalance(tokenA, wallet, owner),
    privateBalance(tokenB, wallet, owner),
  ]);
  if (Number(actualDecimalsA) !== decimalsA || Number(actualDecimalsB) !== decimalsB) {
    throw new Error("configured private token decimals changed");
  }
  const [token0Address, token1Address, decimals0, decimals1, amount0, amount1] =
    tokenAAddress.toLowerCase() < tokenBAddress.toLowerCase()
      ? [tokenAAddress, tokenBAddress, decimalsA, decimalsB, liquidityA, liquidityB]
      : [tokenBAddress, tokenAAddress, decimalsB, decimalsA, liquidityB, liquidityA];
  const balance0 = token0Address === tokenAAddress ? balanceA : balanceB;
  const balance1 = token1Address === tokenBAddress ? balanceB : balanceA;
  if (
    amount0 + swapAmount * BigInt(SWAP_COUNT) > balance0 ||
    amount1 > balance1
  ) throw new Error("observable funded amounts exceed the configured private balance");
  const initialReference = normalizedPriceX18(amount0, decimals0, amount1, decimals1);
  const create = await submit("observable pool creation", () =>
    factory.getFunction("createPool")(
      token0Address,
      token1Address,
      decimals0,
      decimals1,
      Number(FEE_BPS),
      { gasLimit: CREATE_POOL_GAS_LIMIT },
    ));
  const key = await factory.getFunction("poolKey").staticCall(
    token0Address,
    token1Address,
    decimals0,
    decimals1,
    Number(FEE_BPS),
    ethersLibrary.ZeroAddress,
  );
  const poolAddress = ethersLibrary.getAddress(
    String(await factory.getFunction("getPool").staticCall(key)),
  );
  await verifyDeployedRuntimeArtifact("ObservableConfidentialCPMM", poolAddress);
  journal().recordResource({
    id: "observable-pool",
    kind: "confidential-pool",
    address: poolAddress,
    creationTransactionHash: create.transactionHash,
    metadata: {
      factoryAddress,
      token0Address,
      token1Address,
      decimals0,
      decimals1,
      feeBps: Number(FEE_BPS),
    },
  });

  const pool = await ethers.getContractAt("ObservableConfidentialCPMM", poolAddress, wallet);
  const token0 = token0Address === tokenAAddress ? tokenA : tokenB;
  const token1 = token1Address === tokenBAddress ? tokenB : tokenA;
  await setRecoverablePrivateAllowance({
    journal: journal(), wallet, token: token0, tokenAddress: token0Address,
    spender: poolAddress, amount: amount0, label: "observable token0 liquidity approval",
    overrides: { gasLimit: GAS_LIMIT }, submit,
  });
  await setRecoverablePrivateAllowance({
    journal: journal(), wallet, token: token1, tokenAddress: token1Address,
    spender: poolAddress, amount: amount1, label: "observable token1 liquidity approval",
    overrides: { gasLimit: GAS_LIMIT }, submit,
  });
  const addSelector = pool.interface.getFunction("initializeLiquidity")!.selector;
  const bounds = confidentialLiquidityBounds(amount0, decimals0, amount1, decimals1, false);
  const encryptedAdd = await Promise.all([
    wallet.encryptValue256(amount0, poolAddress, addSelector),
    wallet.encryptValue256(amount1, poolAddress, addSelector),
    wallet.encryptValue256(bounds.minShares, poolAddress, addSelector),
    wallet.encryptValue256(bounds.minPriceX18, poolAddress, addSelector),
    wallet.encryptValue256(bounds.maxPriceX18, poolAddress, addSelector),
  ]);
  const initialization = await submit("observable pool initialization", () =>
    pool.initializeLiquidity(
      ...encryptedAdd,
      initialReference,
      deadline(),
      { gasLimit: GAS_LIMIT },
    ));
  await setRecoverablePrivateAllowance({
    journal: journal(), wallet, token: token0, tokenAddress: token0Address,
    spender: poolAddress, amount: ZERO, label: "observable token0 liquidity cleanup",
    overrides: { gasLimit: GAS_LIMIT }, submit,
  });
  await setRecoverablePrivateAllowance({
    journal: journal(), wallet, token: token1, tokenAddress: token1Address,
    spender: poolAddress, amount: ZERO, label: "observable token1 liquidity cleanup",
    overrides: { gasLimit: GAS_LIMIT }, submit,
  });
  if (
    await pool.publicObservationSequence() !== 1n ||
    await pool.publicPriceBucketX18() === 0n ||
    await pool.hasPendingObservation()
  ) throw new Error("initial observable price publication is invalid");

  const totalSwapInput = swapAmount * BigInt(SWAP_COUNT);
  await setRecoverablePrivateAllowance({
    journal: journal(), wallet, token: token0, tokenAddress: token0Address,
    spender: poolAddress, amount: totalSwapInput, label: "observable swap approval",
    overrides: { gasLimit: GAS_LIMIT }, submit,
  });
  const model: PoolModel = { reserve0: amount0, reserve1: amount1 };
  const swapGas: string[] = [];
  for (let index = 0; index < SWAP_COUNT; index++) {
    if (index === 2 || index === 5) {
      await waitUntil(await pool.lastObservationClosedAt() + 120n);
      if (!(await pool.observationDueForNextSwap())) {
        throw new Error(`swap ${index + 1} was not marked observation-due`);
      }
    }
    const modeledOutput = modeledSwap(model, swapAmount);
    const minimumOut = minimumWithSlippage(modeledOutput);
    const selector = pool.interface.getFunction("swapExactInput")!.selector;
    const [encryptedInput, encryptedMinimum] = await Promise.all([
      wallet.encryptValue256(swapAmount, poolAddress, selector),
      wallet.encryptValue256(minimumOut, poolAddress, selector),
    ]);
    const evidence = await submit(`observable swap ${index + 1}`, () =>
      pool.swapExactInput(
        encryptedInput,
        encryptedMinimum,
        true,
        deadline(),
        { gasLimit: GAS_LIMIT },
      ));
    swapGas.push(evidence.receipt.gasUsed.toString());
    if (index < 2 && await pool.publicObservationSequence() !== 1n) {
      throw new Error("non-closing swap unexpectedly published a price");
    }
    if (index === 2 && (
      !(await pool.hasPendingObservation()) ||
      await pool.publicObservationSequence() !== 1n
    )) throw new Error("first epoch did not remain encrypted and pending");
  }
  await setRecoverablePrivateAllowance({
    journal: journal(), wallet, token: token0, tokenAddress: token0Address,
    spender: poolAddress, amount: ZERO, label: "observable swap allowance cleanup",
    overrides: { gasLimit: GAS_LIMIT }, submit,
  });
  if (
    await pool.publicObservationSequence() !== 2n ||
    await pool.publicObservationActivityCount() !== 3n ||
    !(await pool.hasPendingObservation()) ||
    await pool.publicObservationAt() >= await pool.publicObservationPublishedAt()
  ) throw new Error("delayed observable publication is invalid");

  const shares = await decryptPrivateValue256(wallet, await pool.myShares());
  if (shares <= 0n) throw new Error("observable LP shares are unavailable for cleanup");
  const removeSelector = pool.interface.getFunction("removeLiquidity")!.selector;
  const encryptedRemove = await Promise.all([
    wallet.encryptValue256(shares, poolAddress, removeSelector),
    wallet.encryptValue256(1n, poolAddress, removeSelector),
    wallet.encryptValue256(1n, poolAddress, removeSelector),
  ]);
  const exit = await submit("observable full liquidity exit", () =>
    pool.removeLiquidity(
      ...encryptedRemove,
      deadline(),
      { gasLimit: GAS_LIMIT },
    ));
  if (
    await pool.initialized() ||
    await pool.initialPriceReferenceX18() !== 0n ||
    await pool.publicPriceBucketX18() !== 0n ||
    await pool.hasPendingObservation()
  ) throw new Error("observable full exit did not clear current market data");
  journal().markRecovered("observable-pool", [exit.transactionHash]);
  journal().markRun("passed");

  console.log(`observableConfidentialResult=${JSON.stringify({
    sourceCommit,
    chainId: network.chainId.toString(),
    reusedLpTokenFactory: lpTokenFactoryAddress,
    factory: await factory.getAddress(),
    pool: poolAddress,
    initializationTx: initialization.transactionHash,
    swaps: SWAP_COUNT,
    swapGas,
    publishedSequence: "2",
    fullyExited: true,
  })}`);
}

void main().catch((error: unknown) => {
  recoveryJournal?.markRun("failed");
  console.error(
    `COTI observable confidential test failed during ${stage}: ` +
      safeTestnetErrorSummary(error),
  );
  process.exitCode = 1;
});
