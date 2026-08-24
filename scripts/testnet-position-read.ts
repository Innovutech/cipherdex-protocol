import { Contract, TransactionReceipt, ethers as ethersLibrary } from "ethers";
import { ethers } from "../hardhat/runtime.js";

import {
  CONFIDENTIAL_FACTORY_TESTNET_ABI,
  CONFIDENTIAL_POOL_TESTNET_ABI,
  PRIVATE_ERC20_TESTNET_ABI,
} from "./coti-testnet-abi";
import { decryptPrivateValue256 } from "./coti-testnet-values";
import { createFundedDeploymentBinding } from "./funded-deployment-binding";
import {
  type FundedRecoveryJournal,
  verifyRecoveryResourceCreation,
} from "./funded-recovery-journal";
import {
  FundedCotiWallet as CotiWallet,
  openFundedRecoveryJournal,
  withFundedTransactionEvidence,
} from "./funded-transaction-wallet";
import { requiredFundedRecoveryDirectory } from "./funded-runtime-state";
import {
  recoverPrivateAllowanceObligations,
  setRecoverablePrivateAllowance,
} from "./funded-private-allowance";
import { assertCompatiblePrivateTokens } from "./private-token-compatibility";
import { verifyDeployedRuntimeArtifact } from "./runtime-artifact";
import { confidentialLiquidityBounds } from "./testnet-slippage";
import {
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
const CREATE_POOL_GAS_LIMIT = 8_500_000n;
const CALL_GAS_LIMIT = 30_000_000n;
const UINT64_MAX = (1n << 64n) - 1n;
const PRICE_SCALE = 10n ** 18n;
const LOCK_SECONDS = 15;
let stage = "configuration";
let requestNonce = 0;
let recoveryJournal: FundedRecoveryJournal | undefined;
let recoveryWallet: CotiWallet | undefined;

type Submitted = Readonly<{
  receipt: TransactionReceipt;
  hash: string;
  gasUsed: bigint;
}>;

type PoolContext = Readonly<{
  address: string;
  factoryAddress: string;
  pool: Contract;
  token0Address: string;
  token1Address: string;
  token0: Contract;
  token1: Contract;
  token0Decimals: number;
  token1Decimals: number;
}>;

type Position = Readonly<{
  shares: bigint;
  amount0: bigint;
  amount1: bigint;
  priceX18: bigint;
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

function requiredAddress(name: string): string {
  const value = process.env[name]?.trim();
  if (!value || !ethersLibrary.isAddress(value)) {
    throw new Error(`${name} must be a valid address`);
  }
  return ethersLibrary.getAddress(value);
}

function requiredInteger(name: string, minimum: number, maximum: number): number {
  const value = process.env[name]?.trim();
  if (!value || !/^\d+$/.test(value)) throw new Error(`${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function requiredAmount(name: string): bigint {
  const value = process.env[name]?.trim();
  if (!value || !/^\d+$/.test(value)) throw new Error(`${name} must be a positive uint256`);
  const parsed = BigInt(value);
  if (parsed <= 0n || parsed >= 1n << 256n) {
    throw new Error(`${name} must be a positive uint256`);
  }
  return parsed;
}

function journal(): FundedRecoveryJournal {
  if (!recoveryJournal) throw new Error("funded recovery journal is not initialized");
  return recoveryJournal;
}

function nextRequestId(label: string): string {
  requestNonce += 1;
  return ethersLibrary.keccak256(
    ethersLibrary.solidityPacked(
      ["string", "uint256", "uint256"],
      [label, Date.now(), requestNonce],
    ),
  );
}

function deadline(seconds = 600): bigint {
  const value = BigInt(Math.floor(Date.now() / 1_000) + seconds);
  if (value <= 0n || value > UINT64_MAX) throw new Error("invalid test deadline");
  return value;
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
    journal().recordTransaction(
      evidence.transactionHash,
      "mined-success",
      evidence.receipt.blockNumber,
    );
    console.log(
      `${label}: tx=${evidence.transactionHash} gas=${evidence.receipt.gasUsed.toString()}`,
    );
    return {
      receipt: evidence.receipt,
      hash: evidence.transactionHash,
      gasUsed: evidence.receipt.gasUsed,
    };
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

async function privateBalance(
  token: Contract,
  wallet: CotiWallet,
  account: string,
): Promise<bigint> {
  return decryptPrivateValue256(wallet, await token.balanceOf.staticCall(account));
}

async function privateAllowance(
  token: Contract,
  wallet: CotiWallet,
  owner: string,
  spender: string,
): Promise<bigint> {
  const allowance = await token.allowance.staticCall(owner, spender);
  return decryptPrivateValue256(wallet, allowance.ownerCiphertext);
}

async function privateShares(context: PoolContext, wallet: CotiWallet): Promise<bigint> {
  const lpTokenAddress = ethersLibrary.getAddress(await context.pool.lpToken());
  const owner = ethersLibrary.getAddress(await wallet.getAddress());
  const lpToken = new Contract(lpTokenAddress, PRIVATE_ERC20_TESTNET_ABI, wallet);
  return privateBalance(lpToken, wallet, owner);
}

async function poolActiveShares(context: PoolContext, wallet: CotiWallet): Promise<bigint> {
  return decryptPrivateValue256(wallet, await context.pool.myShares.staticCall());
}

async function setExactAllowance(
  token: Contract,
  wallet: CotiWallet,
  tokenAddress: string,
  spender: string,
  amount: bigint,
  label: string,
): Promise<void> {
  await setRecoverablePrivateAllowance({
    journal: journal(),
    wallet,
    token,
    tokenAddress,
    spender,
    amount,
    label,
    overrides: { gasLimit: CALL_GAS_LIMIT },
    submit,
  });
}

function parsePositionEvent(
  context: PoolContext,
  receipt: TransactionReceipt,
  eventName: string,
  caller: string,
  requestId: string,
  lockId?: string,
): any {
  const matches = receipt.logs.flatMap((log) => {
    if (log.address.toLowerCase() !== context.address.toLowerCase()) return [];
    try {
      const parsed = context.pool.interface.parseLog(log);
      return parsed?.name === eventName ? [parsed] : [];
    } catch {
      return [];
    }
  }).filter((event) =>
    String(event.args.caller).toLowerCase() === caller.toLowerCase() &&
    String(event.args.requestId).toLowerCase() === requestId.toLowerCase() &&
    (lockId === undefined || String(event.args.lockId).toLowerCase() === lockId.toLowerCase())
  );
  if (matches.length !== 1) throw new Error(`${eventName} is missing or ambiguous`);
  return matches[0];
}

async function decryptPosition(wallet: CotiWallet, event: any): Promise<Position> {
  const [shares, amount0, amount1, priceX18] = await Promise.all([
    wallet.decryptValue256(event.args.sharesCiphertext as never),
    wallet.decryptValue256(event.args.amount0Ciphertext as never),
    wallet.decryptValue256(event.args.amount1Ciphertext as never),
    wallet.decryptValue256(event.args.priceX18Ciphertext as never),
  ]);
  return Object.freeze({ shares, amount0, amount1, priceX18 });
}

function expectedPosition(
  shares: bigint,
  totalShares: bigint,
  reserve0: bigint,
  reserve1: bigint,
  decimals0: number,
  decimals1: number,
): Position {
  if (shares <= 0n || totalShares <= 0n || reserve0 <= 0n || reserve1 <= 0n) {
    throw new Error("position model requires positive values");
  }
  const normalized0 = reserve0 * 10n ** BigInt(18 - decimals0);
  const normalized1 = reserve1 * 10n ** BigInt(18 - decimals1);
  return Object.freeze({
    shares,
    amount0: shares * reserve0 / totalShares,
    amount1: shares * reserve1 / totalShares,
    priceX18: normalized1 * PRICE_SCALE / normalized0,
  });
}

function requirePosition(actual: Position, expected: Position, label: string): void {
  if (
    actual.shares !== expected.shares ||
    actual.amount0 !== expected.amount0 ||
    actual.amount1 !== expected.amount1 ||
    actual.priceX18 !== expected.priceX18
  ) throw new Error(`${label} diverged from proportional pool accounting`);
}

async function requestMyPosition(
  context: PoolContext,
  wallet: CotiWallet,
  caller: string,
): Promise<Readonly<{ position: Position; transaction: Submitted }>> {
  const requestId = nextRequestId("my-position");
  const transaction = await submit(
    "owner-encrypted active position read",
    () => context.pool.requestMyPosition(
      requestId,
      deadline(),
      { gasLimit: CALL_GAS_LIMIT },
    ),
  );
  const event = parsePositionEvent(
    context,
    transaction.receipt,
    "ConfidentialPositionResult",
    caller,
    requestId,
  );
  return Object.freeze({ position: await decryptPosition(wallet, event), transaction });
}

async function requestRemovalPreview(
  context: PoolContext,
  wallet: CotiWallet,
  caller: string,
  shares: bigint,
  label: string,
): Promise<Readonly<{ position: Position; transaction: Submitted }>> {
  const selector = context.pool.interface.getFunction("requestRemoveLiquidityQuote")?.selector;
  if (!selector) throw new Error("remove-liquidity quote selector unavailable");
  const input = await wallet.encryptValue256(shares, context.address, selector);
  const requestId = nextRequestId(label);
  const transaction = await submit(
    label,
    () => context.pool.requestRemoveLiquidityQuote(
      input,
      requestId,
      deadline(),
      { gasLimit: CALL_GAS_LIMIT },
    ),
  );
  const event = parsePositionEvent(
    context,
    transaction.receipt,
    "ConfidentialRemoveLiquidityQuoteResult",
    caller,
    requestId,
  );
  return Object.freeze({ position: await decryptPosition(wallet, event), transaction });
}

async function requestLockedPosition(
  context: PoolContext,
  wallet: CotiWallet,
  caller: string,
  lockId: string,
): Promise<Readonly<{ position: Position; transaction: Submitted }>> {
  const requestId = nextRequestId("locked-position");
  const transaction = await submit(
    "owner-encrypted locked position read",
    () => context.pool.requestLockedPosition(
      lockId,
      requestId,
      deadline(),
      { gasLimit: CALL_GAS_LIMIT },
    ),
  );
  const event = parsePositionEvent(
    context,
    transaction.receipt,
    "ConfidentialLockedPositionResult",
    caller,
    requestId,
    lockId,
  );
  return Object.freeze({ position: await decryptPosition(wallet, event), transaction });
}

async function waitUntilUnlock(unlockTime: bigint): Promise<void> {
  const started = Date.now();
  while (true) {
    const block = await ethers.provider.getBlock("latest");
    if (!block) throw new Error("latest COTI testnet block is unavailable");
    if (BigInt(block.timestamp) >= unlockTime) return;
    if (Date.now() - started > 120_000) throw new Error("timed LP lock did not mature");
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

async function removeLiquidity(
  context: PoolContext,
  wallet: CotiWallet,
  shares: bigint,
  minimum0: bigint,
  minimum1: bigint,
  label: string,
): Promise<Submitted> {
  const selector = context.pool.interface.getFunction("removeLiquidity")?.selector;
  if (!selector) throw new Error("remove-liquidity selector unavailable");
  const [shareInput, min0Input, min1Input] = await Promise.all([
    wallet.encryptValue256(shares, context.address, selector),
    wallet.encryptValue256(minimum0, context.address, selector),
    wallet.encryptValue256(minimum1, context.address, selector),
  ]);
  return submit(label, () => context.pool.removeLiquidity(
    shareInput,
    min0Input,
    min1Input,
    deadline(),
    { gasLimit: CALL_GAS_LIMIT },
  ));
}

async function loadPool(
  address: string,
  factoryAddress: string,
  wallet: CotiWallet,
): Promise<PoolContext> {
  const pool = new Contract(address, CONFIDENTIAL_POOL_TESTNET_ABI, wallet);
  const [token0Address, token1Address, token0Decimals, token1Decimals] = await Promise.all([
    pool.token0(),
    pool.token1(),
    pool.token0Decimals(),
    pool.token1Decimals(),
  ]);
  const normalized0 = ethersLibrary.getAddress(String(token0Address));
  const normalized1 = ethersLibrary.getAddress(String(token1Address));
  return Object.freeze({
    address: ethersLibrary.getAddress(address),
    factoryAddress: ethersLibrary.getAddress(factoryAddress),
    pool,
    token0Address: normalized0,
    token1Address: normalized1,
    token0: new Contract(normalized0, PRIVATE_ERC20_TESTNET_ABI, wallet),
    token1: new Contract(normalized1, PRIVATE_ERC20_TESTNET_ABI, wallet),
    token0Decimals: Number(token0Decimals),
    token1Decimals: Number(token1Decimals),
  });
}

async function recoverActivePool(): Promise<void> {
  if (!recoveryJournal || !recoveryWallet) return;
  const owner = ethersLibrary.getAddress(await recoveryWallet.getAddress());
  for (const resource of recoveryJournal.activeResources) {
    await verifyRecoveryResourceCreation(recoveryJournal, resource, ethers.provider);
    if (resource.kind !== "confidential-pool") {
      throw new Error(`unsupported active recovery resource ${resource.kind}`);
    }
    const factoryAddress = String(resource.metadata.factoryAddress ?? "");
    if (!ethersLibrary.isAddress(factoryAddress)) {
      throw new Error("position-read recovery factory metadata is invalid");
    }
    const context = await loadPool(resource.address, factoryAddress, recoveryWallet);
    const lockId = String(resource.metadata.lockId ?? "");
    if (/^0x[0-9a-fA-F]{64}$/.test(lockId)) {
      const lock = await context.pool.lockInfo(lockId);
      if (
        ethersLibrary.getAddress(String(lock.owner)) === owner &&
        !Boolean(lock.released)
      ) {
        if (Boolean(lock.permanent)) throw new Error("position-read recovery found a permanent lock");
        await waitUntilUnlock(BigInt(lock.unlockTime));
        await submit(
          "recover timed position lock",
          () => context.pool.unlockShares(lockId, { gasLimit: CALL_GAS_LIMIT }),
        );
      }
    }
    const initialized = Boolean(await context.pool.initialized());
    if (initialized) {
      const shares = await privateShares(context, recoveryWallet);
      if (shares <= 0n) throw new Error("initialized recovery pool has no active owner shares");
      const cleanup = await removeLiquidity(
        context,
        recoveryWallet,
        shares,
        1n,
        1n,
        "recover full position exit",
      );
      recoveryJournal.markRecovered(resource.id, [cleanup.hash]);
    } else {
      const terminalExit = [...recoveryJournal.transactions].reverse().find((transaction) =>
        transaction.status === "mined-success" &&
        ["execute focused full position exit", "recover full position exit"].includes(
          transaction.label,
        )
      );
      recoveryJournal.markRecovered(
        resource.id,
        [terminalExit?.hash ?? resource.creationTransactionHash],
      );
    }
  }
}

async function main(): Promise<void> {
  const primaryKey = requiredPrivateKey("COTI_TESTNET_PRIVATE_KEY");
  const primaryAes = requiredAesKey("COTI_AES_KEY");
  const secondKey = requiredPrivateKey("COTI_SECOND_LP_PRIVATE_KEY");
  const secondAes = requiredAesKey("COTI_SECOND_LP_AES_KEY");
  const tokenAAddress = requiredAddress("COTI_TOKEN0");
  const tokenBAddress = requiredAddress("COTI_TOKEN1");
  const decimalsA = requiredInteger("COTI_TOKEN0_DECIMALS", 0, 18);
  const decimalsB = requiredInteger("COTI_TOKEN1_DECIMALS", 0, 18);
  const feeBps = requiredInteger("COTI_FEE_BPS", 1, 1_000);
  if (![5, 30, 100].includes(feeBps)) throw new Error("COTI_FEE_BPS is not an approved tier");
  const amountA = requiredAmount("COTI_LIQUIDITY_AMOUNT0");
  const amountB = requiredAmount("COTI_LIQUIDITY_AMOUNT1");
  const factoryAddress = requiredAddress("COTI_FACTORY");
  const feeVaultAddress = requiredAddress("COTI_FEE_VAULT");

  const network = await ethers.provider.getNetwork();
  if (network.chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(`expected COTI testnet ${EXPECTED_CHAIN_ID}, received ${network.chainId}`);
  }
  const primary = new CotiWallet(primaryKey, ethers.provider, { aesKey: primaryAes });
  primary.setAesKey(primaryAes);
  const second = new CotiWallet(secondKey, ethers.provider, { aesKey: secondAes });
  second.setAesKey(secondAes);
  const primaryAddress = ethersLibrary.getAddress(await primary.getAddress());
  const secondAddress = ethersLibrary.getAddress(await second.getAddress());
  if (primaryAddress === secondAddress) throw new Error("position-read test identities must differ");

  stage = "reviewed deployment provenance";
  const deploymentRecord = await verifyConfiguredTestnetDeployment(
    requiredTestnetDeploymentRecordPath(),
    ethers.provider,
    [
      {
        recordKey: "confidentialFactory",
        contractName: "ConfidentialCPMMFactory",
        address: factoryAddress,
      },
      {
        recordKey: "feeVault",
        contractName: "CipherDEXFeeVault",
        address: feeVaultAddress,
      },
    ],
  );
  recoveryJournal = openFundedRecoveryJournal(primaryKey, {
    runner: "position-read",
    sourceCommit: deploymentRecord.sourceCommit,
    chainId: Number(network.chainId),
    owner: primaryAddress,
    directory: requiredFundedRecoveryDirectory(),
    deployment: await createFundedDeploymentBinding(deploymentRecord),
  });
  recoveryWallet = primary;
  const unresolved = await recoveryJournal.reconcileTransactions(ethers.provider);
  if (unresolved.length > 0) {
    throw new Error(
      `funded recovery has ${unresolved.length} transaction(s) with unknown outcome; do not retry`,
    );
  }
  await recoverPrivateAllowanceObligations({
    journal: recoveryJournal,
    wallets: [primary, second],
    overrides: { gasLimit: CALL_GAS_LIMIT },
    submit,
  });
  await recoverActivePool();
  if (recoveryJournal.runStatus === "passed") {
    console.log("Focused COTI testnet position-read validation was already completed.");
    return;
  }

  const factory = new Contract(factoryAddress, CONFIDENTIAL_FACTORY_TESTNET_ABI, primary);
  const [factoryVersion, factoryVault] = await Promise.all([
    factory.PROTOCOL_VERSION(),
    factory.feeVault(),
  ]);
  if (
    BigInt(factoryVersion) !== 1n ||
    ethersLibrary.getAddress(String(factoryVault)) !== feeVaultAddress
  ) throw new Error("configured confidential factory is not protocol v1");
  await assertCompatiblePrivateTokens(factory, [tokenAAddress, tokenBAddress]);

  const tokenA = new Contract(tokenAAddress, PRIVATE_ERC20_TESTNET_ABI, primary);
  const tokenB = new Contract(tokenBAddress, PRIVATE_ERC20_TESTNET_ABI, primary);
  const [onchainDecimalsA, onchainDecimalsB, balanceA, balanceB] = await Promise.all([
    tokenA.decimals(),
    tokenB.decimals(),
    privateBalance(tokenA, primary, primaryAddress),
    privateBalance(tokenB, primary, primaryAddress),
  ]);
  if (Number(onchainDecimalsA) !== decimalsA || Number(onchainDecimalsB) !== decimalsB) {
    throw new Error("configured private-token decimals do not match onchain metadata");
  }
  if (amountA > balanceA / 2n || amountB > balanceB / 2n) {
    throw new Error("focused position-read liquidity exceeds half the funded balance");
  }

  const creation = await submit(
    "create focused canonical pool",
    () => factory.createPool(
      tokenAAddress,
      tokenBAddress,
      decimalsA,
      decimalsB,
      feeBps,
      { gasLimit: CREATE_POOL_GAS_LIMIT },
    ),
  );
  const key = await factory.poolKey(
    tokenAAddress,
    tokenBAddress,
    decimalsA,
    decimalsB,
    feeBps,
    ethersLibrary.ZeroAddress,
  );
  const poolAddress = ethersLibrary.getAddress(await factory.getPool(key));
  if (poolAddress === ethersLibrary.ZeroAddress || !(await factory.isPool(poolAddress))) {
    throw new Error("factory did not register the focused canonical pool");
  }
  await verifyDeployedRuntimeArtifact("ConfidentialCPMM", poolAddress);
  const context = await loadPool(poolAddress, factoryAddress, primary);
  const amount0 = context.token0Address === tokenAAddress ? amountA : amountB;
  const amount1 = context.token1Address === tokenBAddress ? amountB : amountA;
  journal().recordResource({
    id: "position-read-pool",
    kind: "confidential-pool",
    address: poolAddress,
    creationTransactionHash: creation.hash,
    metadata: {
      factoryAddress,
      token0Address: context.token0Address,
      token1Address: context.token1Address,
      decimals0: context.token0Decimals,
      decimals1: context.token1Decimals,
      feeBps,
    },
  });

  await setExactAllowance(
    context.token0,
    primary,
    context.token0Address,
    poolAddress,
    amount0,
    "focused token0 liquidity approval",
  );
  await setExactAllowance(
    context.token1,
    primary,
    context.token1Address,
    poolAddress,
    amount1,
    "focused token1 liquidity approval",
  );
  const addSelector = context.pool.interface.getFunction("addLiquidity")?.selector;
  if (!addSelector) throw new Error("add-liquidity selector unavailable");
  const bounds = confidentialLiquidityBounds(
    amount0,
    context.token0Decimals,
    amount1,
    context.token1Decimals,
    false,
  );
  const [input0, input1, minimumShares, minimumPrice, maximumPrice] = await Promise.all([
    primary.encryptValue256(amount0, poolAddress, addSelector),
    primary.encryptValue256(amount1, poolAddress, addSelector),
    primary.encryptValue256(bounds.minShares, poolAddress, addSelector),
    primary.encryptValue256(bounds.minPriceX18, poolAddress, addSelector),
    primary.encryptValue256(bounds.maxPriceX18, poolAddress, addSelector),
  ]);
  const [ownerBalance0Before, ownerBalance1Before] = await Promise.all([
    privateBalance(context.token0, primary, primaryAddress),
    privateBalance(context.token1, primary, primaryAddress),
  ]);
  await submit(
    "initialize focused canonical pool",
    () => context.pool.addLiquidity(
      input0,
      input1,
      minimumShares,
      minimumPrice,
      maximumPrice,
      false,
      deadline(),
      { gasLimit: CALL_GAS_LIMIT },
    ),
  );
  await setExactAllowance(
    context.token0,
    primary,
    context.token0Address,
    poolAddress,
    0n,
    "focused token0 allowance cleanup",
  );
  await setExactAllowance(
    context.token1,
    primary,
    context.token1Address,
    poolAddress,
    0n,
    "focused token1 allowance cleanup",
  );
  const [initialShares, activeShares, ownerBalance0After, ownerBalance1After] = await Promise.all([
    privateShares(context, primary),
    poolActiveShares(context, primary),
    privateBalance(context.token0, primary, primaryAddress),
    privateBalance(context.token1, primary, primaryAddress),
  ]);
  if (
    initialShares < 8n ||
    activeShares !== initialShares ||
    ownerBalance0Before - ownerBalance0After !== amount0 ||
    ownerBalance1Before - ownerBalance1After !== amount1
  ) throw new Error("focused pool initialization accounting is invalid");

  const [poolBalance0BeforeReads, poolBalance1BeforeReads] = await Promise.all([
    privateBalance(context.token0, primary, poolAddress),
    privateBalance(context.token1, primary, poolAddress),
  ]);
  const active = await requestMyPosition(context, primary, primaryAddress);
  requirePosition(
    active.position,
    expectedPosition(
      initialShares,
      initialShares,
      amount0,
      amount1,
      context.token0Decimals,
      context.token1Decimals,
    ),
    "active position read",
  );
  const partialShares = initialShares / 4n;
  const partialPreview = await requestRemovalPreview(
    context,
    primary,
    primaryAddress,
    partialShares,
    "owner-encrypted partial withdrawal preview",
  );
  requirePosition(
    partialPreview.position,
    expectedPosition(
      partialShares,
      initialShares,
      amount0,
      amount1,
      context.token0Decimals,
      context.token1Decimals,
    ),
    "partial withdrawal preview",
  );
  const fullPreview = await requestRemovalPreview(
    context,
    primary,
    primaryAddress,
    initialShares,
    "owner-encrypted full withdrawal preview",
  );
  requirePosition(
    fullPreview.position,
    expectedPosition(
      initialShares,
      initialShares,
      amount0,
      amount1,
      context.token0Decimals,
      context.token1Decimals,
    ),
    "full withdrawal preview",
  );
  const [poolBalance0AfterReads, poolBalance1AfterReads, sharesAfterReads] = await Promise.all([
    privateBalance(context.token0, primary, poolAddress),
    privateBalance(context.token1, primary, poolAddress),
    privateShares(context, primary),
  ]);
  if (
    poolBalance0AfterReads !== poolBalance0BeforeReads ||
    poolBalance1AfterReads !== poolBalance1BeforeReads ||
    sharesAfterReads !== initialShares
  ) throw new Error("position reads changed pool custody or owner shares");

  const lockShares = initialShares / 4n;
  const lockSelector = context.pool.interface.getFunction("lockShares")?.selector;
  if (!lockSelector) throw new Error("lock-shares selector unavailable");
  const latest = await ethers.provider.getBlock("latest");
  if (!latest) throw new Error("latest COTI testnet block is unavailable");
  const unlockTime = BigInt(latest.timestamp + LOCK_SECONDS);
  const lockNonce = BigInt(await context.pool.nextLockNonce());
  const lockId = ethersLibrary.keccak256(
    ethersLibrary.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "uint256"],
      [poolAddress, primaryAddress, lockNonce],
    ),
  );
  journal().updateResourceMetadata("position-read-pool", { lockId });
  const encryptedLockShares = await primary.encryptValue256(
    lockShares,
    poolAddress,
    lockSelector,
  );
  const lockTransaction = await submit(
    "create focused timed LP lock",
    () => context.pool.lockShares(
      encryptedLockShares,
      unlockTime,
      false,
      deadline(),
      { gasLimit: CALL_GAS_LIMIT },
    ),
  );
  const lockEvents = lockTransaction.receipt.logs.flatMap((log) => {
    if (log.address.toLowerCase() !== poolAddress.toLowerCase()) return [];
    try {
      const parsed = context.pool.interface.parseLog(log);
      return parsed?.name === "LiquidityLocked" ? [parsed] : [];
    } catch {
      return [];
    }
  }).filter((event) =>
    String(event.args.lockId).toLowerCase() === lockId.toLowerCase() &&
    String(event.args.owner).toLowerCase() === primaryAddress.toLowerCase()
  );
  if (lockEvents.length !== 1) throw new Error("focused LP lock event is missing or ambiguous");
  if (await poolActiveShares(context, primary) !== initialShares - lockShares) {
    throw new Error("timed LP lock did not remove exact active shares");
  }
  const locked = await requestLockedPosition(context, primary, primaryAddress, lockId);
  requirePosition(
    locked.position,
    expectedPosition(
      lockShares,
      initialShares,
      amount0,
      amount1,
      context.token0Decimals,
      context.token1Decimals,
    ),
    "locked position read",
  );

  let nonOwnerRejected = false;
  const secondPool = new Contract(poolAddress, CONFIDENTIAL_POOL_TESTNET_ABI, second);
  try {
    await secondPool.requestLockedPosition.staticCall(
      lockId,
      nextRequestId("non-owner-locked-position"),
      deadline(),
    );
  } catch {
    nonOwnerRejected = true;
  }
  if (!nonOwnerRejected) throw new Error("non-owner locked-position read was not rejected");

  await waitUntilUnlock(unlockTime);
  await submit(
    "release focused timed LP lock",
    () => context.pool.unlockShares(lockId, { gasLimit: CALL_GAS_LIMIT }),
  );
  if (await poolActiveShares(context, primary) !== initialShares) {
    throw new Error("timed LP unlock did not restore exact active shares");
  }

  const [allowance0, allowance1] = await Promise.all([
    privateAllowance(context.token0, primary, primaryAddress, poolAddress),
    privateAllowance(context.token1, primary, primaryAddress, poolAddress),
  ]);
  if (allowance0 !== 0n || allowance1 !== 0n) {
    throw new Error("owner-encrypted allowance read found residual liquidity approval");
  }

  const [balance0BeforePartial, balance1BeforePartial] = await Promise.all([
    privateBalance(context.token0, primary, primaryAddress),
    privateBalance(context.token1, primary, primaryAddress),
  ]);
  await removeLiquidity(
    context,
    primary,
    partialShares,
    partialPreview.position.amount0,
    partialPreview.position.amount1,
    "execute previewed partial withdrawal",
  );
  const [balance0AfterPartial, balance1AfterPartial, sharesAfterPartial] = await Promise.all([
    privateBalance(context.token0, primary, primaryAddress),
    privateBalance(context.token1, primary, primaryAddress),
    privateShares(context, primary),
  ]);
  if (
    balance0AfterPartial - balance0BeforePartial !== partialPreview.position.amount0 ||
    balance1AfterPartial - balance1BeforePartial !== partialPreview.position.amount1 ||
    sharesAfterPartial !== initialShares - partialShares
  ) throw new Error("previewed partial withdrawal settlement is inconsistent");

  const remainingReserve0 = amount0 - partialPreview.position.amount0;
  const remainingReserve1 = amount1 - partialPreview.position.amount1;
  const fullExit = await removeLiquidity(
    context,
    primary,
    sharesAfterPartial,
    remainingReserve0,
    remainingReserve1,
    "execute focused full position exit",
  );
  const [finalShares, initialized, poolBalance0, poolBalance1, finalAllowance0, finalAllowance1] =
    await Promise.all([
      privateShares(context, primary),
      context.pool.initialized(),
      privateBalance(context.token0, primary, poolAddress),
      privateBalance(context.token1, primary, poolAddress),
      privateAllowance(context.token0, primary, primaryAddress, poolAddress),
      privateAllowance(context.token1, primary, primaryAddress, poolAddress),
    ]);
  if (
    finalShares !== 0n ||
    Boolean(initialized) ||
    poolBalance0 !== 0n ||
    poolBalance1 !== 0n ||
    finalAllowance0 !== 0n ||
    finalAllowance1 !== 0n
  ) throw new Error("focused position-read cleanup left assets, shares, or allowances");

  journal().markRecovered("position-read-pool", [fullExit.hash]);
  journal().markRun("passed");
  console.log(
    "Focused COTI testnet position-read validation passed: active/full/partial/locked reads, " +
      "non-owner rejection, no read-side custody mutation, exact partial settlement, and full cleanup.",
  );
}

void main().catch(async (error: unknown) => {
  if (error instanceof UnknownBroadcastOutcomeError) {
    recoveryJournal?.markRun("failed");
    console.error(
      `Focused COTI position-read validation paused with an uncertain broadcast: ` +
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
        wallets: recoveryWallet ? [recoveryWallet] : [],
        overrides: { gasLimit: CALL_GAS_LIMIT },
        submit,
      });
      await recoverActivePool();
      recoveryJournal.markRun("failed");
    }
  } catch (recoveryError) {
    recoveryJournal?.markRun("recovery-failed");
    reportedError = new AggregateError(
      [error, recoveryError],
      "focused position-read validation and recovery both failed",
    );
  }
  console.error(
    `Focused COTI position-read validation failed: stage=${stage} ` +
      safeTestnetErrorSummary(reportedError),
  );
  process.exitCode = 1;
});
