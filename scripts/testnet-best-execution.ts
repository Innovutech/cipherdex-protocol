import { Contract, TransactionReceipt, ethers as ethersLibrary } from "ethers";
import { artifacts, ethers } from "../hardhat/runtime.js";

import {
  buildConfidentialLaunchCommitment,
  buildConfidentialLaunchCommitCall,
  LAUNCH_COMMITMENT_EIP712_TYPES,
  LAUNCH_INITIALIZATION_EIP712_DOMAIN,
  LAUNCHPAD_MIGRATION_EIP712_TYPES,
  LAUNCHPAD_MIGRATOR_EIP712_DOMAIN,
} from "../sdk/src/index";
import {
  CONFIDENTIAL_BEST_EXECUTION_ROUTER_TESTNET_ABI,
  CONFIDENTIAL_FACTORY_TESTNET_ABI,
  CONFIDENTIAL_POOL_TESTNET_ABI,
  PRIVATE_ERC20_TESTNET_ABI,
} from "./coti-testnet-abi";
import { decryptPrivateValue256 } from "./coti-testnet-values";
import {
  type FundedRecoveryJournal,
  verifyRecoveryResourceCreation,
} from "./funded-recovery-journal";
import {
  BEST_EXECUTION_FUNDED_ASSERTIONS,
  preflightFundedRunConfiguration,
  writePreparedFundedRunEvidence,
} from "./funded-run-evidence";
import { createFundedDeploymentBinding } from "./funded-deployment-binding";
import {
  deriveFundedTestAmount,
  fundedScenarioCap,
  minimumInputWithProtocolFee,
} from "./funded-balance-budget";
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
import { confidentialLiquidityBounds, minimumWithSlippage } from "./testnet-slippage";
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
const FEE_VAULT_DEPLOY_GAS_LIMIT = 2_500_000n;
const POOL_DEPLOYER_DEPLOY_GAS_LIMIT = 5_000_000n;
const STRATEGY_REGISTRY_DEPLOY_GAS_LIMIT = 3_000_000n;
const INITIALIZATION_STRATEGY_DEPLOY_GAS_LIMIT = 5_000_000n;
const STACK_BIND_GAS_LIMIT = 500_000n;
const UINT64_MAX = (1n << 64n) - 1n;
const FEE_TIERS = [5, 30, 100] as const;
const MIXED_TWO_CANDIDATE_BITMAP = 0b001_010_000;
const MIXED_THREE_CANDIDATE_BITMAP = 0b001_010_001;
const STANDARD_30_BPS_CANDIDATE_BITMAP = 0b000_001_000;
const REFERENCE_PRIVATE_TOKEN = "0x6cE8907414986E73De9e7D28d62Ea2080F8E88E1";
const REFERENCE_PARTNER_TOKEN = "0xcef137e96edf68ee99d4cdea7085f154d74895cd";
const OLD_REFERENCE_CODEHASHES = new Set([
  "0xcd4b4b3329cd64190c49fdfbe7feb3b2a81cfcb50c36f50d4d603c76906589b2",
  "0xf5ce6496ad15db187e8fe1516468c34ed3740a2aab043fcec60be7b05a4a161c",
]);
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
  initializationStrategy: string;
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
  initializationStrategy: string;
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
    evidence = await withFundedTransactionEvidence(
      label,
      journal(),
      () => requireMinedSuccess(
        label,
        operation,
        (hash) => ethers.provider.getTransactionReceipt(hash),
      ),
    );
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

function ciphertextKey(value: unknown): string {
  const ciphertext = value as {
    ciphertextHigh?: bigint | number | string;
    ciphertextLow?: bigint | number | string;
  };
  return `${String(ciphertext.ciphertextHigh ?? "missing")}:` +
    String(ciphertext.ciphertextLow ?? "missing");
}

function inputCommitment(input: {
  ciphertext: { ciphertextHigh: bigint; ciphertextLow: bigint };
  signature: string | Uint8Array;
}): string {
  return ethersLibrary.keccak256(
    ethersLibrary.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "uint256", "bytes32"],
      [
        input.ciphertext.ciphertextHigh,
        input.ciphertext.ciphertextLow,
        ethersLibrary.keccak256(input.signature),
      ],
    ),
  );
}

function encryptedInputsHash(
  ...inputs: Parameters<typeof inputCommitment>[0][]
): string {
  return ethersLibrary.keccak256(
    ethersLibrary.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32", "bytes32", "bytes32", "bytes32"],
      inputs.map(inputCommitment),
    ),
  );
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
    initializationStrategy,
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
    context.pool.initializationStrategy(),
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
    initializationStrategy: String(initializationStrategy).toLowerCase(),
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
  const [
    token0Address,
    token1Address,
    token0Decimals,
    token1Decimals,
    feeBps,
    initializationStrategy,
  ] = await Promise.all([
    pool.token0(),
    pool.token1(),
    pool.token0Decimals(),
    pool.token1Decimals(),
    pool.feeBps(),
    pool.initializationStrategy(),
  ]);
  return {
    address: ethersLibrary.getAddress(address),
    feeBps: Number(feeBps),
    initializationStrategy: ethersLibrary.getAddress(String(initializationStrategy)),
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
    ethersLibrary.ZeroAddress,
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
  await setExactAllowance(
    context.token0, wallet, context.token0Address, context.address, 0n,
    `${context.feeBps} bps token0 post-liquidity cleanup`,
  );
  await setExactAllowance(
    context.token1, wallet, context.token1Address, context.address, 0n,
    `${context.feeBps} bps token1 post-liquidity cleanup`,
  );
  context.model.reserve0 = amount0;
  context.model.reserve1 = amount1;
}

async function initializeProtectedPool(
  factory: any,
  initializationStrategy: any,
  migrator: any,
  creator: CotiWallet,
  launchAuthority: CotiWallet,
  tokenA: string,
  tokenB: string,
  decimalsA: number,
  decimalsB: number,
  feeBps: number,
  amountA: bigint,
  amountB: bigint,
): Promise<PoolContext> {
  const creatorAddress = ethersLibrary.getAddress(await creator.getAddress());
  const authorityAddress = ethersLibrary.getAddress(await launchAuthority.getAddress());
  if (creatorAddress === authorityAddress) {
    throw new Error("protected launch creator and authority must be distinct");
  }
  const factoryAddress = ethersLibrary.getAddress(String(factory.target));
  const strategyAddress = ethersLibrary.getAddress(String(initializationStrategy.target));
  const migratorAddress = ethersLibrary.getAddress(String(migrator.target));
  const tokenAFirst = tokenA.toLowerCase() < tokenB.toLowerCase();
  const canonicalToken0 = ethersLibrary.getAddress(tokenAFirst ? tokenA : tokenB);
  const canonicalToken1 = ethersLibrary.getAddress(tokenAFirst ? tokenB : tokenA);
  const canonicalDecimals0 = tokenAFirst ? decimalsA : decimalsB;
  const canonicalDecimals1 = tokenAFirst ? decimalsB : decimalsA;
  const amount0 = tokenAFirst ? amountA : amountB;
  const amount1 = tokenAFirst ? amountB : amountA;
  const launchId = nextRequestId(`protected-${feeBps}-bps-launch`);
  const authorizationDeadline = deadline(1_200);
  const migrationDeadline = authorizationDeadline;
  const network = await ethers.provider.getNetwork();
  const commitment = buildConfidentialLaunchCommitment({
    launchId,
    creator: creatorAddress,
    tokenA,
    tokenB,
    decimalsA,
    decimalsB,
    feeBps,
    factory: factoryAddress,
    migrator: migratorAddress,
    initializationStrategy: strategyAddress,
    launchAuthority: authorityAddress,
    chainId: network.chainId,
    authorizationDeadline,
    migrationDeadline,
  });
  const launchDomain = {
    ...LAUNCH_INITIALIZATION_EIP712_DOMAIN,
    chainId: network.chainId,
    verifyingContract: strategyAddress,
  };
  const [creatorAuthorization, authorityAuthorization] = await Promise.all([
    creator.signTypedData(
      launchDomain,
      { LaunchCommitment: [...LAUNCH_COMMITMENT_EIP712_TYPES] },
      commitment,
    ),
    launchAuthority.signTypedData(
      launchDomain,
      { LaunchCommitment: [...LAUNCH_COMMITMENT_EIP712_TYPES] },
      commitment,
    ),
  ]);
  const call = buildConfidentialLaunchCommitCall(
    commitment,
    creatorAuthorization,
    authorityAuthorization,
  );
  const [predictedPoolValue, commitmentHash] = await initializationStrategy
    .commitLaunch.staticCall(...call.args);
  const predictedPool = ethersLibrary.getAddress(String(predictedPoolValue));
  const key = await factory.poolKey(
    canonicalToken0,
    canonicalToken1,
    canonicalDecimals0,
    canonicalDecimals1,
    feeBps,
    strategyAddress,
  );
  if (
    ethersLibrary.getAddress(await factory.getPool(key)) !== ethersLibrary.ZeroAddress ||
    await ethers.provider.getCode(predictedPool) !== "0x"
  ) {
    throw new Error("protected launch requires an unused complete pool key");
  }
  const commitmentTransaction = await submit(
    `commit protected ${feeBps} bps launch`,
    () => initializationStrategy.commitLaunch(...call.args, { gasLimit: CALL_GAS_LIMIT }),
  );
  const context = await loadPool(predictedPool, creator);
  if (
    ethersLibrary.getAddress(await factory.getPool(key)) !== predictedPool ||
    !(await factory.isPool(predictedPool)) ||
    context.initializationStrategy !== strategyAddress ||
    await context.pool.initialized()
  ) {
    throw new Error("protected launch commitment did not create its canonical pool");
  }
  journal().recordResource({
    id: `pool-${feeBps}`,
    kind: "launchpad-pool",
    address: predictedPool,
    creationTransactionHash: commitmentTransaction.hash,
    metadata: {
      factoryAddress,
      migratorAddress,
      initializationStrategyAddress: strategyAddress,
      token0Address: canonicalToken0,
      token1Address: canonicalToken1,
      decimals0: canonicalDecimals0,
      decimals1: canonicalDecimals1,
      feeBps,
    },
  });

  const token0 = context.token0;
  const token1 = context.token1;
  const [before0, before1] = await Promise.all([
    privateBalance(token0, creator, creatorAddress),
    privateBalance(token1, creator, creatorAddress),
  ]);
  await setExactAllowance(
    token0,
    creator,
    canonicalToken0,
    migratorAddress,
    amount0,
    `${feeBps} bps protected token0 approval`,
  );
  await setExactAllowance(
    token1,
    creator,
    canonicalToken1,
    migratorAddress,
    amount1,
    `${feeBps} bps protected token1 approval`,
  );
  const selector = migrator.interface.getFunction("migrate")?.selector;
  if (!selector) throw new Error("protected migration selector unavailable");
  const bounds = confidentialLiquidityBounds(
    amount0,
    canonicalDecimals0,
    amount1,
    canonicalDecimals1,
    false,
  );
  const [input0, input1, minShares, minPrice, maxPrice] = await Promise.all([
    creator.encryptValue256(amount0, migratorAddress, selector),
    creator.encryptValue256(amount1, migratorAddress, selector),
    creator.encryptValue256(bounds.minShares, migratorAddress, selector),
    creator.encryptValue256(bounds.minPriceX18, migratorAddress, selector),
    creator.encryptValue256(bounds.maxPriceX18, migratorAddress, selector),
  ]);
  const migrationAuthorization = await creator.signTypedData(
    {
      ...LAUNCHPAD_MIGRATOR_EIP712_DOMAIN,
      chainId: network.chainId,
      verifyingContract: migratorAddress,
    },
    { Migration: [...LAUNCHPAD_MIGRATION_EIP712_TYPES] },
    {
      launchId,
      launchCommitmentHash: commitmentHash,
      initializationStrategy: strategyAddress,
      creator: creatorAddress,
      tokenA,
      tokenB,
      decimalsA,
      decimalsB,
      feeBps,
      encryptedInputsHash: encryptedInputsHash(
        input0,
        input1,
        minShares,
        minPrice,
        maxPrice,
      ),
      deadline: migrationDeadline,
      withDisposition: false,
      disposition: 0,
      unlockTime: 0,
    },
  );
  const migrationRequest = [
    launchId,
    commitmentHash,
    tokenA,
    tokenB,
    decimalsA,
    decimalsB,
    feeBps,
    input0,
    input1,
    minShares,
    minPrice,
    maxPrice,
    migrationDeadline,
    migrationAuthorization,
  ] as const;
  await submit(
    `initialize protected ${feeBps} bps pool`,
    () => migrator.migrate(migrationRequest, { gasLimit: CALL_GAS_LIMIT }),
  );
  const [after0, after1, allowance0, allowance1, launchRecord] = await Promise.all([
    privateBalance(token0, creator, creatorAddress),
    privateBalance(token1, creator, creatorAddress),
    privateAllowance(token0, creator, creatorAddress, migratorAddress),
    privateAllowance(token1, creator, creatorAddress, migratorAddress),
    initializationStrategy.getLaunch(launchId),
  ]);
  if (
    before0 - after0 !== amount0 ||
    before1 - after1 !== amount1 ||
    allowance0 !== 0n ||
    allowance1 !== 0n ||
    !(await context.pool.initialized()) ||
    Number(launchRecord.status) !== 4
  ) {
    throw new Error("protected migration violated exact initialization accounting");
  }
  await setExactAllowance(
    token0, creator, canonicalToken0, migratorAddress, 0n,
    `${feeBps} bps protected token0 post-migration cleanup`,
  );
  await setExactAllowance(
    token1, creator, canonicalToken1, migratorAddress, 0n,
    `${feeBps} bps protected token1 post-migration cleanup`,
  );
  context.model.reserve0 = amount0;
  context.model.reserve1 = amount1;
  return context;
}

async function removeAllLiquidity(
  context: PoolContext,
  wallet: CotiWallet,
  recoveryFloor = false,
): Promise<string> {
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
  const cleanup = await submit(
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
  return cleanup.hash;
}

async function recoverJournalPools(): Promise<void> {
  if (!recoveryJournal || !recoveryWallet) return;
  for (const resource of recoveryJournal.activeResources) {
    await verifyRecoveryResourceCreation(recoveryJournal, resource, ethers.provider);
    if (resource.kind !== "confidential-pool" && resource.kind !== "launchpad-pool") {
      throw new Error(`unsupported active recovery resource ${resource.kind}`);
    }
    const factoryAddress = String(resource.metadata.factoryAddress ?? "");
    const token0Address = String(resource.metadata.token0Address ?? "");
    const token1Address = String(resource.metadata.token1Address ?? "");
    const initializationStrategyAddress = resource.kind === "launchpad-pool"
      ? String(resource.metadata.initializationStrategyAddress ?? "")
      : ethersLibrary.ZeroAddress;
    const migratorAddress = resource.kind === "launchpad-pool"
      ? String(resource.metadata.migratorAddress ?? "")
      : undefined;
    const feeBps = Number(resource.metadata.feeBps);
    if (
      !ethersLibrary.isAddress(factoryAddress) ||
      !ethersLibrary.isAddress(token0Address) ||
      !ethersLibrary.isAddress(token1Address) ||
      !ethersLibrary.isAddress(initializationStrategyAddress) ||
      (migratorAddress !== undefined && !ethersLibrary.isAddress(migratorAddress)) ||
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
    const key = await factory.poolKey(
      token0Address,
      token1Address,
      context.token0Decimals,
      context.token1Decimals,
      feeBps,
      initializationStrategyAddress,
    );
    if (
      context.feeBps !== feeBps ||
      context.token0Address.toLowerCase() !== token0Address.toLowerCase() ||
      context.token1Address.toLowerCase() !== token1Address.toLowerCase() ||
      context.initializationStrategy.toLowerCase() !==
        initializationStrategyAddress.toLowerCase() ||
      ethersLibrary.getAddress(await factory.getPool(key)) !==
        ethersLibrary.getAddress(resource.address) ||
      String(await context.pool.bootstrapper()).toLowerCase() !== factoryAddress.toLowerCase()
    ) throw new Error("funded recovery pool provenance changed");

    if (migratorAddress !== undefined) {
      await setExactAllowance(
        context.token0,
        recoveryWallet,
        context.token0Address,
        migratorAddress,
        0n,
        `${feeBps} bps protected recovery token0 approval`,
      );
      await setExactAllowance(
        context.token1,
        recoveryWallet,
        context.token1Address,
        migratorAddress,
        0n,
        `${feeBps} bps protected recovery token1 approval`,
      );
    }
    const shares = await privateShares(context, recoveryWallet);
    let recoveryTransactionHash = resource.creationTransactionHash;
    if (shares > 0n) {
      recoveryTransactionHash = await removeAllLiquidity(context, recoveryWallet, true);
    } else {
      const [balance0, balance1] = await Promise.all([
        privateBalance(context.token0, recoveryWallet, context.address),
        privateBalance(context.token1, recoveryWallet, context.address),
      ]);
      if (balance0 !== 0n || balance1 !== 0n) {
        throw new Error("funded recovery pool holds assets without recoverable LP shares");
      }
    }
    recoveryJournal.markRecovered(resource.id, [recoveryTransactionHash]);
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
  candidateBitmap?: number,
): Promise<QuoteExecution> {
  const router = new Contract(
    routerAddress,
    CONFIDENTIAL_BEST_EXECUTION_ROUTER_TESTNET_ABI,
    wallet,
  );
  const functionName = candidateBitmap === undefined
    ? "requestBestQuoteExactInput"
    : "requestBestQuoteExactInputWithCandidates";
  const selector = router.interface.getFunction(functionName)?.selector;
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
    () => candidateBitmap === undefined
      ? router.requestBestQuoteExactInput(
          tokenIn,
          tokenOut,
          input,
          requestId,
          deadline(),
          { gasLimit: CALL_GAS_LIMIT },
        )
      : router.requestBestQuoteExactInputWithCandidates(
          tokenIn,
          tokenOut,
          input,
          candidateBitmap,
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
  candidateBitmap?: number,
): Promise<void> {
  const quoteRouter = new Contract(
    routerAddress,
    CONFIDENTIAL_BEST_EXECUTION_ROUTER_TESTNET_ABI,
    quoteWallet,
  );
  const functionName = candidateBitmap === undefined
    ? "requestBestQuoteExactInput"
    : "requestBestQuoteExactInputWithCandidates";
  const selector = quoteRouter.interface.getFunction(functionName)!.selector;
  const requestQuote = (
    router: Contract,
    encryptedInput: unknown,
    requestId: string,
    requestDeadline: bigint,
  ) => candidateBitmap === undefined
    ? router.requestBestQuoteExactInput(
        tokenIn,
        tokenOut,
        encryptedInput,
        requestId,
        requestDeadline,
        { gasLimit: CALL_GAS_LIMIT },
      )
    : router.requestBestQuoteExactInputWithCandidates(
        tokenIn,
        tokenOut,
        encryptedInput,
        candidateBitmap,
        requestId,
        requestDeadline,
        { gasLimit: CALL_GAS_LIMIT },
      );
  const freshInput = await quoteWallet.encryptValue256(
    amountIn,
    routerAddress,
    selector,
  );
  await expectFailure("best quote request-id replay", () =>
    requestQuote(
      quoteRouter,
      freshInput,
      successfulQuote.requestId,
      deadline(),
    ),
  );
  await expectFailure("best quote ciphertext replay", () =>
    requestQuote(
      quoteRouter,
      successfulQuote.input,
      nextRequestId("ciphertext-replay"),
      deadline(),
    ),
  );

  const expiredRequestId = nextRequestId("expired");
  const expiredInput = await quoteWallet.encryptValue256(
    amountIn,
    routerAddress,
    selector,
  );
  await expectFailure("best quote expired deadline", () =>
    requestQuote(
      quoteRouter,
      expiredInput,
      expiredRequestId,
      deadline(-1),
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
  const callerBindingRequestId = nextRequestId("caller-binding");
  const callerBindingDeadline = deadline();
  await expectFailure("caller-bound ciphertext isolation", () =>
    requestQuote(
      secondRouter,
      primaryBoundInput,
      callerBindingRequestId,
      callerBindingDeadline,
    ),
  );
  const control = await submit("caller-bound ciphertext primary control", () =>
    requestQuote(
      quoteRouter,
      primaryBoundInput,
      callerBindingRequestId,
      callerBindingDeadline,
    ),
  );
  const result = bestResultFromReceipt(
    quoteRouter,
    control.receipt,
    "ConfidentialBestQuoteResult",
    await quoteWallet.getAddress(),
    callerBindingRequestId,
  );
  if (await quoteWallet.decryptValue256(result.encryptedResult as never) <= 0n) {
    throw new Error("caller-bound ciphertext primary control returned no quote");
  }
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
  candidateBitmap?: number,
): Promise<Submitted> {
  const caller = await wallet.getAddress();
  const inputToken = new Contract(tokenIn, PRIVATE_ERC20_TESTNET_ABI, wallet);
  const outputToken = new Contract(tokenOut, PRIVATE_ERC20_TESTNET_ABI, wallet);
  const router = new Contract(
    routerAddress,
    CONFIDENTIAL_BEST_EXECUTION_ROUTER_TESTNET_ABI,
    wallet,
  );
  const functionName = candidateBitmap === undefined
    ? "swapBestExactInput"
    : "swapBestExactInputWithCandidates";
  const selector = router.interface.getFunction(functionName)?.selector;
  if (!selector) throw new Error("best-swap selector unavailable");
  const swap = (
    encryptedInput: unknown,
    encryptedMinimum: unknown,
    requestId: string,
  ) => candidateBitmap === undefined
    ? router.swapBestExactInput(
        tokenIn,
        tokenOut,
        encryptedInput,
        encryptedMinimum,
        requestId,
        deadline(),
        { gasLimit: CALL_GAS_LIMIT },
      )
    : router.swapBestExactInputWithCandidates(
        tokenIn,
        tokenOut,
        encryptedInput,
        encryptedMinimum,
        candidateBitmap,
        requestId,
        deadline(),
        { gasLimit: CALL_GAS_LIMIT },
      );
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
    swap(
      input,
      excessiveMinimum,
      requestId,
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
    () => swap(
      input,
      minimum,
      requestId,
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
  await setExactAllowance(
    inputToken, wallet, tokenIn, routerAddress, 0n, `${label} router post-swap cleanup`,
  );

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
  const factoryAddress = requiredAddress("COTI_FACTORY");
  const feeVaultAddress = requiredAddress("COTI_FEE_VAULT");
  const routerAddress = requiredAddress("COTI_BEST_EXECUTION_ROUTER");
  const configuredProofValue = process.env.CIPHERDEX_CONFIGURED_COMPATIBILITY_PROOF?.trim();
  if (configuredProofValue && configuredProofValue !== "1") {
    throw new Error("CIPHERDEX_CONFIGURED_COMPATIBILITY_PROOF must be 1 when set");
  }
  const configuredProof = configuredProofValue === "1";

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
  const configuredFactory = await ethers.getContractAt(
    "ConfidentialCPMMFactory",
    factoryAddress,
  );
  await assertCompatiblePrivateTokens(configuredFactory, [
    tokenAAddress,
    tokenBAddress,
  ]);
  if (configuredProof) {
    await assertCompatiblePrivateTokens(configuredFactory, [
      REFERENCE_PRIVATE_TOKEN,
      REFERENCE_PARTNER_TOKEN,
    ]);
  }
  const reviewedFeeVault = await ethers.getContractAt(
    "CipherDEXFeeVault",
    feeVaultAddress,
    primary,
  );
  const feeBeneficiary = ethersLibrary.getAddress(
    String(await reviewedFeeVault.beneficiary()),
  );
  let configuredTokenACodehash = "";
  let configuredTokenBCodehash = "";
  let referenceTokenCodehash = "";
  if (configuredProof) {
    const [tokenACode, tokenBCode, referenceCode] = await Promise.all([
      ethers.provider.getCode(tokenAAddress),
      ethers.provider.getCode(tokenBAddress),
      ethers.provider.getCode(REFERENCE_PRIVATE_TOKEN),
    ]);
    configuredTokenACodehash = ethersLibrary.keccak256(tokenACode).toLowerCase();
    configuredTokenBCodehash = ethersLibrary.keccak256(tokenBCode).toLowerCase();
    referenceTokenCodehash = ethersLibrary.keccak256(referenceCode).toLowerCase();
    if (
      OLD_REFERENCE_CODEHASHES.has(configuredTokenACodehash) ||
      OLD_REFERENCE_CODEHASHES.has(configuredTokenBCodehash) ||
      !OLD_REFERENCE_CODEHASHES.has(referenceTokenCodehash) ||
      configuredTokenACodehash === configuredTokenBCodehash
    ) {
      throw new Error("configured compatibility proof does not cover distinct non-reference runtimes");
    }
  }
  const runnerName = configuredProof ? "configured-compatibility" : "best-execution";
  const evidenceConfiguration = preflightFundedRunConfiguration(
    runnerName,
    configuredProof ? {
      chainId: Number(EXPECTED_CHAIN_ID),
      factory: factoryAddress,
      router: routerAddress,
      tokenA: tokenAAddress,
      tokenB: tokenBAddress,
      tokenACodehash: configuredTokenACodehash,
      tokenBCodehash: configuredTokenBCodehash,
      referenceToken: REFERENCE_PRIVATE_TOKEN,
      referenceTokenCodehash,
      maximumBalanceBps: 10,
    } : {
      chainId: Number(EXPECTED_CHAIN_ID),
      confidentialPoolVersion: 3,
      routerVersion: 2,
      privacyMode: 1,
      quoteTransport: "paid-transaction",
      candidateTiers: "5,30,100",
      candidateStrategyClasses: "standard,launch-protected",
      candidateBitmap: MIXED_THREE_CANDIDATE_BITMAP,
      tokenA: tokenAAddress,
      tokenB: tokenBAddress,
      feeBeneficiary,
    },
  );
  const sourceCommit = deploymentRecord.sourceCommit;
  recoveryJournal = openFundedRecoveryJournal(primaryKey, {
    runner: runnerName,
    sourceCommit,
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
    wallets: [primary, second, quoteWallet],
    overrides: { gasLimit: CALL_GAS_LIMIT },
    submit,
  });
  await recoverJournalPools();
  if (
    recoveryJournal.runStatus === "evidence-pending" ||
    recoveryJournal.runStatus === "evidence-failed"
  ) {
    const finalEvidence = await writePreparedFundedRunEvidence({
      journal: recoveryJournal,
      provider: ethers.provider,
      attestationSigner: primary,
    });
    console.log(`fundedEvidence=${finalEvidence.path}`);
    return;
  }


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
  const [balanceA, balanceB] = await Promise.all([
    privateBalance(tokenA, primary, primaryAddress),
    privateBalance(tokenB, primary, primaryAddress),
  ]);
  const scenarioCapA = fundedScenarioCap(balanceA);
  const scenarioCapB = fundedScenarioCap(balanceB);
  if (configuredProof) {
    const factory = configuredFactory.connect(primary) as any;
    const referenceToken = new Contract(
      REFERENCE_PRIVATE_TOKEN,
      PRIVATE_ERC20_TESTNET_ABI,
      primary,
    );
    const referencePartner = new Contract(
      REFERENCE_PARTNER_TOKEN,
      PRIVATE_ERC20_TESTNET_ABI,
      primary,
    );
    const [referenceDecimals, referencePartnerDecimals] = await Promise.all([
      referenceToken.decimals(),
      referencePartner.decimals(),
    ]);
    const referencePool = await createPool(
      factory,
      primary,
      REFERENCE_PRIVATE_TOKEN,
      REFERENCE_PARTNER_TOKEN,
      Number(referenceDecimals),
      Number(referencePartnerDecimals),
      100,
    );
    await expectFailure(
      "duplicate canonical reference pool",
      () => factory.createPool(
        REFERENCE_PRIVATE_TOKEN,
        REFERENCE_PARTNER_TOKEN,
        Number(referenceDecimals),
        Number(referencePartnerDecimals),
        100,
        { gasLimit: CREATE_POOL_GAS_LIMIT },
      ),
    );
    if (await referencePool.pool.initialized()) {
      throw new Error("reference compatibility pool unexpectedly initialized");
    }
    await recoverJournalPools();

    const minimumFocusedInput = minimumInputWithProtocolFee(30);
    const focusedLiquidityA = deriveFundedTestAmount(
      balanceA,
      minimumFocusedInput * 20n,
    ).amount;
    const focusedLiquidityB = deriveFundedTestAmount(
      balanceB,
      minimumFocusedInput * 20n,
    ).amount;
    const focusedSwap = deriveFundedTestAmount(
      balanceA,
      minimumFocusedInput,
    ).amount;
    if (
      focusedLiquidityA + focusedSwap > scenarioCapA ||
      focusedLiquidityB > scenarioCapB
    ) {
      throw new Error("configured compatibility proof exceeds its balance-derived cap");
    }
    const compatibilityPool = await createPool(
      factory,
      primary,
      tokenAAddress,
      tokenBAddress,
      decimalsA,
      decimalsB,
      30,
    );
    await initializePool(
      compatibilityPool,
      primary,
      tokenAAddress,
      focusedLiquidityA,
      focusedLiquidityB,
    );
    const configuredQuote = await requestBestQuote(
      routerAddress,
      quoteWallet,
      tokenAAddress,
      tokenBAddress,
      focusedSwap,
      "configured compatibility best quote",
      [compatibilityPool],
      STANDARD_30_BPS_CANDIDATE_BITMAP,
    );
    await swapWithRollbackProof(
      routerAddress,
      primary,
      tokenAAddress,
      tokenBAddress,
      focusedSwap,
      configuredQuote,
      30,
      [compatibilityPool],
      "configured compatibility best swap",
      STANDARD_30_BPS_CANDIDATE_BITMAP,
    );
    const exitHash = await removeAllLiquidity(compatibilityPool, primary);
    recoveryJournal.markRecovered("pool-30", [exitHash]);
    const [finalBalanceA, finalBalanceB, routerAllowance, poolAllowance] =
      await Promise.all([
        privateBalance(tokenA, primary, primaryAddress),
        privateBalance(tokenB, primary, primaryAddress),
        privateAllowance(tokenA, primary, primaryAddress, routerAddress),
        privateAllowance(tokenA, primary, primaryAddress, compatibilityPool.address),
      ]);
    if (
      finalBalanceA !== balanceA - modeledProtocolFee(focusedSwap, 30) ||
      finalBalanceB !== balanceB ||
      routerAllowance !== 0n ||
      poolAllowance !== 0n
    ) {
      throw new Error("configured compatibility cleanup left unexplained balance or allowance state");
    }

    const factoryRecord = deploymentRecord.contracts.confidentialFactory;
    const routerRecord = deploymentRecord.contracts.confidentialBestExecutionRouter;
    const factoryDeploymentTx = String(factoryRecord?.deploymentTx ?? "");
    const routerDeploymentTx = String(routerRecord?.deploymentTx ?? "");
    const factoryConstructorArgs = factoryRecord?.constructorArgs;
    const routerConstructorArgs = routerRecord?.constructorArgs;
    if (
      !/^0x[0-9a-fA-F]{64}$/.test(factoryDeploymentTx) ||
      !/^0x[0-9a-fA-F]{64}$/.test(routerDeploymentTx) ||
      !Array.isArray(factoryConstructorArgs) ||
      !Array.isArray(routerConstructorArgs)
    ) {
      throw new Error("configured deployment manifest omits canonical constructor evidence");
    }
    const referenceResource = recoveryJournal.resources.find(
      (resource) => resource.id === "pool-100",
    );
    const compatibilityResource = recoveryJournal.resources.find(
      (resource) => resource.id === "pool-30",
    );
    if (!referenceResource || !compatibilityResource) {
      throw new Error("configured compatibility resources are missing from recovery evidence");
    }
    const [referenceLPToken, compatibilityLPToken] = await Promise.all([
      referencePool.pool.lpToken(),
      compatibilityPool.pool.lpToken(),
    ]);
    recoveryJournal.prepareEvidence({
      participants: [primaryAddress, quoteAddress],
      configuration: evidenceConfiguration,
      artifacts: [
        {
          label: "configured confidential factory",
          contractName: "ConfidentialCPMMFactory",
          address: factoryAddress,
          creationTransactionHash: factoryDeploymentTx,
          constructorArguments: factoryConstructorArgs as any,
        },
        {
          label: "configured best-execution router",
          contractName: "ConfidentialBestExecutionRouter",
          address: routerAddress,
          creationTransactionHash: routerDeploymentTx,
          constructorArguments: routerConstructorArgs as any,
        },
        {
          label: "configured reference pool",
          contractName: "ConfidentialCPMM",
          address: referencePool.address,
        },
        {
          label: "configured reference private LP token",
          contractName: "PrivateLPToken",
          address: ethersLibrary.getAddress(String(referenceLPToken)),
        },
        {
          label: "configured compatibility pool",
          contractName: "ConfidentialCPMM",
          address: compatibilityPool.address,
        },
        {
          label: "configured compatibility private LP token",
          contractName: "PrivateLPToken",
          address: ethersLibrary.getAddress(String(compatibilityLPToken)),
        },
      ],
      assertions: [
        "reference and differing runtime tokens passed structural compatibility",
        "configured factory created canonical pools without token approval",
        "balance-derived liquidity stayed within one tenth of one percent",
        "configured router quote and atomic swap preserved parity",
        "router escrow and pool allowances returned to zero",
        "configured compatibility pools exited with zero residue",
      ],
    });
    const finalEvidence = await writePreparedFundedRunEvidence({
      journal: recoveryJournal,
      provider: ethers.provider,
      attestationSigner: primary,
    });
    console.log(`configuredCompatibilityEvidence=${finalEvidence.path}`);
    console.log("Configured compatibility proof completed without printing private values.");
    return;
  }
  const unitA = scenarioCapA / 64n;
  const unitB = scenarioCapB / 32n;
  const minimumSwap = minimumInputWithProtocolFee(5);
  const swapA = unitA / 1_000n > minimumSwap ? unitA / 1_000n : minimumSwap;
  const swapB = unitB / 1_000n > minimumSwap ? unitB / 1_000n : minimumSwap;
  if (unitA === 0n || unitB === 0n || swapA > scenarioCapA || swapB > scenarioCapB) {
    throw new Error("private balances are too small for the bounded best-execution proof");
  }

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

  const requiredA = pool5LiquidityA + pool30LiquidityA + pool100LiquidityA + 3n * swapA;
  const requiredB = pool5LiquidityB + pool30LiquidityB + pool100LiquidityB + 5n * swapB;
  if (
    balanceA < requiredA ||
    balanceB < requiredB ||
    requiredA > scenarioCapA ||
    requiredB > scenarioCapB
  ) {
    throw new Error("best-execution proof exceeds its balance-derived 0.1% cap");
  }

  stage = "disposable best-execution stack deployment";
  const feeVaultDeployment = await deployContract(
    "CipherDEXFeeVault",
    primary,
    [feeBeneficiary],
    FEE_VAULT_DEPLOY_GAS_LIMIT,
  );
  const lpFactoryDeployment = await deployContract(
    "PrivateLPTokenFactory",
    primary,
    [],
    8_000_000n,
  );
  const strategyArtifact = await artifacts.readArtifact(
    "ConfidentialLaunchInitializationStrategy",
  );
  const reviewedStrategyRuntimeCodehash = ethersLibrary.keccak256(
    strategyArtifact.deployedBytecode,
  );
  const strategyRegistryDeployment = await deployContract(
    "ConfidentialInitializationStrategyRegistry",
    primary,
    [[reviewedStrategyRuntimeCodehash]],
    STRATEGY_REGISTRY_DEPLOY_GAS_LIMIT,
  );
  const strategyRegistryRuntimeCodehash = ethersLibrary.keccak256(
    await ethers.provider.getCode(strategyRegistryDeployment.address),
  );
  const poolDeployerDeployment = await deployContract(
    "ConfidentialCPMMDeployer",
    primary,
    [],
    POOL_DEPLOYER_DEPLOY_GAS_LIMIT,
  );
  const poolDeployerRuntimeCodehash = ethersLibrary.keccak256(
    await ethers.provider.getCode(poolDeployerDeployment.address),
  );
  const factoryDeployment = await deployContract(
    "ConfidentialCPMMFactory",
    primary,
    [
      feeVaultDeployment.address,
      lpFactoryDeployment.address,
      poolDeployerDeployment.address,
      poolDeployerRuntimeCodehash,
      strategyRegistryDeployment.address,
      strategyRegistryRuntimeCodehash,
    ],
    8_000_000n,
  );
  const factory = factoryDeployment.contract;
  await submit(
    "bind disposable confidential fee vault",
    () => feeVaultDeployment.contract.setConfidentialFactory(factoryDeployment.address, {
      gasLimit: 500_000n,
    }),
  );
  await submit(
    "bind disposable confidential pool deployer",
    () => poolDeployerDeployment.contract.bindFactory(
      factoryDeployment.address,
      { gasLimit: STACK_BIND_GAS_LIMIT },
    ),
  );
  await submit(
    "bind disposable initialization strategy registry",
    () => strategyRegistryDeployment.contract.bindFactory(
      factoryDeployment.address,
      { gasLimit: STACK_BIND_GAS_LIMIT },
    ),
  );
  const strategyDeployment = await deployContract(
    "ConfidentialLaunchInitializationStrategy",
    primary,
    [
      factoryDeployment.address,
      strategyRegistryDeployment.address,
      quoteAddress,
    ],
    INITIALIZATION_STRATEGY_DEPLOY_GAS_LIMIT,
  );
  const migratorAddress = ethersLibrary.getAddress(
    String(await strategyDeployment.contract.migrator()),
  );
  await verifyDeployedRuntimeArtifact(
    "ConfidentialLaunchpadMigrator",
    migratorAddress,
  );
  const migratorDeployment = {
    address: migratorAddress,
    contract: await ethers.getContractAt(
      "ConfidentialLaunchpadMigrator",
      migratorAddress,
      primary,
    ),
  };
  await submit(
    "register disposable initialization strategy",
    () => strategyRegistryDeployment.contract.registerInitializationStrategy(
      strategyDeployment.address,
      { gasLimit: STACK_BIND_GAS_LIMIT },
    ),
  );
  await submit(
    "finalize disposable initialization strategy registry",
    () => strategyRegistryDeployment.contract.finalize({
      gasLimit: STACK_BIND_GAS_LIMIT,
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
    configuredPoolDeployer,
    configuredStrategyRegistry,
    registryFinalized,
    configuredStrategy,
    configuredMigrator,
    tokenACompatible,
    tokenBCompatible,
  ] = await Promise.all([
    factory.feeVault(),
    factory.bestExecutionRouter(),
    feeVaultDeployment.contract.beneficiary(),
    feeVaultDeployment.contract.confidentialFactory(),
    router.factory(),
    router.PROTOCOL_VERSION(),
    factory.poolDeployer(),
    factory.initializationStrategyRegistry(),
    factory.initializationStrategyRegistryFinalized(),
    factory.initializationStrategyAt(1),
    strategyDeployment.contract.migrator(),
    factory.isCompatiblePrivateToken(tokenAAddress),
    factory.isCompatiblePrivateToken(tokenBAddress),
  ]);
  if (
    ethersLibrary.getAddress(String(configuredVault)) !== feeVaultDeployment.address ||
    ethersLibrary.getAddress(String(configuredRouter)) !== routerDeployment.address ||
    ethersLibrary.getAddress(String(configuredBeneficiary)) !== feeBeneficiary ||
    ethersLibrary.getAddress(String(configuredVaultFactory)) !== factoryDeployment.address ||
    ethersLibrary.getAddress(String(configuredRouterFactory)) !== factoryDeployment.address ||
    BigInt(configuredRouterVersion) !== 2n ||
    ethersLibrary.getAddress(String(configuredPoolDeployer)) !==
      poolDeployerDeployment.address ||
    ethersLibrary.getAddress(String(configuredStrategyRegistry)) !==
      strategyRegistryDeployment.address ||
    !Boolean(registryFinalized) ||
    ethersLibrary.getAddress(String(configuredStrategy)) !==
      strategyDeployment.address ||
    ethersLibrary.getAddress(String(configuredMigrator)) !==
      migratorDeployment.address ||
    !tokenACompatible ||
    !tokenBCompatible
  ) throw new Error("canonical deployment binding verification failed");

  const pool30 = await initializeProtectedPool(
    factory,
    strategyDeployment.contract,
    migratorDeployment.contract,
    primary,
    quoteWallet,
    tokenAAddress,
    tokenBAddress,
    decimalsA,
    decimalsB,
    30,
    pool30LiquidityA,
    pool30LiquidityB,
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
    MIXED_TWO_CANDIDATE_BITMAP,
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
    MIXED_THREE_CANDIDATE_BITMAP,
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
    MIXED_THREE_CANDIDATE_BITMAP,
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
    MIXED_THREE_CANDIDATE_BITMAP,
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
    MIXED_THREE_CANDIDATE_BITMAP,
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
    MIXED_THREE_CANDIDATE_BITMAP,
  );

  const postTieQuote = await requestBestQuote(
    routerDeployment.address,
    quoteWallet,
    tokenBAddress,
    tokenAAddress,
    swapB,
    "post-tie 30 bps selection quote",
    allPools,
    MIXED_THREE_CANDIDATE_BITMAP,
  );
  if (
    postTieQuote.selectedFeeBps !== 30 ||
    postTieQuote.selectedPool !== pool30.address ||
    pool30.initializationStrategy !== strategyDeployment.address
  ) {
    throw new Error("post-tie quote did not select the protected 30 bps candidate");
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
    MIXED_THREE_CANDIDATE_BITMAP,
  );

  const tinyQuote = await requestBestQuote(
    routerDeployment.address,
    quoteWallet,
    tokenBAddress,
    tokenAAddress,
    501n,
    "encrypted-invalid candidate isolation quote",
    allPools,
    MIXED_THREE_CANDIDATE_BITMAP,
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
    MIXED_THREE_CANDIDATE_BITMAP,
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
    MIXED_THREE_CANDIDATE_BITMAP,
  );

  stage = "disposable candidate cleanup";
  for (const context of allPools) {
    const recoveryTransactionHash = await removeAllLiquidity(context, primary);
    recoveryJournal.markRecovered(`pool-${context.feeBps}`, [recoveryTransactionHash]);
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
    console.log(
      `canonicalPool feeBps=${context.feeBps} ` +
        `strategy=${context.initializationStrategy} address=${context.address}`,
    );
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
    "private mixed-class selection, exact lower-tier tie-breaking, both directions, every v1 tier, encrypted candidate isolation, " +
      "caller/replay/deadline protection, atomic rollback, exact escrow, quote parity, full LP exits, and zero-residue cleanup",
  );
  const lpArtifacts = await Promise.all(allPools.map(async (context) => ({
    label: `${context.feeBps} bps private LP token`,
    contractName: "PrivateLPToken",
    address: ethersLibrary.getAddress(await context.pool.lpToken()),
  })));
  recoveryJournal.prepareEvidence({
    participants: [primaryAddress, secondAddress, quoteAddress],
    configuration: evidenceConfiguration,
    artifacts: [
      {
        label: "disposable fee vault",
        contractName: "CipherDEXFeeVault",
        address: feeVaultDeployment.address,
        creationTransactionHash: feeVaultDeployment.transaction.hash,
        constructorArguments: [feeBeneficiary],
      },
      {
        label: "disposable private LP factory",
        contractName: "PrivateLPTokenFactory",
        address: lpFactoryDeployment.address,
        creationTransactionHash: lpFactoryDeployment.transaction.hash,
        constructorArguments: [],
      },
      {
        label: "disposable confidential factory",
        contractName: "ConfidentialCPMMFactory",
        address: factoryDeployment.address,
        creationTransactionHash: factoryDeployment.transaction.hash,
        constructorArguments: [
          feeVaultDeployment.address,
          lpFactoryDeployment.address,
          poolDeployerDeployment.address,
          poolDeployerRuntimeCodehash,
          strategyRegistryDeployment.address,
          strategyRegistryRuntimeCodehash,
        ],
      },
      {
        label: "disposable confidential pool deployer",
        contractName: "ConfidentialCPMMDeployer",
        address: poolDeployerDeployment.address,
        creationTransactionHash: poolDeployerDeployment.transaction.hash,
        constructorArguments: [],
      },
      {
        label: "disposable initialization strategy registry",
        contractName: "ConfidentialInitializationStrategyRegistry",
        address: strategyRegistryDeployment.address,
        creationTransactionHash: strategyRegistryDeployment.transaction.hash,
        constructorArguments: [[reviewedStrategyRuntimeCodehash]],
      },
      {
        label: "disposable launch initialization strategy",
        contractName: "ConfidentialLaunchInitializationStrategy",
        address: strategyDeployment.address,
        creationTransactionHash: strategyDeployment.transaction.hash,
        constructorArguments: [
          factoryDeployment.address,
          strategyRegistryDeployment.address,
          quoteAddress,
        ],
      },
      {
        label: "disposable launchpad migrator",
        contractName: "ConfidentialLaunchpadMigrator",
        address: migratorDeployment.address,
      },
      {
        label: "disposable best execution router",
        contractName: "ConfidentialBestExecutionRouter",
        address: routerDeployment.address,
        creationTransactionHash: routerDeployment.transaction.hash,
        constructorArguments: [factoryDeployment.address],
      },
      ...allPools.map((context) => ({
        label: context.initializationStrategy === ethersLibrary.ZeroAddress
          ? `${context.feeBps} bps standard canonical pool`
          : `${context.feeBps} bps launch-protected canonical pool`,
        contractName: "ConfidentialCPMM",
        address: context.address,
      })),
      ...lpArtifacts,
    ],
    assertions: BEST_EXECUTION_FUNDED_ASSERTIONS,
  });
  const finalEvidence = await writePreparedFundedRunEvidence({
    journal: recoveryJournal,
    provider: ethers.provider,
    attestationSigner: primary,
  });
  console.log(`fundedEvidence=${finalEvidence.path}`);
}

void main().catch(async (error: unknown) => {
  if (recoveryJournal?.runStatus === "evidence-failed") {
    console.error(
      `COTI production best-execution evidence generation failed: ` +
        `${safeTestnetErrorSummary(error)}; paid execution will not be repeated.`,
    );
    process.exitCode = 1;
    return;
  }
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
