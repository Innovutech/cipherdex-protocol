import { Contract, TransactionReceipt, ethers as ethersLibrary } from "ethers";
import { Wallet as CotiWallet } from "@coti-io/coti-ethers";
import { ethers } from "hardhat";

import {
  CONFIDENTIAL_BEST_EXECUTION_ROUTER_TESTNET_ABI,
  CONFIDENTIAL_FACTORY_TESTNET_ABI,
  CONFIDENTIAL_POOL_TESTNET_ABI,
  PRIVATE_ERC20_TESTNET_ABI,
} from "./coti-testnet-abi";
import { decryptPrivateValue256 } from "./coti-testnet-values";
import {
  FundedRecoveryJournal,
  verifyRecoveryResourceCreation,
} from "./funded-recovery-journal";
import { writeFundedRunEvidence } from "./funded-run-evidence";
import { createFundedDeploymentBinding } from "./funded-deployment-binding";
import { resolvePrivateTokenCodehashes } from "./private-token-codehashes";
import { verifyDeployedRuntimeArtifact } from "./runtime-artifact";
import { confidentialLiquidityBounds, minimumWithSlippage } from "./testnet-slippage";
import {
  assertReviewedPrivateTokens,
  requiredTestnetDeploymentRecordPath,
  verifyConfiguredTestnetDeployment,
} from "./testnet-deployment-provenance";
import {
  MinedTransactionStatusError,
  requireMinedFailure,
  requireMinedSuccess,
  safeTestnetErrorSummary,
  transactionHashFromError,
  UnknownBroadcastOutcomeError,
} from "./testnet-transaction-evidence";

const EXPECTED_CHAIN_ID = 7_082_400n;
const CALL_GAS_LIMIT = (() => {
  const raw = process.env.COTI_BEST_EXECUTION_GAS_LIMIT?.trim() ?? "60000000";
  if (!/^\d+$/.test(raw)) {
    throw new Error("COTI_BEST_EXECUTION_GAS_LIMIT must be a positive integer");
  }
  const value = BigInt(raw);
  if (value <= 0n) {
    throw new Error("COTI_BEST_EXECUTION_GAS_LIMIT must be a positive integer");
  }
  return value;
})();
const CREATE_POOL_GAS_LIMIT = 6_500_000n;
const UINT64_MAX = (1n << 64n) - 1n;
const FEE_TIERS = [5, 30, 100] as const;
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
  feeBps: number;
  pool: Contract;
  token0Address: string;
  token1Address: string;
  token0: Contract;
  token1: Contract;
  token0Decimals: number;
  token1Decimals: number;
  model: {
    reserve0: bigint;
    reserve1: bigint;
    protocolFee0: bigint;
    protocolFee1: bigint;
  };
}>;

type BestResult = Readonly<{
  selectedPool: string;
  selectedFeeBps: number;
  zeroForOne: boolean;
  encryptedResult: unknown;
}>;

type QuoteExecution = BestResult & Readonly<{
  amountOut: bigint;
  input: unknown;
  requestId: string;
  transaction: Submitted;
}>;

type PublicPoolSnapshot = Readonly<{
  protocolVersion: string;
  privacyMode: string;
  token0: string;
  token1: string;
  token0Decimals: string;
  token1Decimals: string;
  scale0: string;
  scale1: string;
  feeBps: string;
  feeVault: string;
  bootstrapper: string;
  lpToken: string;
  initialized: boolean;
  feeCount0: string;
  feeCount1: string;
  feeWindow0: string;
  feeWindow1: string;
  nextLockNonce: string;
  token0Balance: string;
  token1Balance: string;
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

function journal(): FundedRecoveryJournal {
  if (!recoveryJournal) throw new Error("funded recovery journal is not initialized");
  return recoveryJournal;
}

function optionalPositiveAmount(name: string, fallback: bigint): bigint {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  const value = BigInt(raw);
  if (value === 0n) throw new Error(`${name} must be a positive integer`);
  return value;
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
  const value = BigInt(Math.floor(Date.now() / 1000) + seconds);
  if (value <= 0n || value > UINT64_MAX) throw new Error("invalid test deadline");
  return value;
}

function modeledAmountOut(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeBps: number,
): bigint {
  const netAmountIn = amountIn * BigInt(10_000 - feeBps) / 10_000n;
  if (netAmountIn <= 0n) throw new Error("modeled quote has no net input");
  const denominator = reserveIn + netAmountIn;
  const product = reserveIn * reserveOut;
  const retained = product / denominator + (product % denominator === 0n ? 0n : 1n);
  return retained >= reserveOut ? 0n : reserveOut - retained;
}

function modeledPostSwapReserves(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeBps: number,
): Readonly<{ reserveIn: bigint; reserveOut: bigint }> {
  const amountOut = modeledAmountOut(amountIn, reserveIn, reserveOut, feeBps);
  const netAmountIn = amountIn * BigInt(10_000 - feeBps) / 10_000n;
  const protocolFee = (amountIn - netAmountIn) / 6n;
  if (amountOut <= 0n || protocolFee <= 0n || amountOut >= reserveOut) {
    throw new Error("modeled funded swap is not operational");
  }
  return {
    reserveIn: reserveIn + amountIn - protocolFee,
    reserveOut: reserveOut - amountOut,
  };
}

function modeledProtocolFee(amountIn: bigint, feeBps: number): bigint {
  const netAmountIn = amountIn * BigInt(10_000 - feeBps) / 10_000n;
  return (amountIn - netAmountIn) / 6n;
}

function reserveOutForExactQuote(
  targetOutput: bigint,
  amountIn: bigint,
  reserveIn: bigint,
  feeBps: number,
  initialUpperBound: bigint,
): bigint {
  let lower = 1n;
  let upper = initialUpperBound > 1n ? initialUpperBound : 2n;
  while (modeledAmountOut(amountIn, reserveIn, upper, feeBps) < targetOutput) {
    upper *= 2n;
  }
  while (lower < upper) {
    const midpoint = (lower + upper) / 2n;
    if (modeledAmountOut(amountIn, reserveIn, midpoint, feeBps) < targetOutput) {
      lower = midpoint + 1n;
    } else {
      upper = midpoint;
    }
  }
  if (modeledAmountOut(amountIn, reserveIn, lower, feeBps) !== targetOutput) {
    throw new Error("unable to construct an exact deterministic fee-tier tie");
  }
  return lower;
}

async function submit(
  label: string,
  operation: () => Promise<{ hash: string; wait(): Promise<TransactionReceipt | null> }>,
): Promise<Submitted> {
  stage = label;
  const started = Date.now();
  let evidence: Awaited<ReturnType<typeof requireMinedSuccess<TransactionReceipt>>>;
  try {
    evidence = await requireMinedSuccess(
      label,
      operation,
      (hash) => ethers.provider.getTransactionReceipt(hash),
      (hash) => journal().recordBroadcast(label, hash),
      () => journal().recordSubmission(label),
    );
  } catch (error) {
    const hash = transactionHashFromError(error);
    if (hash) {
      if (!journal().transactions.some((transaction) =>
        transaction.hash.toLowerCase() === hash.toLowerCase()
      )) journal().recordBroadcast(label, hash);
      journal().recordTransaction(
        hash,
        error instanceof MinedTransactionStatusError ? "mined-failure" : "outcome-unknown",
      );
    }
    throw error;
  }
  const receipt = evidence.receipt;
  journal().recordTransaction(evidence.transactionHash, "mined-success", receipt.blockNumber);
  console.log(
    `${label}: tx=${evidence.transactionHash} gas=${receipt.gasUsed.toString()} ` +
      `latencyMs=${Date.now() - started}`,
  );
  return { receipt, hash: evidence.transactionHash, gasUsed: receipt.gasUsed };
}

async function deployContract(
  name: string,
  wallet: CotiWallet,
  args: readonly unknown[],
  gasLimit: bigint,
): Promise<{ contract: any; address: string; transaction: Submitted }> {
  stage = `${name} deployment`;
  const factory = await ethers.getContractFactory(name, wallet);
  let contract: any;
  const transaction = await submit(
    `${name} deployment`,
    async () => {
      contract = await factory.deploy(...args, { gasLimit });
      const deploymentTx = contract.deploymentTransaction();
      if (!deploymentTx) throw new Error(`${name} deployment transaction unavailable`);
      return deploymentTx;
    },
  );
  if (!contract) {
    throw new Error(`${name} deployment mined without a contract handle; do not retry automatically`);
  }
  const address = ethersLibrary.getAddress(await contract.getAddress());
  await verifyDeployedRuntimeArtifact(name, address);
  return { contract, address, transaction };
}

async function expectFailure(
  label: string,
  operation: () => Promise<{ hash: string; wait(): Promise<TransactionReceipt | null> }>,
): Promise<void> {
  stage = label;
  const evidence = await requireMinedFailure(
    label,
    operation,
    (hash) => ethers.provider.getTransactionReceipt(hash),
    (hash) => journal().recordBroadcast(label, hash),
    () => journal().recordSubmission(label),
  );
  journal().recordTransaction(evidence.transactionHash, "mined-failure", evidence.receipt.blockNumber);
  console.log(`${label}: rejected onchain tx=${evidence.transactionHash}`);
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
  if (lpTokenAddress === ethersLibrary.ZeroAddress) return 0n;
  const owner = await wallet.getAddress();
  const lpToken = new Contract(lpTokenAddress, PRIVATE_ERC20_TESTNET_ABI, wallet);
  return privateBalance(lpToken, wallet, owner);
}

async function setExactAllowance(
  token: Contract,
  wallet: CotiWallet,
  tokenAddress: string,
  spender: string,
  amount: bigint,
  label: string,
): Promise<void> {
  const owner = await wallet.getAddress();
  const current = await privateAllowance(token, wallet, owner, spender);
  if (current === amount) return;
  const selector = token.interface.getFunction("approve")?.selector;
  if (!selector) throw new Error("private token approve selector unavailable");
  if (current !== 0n) {
    const zero = await wallet.encryptValue256(0n, tokenAddress, selector);
    await submit(
      `${label} reset`,
      () => token.approve(spender, zero, { gasLimit: CALL_GAS_LIMIT }),
    );
  }
  if (amount !== 0n) {
    const encryptedAmount = await wallet.encryptValue256(
      amount,
      tokenAddress,
      selector,
    );
    await submit(
      label,
      () => token.approve(spender, encryptedAmount, { gasLimit: CALL_GAS_LIMIT }),
    );
  }
}

function ciphertextKey(value: unknown): string {
  const ciphertext = value as {
    ciphertextHigh?: bigint | number | string;
    ciphertextLow?: bigint | number | string;
  };
  return `${String(ciphertext.ciphertextHigh ?? "missing")}:` +
    String(ciphertext.ciphertextLow ?? "missing");
}

async function poolSnapshot(context: PoolContext): Promise<PublicPoolSnapshot> {
  const [
    protocolVersion,
    privacyMode,
    token0,
    token1,
    token0Decimals,
    token1Decimals,
    scale0,
    scale1,
    feeBps,
    feeVault,
    bootstrapper,
    lpToken,
    initialized,
    feeCount0,
    feeCount1,
    feeWindow0,
    feeWindow1,
    nextLockNonce,
    token0Balance,
    token1Balance,
  ] = await Promise.all([
    context.pool.PROTOCOL_VERSION(),
    context.pool.PRIVACY_MODE(),
    context.pool.token0(),
    context.pool.token1(),
    context.pool.token0Decimals(),
    context.pool.token1Decimals(),
    context.pool.scale0(),
    context.pool.scale1(),
    context.pool.feeBps(),
    context.pool.feeVault(),
    context.pool.bootstrapper(),
    context.pool.lpToken(),
    context.pool.initialized(),
    context.pool.protocolFeeSwapCount0(),
    context.pool.protocolFeeSwapCount1(),
    context.pool.protocolFeeWindowStart0(),
    context.pool.protocolFeeWindowStart1(),
    context.pool.nextLockNonce(),
    context.token0.balanceOf.staticCall(context.address),
    context.token1.balanceOf.staticCall(context.address),
  ]);
  return {
    protocolVersion: String(protocolVersion),
    privacyMode: String(privacyMode),
    token0: String(token0).toLowerCase(),
    token1: String(token1).toLowerCase(),
    token0Decimals: String(token0Decimals),
    token1Decimals: String(token1Decimals),
    scale0: String(scale0),
    scale1: String(scale1),
    feeBps: String(feeBps),
    feeVault: String(feeVault).toLowerCase(),
    bootstrapper: String(bootstrapper).toLowerCase(),
    lpToken: String(lpToken).toLowerCase(),
    initialized: Boolean(initialized),
    feeCount0: String(feeCount0),
    feeCount1: String(feeCount1),
    feeWindow0: String(feeWindow0),
    feeWindow1: String(feeWindow1),
    nextLockNonce: String(nextLockNonce),
    token0Balance: ciphertextKey(token0Balance),
    token1Balance: ciphertextKey(token1Balance),
  };
}

async function snapshots(
  contexts: readonly PoolContext[],
): Promise<Map<string, PublicPoolSnapshot>> {
  return new Map(
    await Promise.all(
      contexts.map(async (context) => [context.address, await poolSnapshot(context)] as const),
    ),
  );
}

function requireSnapshotsEqual(
  before: ReadonlyMap<string, PublicPoolSnapshot>,
  after: ReadonlyMap<string, PublicPoolSnapshot>,
  label: string,
): void {
  for (const [address, expected] of before) {
    const actual = after.get(address);
    if (!actual || JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`${label} changed pool state`);
    }
  }
}

async function loadPool(address: string, wallet: CotiWallet): Promise<PoolContext> {
  const pool = new Contract(address, CONFIDENTIAL_POOL_TESTNET_ABI, wallet);
  const [token0Address, token1Address, token0Decimals, token1Decimals, feeBps] = await Promise.all([
    pool.token0(),
    pool.token1(),
    pool.token0Decimals(),
    pool.token1Decimals(),
    pool.feeBps(),
  ]);
  return {
    address: ethersLibrary.getAddress(address),
    feeBps: Number(feeBps),
    pool,
    token0Address: ethersLibrary.getAddress(String(token0Address)),
    token1Address: ethersLibrary.getAddress(String(token1Address)),
    token0: new Contract(String(token0Address), PRIVATE_ERC20_TESTNET_ABI, wallet),
    token1: new Contract(String(token1Address), PRIVATE_ERC20_TESTNET_ABI, wallet),
    token0Decimals: Number(token0Decimals),
    token1Decimals: Number(token1Decimals),
    model: {
      reserve0: 0n,
      reserve1: 0n,
      protocolFee0: 0n,
      protocolFee1: 0n,
    },
  };
}

async function createPool(
  factory: any,
  wallet: CotiWallet,
  tokenA: string,
  tokenB: string,
  decimalsA: number,
  decimalsB: number,
  feeBps: number,
): Promise<PoolContext> {
  const creation = await submit(
    `create canonical ${feeBps} bps pool`,
    () => factory.createPool(
      tokenA,
      tokenB,
      decimalsA,
      decimalsB,
      feeBps,
      { gasLimit: CREATE_POOL_GAS_LIMIT },
    ),
  );
  const key = await factory.poolKey(
    tokenA,
    tokenB,
    decimalsA,
    decimalsB,
    feeBps,
  );
  const address = ethersLibrary.getAddress(await factory.getPool(key));
  if (address === ethersLibrary.ZeroAddress || !(await factory.isPool(address))) {
    throw new Error("factory did not register the canonical pool");
  }
  const context = await loadPool(address, wallet);
  journal().recordResource({
    id: `pool-${feeBps}`,
    kind: "confidential-pool",
    address,
    creationTransactionHash: creation.hash,
    metadata: {
      factoryAddress: ethersLibrary.getAddress(String(factory.target)),
      token0Address: context.token0Address,
      token1Address: context.token1Address,
      decimals0: context.token0Decimals,
      decimals1: context.token1Decimals,
      feeBps,
    },
  });
  return context;
}

async function initializePool(
  context: PoolContext,
  wallet: CotiWallet,
  tokenA: string,
  amountA: bigint,
  amountB: bigint,
): Promise<void> {
  const owner = await wallet.getAddress();
  const amount0 = context.token0Address.toLowerCase() === tokenA.toLowerCase()
    ? amountA
    : amountB;
  const amount1 = context.token1Address.toLowerCase() === tokenA.toLowerCase()
    ? amountA
    : amountB;
  const [before0, before1] = await Promise.all([
    privateBalance(context.token0, wallet, owner),
    privateBalance(context.token1, wallet, owner),
  ]);
  await setExactAllowance(
    context.token0,
    wallet,
    context.token0Address,
    context.address,
    amount0,
    `${context.feeBps} bps token0 liquidity approval`,
  );
  await setExactAllowance(
    context.token1,
    wallet,
    context.token1Address,
    context.address,
    amount1,
    `${context.feeBps} bps token1 liquidity approval`,
  );

  const selector = context.pool.interface.getFunction("addLiquidity")?.selector;
  if (!selector) throw new Error("add-liquidity selector unavailable");
  const bounds = confidentialLiquidityBounds(
    amount0,
    context.token0Decimals,
    amount1,
    context.token1Decimals,
    false,
  );
  const [input0, input1, minimum, minimumPrice, maximumPrice] = await Promise.all([
    wallet.encryptValue256(amount0, context.address, selector),
    wallet.encryptValue256(amount1, context.address, selector),
    wallet.encryptValue256(bounds.minShares, context.address, selector),
    wallet.encryptValue256(bounds.minPriceX18, context.address, selector),
    wallet.encryptValue256(bounds.maxPriceX18, context.address, selector),
  ]);
  await submit(
    `initialize canonical ${context.feeBps} bps pool`,
    () => context.pool.addLiquidity(
      input0,
      input1,
      minimum,
      minimumPrice,
      maximumPrice,
      false,
      deadline(),
      { gasLimit: CALL_GAS_LIMIT },
    ),
  );
  const [after0, after1] = await Promise.all([
    privateBalance(context.token0, wallet, owner),
    privateBalance(context.token1, wallet, owner),
  ]);
  if (
    before0 - after0 !== amount0 ||
    before1 - after1 !== amount1 ||
    !(await context.pool.initialized())
  ) {
    throw new Error("pool initialization did not consume exact liquidity");
  }
  context.model.reserve0 = amount0;
  context.model.reserve1 = amount1;
}

async function removeAllLiquidity(
  context: PoolContext,
  wallet: CotiWallet,
  recoveryFloor = false,
): Promise<void> {
  const owner = await wallet.getAddress();
  const shares = await privateShares(context, wallet);
  if (shares <= 0n) throw new Error(`${context.feeBps} bps pool has no removable LP shares`);
  const selector = context.pool.interface.getFunction("removeLiquidity")?.selector;
  if (!selector) throw new Error("remove-liquidity selector unavailable");
  if (!recoveryFloor && (context.model.reserve0 <= 0n || context.model.reserve1 <= 0n)) {
    throw new Error(`${context.feeBps} bps pool has no positive modeled exit bounds`);
  }
  const minimum0 = recoveryFloor ? 1n : minimumWithSlippage(context.model.reserve0);
  const minimum1 = recoveryFloor ? 1n : minimumWithSlippage(context.model.reserve1);
  if (minimum0 <= 0n || minimum1 <= 0n) {
    throw new Error(`${context.feeBps} bps pool cleanup minimum is not positive`);
  }
  const [encryptedShares, encryptedMinimum0, encryptedMinimum1] = await Promise.all([
    wallet.encryptValue256(shares, context.address, selector),
    wallet.encryptValue256(minimum0, context.address, selector),
    wallet.encryptValue256(minimum1, context.address, selector),
  ]);
  await submit(
    `full cleanup exit for ${context.feeBps} bps pool`,
    () => context.pool.removeLiquidity(
      encryptedShares,
      encryptedMinimum0,
      encryptedMinimum1,
      deadline(),
      { gasLimit: CALL_GAS_LIMIT },
    ),
  );

  const [sharesAfter, initialized, balance0, balance1, allowance0, allowance1] =
    await Promise.all([
      privateShares(context, wallet),
      context.pool.initialized(),
      privateBalance(context.token0, wallet, context.address),
      privateBalance(context.token1, wallet, context.address),
      privateAllowance(context.token0, wallet, owner, context.address),
      privateAllowance(context.token1, wallet, owner, context.address),
    ]);
  if (
    sharesAfter !== 0n ||
    Boolean(initialized) ||
    balance0 !== 0n ||
    balance1 !== 0n ||
    allowance0 !== 0n ||
    allowance1 !== 0n
  ) {
    throw new Error(`${context.feeBps} bps pool cleanup left shares, assets, or allowances`);
  }
  context.model.reserve0 = 0n;
  context.model.reserve1 = 0n;
  context.model.protocolFee0 = 0n;
  context.model.protocolFee1 = 0n;
}

async function recoverJournalPools(): Promise<void> {
  if (!recoveryJournal || !recoveryWallet) return;
  for (const resource of recoveryJournal.activeResources) {
    await verifyRecoveryResourceCreation(recoveryJournal, resource, ethers.provider);
    if (resource.kind !== "confidential-pool") {
      throw new Error(`unsupported active recovery resource ${resource.kind}`);
    }
    const factoryAddress = String(resource.metadata.factoryAddress ?? "");
    const token0Address = String(resource.metadata.token0Address ?? "");
    const token1Address = String(resource.metadata.token1Address ?? "");
    const feeBps = Number(resource.metadata.feeBps);
    if (
      !ethersLibrary.isAddress(factoryAddress) ||
      !ethersLibrary.isAddress(token0Address) ||
      !ethersLibrary.isAddress(token1Address) ||
      !FEE_TIERS.includes(feeBps as (typeof FEE_TIERS)[number])
    ) throw new Error("funded recovery pool metadata is invalid");

    await verifyDeployedRuntimeArtifact("ConfidentialCPMM", resource.address);
    const factory = new Contract(
      factoryAddress,
      CONFIDENTIAL_FACTORY_TESTNET_ABI,
      ethers.provider,
    );
    if (!(await factory.isPool(resource.address))) {
      throw new Error("funded recovery resource is not canonical to its recorded factory");
    }
    const context = await loadPool(resource.address, recoveryWallet);
    if (
      context.feeBps !== feeBps ||
      context.token0Address.toLowerCase() !== token0Address.toLowerCase() ||
      context.token1Address.toLowerCase() !== token1Address.toLowerCase() ||
      String(await context.pool.bootstrapper()).toLowerCase() !== factoryAddress.toLowerCase()
    ) throw new Error("funded recovery pool provenance changed");

    const shares = await privateShares(context, recoveryWallet);
    if (shares > 0n) {
      await removeAllLiquidity(context, recoveryWallet, true);
    } else {
      const [balance0, balance1] = await Promise.all([
        privateBalance(context.token0, recoveryWallet, context.address),
        privateBalance(context.token1, recoveryWallet, context.address),
      ]);
      if (balance0 !== 0n || balance1 !== 0n) {
        throw new Error("funded recovery pool holds assets without recoverable LP shares");
      }
    }
    recoveryJournal.markRecovered(resource.id);
  }
}

function bestResultFromReceipt(
  router: Contract,
  receipt: TransactionReceipt,
  eventName: "ConfidentialBestQuoteResult" | "ConfidentialBestSwapResult",
  caller: string,
  requestId: string,
): BestResult {
  const routerAddress = String(router.target).toLowerCase();
  const matches: BestResult[] = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== routerAddress) continue;
    try {
      const parsed = router.interface.parseLog(log);
      if (
        parsed?.name === eventName &&
        String(parsed.args.caller).toLowerCase() === caller.toLowerCase() &&
        String(parsed.args.requestId).toLowerCase() === requestId.toLowerCase()
      ) {
        matches.push({
          selectedPool: ethersLibrary.getAddress(String(parsed.args.selectedPool)),
          selectedFeeBps: Number(parsed.args.selectedFeeBps),
          zeroForOne: Boolean(parsed.args.zeroForOne),
          encryptedResult: parsed.args.result,
        });
      }
    } catch {
      // Ignore logs from COTI token and pool contracts.
    }
  }
  if (matches.length !== 1) {
    throw new Error(`${eventName} is missing or ambiguous`);
  }
  return matches[0]!;
}

async function requestBestQuote(
  routerAddress: string,
  wallet: CotiWallet,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  label: string,
  contexts: readonly PoolContext[],
): Promise<QuoteExecution> {
  const router = new Contract(
    routerAddress,
    CONFIDENTIAL_BEST_EXECUTION_ROUTER_TESTNET_ABI,
    wallet,
  );
  const selector = router.interface.getFunction("requestBestQuoteExactInput")?.selector;
  if (!selector) throw new Error("best-quote selector unavailable");
  const requestId = nextRequestId(label);
  const input = await wallet.encryptValue256(amountIn, routerAddress, selector);
  const caller = await wallet.getAddress();
  const inputToken = new Contract(tokenIn, PRIVATE_ERC20_TESTNET_ABI, wallet);
  const outputToken = new Contract(tokenOut, PRIVATE_ERC20_TESTNET_ABI, wallet);
  const [inputBalanceBefore, outputBalanceBefore, poolStateBefore] = await Promise.all([
    privateBalance(inputToken, wallet, caller),
    privateBalance(outputToken, wallet, caller),
    snapshots(contexts),
  ]);
  const transaction = await submit(
    label,
    () => router.requestBestQuoteExactInput(
      tokenIn,
      tokenOut,
      input,
      requestId,
      deadline(),
      { gasLimit: CALL_GAS_LIMIT },
    ),
  );
  const result = bestResultFromReceipt(
    router,
    transaction.receipt,
    "ConfidentialBestQuoteResult",
    caller,
    requestId,
  );
  const amountOut = await wallet.decryptValue256(result.encryptedResult as never);
  const [inputBalanceAfter, outputBalanceAfter, poolStateAfter] = await Promise.all([
    privateBalance(inputToken, wallet, caller),
    privateBalance(outputToken, wallet, caller),
    snapshots(contexts),
  ]);
  if (
    amountOut <= 0n ||
    inputBalanceAfter !== inputBalanceBefore ||
    outputBalanceAfter !== outputBalanceBefore
  ) {
    throw new Error("best quote moved funds or returned an invalid result");
  }
  requireSnapshotsEqual(poolStateBefore, poolStateAfter, label);
  const forbiddenLogAddresses = new Set(
    [tokenIn, tokenOut, ...contexts.map((context) => context.address)]
      .map((address) => address.toLowerCase()),
  );
  if (
    transaction.receipt.logs.some((log) =>
      forbiddenLogAddresses.has(log.address.toLowerCase()))
  ) {
    throw new Error("best quote emitted a token or pool event");
  }
  return { ...result, amountOut, input, requestId, transaction };
}

async function assertRequestAndCiphertextGuards(
  routerAddress: string,
  quoteWallet: CotiWallet,
  secondWallet: CotiWallet,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  successfulQuote: QuoteExecution,
): Promise<void> {
  const quoteRouter = new Contract(
    routerAddress,
    CONFIDENTIAL_BEST_EXECUTION_ROUTER_TESTNET_ABI,
    quoteWallet,
  );
  const selector = quoteRouter.interface.getFunction("requestBestQuoteExactInput")!.selector;
  const freshInput = await quoteWallet.encryptValue256(
    amountIn,
    routerAddress,
    selector,
  );
  await expectFailure("best quote request-id replay", () =>
    quoteRouter.requestBestQuoteExactInput(
      tokenIn,
      tokenOut,
      freshInput,
      successfulQuote.requestId,
      deadline(),
      { gasLimit: CALL_GAS_LIMIT },
    ),
  );
  await expectFailure("best quote ciphertext replay", () =>
    quoteRouter.requestBestQuoteExactInput(
      tokenIn,
      tokenOut,
      successfulQuote.input,
      nextRequestId("ciphertext-replay"),
      deadline(),
      { gasLimit: CALL_GAS_LIMIT },
    ),
  );

  const expiredRequestId = nextRequestId("expired");
  const expiredInput = await quoteWallet.encryptValue256(
    amountIn,
    routerAddress,
    selector,
  );
  await expectFailure("best quote expired deadline", () =>
    quoteRouter.requestBestQuoteExactInput(
      tokenIn,
      tokenOut,
      expiredInput,
      expiredRequestId,
      deadline(-1),
      { gasLimit: CALL_GAS_LIMIT },
    ),
  );
  if (await quoteRouter.usedRequestIds(
    await quoteWallet.getAddress(),
    selector,
    expiredRequestId,
  )) {
    throw new Error("expired request consumed its request ID");
  }

  const primaryBoundInput = await quoteWallet.encryptValue256(
    amountIn,
    routerAddress,
    selector,
  );
  const secondRouter = quoteRouter.connect(secondWallet) as Contract;
  await expectFailure("caller-bound ciphertext isolation", () =>
    secondRouter.requestBestQuoteExactInput(
      tokenIn,
      tokenOut,
      primaryBoundInput,
      nextRequestId("caller-binding"),
      deadline(),
      { gasLimit: CALL_GAS_LIMIT },
    ),
  );
}

async function swapWithRollbackProof(
  routerAddress: string,
  wallet: CotiWallet,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  quote: QuoteExecution,
  expectedTier: number,
  contexts: readonly PoolContext[],
  label: string,
): Promise<Submitted> {
  const caller = await wallet.getAddress();
  const inputToken = new Contract(tokenIn, PRIVATE_ERC20_TESTNET_ABI, wallet);
  const outputToken = new Contract(tokenOut, PRIVATE_ERC20_TESTNET_ABI, wallet);
  const router = new Contract(
    routerAddress,
    CONFIDENTIAL_BEST_EXECUTION_ROUTER_TESTNET_ABI,
    wallet,
  );
  const selector = router.interface.getFunction("swapBestExactInput")?.selector;
  if (!selector) throw new Error("best-swap selector unavailable");
  await setExactAllowance(
    inputToken,
    wallet,
    tokenIn,
    routerAddress,
    amountIn,
    `${label} router approval`,
  );
  const [balanceInBefore, balanceOutBefore, poolStateBefore] = await Promise.all([
    privateBalance(inputToken, wallet, caller),
    privateBalance(outputToken, wallet, caller),
    snapshots(contexts),
  ]);
  const requestId = nextRequestId(label);
  const [input, excessiveMinimum] = await Promise.all([
    wallet.encryptValue256(amountIn, routerAddress, selector),
    wallet.encryptValue256(quote.amountOut + 1n, routerAddress, selector),
  ]);
  await expectFailure(`${label} encrypted slippage rollback`, () =>
    router.swapBestExactInput(
      tokenIn,
      tokenOut,
      input,
      excessiveMinimum,
      requestId,
      deadline(),
      { gasLimit: CALL_GAS_LIMIT },
    ),
  );
  const [balanceInAfterFailure, balanceOutAfterFailure, poolStateAfterFailure] =
    await Promise.all([
      privateBalance(inputToken, wallet, caller),
      privateBalance(outputToken, wallet, caller),
      snapshots(contexts),
    ]);
  if (
    balanceInAfterFailure !== balanceInBefore ||
    balanceOutAfterFailure !== balanceOutBefore ||
    await privateAllowance(inputToken, wallet, caller, routerAddress) !== amountIn ||
    await router.usedRequestIds(caller, selector, requestId)
  ) {
    throw new Error("failed best swap did not roll back atomically");
  }
  requireSnapshotsEqual(poolStateBefore, poolStateAfterFailure, label);

  const minimum = await wallet.encryptValue256(
    quote.amountOut,
    routerAddress,
    selector,
  );
  const transaction = await submit(
    label,
    () => router.swapBestExactInput(
      tokenIn,
      tokenOut,
      input,
      minimum,
      requestId,
      deadline(),
      { gasLimit: CALL_GAS_LIMIT },
    ),
  );
  const result = bestResultFromReceipt(
    router,
    transaction.receipt,
    "ConfidentialBestSwapResult",
    caller,
    requestId,
  );
  const actualOutput = await wallet.decryptValue256(result.encryptedResult as never);
  const [balanceInAfter, balanceOutAfter, allowanceAfter] = await Promise.all([
    privateBalance(inputToken, wallet, caller),
    privateBalance(outputToken, wallet, caller),
    privateAllowance(inputToken, wallet, caller, routerAddress),
  ]);
  if (
    result.selectedPool.toLowerCase() !== quote.selectedPool.toLowerCase() ||
    result.selectedFeeBps !== expectedTier ||
    actualOutput !== quote.amountOut ||
    balanceInBefore - balanceInAfter !== amountIn ||
    balanceOutAfter - balanceOutBefore !== actualOutput ||
    allowanceAfter !== 0n
  ) {
    throw new Error("best swap violated quote parity or exact escrow accounting");
  }

  const selectedContext = contexts.find(
    (context) => context.address.toLowerCase() === result.selectedPool.toLowerCase(),
  );
  if (!selectedContext) throw new Error("selected pool was not canonical");
  if (selectedContext.feeBps !== result.selectedFeeBps) {
    throw new Error("selected pool fee does not match the router result");
  }
  const selectedPoolLogs = transaction.receipt.logs.filter(
    (log) => contexts.some(
      (context) => context.address.toLowerCase() === log.address.toLowerCase(),
    ),
  );
  if (
    selectedPoolLogs.length !== 1 ||
    selectedPoolLogs[0].address.toLowerCase() !== selectedContext.address.toLowerCase()
  ) {
    throw new Error("best swap touched an unselected candidate pool");
  }
  const protocolFee = modeledProtocolFee(amountIn, selectedContext.feeBps);
  if (tokenIn.toLowerCase() === selectedContext.token0Address.toLowerCase()) {
    if (actualOutput >= selectedContext.model.reserve1) {
      throw new Error("modeled selected-pool token1 reserve was exhausted");
    }
    selectedContext.model.reserve0 += amountIn - protocolFee;
    selectedContext.model.reserve1 -= actualOutput;
    selectedContext.model.protocolFee0 += protocolFee;
  } else if (tokenIn.toLowerCase() === selectedContext.token1Address.toLowerCase()) {
    if (actualOutput >= selectedContext.model.reserve0) {
      throw new Error("modeled selected-pool token0 reserve was exhausted");
    }
    selectedContext.model.reserve1 += amountIn - protocolFee;
    selectedContext.model.reserve0 -= actualOutput;
    selectedContext.model.protocolFee1 += protocolFee;
  } else {
    throw new Error("selected pool does not contain the input token");
  }
  return transaction;
}

async function main(): Promise<void> {
  stage = "current artifacts compiled";

  const primaryKey = requiredPrivateKey("COTI_TESTNET_PRIVATE_KEY");
  const primaryAes = requiredAesKey("COTI_AES_KEY");
  const secondKey = requiredPrivateKey("COTI_SECOND_LP_PRIVATE_KEY");
  const secondAes = requiredAesKey("COTI_SECOND_LP_AES_KEY");
  const quoteKey = requiredPrivateKey("COTI_QUOTE_PRIVATE_KEY");
  const quoteAes = requiredAesKey("COTI_QUOTE_AES_KEY");
  const tokenAAddress = requiredAddress("COTI_TOKEN0");
  const tokenBAddress = requiredAddress("COTI_TOKEN1");
  const feeBeneficiary = requiredAddress("CIPHERDEX_FEE_BENEFICIARY");
  const factoryAddress = requiredAddress("COTI_FACTORY");
  const feeVaultAddress = requiredAddress("COTI_FEE_VAULT");
  const routerAddress = requiredAddress("COTI_BEST_EXECUTION_ROUTER");

  stage = "wallet and network initialization";
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(`expected COTI testnet ${EXPECTED_CHAIN_ID}, received ${network.chainId}`);
  }
  const primary = new CotiWallet(primaryKey, ethers.provider, { aesKey: primaryAes });
  const second = new CotiWallet(secondKey, ethers.provider, { aesKey: secondAes });
  const quoteWallet = new CotiWallet(quoteKey, ethers.provider, { aesKey: quoteAes });
  primary.setAesKey(primaryAes);
  second.setAesKey(secondAes);
  quoteWallet.setAesKey(quoteAes);
  const primaryAddress = await primary.getAddress();
  const secondAddress = await second.getAddress();
  const quoteAddress = await quoteWallet.getAddress();
  if (primaryAddress === quoteAddress) throw new Error("quote identity must be distinct");

  stage = "canonical deployment provenance";
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
        address: routerAddress,
      },
    ],
  );
  assertReviewedPrivateTokens(deploymentRecord, [tokenAAddress, tokenBAddress]);
  const sourceCommit = deploymentRecord.sourceCommit;
  recoveryJournal = FundedRecoveryJournal.open({
    runner: "best-execution",
    sourceCommit,
    chainId: Number(network.chainId),
    owner: primaryAddress,
    deployment: await createFundedDeploymentBinding(deploymentRecord),
  });
  recoveryWallet = primary;
  const unresolved = await recoveryJournal.reconcileTransactions(ethers.provider);
  if (unresolved.length > 0) {
    throw new Error(
      `funded recovery has ${unresolved.length} transaction(s) with unknown outcome; do not retry`,
    );
  }
  await recoverJournalPools();


  const tokenA = new Contract(tokenAAddress, PRIVATE_ERC20_TESTNET_ABI, primary);
  const tokenB = new Contract(tokenBAddress, PRIVATE_ERC20_TESTNET_ABI, primary);
  const [decimalsAValue, decimalsBValue] = await Promise.all([
    tokenA.decimals(),
    tokenB.decimals(),
  ]);
  const decimalsA = Number(decimalsAValue);
  const decimalsB = Number(decimalsBValue);
  if (
    !Number.isInteger(decimalsA) ||
    !Number.isInteger(decimalsB) ||
    decimalsA < 0 ||
    decimalsB < 0 ||
    decimalsA > 18 ||
    decimalsB > 18
  ) throw new Error("unsupported private token decimals");
  const unitA = 10n ** BigInt(decimalsA);
  const unitB = 10n ** BigInt(decimalsB);
  const swapA = optionalPositiveAmount(
    "COTI_BEST_EXECUTION_SWAP_AMOUNT",
    unitA / 1_000n > 20_000n ? unitA / 1_000n : 20_000n,
  );
  const swapB = optionalPositiveAmount(
    "COTI_BEST_EXECUTION_SWAP_AMOUNT",
    unitB / 1_000n > 20_000n ? unitB / 1_000n : 20_000n,
  );

  const pool5LiquidityA = 2n * unitA;
  const pool5LiquidityB = unitB;
  const pool30LiquidityB = 2n * unitB;
  const tiedOutput = modeledAmountOut(
    swapB,
    pool5LiquidityB,
    pool5LiquidityA,
    5,
  );
  const pool30LiquidityA = reserveOutForExactQuote(
    tiedOutput,
    swapB,
    pool30LiquidityB,
    30,
    5n * unitA,
  );
  const pool100LiquidityB = 2n * unitB;
  const pool100LiquidityA = reserveOutForExactQuote(
    tiedOutput + 1n,
    swapB,
    pool100LiquidityB,
    100,
    pool30LiquidityA,
  );
  const pool100AfterInitialSwap = modeledPostSwapReserves(
    swapB,
    pool100LiquidityB,
    pool100LiquidityA,
    100,
  );
  if (
    modeledAmountOut(swapB, pool30LiquidityB, pool30LiquidityA, 30) !== tiedOutput ||
    modeledAmountOut(swapB, pool100LiquidityB, pool100LiquidityA, 100) !== tiedOutput + 1n ||
    modeledAmountOut(
      swapB,
      pool100AfterInitialSwap.reserveIn,
      pool100AfterInitialSwap.reserveOut,
      100,
    ) >= tiedOutput
  ) throw new Error("funded tier-selection witness is inconsistent");

  const [balanceA, balanceB] = await Promise.all([
    privateBalance(tokenA, primary, primaryAddress),
    privateBalance(tokenB, primary, primaryAddress),
  ]);
  const requiredA = pool5LiquidityA + pool30LiquidityA + pool100LiquidityA + 3n * swapA;
  const requiredB = pool5LiquidityB + pool30LiquidityB + pool100LiquidityB + 5n * swapB;
  if (balanceA < requiredA || balanceB < requiredB) {
    throw new Error("primary test identity lacks the required private liquidity");
  }

  stage = "disposable best-execution stack deployment";
  const codehashes = await resolvePrivateTokenCodehashes(
    ethers.provider,
    [tokenAAddress, tokenBAddress],
  );
  const feeVaultDeployment = await deployContract(
    "CipherDEXFeeVault",
    primary,
    [feeBeneficiary],
    1_000_000n,
  );
  const lpFactoryDeployment = await deployContract(
    "PrivateLPTokenFactory",
    primary,
    [],
    8_000_000n,
  );
  const factoryDeployment = await deployContract(
    "ConfidentialCPMMFactory",
    primary,
    [feeVaultDeployment.address, lpFactoryDeployment.address, codehashes],
    8_000_000n,
  );
  const factory = factoryDeployment.contract;
  await submit(
    "bind disposable confidential fee vault",
    () => feeVaultDeployment.contract.setConfidentialFactory(factoryDeployment.address, {
      gasLimit: 500_000n,
    }),
  );
  const routerDeployment = await deployContract(
    "ConfidentialBestExecutionRouter",
    primary,
    [factoryDeployment.address],
    3_000_000n,
  );
  await submit(
    "bind disposable best-execution router",
    () => factory.setBestExecutionRouter(routerDeployment.address, {
      gasLimit: 500_000n,
    }),
  );
  const router = routerDeployment.contract;
  const [
    configuredVault,
    configuredRouter,
    configuredBeneficiary,
    configuredVaultFactory,
    configuredRouterFactory,
    configuredRouterVersion,
    tokenAApproved,
    tokenBApproved,
  ] = await Promise.all([
    factory.feeVault(),
    factory.bestExecutionRouter(),
    feeVaultDeployment.contract.beneficiary(),
    feeVaultDeployment.contract.confidentialFactory(),
    router.factory(),
    router.PROTOCOL_VERSION(),
    factory.isApprovedPrivateToken(tokenAAddress),
    factory.isApprovedPrivateToken(tokenBAddress),
  ]);
  if (
    ethersLibrary.getAddress(String(configuredVault)) !== feeVaultDeployment.address ||
    ethersLibrary.getAddress(String(configuredRouter)) !== routerDeployment.address ||
    ethersLibrary.getAddress(String(configuredBeneficiary)) !== feeBeneficiary ||
    ethersLibrary.getAddress(String(configuredVaultFactory)) !== factoryDeployment.address ||
    ethersLibrary.getAddress(String(configuredRouterFactory)) !== factoryDeployment.address ||
    BigInt(configuredRouterVersion) !== 1n ||
    !tokenAApproved ||
    !tokenBApproved
  ) throw new Error("canonical deployment binding verification failed");

  const pool30 = await createPool(
    factory,
    primary,
    tokenAAddress,
    tokenBAddress,
    decimalsA,
    decimalsB,
    30,
  );
  const pool100 = await createPool(
    factory,
    primary,
    tokenAAddress,
    tokenBAddress,
    decimalsA,
    decimalsB,
    100,
  );
  await initializePool(
    pool30,
    primary,
    tokenAAddress,
    pool30LiquidityA,
    pool30LiquidityB,
  );
  await initializePool(
    pool100,
    primary,
    tokenAAddress,
    pool100LiquidityA,
    pool100LiquidityB,
  );
  const twoPools = [pool30, pool100] as const;

  const absentTierQuote = await requestBestQuote(
    routerDeployment.address,
    quoteWallet,
    tokenBAddress,
    tokenAAddress,
    swapB,
    "two-candidate quote with absent tier",
    twoPools,
  );
  if (absentTierQuote.selectedFeeBps !== 100) {
    throw new Error("two-candidate quote selected the wrong fee tier");
  }

  const pool5 = await createPool(
    factory,
    primary,
    tokenAAddress,
    tokenBAddress,
    decimalsA,
    decimalsB,
    5,
  );
  const allPools = [pool5, pool30, pool100] as const;
  const uninitializedTierQuote = await requestBestQuote(
    routerDeployment.address,
    quoteWallet,
    tokenBAddress,
    tokenAAddress,
    swapB,
    "two-candidate quote with uninitialized tier",
    allPools,
  );
  if (uninitializedTierQuote.selectedFeeBps !== 100) {
    throw new Error("uninitialized candidate was not isolated");
  }
  await assertRequestAndCiphertextGuards(
    routerDeployment.address,
    quoteWallet,
    second,
    tokenBAddress,
    tokenAAddress,
    swapB,
    uninitializedTierQuote,
  );
  const twoCandidateSwap = await swapWithRollbackProof(
    routerDeployment.address,
    primary,
    tokenBAddress,
    tokenAAddress,
    swapB,
    uninitializedTierQuote,
    100,
    allPools,
    "two-candidate quote-plus-swap",
  );

  await initializePool(
    pool5,
    primary,
    tokenAAddress,
    pool5LiquidityA,
    pool5LiquidityB,
  );
  const threeCandidateQuote = await requestBestQuote(
    routerDeployment.address,
    quoteWallet,
    tokenBAddress,
    tokenAAddress,
    swapB,
    "three-candidate quote",
    allPools,
  );
  if (threeCandidateQuote.selectedFeeBps !== 5) {
    throw new Error(
      `exact tied quote selected ${threeCandidateQuote.selectedFeeBps} bps instead of the lower tier`,
    );
  }
  const threeCandidateSwap = await swapWithRollbackProof(
    routerDeployment.address,
    primary,
    tokenBAddress,
    tokenAAddress,
    swapB,
    threeCandidateQuote,
    5,
    allPools,
    "three-candidate quote-plus-swap",
  );

  const postTieQuote = await requestBestQuote(
    routerDeployment.address,
    quoteWallet,
    tokenBAddress,
    tokenAAddress,
    swapB,
    "post-tie 30 bps selection quote",
    allPools,
  );
  if (postTieQuote.selectedFeeBps !== 30) {
    throw new Error("post-tie quote did not select the untouched 30 bps tier");
  }
  await swapWithRollbackProof(
    routerDeployment.address,
    primary,
    tokenBAddress,
    tokenAAddress,
    swapB,
    postTieQuote,
    30,
    allPools,
    "post-tie 30 bps quote-plus-swap",
  );

  const tinyQuote = await requestBestQuote(
    routerDeployment.address,
    quoteWallet,
    tokenBAddress,
    tokenAAddress,
    501n,
    "encrypted-invalid candidate isolation quote",
    allPools,
  );
  if (tinyQuote.selectedFeeBps !== 100) {
    throw new Error("encrypted-invalid candidates blocked the viable tier");
  }

  const reverseQuote = await requestBestQuote(
    routerDeployment.address,
    quoteWallet,
    tokenAAddress,
    tokenBAddress,
    swapA,
    "reverse three-candidate quote",
    allPools,
  );
  if (!FEE_TIERS.includes(reverseQuote.selectedFeeBps as 5 | 30 | 100)) {
    throw new Error("reverse quote selected an unsupported tier");
  }
  await swapWithRollbackProof(
    routerDeployment.address,
    primary,
    tokenAAddress,
    tokenBAddress,
    swapA,
    reverseQuote,
    reverseQuote.selectedFeeBps,
    allPools,
    "reverse three-candidate quote-plus-swap",
  );

  stage = "disposable candidate cleanup";
  for (const context of allPools) {
    await removeAllLiquidity(context, primary);
    recoveryJournal.markRecovered(`pool-${context.feeBps}`);
  }
  const expectedProtocolFeeA = modeledProtocolFee(swapA, reverseQuote.selectedFeeBps);
  const expectedProtocolFeeB =
    modeledProtocolFee(swapB, 100) +
    modeledProtocolFee(swapB, 5) +
    modeledProtocolFee(swapB, 30);
  const [finalBalanceA, finalBalanceB] = await Promise.all([
    privateBalance(tokenA, primary, primaryAddress),
    privateBalance(tokenB, primary, primaryAddress),
  ]);
  if (
    finalBalanceA !== balanceA - expectedProtocolFeeA ||
    finalBalanceB !== balanceB - expectedProtocolFeeB
  ) {
    throw new Error("candidate cleanup produced an unexplained private-token balance delta");
  }

  console.log(`confidentialFactory=${factoryDeployment.address}`);
  console.log(`confidentialBestExecutionRouter=${routerDeployment.address}`);
  for (const context of allPools) {
    console.log(`canonicalPool feeBps=${context.feeBps} address=${context.address}`);
  }
  console.log(
    `benchmark candidates=2 quoteGas=${uninitializedTierQuote.transaction.gasUsed} ` +
      `quoteSwapGas=${twoCandidateSwap.gasUsed}`,
  );
  console.log(
    `benchmark candidates=3 quoteGas=${threeCandidateQuote.transaction.gasUsed} ` +
      `quoteSwapGas=${threeCandidateSwap.gasUsed}`,
  );
  console.log(
    "COTI testnet production best execution passed: canonical discovery, paid quote-only, " +
      "private selection, exact lower-tier tie-breaking, both directions, every v1 tier, encrypted candidate isolation, " +
      "caller/replay/deadline protection, atomic rollback, exact escrow, quote parity, full LP exits, and zero-residue cleanup",
  );
  const lpArtifacts = await Promise.all(allPools.map(async (context) => ({
    label: `${context.feeBps} bps private LP token`,
    contractName: "PrivateLPToken",
    address: ethersLibrary.getAddress(await context.pool.lpToken()),
  })));
  recoveryJournal.markRun("passed");
  const finalEvidence = await writeFundedRunEvidence({
    journal: recoveryJournal,
    provider: ethers.provider,
    participants: [primaryAddress, secondAddress, quoteAddress],
    configuration: {
      chainId: Number(network.chainId),
      confidentialPoolVersion: 2,
      routerVersion: 1,
      privacyMode: 1,
      quoteTransport: "paid-transaction",
      candidateTiers: "5,30,100",
      tokenA: tokenAAddress,
      tokenB: tokenBAddress,
      feeBeneficiary,
    },
    artifacts: [
      {
        label: "disposable fee vault",
        contractName: "CipherDEXFeeVault",
        address: feeVaultDeployment.address,
      },
      {
        label: "disposable private LP factory",
        contractName: "PrivateLPTokenFactory",
        address: lpFactoryDeployment.address,
      },
      {
        label: "disposable confidential factory",
        contractName: "ConfidentialCPMMFactory",
        address: factoryDeployment.address,
      },
      {
        label: "disposable best execution router",
        contractName: "ConfidentialBestExecutionRouter",
        address: routerDeployment.address,
      },
      ...allPools.map((context) => ({
        label: `${context.feeBps} bps canonical pool`,
        contractName: "ConfidentialCPMM",
        address: context.address,
      })),
      ...lpArtifacts,
    ],
    assertions: [
      "canonical candidates resolved from factory",
      "paid quote selected best encrypted output",
      "deterministic lower-tier tie break enforced",
      "quote-only pool state remained unchanged",
      "quote and settlement output parity enforced",
      "both swap directions exercised",
      "all approved fee tiers exercised",
      "request replay caller and deadline guards enforced",
      "slippage failure rolled back atomically",
      "router escrow and allowances returned to zero",
      "full LP exits used positive modeled minima",
      "disposable pools recovered with zero residue",
    ],
  });
  console.log(`fundedEvidence=${finalEvidence.path}`);
}

void main().catch(async (error: unknown) => {
  if (error instanceof UnknownBroadcastOutcomeError) {
    recoveryJournal?.markRun("failed");
    console.error(
      `COTI production best-execution validation paused with an uncertain broadcast: ` +
        `stage=${stage} ${safeTestnetErrorSummary(error)}; cleanup is deferred until receipt reconciliation.`,
    );
    process.exitCode = 1;
    return;
  }
  let reportedError = error;
  try {
    await recoverJournalPools();
    recoveryJournal?.markRun("failed");
  } catch (recoveryError) {
    recoveryJournal?.markRun("recovery-failed");
    reportedError = new AggregateError(
      [error, recoveryError],
      "best-execution validation and funded recovery both failed",
    );
  }
  console.error(
    `COTI production best-execution validation failed: stage=${stage} ` +
      safeTestnetErrorSummary(reportedError),
  );
  process.exitCode = 1;
});
