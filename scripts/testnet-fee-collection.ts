import { Contract, TransactionReceipt } from "ethers";
import { artifacts, ethers } from "../hardhat/runtime.js";

import {
  CONFIDENTIAL_FACTORY_TESTNET_ABI,
  CONFIDENTIAL_POOL_TESTNET_ABI,
  PRIVATE_ERC20_TESTNET_ABI,
} from "./coti-testnet-abi";
import { decryptPrivateValue256 } from "./coti-testnet-values";
import {
  type FundedRecoveryJournal,
  type RecoveryResource,
  verifyRecoveryResourceCreation,
} from "./funded-recovery-journal";
import { writePreparedFundedRunEvidence } from "./funded-run-evidence";
import { createFundedDeploymentBinding } from "./funded-deployment-binding";
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
import {
  FeeCollectionPendingError,
  requireFeeCollectionMature,
} from "./testnet-fee-collection-readiness";
import { resolvePrivateTokenCodehashes } from "./private-token-codehashes";
import { verifyDeployedRuntimeArtifact } from "./runtime-artifact";
import {
  assertReviewedPrivateTokens,
  requiredTestnetDeploymentRecordPath,
  verifyConfiguredTestnetDeployment,
} from "./testnet-deployment-provenance";
import {
  confidentialLiquidityBounds,
  minimumWithSlippage,
} from "./testnet-slippage";
import {
  MinedTransactionStatusError,
  requireMinedFailure,
  requireMinedSuccess,
  safeTestnetErrorSummary,
  transactionHashFromError,
  UnknownBroadcastOutcomeError,
} from "./testnet-transaction-evidence";

const EXPECTED_CHAIN_ID = 7_082_400n;
const TARGET_SWAP_COUNT = 8n;
const COLLECTION_DELAY_SECONDS = 3_600n;
const FEE_BPS = 100n;
const RESOURCE_ID = "fee-collection-pool";
const gasLimitText = process.env.COTI_TESTNET_GAS_LIMIT?.trim() ?? "30000000";
if (!/^\d+$/.test(gasLimitText) || BigInt(gasLimitText) === 0n) {
  throw new Error("COTI_TESTNET_GAS_LIMIT must be a positive integer");
}
const TX_GAS_LIMIT = BigInt(gasLimitText);
const TX_OVERRIDES = { gasLimit: TX_GAS_LIMIT } as const;

type Submitted = Readonly<{
  transactionHash: string;
  receipt: TransactionReceipt;
}>;

type EffectiveReserveModel = {
  reserve0: bigint;
  reserve1: bigint;
  protocolFee0: bigint;
  protocolFee1: bigint;
};

type DisposableStack = Readonly<{
  resource: RecoveryResource;
  poolAddress: string;
  factoryAddress: string;
  feeVaultAddress: string;
  lpFactoryAddress: string;
  poolDeployerAddress: string;
  strategyRegistryAddress: string;
  token0Address: string;
  token1Address: string;
  decimals0: number;
  decimals1: number;
  pool: Contract;
  factory: Contract;
  feeVault: any;
  token0: Contract;
  token1: Contract;
}>;

let stage = "configuration";
let recoveryJournal: FundedRecoveryJournal | undefined;
let recoveryWallet: CotiWallet | undefined;
let recoveryOwner: string | undefined;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function requiredAddress(name: string): string {
  const value = required(name);
  if (!ethers.isAddress(value)) throw new Error(`invalid ${name}`);
  return ethers.getAddress(value);
}

function journal(): FundedRecoveryJournal {
  if (!recoveryJournal) throw new Error("funded recovery journal is not initialized");
  return recoveryJournal;
}

function defaultRawAmount(decimals: number, decimalPlaces: number): bigint {
  return decimals >= decimalPlaces ? 10n ** BigInt(decimals - decimalPlaces) : 1n;
}

function optionalRawAmount(name: string, fallback: bigint): bigint {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`invalid ${name}`);
  const parsed = BigInt(value);
  if (parsed === 0n) throw new Error(`${name} must be positive`);
  return parsed;
}

function metadataAddress(resource: RecoveryResource, name: string): string {
  const value = resource.metadata[name];
  if (typeof value !== "string" || !ethers.isAddress(value)) {
    throw new Error(`disposable fee stack has invalid ${name}`);
  }
  return ethers.getAddress(value);
}

function metadataHash(resource: RecoveryResource, name: string): string {
  const value = resource.metadata[name];
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`disposable fee stack has invalid ${name}`);
  }
  return value;
}

function modeledAmountOut(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeBps: bigint,
): bigint {
  const netAmountIn = amountIn * (10_000n - feeBps) / 10_000n;
  if (netAmountIn <= 0n) throw new Error("modeled fee test swap has no net input");
  const denominator = reserveIn + netAmountIn;
  const product = reserveIn * reserveOut;
  const retained = product / denominator + (product % denominator === 0n ? 0n : 1n);
  const output = retained >= reserveOut ? 0n : reserveOut - retained;
  if (output <= 0n) throw new Error("modeled fee test swap has no output");
  return output;
}

function applyModeledSwap(
  model: EffectiveReserveModel,
  amountIn: bigint,
  zeroForOne: boolean,
  expectedOutput?: bigint,
): bigint {
  const reserveIn = zeroForOne ? model.reserve0 : model.reserve1;
  const reserveOut = zeroForOne ? model.reserve1 : model.reserve0;
  const amountOut = modeledAmountOut(amountIn, reserveIn, reserveOut, FEE_BPS);
  if (expectedOutput !== undefined && amountOut !== expectedOutput) {
    throw new Error("paid quote diverged from the v1 fee and rounding model");
  }
  const netAmountIn = amountIn * (10_000n - FEE_BPS) / 10_000n;
  const protocolFee = (amountIn - netAmountIn) / 6n;
  if (protocolFee <= 0n) throw new Error("fee test amount produces no protocol fee");
  if (zeroForOne) {
    model.reserve0 += amountIn - protocolFee;
    model.reserve1 -= amountOut;
    model.protocolFee0 += protocolFee;
  } else {
    model.reserve1 += amountIn - protocolFee;
    model.reserve0 -= amountOut;
    model.protocolFee1 += protocolFee;
  }
  return amountOut;
}

function reconstructModel(
  liquidity0: bigint,
  liquidity1: bigint,
  swap0: bigint,
  swap1: bigint,
  count0: bigint,
  count1: bigint,
): EffectiveReserveModel {
  if (count0 > TARGET_SWAP_COUNT || count1 > TARGET_SWAP_COUNT) {
    throw new Error("fee batch counters exceed the reproducible v1 test sequence");
  }
  const model: EffectiveReserveModel = {
    reserve0: liquidity0,
    reserve1: liquidity1,
    protocolFee0: 0n,
    protocolFee1: 0n,
  };
  const rounds = Number(count0 > count1 ? count0 : count1);
  for (let index = 0; index < rounds; index += 1) {
    if (BigInt(index) < count0) applyModeledSwap(model, swap0, true);
    if (BigInt(index) < count1) applyModeledSwap(model, swap1, false);
  }
  return model;
}

async function submit(
  label: string,
  operation: () => Promise<{ hash: string; wait(): Promise<TransactionReceipt | null> }>,
): Promise<Submitted> {
  stage = label;
  const started = Date.now();
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
      `${label}: tx=${evidence.transactionHash} gas=${evidence.receipt.gasUsed.toString()} ` +
        `latencyMs=${Date.now() - started}`,
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

async function submitExpectedFailure(
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
  journal().recordTransaction(
    evidence.transactionHash,
    "mined-failure",
    evidence.receipt.blockNumber,
  );
  return evidence;
}

async function deployContract(
  contractName:
    | "CipherDEXFeeVault"
    | "PrivateLPTokenFactory"
    | "ConfidentialCPMMDeployer"
    | "ConfidentialInitializationStrategyRegistry"
    | "ConfidentialCPMMFactory",
  wallet: CotiWallet,
  args: readonly unknown[],
): Promise<Readonly<{ contract: any; address: string; transactionHash: string }>> {
  const factory = await ethers.getContractFactory(contractName, wallet);
  let contract: any;
  const evidence = await submit(
    `${contractName} disposable deployment`,
    async () => {
      contract = await factory.deploy(...args, TX_OVERRIDES);
      const transaction = contract.deploymentTransaction();
      if (!transaction) throw new Error(`${contractName} deployment transaction unavailable`);
      return transaction;
    },
  );
  if (!contract) throw new Error(`${contractName} deployment handle unavailable`);
  const address = ethers.getAddress(await contract.getAddress());
  await verifyDeployedRuntimeArtifact(contractName, address);
  return { contract, address, transactionHash: evidence.transactionHash };
}

async function privateBalance(token: Contract, owner: string, wallet: CotiWallet): Promise<bigint> {
  return decryptPrivateValue256(wallet, await token.balanceOf.staticCall(owner));
}

async function privateAllowance(
  token: Contract,
  owner: string,
  spender: string,
  wallet: CotiWallet,
): Promise<bigint> {
  const value = await token.allowance.staticCall(owner, spender);
  return decryptPrivateValue256(wallet, value.ownerCiphertext);
}

async function setPrivateAllowance(
  token: Contract,
  tokenAddress: string,
  poolAddress: string,
  amount: bigint,
  wallet: CotiWallet,
  label: string,
): Promise<void> {
  await setRecoverablePrivateAllowance({
    journal: journal(),
    wallet,
    token,
    tokenAddress,
    spender: poolAddress,
    amount,
    label: `${label} approval`,
    overrides: TX_OVERRIDES,
    submit,
  });
}

async function requestPrivateQuote(
  stack: DisposableStack,
  wallet: CotiWallet,
  amountIn: bigint,
  zeroForOne: boolean,
  label: string,
): Promise<bigint> {
  const selector = stack.pool.interface.getFunction("requestQuoteExactInput")?.selector;
  if (!selector) throw new Error("transactional quote selector unavailable");
  const requestId = ethers.keccak256(ethers.randomBytes(32));
  const caller = await wallet.getAddress();
  const encryptedAmount = await wallet.encryptValue256(amountIn, stack.poolAddress, selector);
  const evidence = await submit(
    label,
    () => stack.pool.requestQuoteExactInput(
      encryptedAmount,
      zeroForOne,
      requestId,
      TX_OVERRIDES,
    ),
  );
  const matches: unknown[] = [];
  for (const log of evidence.receipt.logs) {
    if (log.address.toLowerCase() !== stack.poolAddress.toLowerCase()) continue;
    try {
      const parsed = stack.pool.interface.parseLog(log);
      if (
        parsed?.name === "ConfidentialQuoteResult" &&
        String(parsed.args.caller).toLowerCase() === caller.toLowerCase() &&
        String(parsed.args.requestId).toLowerCase() === requestId.toLowerCase() &&
        parsed.args.zeroForOne === zeroForOne
      ) matches.push(parsed.args.result);
    } catch {
      // Ignore unrelated logs emitted in the quote transaction.
    }
  }
  if (matches.length !== 1) throw new Error("encrypted quote result is missing or ambiguous");
  const quote = await decryptPrivateValue256(wallet, matches[0] as never);
  if (quote <= 0n) throw new Error("paid encrypted quote returned zero");
  return quote;
}

async function verifyTransaction(
  hash: string,
  expectedFrom: string,
  expectedTo?: string,
  expectedContract?: string,
): Promise<void> {
  const [transaction, receipt] = await Promise.all([
    ethers.provider.getTransaction(hash),
    ethers.provider.getTransactionReceipt(hash),
  ]);
  if (
    !transaction ||
    !receipt ||
    receipt.status !== 1 ||
    transaction.from.toLowerCase() !== expectedFrom.toLowerCase() ||
    (expectedTo !== undefined && transaction.to?.toLowerCase() !== expectedTo.toLowerCase()) ||
    (expectedContract !== undefined &&
      receipt.contractAddress?.toLowerCase() !== expectedContract.toLowerCase())
  ) throw new Error("disposable fee stack transaction provenance failed");
}

async function validateStackResource(
  resource: RecoveryResource,
  wallet: CotiWallet,
  owner: string,
  reviewedAddresses: ReadonlySet<string>,
): Promise<DisposableStack> {
  await verifyRecoveryResourceCreation(journal(), resource, ethers.provider);
  if (resource.kind !== "fee-collection-pool") {
    throw new Error(`unsupported fee recovery resource ${resource.kind}`);
  }
  const poolAddress = ethers.getAddress(resource.address);
  const factoryAddress = metadataAddress(resource, "factoryAddress");
  const feeVaultAddress = metadataAddress(resource, "feeVaultAddress");
  const lpFactoryAddress = metadataAddress(resource, "lpFactoryAddress");
  const poolDeployerAddress = metadataAddress(resource, "poolDeployerAddress");
  const strategyRegistryAddress = metadataAddress(
    resource,
    "strategyRegistryAddress",
  );
  const token0Address = metadataAddress(resource, "token0Address");
  const token1Address = metadataAddress(resource, "token1Address");
  const decimals0 = Number(resource.metadata.decimals0);
  const decimals1 = Number(resource.metadata.decimals1);
  if (
    !Number.isInteger(decimals0) ||
    !Number.isInteger(decimals1) ||
    decimals0 < 0 ||
    decimals1 < 0 ||
    decimals0 > 18 ||
    decimals1 > 18
  ) throw new Error("disposable fee stack token decimals are invalid");
  for (const address of [
    poolAddress,
    factoryAddress,
    feeVaultAddress,
    lpFactoryAddress,
    poolDeployerAddress,
    strategyRegistryAddress,
  ]) {
    if (reviewedAddresses.has(address.toLowerCase())) {
      throw new Error("fee runner refuses to mutate a reviewed deployment contract");
    }
  }

  await Promise.all([
    verifyDeployedRuntimeArtifact("ConfidentialCPMM", poolAddress),
    verifyDeployedRuntimeArtifact("ConfidentialCPMMFactory", factoryAddress),
    verifyDeployedRuntimeArtifact("CipherDEXFeeVault", feeVaultAddress),
    verifyDeployedRuntimeArtifact("PrivateLPTokenFactory", lpFactoryAddress),
    verifyDeployedRuntimeArtifact(
      "ConfidentialCPMMDeployer",
      poolDeployerAddress,
    ),
    verifyDeployedRuntimeArtifact(
      "ConfidentialInitializationStrategyRegistry",
      strategyRegistryAddress,
    ),
    verifyTransaction(metadataHash(resource, "feeVaultTx"), owner, undefined, feeVaultAddress),
    verifyTransaction(metadataHash(resource, "lpFactoryTx"), owner, undefined, lpFactoryAddress),
    verifyTransaction(
      metadataHash(resource, "poolDeployerTx"),
      owner,
      undefined,
      poolDeployerAddress,
    ),
    verifyTransaction(
      metadataHash(resource, "strategyRegistryTx"),
      owner,
      undefined,
      strategyRegistryAddress,
    ),
    verifyTransaction(metadataHash(resource, "factoryTx"), owner, undefined, factoryAddress),
    verifyTransaction(metadataHash(resource, "bindTx"), owner, feeVaultAddress),
    verifyTransaction(metadataHash(resource, "poolDeployerBindTx"), owner, poolDeployerAddress),
    verifyTransaction(metadataHash(resource, "strategyRegistryBindTx"), owner, strategyRegistryAddress),
    verifyTransaction(metadataHash(resource, "poolTx"), owner, factoryAddress),
  ]);

  const factory = new Contract(factoryAddress, CONFIDENTIAL_FACTORY_TESTNET_ABI, wallet);
  const pool = new Contract(poolAddress, CONFIDENTIAL_POOL_TESTNET_ABI, wallet);
  const feeVault = await ethers.getContractAt("CipherDEXFeeVault", feeVaultAddress, wallet);
  const token0 = new Contract(token0Address, PRIVATE_ERC20_TESTNET_ABI, wallet);
  const token1 = new Contract(token1Address, PRIVATE_ERC20_TESTNET_ABI, wallet);
  const key = await factory.poolKey(
    token0Address,
    token1Address,
    decimals0,
    decimals1,
    FEE_BPS,
    ethers.ZeroAddress,
  );
  const poolDeployer = await ethers.getContractAt(
    "ConfidentialCPMMDeployer",
    poolDeployerAddress,
    wallet,
  );
  const strategyRegistry = await ethers.getContractAt(
    "ConfidentialInitializationStrategyRegistry",
    strategyRegistryAddress,
    wallet,
  );
  const [canonicalPool, token0Code, token1Code] = await Promise.all([
    factory.getPool(key),
    ethers.provider.getCode(token0Address),
    ethers.provider.getCode(token1Address),
  ]);
  if (
    !(await factory.isPool(poolAddress)) ||
    String(canonicalPool).toLowerCase() !== poolAddress.toLowerCase() ||
    String(await factory.feeVault()).toLowerCase() !== feeVaultAddress.toLowerCase() ||
    String(await feeVault.confidentialFactory()).toLowerCase() !== factoryAddress.toLowerCase() ||
    String(await factory.poolDeployer()).toLowerCase() !== poolDeployerAddress.toLowerCase() ||
    String(await poolDeployer.factory()).toLowerCase() !== factoryAddress.toLowerCase() ||
    String(await factory.initializationStrategyRegistry()).toLowerCase() !==
      strategyRegistryAddress.toLowerCase() ||
    String(await strategyRegistry.factory()).toLowerCase() !== factoryAddress.toLowerCase() ||
    String(await pool.bootstrapper()).toLowerCase() !== factoryAddress.toLowerCase() ||
    String(await pool.feeVault()).toLowerCase() !== feeVaultAddress.toLowerCase() ||
    String(await pool.token0()).toLowerCase() !== token0Address.toLowerCase() ||
    String(await pool.token1()).toLowerCase() !== token1Address.toLowerCase() ||
    BigInt(await pool.feeBps()) !== FEE_BPS ||
    BigInt(await pool.PROTOCOL_VERSION()) !== 3n ||
    BigInt(await pool.PRIVACY_MODE()) !== 1n ||
    !(await factory.isApprovedPrivateTokenCodehash(ethers.keccak256(token0Code))) ||
    !(await factory.isApprovedPrivateTokenCodehash(ethers.keccak256(token1Code)))
  ) throw new Error("disposable fee stack canonical binding validation failed");

  return {
    resource,
    poolAddress,
    factoryAddress,
    feeVaultAddress,
    lpFactoryAddress,
    poolDeployerAddress,
    strategyRegistryAddress,
    token0Address,
    token1Address,
    decimals0,
    decimals1,
    pool,
    factory,
    feeVault,
    token0,
    token1,
  };
}

async function createDisposableStack(
  wallet: CotiWallet,
  owner: string,
  tokenAAddress: string,
  tokenBAddress: string,
  beneficiary: string,
  reviewedAddresses: ReadonlySet<string>,
): Promise<DisposableStack> {
  const tokenA = new Contract(tokenAAddress, PRIVATE_ERC20_TESTNET_ABI, wallet);
  const tokenB = new Contract(tokenBAddress, PRIVATE_ERC20_TESTNET_ABI, wallet);
  const [decimalsA, decimalsB, codehashes] = await Promise.all([
    tokenA.decimals(),
    tokenB.decimals(),
    resolvePrivateTokenCodehashes(ethers.provider, [tokenAAddress, tokenBAddress]),
  ]);
  const feeVault = await deployContract("CipherDEXFeeVault", wallet, [beneficiary]);
  const lpFactory = await deployContract("PrivateLPTokenFactory", wallet, []);
  const strategyArtifact = await artifacts.readArtifact(
    "ConfidentialLaunchInitializationStrategy",
  );
  const reviewedStrategyRuntimeCodehash = ethers.keccak256(
    strategyArtifact.deployedBytecode,
  );
  const strategyRegistry = await deployContract(
    "ConfidentialInitializationStrategyRegistry",
    wallet,
    [[reviewedStrategyRuntimeCodehash]],
  );
  const strategyRegistryRuntimeCodehash = ethers.keccak256(
    await ethers.provider.getCode(strategyRegistry.address),
  );
  const poolDeployer = await deployContract(
    "ConfidentialCPMMDeployer",
    wallet,
    [],
  );
  const poolDeployerRuntimeCodehash = ethers.keccak256(
    await ethers.provider.getCode(poolDeployer.address),
  );
  const factory = await deployContract(
    "ConfidentialCPMMFactory",
    wallet,
    [
      feeVault.address,
      lpFactory.address,
      poolDeployer.address,
      poolDeployerRuntimeCodehash,
      codehashes,
      strategyRegistry.address,
      strategyRegistryRuntimeCodehash,
    ],
  );
  const bind = await submit(
    "bind disposable fee vault",
    () => feeVault.contract.setConfidentialFactory(factory.address, TX_OVERRIDES),
  );
  const poolDeployerBind = await submit(
    "bind disposable pool deployer",
    () => poolDeployer.contract.bindFactory(factory.address, TX_OVERRIDES),
  );
  const strategyRegistryBind = await submit(
    "bind disposable strategy registry",
    () => strategyRegistry.contract.bindFactory(factory.address, TX_OVERRIDES),
  );
  const poolCreation = await submit(
    "create disposable 100 bps fee pool",
    () => factory.contract.createPool(
      tokenAAddress,
      tokenBAddress,
      Number(decimalsA),
      Number(decimalsB),
      FEE_BPS,
      TX_OVERRIDES,
    ),
  );
  const key = await factory.contract.poolKey(
    tokenAAddress,
    tokenBAddress,
    Number(decimalsA),
    Number(decimalsB),
    FEE_BPS,
    ethers.ZeroAddress,
  );
  const poolAddress = ethers.getAddress(await factory.contract.getPool(key));
  const pool = new Contract(poolAddress, CONFIDENTIAL_POOL_TESTNET_ABI, wallet);
  const [token0Address, token1Address, decimals0, decimals1] = await Promise.all([
    pool.token0(),
    pool.token1(),
    pool.token0Decimals(),
    pool.token1Decimals(),
  ]);
  journal().recordResource({
    id: RESOURCE_ID,
    kind: "fee-collection-pool",
    address: poolAddress,
    creationTransactionHash: poolCreation.transactionHash,
    metadata: {
      phase: "created",
      factoryAddress: factory.address,
      feeVaultAddress: feeVault.address,
      lpFactoryAddress: lpFactory.address,
      poolDeployerAddress: poolDeployer.address,
      strategyRegistryAddress: strategyRegistry.address,
      token0Address: ethers.getAddress(String(token0Address)),
      token1Address: ethers.getAddress(String(token1Address)),
      decimals0: Number(decimals0),
      decimals1: Number(decimals1),
      feeBps: Number(FEE_BPS),
      feeVaultTx: feeVault.transactionHash,
      lpFactoryTx: lpFactory.transactionHash,
      poolDeployerTx: poolDeployer.transactionHash,
      strategyRegistryTx: strategyRegistry.transactionHash,
      factoryTx: factory.transactionHash,
      bindTx: bind.transactionHash,
      poolDeployerBindTx: poolDeployerBind.transactionHash,
      strategyRegistryBindTx: strategyRegistryBind.transactionHash,
      poolTx: poolCreation.transactionHash,
    },
  });
  const resource = journal().activeResources.find((candidate) => candidate.id === RESOURCE_ID);
  if (!resource) throw new Error("disposable fee stack recovery record is missing");
  stage = "validate disposable fee stack";
  return validateStackResource(resource, wallet, owner, reviewedAddresses);
}

async function removeAllLiquidity(
  stack: DisposableStack,
  wallet: CotiWallet,
  minimum0: bigint,
  minimum1: bigint,
): Promise<Submitted | undefined> {
  if (minimum0 <= 0n || minimum1 <= 0n) {
    throw new Error("fee-pool cleanup minima must be positive");
  }
  const shares = await decryptPrivateValue256(wallet, await stack.pool.myShares.staticCall());
  if (shares === 0n) {
    const [balance0, balance1] = await Promise.all([
      privateBalance(stack.token0, stack.poolAddress, wallet),
      privateBalance(stack.token1, stack.poolAddress, wallet),
    ]);
    if (balance0 !== 0n || balance1 !== 0n) {
      throw new Error("disposable fee pool holds assets without recoverable LP shares");
    }
    return undefined;
  }
  const selector = stack.pool.interface.getFunction("removeLiquidity")?.selector;
  if (!selector) throw new Error("remove-liquidity selector unavailable");
  const [encryptedShares, encryptedMinimum0, encryptedMinimum1] = await Promise.all([
    wallet.encryptValue256(shares, stack.poolAddress, selector),
    wallet.encryptValue256(minimum0, stack.poolAddress, selector),
    wallet.encryptValue256(minimum1, stack.poolAddress, selector),
  ]);
  const evidence = await submit(
    "full disposable fee-pool exit",
    () => stack.pool.removeLiquidity(
      encryptedShares,
      encryptedMinimum0,
      encryptedMinimum1,
      BigInt(Math.floor(Date.now() / 1000) + 600),
      TX_OVERRIDES,
    ),
  );
  return evidence;
}

async function recoverDisposablePool(): Promise<void> {
  if (!recoveryJournal || !recoveryWallet || !recoveryOwner) return;
  const resource = recoveryJournal.activeResources.find((candidate) =>
    candidate.id === RESOURCE_ID
  );
  if (!resource) return;
  const reviewedAddresses = new Set<string>();
  for (const name of ["COTI_FACTORY", "COTI_FEE_VAULT"]) {
    const value = process.env[name]?.trim();
    if (value && ethers.isAddress(value)) reviewedAddresses.add(value.toLowerCase());
  }
  const stack = await validateStackResource(
    resource,
    recoveryWallet,
    recoveryOwner,
    reviewedAddresses,
  );
  if (!(await stack.pool.initialized())) {
    const [balance0, balance1, allowance0, allowance1] = await Promise.all([
      privateBalance(stack.token0, stack.poolAddress, recoveryWallet),
      privateBalance(stack.token1, stack.poolAddress, recoveryWallet),
      privateAllowance(stack.token0, recoveryOwner, stack.poolAddress, recoveryWallet),
      privateAllowance(stack.token1, recoveryOwner, stack.poolAddress, recoveryWallet),
    ]);
    if (balance0 !== 0n || balance1 !== 0n || allowance0 !== 0n || allowance1 !== 0n) {
      throw new Error("uninitialized fee-pool recovery found private-token residue or allowance");
    }
    recoveryJournal.markRecovered(RESOURCE_ID, [resource.creationTransactionHash]);
    return;
  }
  const recovery = await removeAllLiquidity(stack, recoveryWallet, 1n, 1n);
  const [balance0, balance1, allowance0, allowance1] = await Promise.all([
    privateBalance(stack.token0, stack.poolAddress, recoveryWallet),
    privateBalance(stack.token1, stack.poolAddress, recoveryWallet),
    privateAllowance(stack.token0, recoveryOwner, stack.poolAddress, recoveryWallet),
    privateAllowance(stack.token1, recoveryOwner, stack.poolAddress, recoveryWallet),
  ]);
  if (balance0 !== 0n || balance1 !== 0n || allowance0 !== 0n || allowance1 !== 0n) {
    throw new Error("disposable fee-pool recovery left private-token residue or allowance");
  }
  recoveryJournal.markRecovered(
    RESOURCE_ID,
    [recovery?.transactionHash ?? resource.creationTransactionHash],
  );
}

async function main(): Promise<void> {
  const reviewedFactoryAddress = requiredAddress("COTI_FACTORY");
  const reviewedFeeVaultAddress = requiredAddress("COTI_FEE_VAULT");
  const tokenAAddress = requiredAddress("COTI_TOKEN0");
  const tokenBAddress = requiredAddress("COTI_TOKEN1");
  const privateKey = required("COTI_TESTNET_PRIVATE_KEY");
  const aesKey = required("COTI_AES_KEY");
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("invalid COTI_TESTNET_PRIVATE_KEY");
  }

  stage = "network and reviewed deployment provenance";
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(`expected COTI testnet ${EXPECTED_CHAIN_ID}, received ${network.chainId}`);
  }
  const deploymentRecord = await verifyConfiguredTestnetDeployment(
    requiredTestnetDeploymentRecordPath(),
    ethers.provider,
    [
      {
        recordKey: "confidentialFactory",
        contractName: "ConfidentialCPMMFactory",
        address: reviewedFactoryAddress,
      },
      {
        recordKey: "feeVault",
        contractName: "CipherDEXFeeVault",
        address: reviewedFeeVaultAddress,
      },
    ],
  );
  assertReviewedPrivateTokens(deploymentRecord, [tokenAAddress, tokenBAddress]);
  const reviewedVault = await ethers.getContractAt("CipherDEXFeeVault", reviewedFeeVaultAddress);
  const feeBeneficiary = ethers.getAddress(await reviewedVault.beneficiary());
  const reviewedAddresses = new Set(
    Object.values(deploymentRecord.contracts)
      .map((entry) => entry.address)
      .filter((address): address is string => typeof address === "string")
      .map((address) => address.toLowerCase()),
  );

  const wallet = new CotiWallet(privateKey, ethers.provider, { aesKey });
  wallet.setAesKey(aesKey);
  const owner = await wallet.getAddress();
  const sourceCommit = deploymentRecord.sourceCommit;
  recoveryJournal = openFundedRecoveryJournal(privateKey, {
    runner: "fee-collection",
    sourceCommit,
    chainId: Number(network.chainId),
    owner,
    directory: requiredFundedRecoveryDirectory(),
    deployment: await createFundedDeploymentBinding(deploymentRecord),
  });
  recoveryWallet = wallet;
  recoveryOwner = owner;
  const unresolved = await recoveryJournal.reconcileTransactions(ethers.provider);
  if (unresolved.length > 0) {
    throw new Error(
      `funded recovery has ${unresolved.length} transaction(s) with unknown outcome; do not retry`,
    );
  }
  await recoverPrivateAllowanceObligations({
    journal: recoveryJournal,
    wallets: [wallet],
    overrides: TX_OVERRIDES,
    submit,
  });
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

  let resource = recoveryJournal.activeResources.find((candidate) => candidate.id === RESOURCE_ID);
  const stack = resource
    ? await validateStackResource(resource, wallet, owner, reviewedAddresses)
    : await createDisposableStack(
      wallet,
      owner,
      tokenAAddress,
      tokenBAddress,
      feeBeneficiary,
      reviewedAddresses,
    );
  const configuredTokens = new Set([
    tokenAAddress.toLowerCase(),
    tokenBAddress.toLowerCase(),
  ]);
  const recoveredTokens = new Set([
    stack.token0Address.toLowerCase(),
    stack.token1Address.toLowerCase(),
  ]);
  if (
    configuredTokens.size !== 2 ||
    recoveredTokens.size !== 2 ||
    [...configuredTokens].some((address) => !recoveredTokens.has(address))
  ) throw new Error("source-bound disposable fee stack token pair changed");
  resource = stack.resource;
  const phase = String(resource.metadata.phase ?? "");
  if (phase === "collected" || phase === "terminal-swapped") {
    throw new Error("an interrupted post-collection fee proof must recover and restart");
  }

  const liquidity0 = optionalRawAmount(
    "COTI_FEE_TEST_LIQUIDITY0",
    defaultRawAmount(stack.decimals0, 1),
  );
  const liquidity1 = optionalRawAmount(
    "COTI_FEE_TEST_LIQUIDITY1",
    defaultRawAmount(stack.decimals1, 1),
  );
  const swap0 = optionalRawAmount(
    "COTI_FEE_TEST_SWAP0",
    defaultRawAmount(stack.decimals0, 2),
  );
  const swap1 = optionalRawAmount(
    "COTI_FEE_TEST_SWAP1",
    defaultRawAmount(stack.decimals1, 2),
  );
  let count0 = BigInt(await stack.pool.protocolFeeSwapCount0());
  let count1 = BigInt(await stack.pool.protocolFeeSwapCount1());
  const initialized = Boolean(await stack.pool.initialized());
  const model = initialized
    ? reconstructModel(liquidity0, liquidity1, swap0, swap1, count0, count1)
    : { reserve0: 0n, reserve1: 0n, protocolFee0: 0n, protocolFee1: 0n };

  const needed0 = TARGET_SWAP_COUNT - count0;
  const needed1 = TARGET_SWAP_COUNT - count1;
  if (needed0 < 0n || needed1 < 0n) {
    throw new Error("disposable fee pool has unexpected batch counters");
  }
  const allowance0 = (initialized ? 0n : liquidity0) + needed0 * swap0;
  const allowance1 = (initialized ? 0n : liquidity1) + needed1 * swap1;
  if (
    await privateBalance(stack.token0, owner, wallet) < allowance0 ||
    await privateBalance(stack.token1, owner, wallet) < allowance1
  ) throw new Error("fee-collection test amounts exceed the available private balance");
  await setPrivateAllowance(
    stack.token0,
    stack.token0Address,
    stack.poolAddress,
    allowance0,
    wallet,
    "fee token0",
  );
  await setPrivateAllowance(
    stack.token1,
    stack.token1Address,
    stack.poolAddress,
    allowance1,
    wallet,
    "fee token1",
  );

  if (!initialized) {
    const selector = stack.pool.interface.getFunction("addLiquidity")?.selector;
    if (!selector) throw new Error("add-liquidity selector unavailable");
    const bounds = confidentialLiquidityBounds(
      liquidity0,
      stack.decimals0,
      liquidity1,
      stack.decimals1,
      false,
    );
    const encryptedLiquidity = await Promise.all([
      wallet.encryptValue256(liquidity0, stack.poolAddress, selector),
      wallet.encryptValue256(liquidity1, stack.poolAddress, selector),
      wallet.encryptValue256(bounds.minShares, stack.poolAddress, selector),
      wallet.encryptValue256(bounds.minPriceX18, stack.poolAddress, selector),
      wallet.encryptValue256(bounds.maxPriceX18, stack.poolAddress, selector),
    ]);
    await submit(
      "initialize disposable fee pool",
      () => stack.pool.addLiquidity(
        encryptedLiquidity[0],
        encryptedLiquidity[1],
        encryptedLiquidity[2],
        encryptedLiquidity[3],
        encryptedLiquidity[4],
        false,
        BigInt(Math.floor(Date.now() / 1000) + 600),
        TX_OVERRIDES,
      ),
    );
    model.reserve0 = liquidity0;
    model.reserve1 = liquidity1;
    recoveryJournal.updateResourceMetadata(RESOURCE_ID, { phase: "initialized" });
  }

  const swapSelector = stack.pool.interface.getFunction("swapExactInput")?.selector;
  if (!swapSelector) throw new Error("swap selector unavailable");
  const rounds = Number(needed0 > needed1 ? needed0 : needed1);
  for (let index = 0; index < rounds; index += 1) {
    if (BigInt(index) < needed0) {
      const quote = await requestPrivateQuote(
        stack,
        wallet,
        swap0,
        true,
        `fee token0 quote ${index + 1}/${needed0}`,
      );
      applyModeledSwap(model, swap0, true, quote);
      const encryptedSwap0 = await Promise.all([
        wallet.encryptValue256(swap0, stack.poolAddress, swapSelector),
        wallet.encryptValue256(minimumWithSlippage(quote), stack.poolAddress, swapSelector),
      ]);
      await submit(
        `fee token0 swap ${index + 1}/${needed0}`,
        () => stack.pool.swapExactInput(
          encryptedSwap0[0],
          encryptedSwap0[1],
          true,
          BigInt(Math.floor(Date.now() / 1000) + 600),
          TX_OVERRIDES,
        ),
      );
    }
    if (BigInt(index) < needed1) {
      const quote = await requestPrivateQuote(
        stack,
        wallet,
        swap1,
        false,
        `fee token1 quote ${index + 1}/${needed1}`,
      );
      applyModeledSwap(model, swap1, false, quote);
      const encryptedSwap1 = await Promise.all([
        wallet.encryptValue256(swap1, stack.poolAddress, swapSelector),
        wallet.encryptValue256(minimumWithSlippage(quote), stack.poolAddress, swapSelector),
      ]);
      await submit(
        `fee token1 swap ${index + 1}/${needed1}`,
        () => stack.pool.swapExactInput(
          encryptedSwap1[0],
          encryptedSwap1[1],
          false,
          BigInt(Math.floor(Date.now() / 1000) + 600),
          TX_OVERRIDES,
        ),
      );
    }
  }

  count0 = BigInt(await stack.pool.protocolFeeSwapCount0());
  count1 = BigInt(await stack.pool.protocolFeeSwapCount1());
  if (count0 !== TARGET_SWAP_COUNT || count1 !== TARGET_SWAP_COUNT) {
    throw new Error("confidential fee batch did not reach the exact required swap count");
  }
  recoveryJournal.updateResourceMetadata(RESOURCE_ID, { phase: "awaiting-maturity" });
  const window0 = BigInt(await stack.pool.protocolFeeWindowStart0());
  const window1 = BigInt(await stack.pool.protocolFeeWindowStart1());
  const readyAt = (window0 > window1 ? window0 : window1) + COLLECTION_DELAY_SECONDS;
  let latestBlock = await ethers.provider.getBlock("latest");
  if (!latestBlock) throw new Error("latest block unavailable");
  const prematureLabel = "premature confidential protocol fee collection";
  const existingPrematureProof = recoveryJournal.transactions.filter((transaction) =>
    transaction.label === prematureLabel && transaction.status === "mined-failure"
  );
  if (existingPrematureProof.length > 1) {
    throw new Error("fee maturity proof has multiple premature collection transactions");
  }
  if (existingPrematureProof.length === 0) {
    if (BigInt(latestBlock.timestamp) >= readyAt) {
      throw new Error("fee maturity rejection window was missed; recover and restart the disposable proof");
    }
    await submitExpectedFailure(
      prematureLabel,
      () => stack.pool.collectProtocolFees(true, true, TX_OVERRIDES),
    );
    recoveryJournal.updateResourceMetadata(RESOURCE_ID, {
      phase: "maturity-rejection-proven",
    });
    latestBlock = await ethers.provider.getBlock("latest");
    if (!latestBlock) throw new Error("latest block unavailable after maturity rejection");
  }
  stage = "fee collection maturity gate";
  requireFeeCollectionMature(BigInt(latestBlock.timestamp), readyAt);

  const collection = await submit(
    "mature confidential protocol fee collection",
    () => stack.pool.collectProtocolFees(true, true, TX_OVERRIDES),
  );
  const deposits = collection.receipt.logs.flatMap((log) => {
    if (log.address.toLowerCase() !== stack.feeVaultAddress.toLowerCase()) return [];
    try {
      const parsed = stack.feeVault.interface.parseLog(log);
      return parsed?.name === "ConfidentialFeesDeposited" ? [parsed] : [];
    } catch {
      return [];
    }
  });
  if (
    deposits.length !== 2 ||
    !deposits.every((event) =>
      String(event.args.pool).toLowerCase() === stack.poolAddress.toLowerCase() &&
      BigInt(event.args.aggregatedSwapCount) === TARGET_SWAP_COUNT
    )
  ) throw new Error("mature collection did not produce two exact vault deposits");
  model.protocolFee0 = 0n;
  model.protocolFee1 = 0n;
  recoveryJournal.updateResourceMetadata(RESOURCE_ID, { phase: "collected" });

  if (await privateBalance(stack.token0, owner, wallet) < swap0) {
    throw new Error("terminal-fee proof exceeds the available private token0 balance");
  }
  await setPrivateAllowance(
    stack.token0,
    stack.token0Address,
    stack.poolAddress,
    swap0,
    wallet,
    "terminal fee token0",
  );
  const terminalQuote = await requestPrivateQuote(
    stack,
    wallet,
    swap0,
    true,
    "terminal sub-threshold fee quote",
  );
  applyModeledSwap(model, swap0, true, terminalQuote);
  const encryptedTerminalSwap = await Promise.all([
    wallet.encryptValue256(swap0, stack.poolAddress, swapSelector),
    wallet.encryptValue256(
      minimumWithSlippage(terminalQuote),
      stack.poolAddress,
      swapSelector,
    ),
  ]);
  await submit(
    "terminal sub-threshold fee swap",
    () => stack.pool.swapExactInput(
      encryptedTerminalSwap[0],
      encryptedTerminalSwap[1],
      true,
      BigInt(Math.floor(Date.now() / 1000) + 600),
      TX_OVERRIDES,
    ),
  );
  if (BigInt(await stack.pool.protocolFeeSwapCount0()) !== 1n) {
    throw new Error("terminal-fee proof did not create one sub-threshold accrual");
  }
  recoveryJournal.updateResourceMetadata(RESOURCE_ID, { phase: "terminal-swapped" });

  const terminalExit = await removeAllLiquidity(
    stack,
    wallet,
    minimumWithSlippage(model.reserve0),
    minimumWithSlippage(model.reserve1),
  );
  if (!terminalExit) throw new Error("terminal full exit produced no transaction");
  const terminalReceipt = terminalExit.receipt;
  const terminalDeposits = terminalReceipt.logs.flatMap((log) => {
    if (log.address.toLowerCase() !== stack.feeVaultAddress.toLowerCase()) return [];
    try {
      const parsed = stack.feeVault.interface.parseLog(log);
      return parsed?.name === "ConfidentialFeesDeposited" ? [parsed] : [];
    } catch {
      return [];
    }
  });
  if (
    terminalDeposits.length !== 1 ||
    String(terminalDeposits[0].args.pool).toLowerCase() !== stack.poolAddress.toLowerCase() ||
    String(terminalDeposits[0].args.token).toLowerCase() !== stack.token0Address.toLowerCase() ||
    BigInt(terminalDeposits[0].args.aggregatedSwapCount) !== 1n ||
    Boolean(await stack.pool.initialized()) ||
    BigInt(await stack.pool.protocolFeeSwapCount0()) !== 0n ||
    BigInt(await stack.pool.protocolFeeSwapCount1()) !== 0n
  ) throw new Error("terminal full exit did not safely aggregate and clear the final fee");

  const [poolBalance0, poolBalance1, allowanceAfter0, allowanceAfter1] = await Promise.all([
    privateBalance(stack.token0, stack.poolAddress, wallet),
    privateBalance(stack.token1, stack.poolAddress, wallet),
    privateAllowance(stack.token0, owner, stack.poolAddress, wallet),
    privateAllowance(stack.token1, owner, stack.poolAddress, wallet),
  ]);
  if (poolBalance0 !== 0n || poolBalance1 !== 0n || allowanceAfter0 !== 0n || allowanceAfter1 !== 0n) {
    throw new Error("completed disposable fee proof left private-token residue or allowance");
  }
  await setPrivateAllowance(
    stack.token0, stack.token0Address, stack.poolAddress, 0n, wallet, "fee token0 final cleanup",
  );
  await setPrivateAllowance(
    stack.token1, stack.token1Address, stack.poolAddress, 0n, wallet, "fee token1 final cleanup",
  );
  recoveryJournal.markRecovered(RESOURCE_ID, [terminalExit.transactionHash]);
  const lpTokenAddress = ethers.getAddress(await stack.pool.lpToken());
  const [privateTokenCodehashes, poolDeployerCode, strategyRegistryCode,
    reviewedStrategyArtifact] = await Promise.all([
      resolvePrivateTokenCodehashes(
        ethers.provider,
        [stack.token0Address, stack.token1Address],
      ),
      ethers.provider.getCode(stack.poolDeployerAddress),
      ethers.provider.getCode(stack.strategyRegistryAddress),
      artifacts.readArtifact("ConfidentialLaunchInitializationStrategy"),
    ]);
  const poolDeployerRuntimeCodehash = ethers.keccak256(poolDeployerCode);
  const strategyRegistryRuntimeCodehash = ethers.keccak256(strategyRegistryCode);
  const reviewedStrategyRuntimeCodehash = ethers.keccak256(
    reviewedStrategyArtifact.deployedBytecode,
  );
  recoveryJournal.prepareEvidence({
    participants: [owner],
    configuration: {
      chainId: Number(network.chainId),
      confidentialPoolVersion: 3,
      privacyMode: 1,
      totalFeeBps: Number(FEE_BPS),
      targetSwapCountPerDirection: Number(TARGET_SWAP_COUNT),
      collectionDelaySeconds: Number(COLLECTION_DELAY_SECONDS),
      collectionReadyAt: Number(readyAt),
      tokenA: tokenAAddress,
      tokenB: tokenBAddress,
      feeBeneficiary,
    },
    artifacts: [
      {
        label: "disposable fee vault",
        contractName: "CipherDEXFeeVault",
        address: stack.feeVaultAddress,
        creationTransactionHash: metadataHash(stack.resource, "feeVaultTx"),
        constructorArguments: [feeBeneficiary],
      },
      {
        label: "disposable private LP factory",
        contractName: "PrivateLPTokenFactory",
        address: stack.lpFactoryAddress,
        creationTransactionHash: metadataHash(stack.resource, "lpFactoryTx"),
        constructorArguments: [],
      },
      {
        label: "disposable confidential factory",
        contractName: "ConfidentialCPMMFactory",
        address: stack.factoryAddress,
        creationTransactionHash: metadataHash(stack.resource, "factoryTx"),
        constructorArguments: [
          stack.feeVaultAddress,
          stack.lpFactoryAddress,
          stack.poolDeployerAddress,
          poolDeployerRuntimeCodehash,
          privateTokenCodehashes,
          stack.strategyRegistryAddress,
          strategyRegistryRuntimeCodehash,
        ],
      },
      {
        label: "disposable confidential pool deployer",
        contractName: "ConfidentialCPMMDeployer",
        address: stack.poolDeployerAddress,
        creationTransactionHash: metadataHash(stack.resource, "poolDeployerTx"),
        constructorArguments: [],
      },
      {
        label: "disposable initialization strategy registry",
        contractName: "ConfidentialInitializationStrategyRegistry",
        address: stack.strategyRegistryAddress,
        creationTransactionHash: metadataHash(stack.resource, "strategyRegistryTx"),
        constructorArguments: [[reviewedStrategyRuntimeCodehash]],
      },
      {
        label: "disposable confidential fee pool",
        contractName: "ConfidentialCPMM",
        address: stack.poolAddress,
      },
      {
        label: "disposable private LP token",
        contractName: "PrivateLPToken",
        address: lpTokenAddress,
      },
    ],
    assertions: [
      "exact fee batches accrued in both input tokens",
      "maturity gate enforced before collection",
      "two aggregate protocol fee deposits verified",
      "terminal sub-threshold fee deposited on full exit",
      "protocol fees excluded from effective reserves",
      "full LP exit used positive modeled minima",
      "pool balances and owner allowances returned to zero",
      "reviewed deployment contracts were not mutated",
    ],
  });
  const finalEvidence = await writePreparedFundedRunEvidence({
    journal: recoveryJournal,
    provider: ethers.provider,
    attestationSigner: wallet,
  });
  console.log(`disposableFeePool=${stack.poolAddress}`);
  console.log(`disposableFeeVault=${stack.feeVaultAddress}`);
  console.log(`fundedEvidence=${finalEvidence.path}`);
  console.log(
    "COTI confidential fee collection passed with source-bound disposable custody, exact batched deposits, positive full-exit minima, and zero pool residue",
  );
}

void main().catch(async (error: unknown) => {
  if (recoveryJournal?.runStatus === "evidence-failed") {
    console.error(
      `COTI fee-collection evidence generation failed: ` +
        `${safeTestnetErrorSummary(error)}; paid execution will not be repeated.`,
    );
    process.exitCode = 1;
    return;
  }
  if (error instanceof FeeCollectionPendingError) {
    recoveryJournal?.markRun("awaiting-maturity");
    console.error(
      `COTI fee-collection proof paused during ${stage}; ${safeTestnetErrorSummary(error)}; ` +
        "the source-bound disposable pool remains journaled for the required rerun.",
    );
    process.exitCode = 75;
    return;
  }
  if (error instanceof UnknownBroadcastOutcomeError) {
    recoveryJournal?.markRun("failed");
    console.error(
      `COTI fee-collection proof paused with an uncertain broadcast: ` +
        `stage=${stage} ${safeTestnetErrorSummary(error)}; cleanup is deferred until receipt reconciliation.`,
    );
    process.exitCode = 1;
    return;
  }

  let reportedError = error;
  try {
    await recoverDisposablePool();
    recoveryJournal?.markRun("failed");
  } catch (recoveryError) {
    recoveryJournal?.markRun("recovery-failed");
    reportedError = new AggregateError(
      [error, recoveryError],
      "fee-collection validation and funded recovery both failed",
    );
  }
  console.error(
    `COTI fee-collection test failed during ${stage}; ${safeTestnetErrorSummary(reportedError)}; ` +
      "private payloads were suppressed.",
  );
  process.exitCode = 1;
});
