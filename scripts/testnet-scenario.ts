import { Wallet as CotiWallet } from "@coti-io/coti-ethers";
import { Contract, TransactionReceipt } from "ethers";
import { ethers } from "hardhat";
import {
  CONFIDENTIAL_QUOTE_TRANSPORT,
  CIPHERDEX_PROTOCOL_VERSION,
  DISCLOSURE_SCHEMA_VERSION,
  PRIVACY_MODE,
  calculateCipherDEXV1FeeBreakdown,
  getCipherDEXV1FeePolicy,
  verifyConfidentialPoolDiscovery,
  type ConfidentialPoolDiscovery,
  type VerifiedConfidentialPoolDiscovery,
} from "../sdk/src";
import {
  CONFIDENTIAL_POOL_TESTNET_ABI,
  PRIVATE_ERC20_TESTNET_ABI,
} from "./coti-testnet-abi";
import { decryptPrivateValue256 } from "./coti-testnet-values";
import { resolvePrivateTokenCodehashes } from "./private-token-codehashes";
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
  requireMinedFailure,
  requireMinedSuccess,
  safeTestnetErrorSummary,
} from "./testnet-transaction-evidence";

const requiredAddress = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value || !ethers.isAddress(value)) throw new Error(`missing ${name}`);
  return value;
};

const requiredPrivateKey = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`missing ${name}`);
  }
  return value;
};

const requiredBigInt = (name: string): bigint => {
  const value = process.env[name]?.trim();
  if (!value || !/^\d+$/.test(value)) throw new Error(`missing ${name}`);
  return BigInt(value);
};

const requiredPositiveBigInt = (name: string): bigint => {
  const value = requiredBigInt(name);
  if (value === 0n) throw new Error(`${name} must be positive`);
  return value;
};

const requiredUInt = (name: string, fallback?: number): number => {
  const value = process.env[name]?.trim();
  if (!value && fallback !== undefined) return fallback;
  if (!value || !/^\d+$/.test(value)) throw new Error(`missing ${name}`);
  return Number(value);
};

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const ceilDiv = (numerator: bigint, denominator: bigint): bigint =>
  numerator / denominator + (numerator % denominator === 0n ? 0n : 1n);

const requireConfidentialFeeAccrual = (
  amountIn: bigint,
  feeBps: number,
): void => {
  if (calculateCipherDEXV1FeeBreakdown(amountIn, feeBps).protocolFee > 0n) return;
  throw new Error("configured confidential input is below the fee-accrual minimum");
};

const CONFIDENTIAL_FACTORY_DEPLOY_GAS_LIMIT = 8_000_000n;
const FEE_VAULT_BIND_GAS_LIMIT = 250_000n;
const PRIVATE_LP_FACTORY_DEPLOY_GAS_LIMIT = 8_000_000n;
const CONFIDENTIAL_POOL_CREATE_GAS_LIMIT = 6_500_000n;
const FEE_VAULT_DEPLOY_GAS_LIMIT = 1_000_000n;
const gasLimitText = process.env.COTI_TESTNET_GAS_LIMIT?.trim() ?? "30000000";
if (!/^\d+$/.test(gasLimitText) || BigInt(gasLimitText) === 0n) {
  throw new Error("COTI_TESTNET_GAS_LIMIT must be a positive integer");
}
const COTI_TESTNET_TX_OVERRIDES = { gasLimit: BigInt(gasLimitText) } as const;

let stage = "configuration";

type PoolContext = {
  address: string;
  pool: Contract;
  token0Address: string;
  token1Address: string;
  token0: Contract;
  token1: Contract;
  token0Decimals: number;
  token1Decimals: number;
  feeBps: number;
  feeVault: string;
};

type LocallyVerifiedQuote = {
  discovery: VerifiedConfidentialPoolDiscovery;
  requestId: string;
  amountIn: bigint;
  zeroForOne: boolean;
  decryptedAmountOut: bigint;
};

async function submit(
  label: string,
  transaction: Promise<{ hash: string; wait(): Promise<any> }>,
): Promise<any> {
  stage = label;
  const started = Date.now();
  const evidence = await requireMinedSuccess(
    label,
    () => transaction,
    (hash) => ethers.provider.getTransactionReceipt(hash),
  );
  const receipt = evidence.receipt;
  const gasUsed = receipt?.gasUsed?.toString() ?? "unknown";
  console.log(
    `${label}: tx=${evidence.transactionHash} gas=${gasUsed} ` +
      `latencyMs=${Date.now() - started}`,
  );
  return receipt;
}

async function deployFunded(
  label: string,
  operation: () => Promise<any>,
): Promise<any> {
  let contract: any;
  await submit(
    label,
    (async () => {
      contract = await operation();
      const transaction = contract.deploymentTransaction();
      if (!transaction) throw new Error(`${label} transaction unavailable`);
      return transaction;
    })(),
  );
  if (!contract) {
    throw new Error(`${label} mined without a contract handle; do not retry automatically`);
  }
  return contract;
}

async function expectMinedFailure(
  label: string,
  operation: () => Promise<{
    hash: string;
    wait(): Promise<TransactionReceipt | null>;
  }>,
): Promise<void> {
  stage = label;
  const evidence = await requireMinedFailure(
    label,
    operation,
    (hash) => ethers.provider.getTransactionReceipt(hash),
  );
  console.log(`${label}: rejected onchain tx=${evidence.transactionHash}`);
}

async function readPrivateBalance(
  token: Contract,
  owner: string,
  wallet: CotiWallet,
): Promise<bigint> {
  const ciphertext = await token.balanceOf.staticCall(owner);
  return decryptPrivateValue256(wallet, ciphertext);
}

async function readPrivateShares(pool: Contract, wallet: CotiWallet): Promise<bigint> {
  const privateLpToken = String(await pool.lpToken());
  if (privateLpToken !== ethers.ZeroAddress) {
    const owner = await wallet.getAddress();
    const lpToken = new Contract(privateLpToken, PRIVATE_ERC20_TESTNET_ABI, wallet);
    const ciphertext = await lpToken.balanceOf.staticCall(owner);
    return decryptPrivateValue256(wallet, ciphertext);
  }
  const ciphertext = await pool.myShares.staticCall();
  return decryptPrivateValue256(wallet, ciphertext);
}

async function loadPoolContext(address: string, wallet: CotiWallet): Promise<PoolContext> {
  const pool = new Contract(address, CONFIDENTIAL_POOL_TESTNET_ABI, wallet);
  const [token0AddressValue, token1AddressValue, token0DecimalsValue, token1DecimalsValue] =
    await Promise.all([
      pool.token0(),
      pool.token1(),
      pool.token0Decimals(),
      pool.token1Decimals(),
    ]);
  const token0Address = String(token0AddressValue);
  const token1Address = String(token1AddressValue);
  return {
    address,
    pool,
    token0Address,
    token1Address,
    token0: new Contract(token0Address, PRIVATE_ERC20_TESTNET_ABI, wallet),
    token1: new Contract(token1Address, PRIVATE_ERC20_TESTNET_ABI, wallet),
    token0Decimals: Number(token0DecimalsValue),
    token1Decimals: Number(token1DecimalsValue),
    feeBps: Number(await pool.feeBps()),
    feeVault: String(await pool.feeVault()),
  };
}

async function approvePoolInputs(
  context: PoolContext,
  wallet: CotiWallet,
  amount0: bigint,
  amount1: bigint,
  label: string,
): Promise<void> {
  const approveSelector0 = context.token0.interface.getFunction("approve")?.selector;
  const approveSelector1 = context.token1.interface.getFunction("approve")?.selector;
  if (!approveSelector0 || !approveSelector1) throw new Error("approval selector unavailable");

  const zero0 = await wallet.encryptValue256(0n, context.token0Address, approveSelector0);
  const zero1 = await wallet.encryptValue256(0n, context.token1Address, approveSelector1);
  const approval0 = await wallet.encryptValue256(amount0, context.token0Address, approveSelector0);
  const approval1 = await wallet.encryptValue256(amount1, context.token1Address, approveSelector1);
  const owner = await wallet.getAddress();
  const current0 = await context.token0.allowance.staticCall(owner, context.address);
  const current1 = await context.token1.allowance.staticCall(owner, context.address);
  const currentAmount0 = await wallet.decryptValue256(current0.ownerCiphertext);
  const currentAmount1 = await wallet.decryptValue256(current1.ownerCiphertext);
  if (currentAmount0 !== amount0) {
    await submit(
      `${label} token0 approval reset`,
      context.token0.approve(context.address, zero0, COTI_TESTNET_TX_OVERRIDES),
    );
    if (amount0 > 0n) {
      await submit(
        `${label} token0 approval`,
        context.token0.approve(context.address, approval0, COTI_TESTNET_TX_OVERRIDES),
      );
    }
  }
  if (currentAmount1 !== amount1) {
    await submit(
      `${label} token1 approval reset`,
      context.token1.approve(context.address, zero1, COTI_TESTNET_TX_OVERRIDES),
    );
    if (amount1 > 0n) {
      await submit(
        `${label} token1 approval`,
        context.token1.approve(context.address, approval1, COTI_TESTNET_TX_OVERRIDES),
      );
    }
  }
}

async function addPrivateLiquidity(
  context: PoolContext,
  wallet: CotiWallet,
  amount0: bigint,
  amount1: bigint,
  label: string,
): Promise<void> {
  const selector = context.pool.interface.getFunction("addLiquidity")?.selector;
  if (!selector) throw new Error("add-liquidity selector unavailable");
  const encrypted0 = await wallet.encryptValue256(amount0, context.address, selector);
  const encrypted1 = await wallet.encryptValue256(amount1, context.address, selector);
  const expectedInitialized = await context.pool.initialized();
  const bounds = confidentialLiquidityBounds(
    amount0,
    context.token0Decimals,
    amount1,
    context.token1Decimals,
    expectedInitialized,
  );
  const minimum = await wallet.encryptValue256(bounds.minShares, context.address, selector);
  const minimumPrice = await wallet.encryptValue256(
    bounds.minPriceX18,
    context.address,
    selector,
  );
  const maximumPrice = await wallet.encryptValue256(
    bounds.maxPriceX18,
    context.address,
    selector,
  );
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  await submit(
    label,
    context.pool.addLiquidity(
      encrypted0,
      encrypted1,
      minimum,
      minimumPrice,
      maximumPrice,
      expectedInitialized,
      deadline,
      COTI_TESTNET_TX_OVERRIDES,
    ),
  );
}

function lockIdFromReceipt(pool: Contract, receipt: any, permanent: boolean): string {
  for (const log of receipt?.logs ?? []) {
    try {
      const parsed = pool.interface.parseLog({ topics: log.topics, data: log.data });
      if (parsed?.name === "LiquidityLocked" && parsed.args.permanent === permanent) {
        return parsed.args.lockId as string;
      }
    } catch {
      // Ignore logs emitted by token contracts.
    }
  }
  throw new Error(`lock event missing (${permanent ? "permanent" : "timed"})`);
}

function encryptedQuoteFromReceipt(
  pool: Contract,
  receipt: any,
  caller: string,
  requestId: string,
  zeroForOne: boolean,
): unknown {
  const poolAddress = String(pool.target).toLowerCase();
  const matches: unknown[] = [];
  for (const log of receipt?.logs ?? []) {
    if (String(log.address).toLowerCase() !== poolAddress) continue;
    try {
      const parsed = pool.interface.parseLog({ topics: log.topics, data: log.data });
      if (
        parsed?.name === "ConfidentialQuoteResult" &&
        String(parsed.args.caller).toLowerCase() === caller.toLowerCase() &&
        String(parsed.args.requestId).toLowerCase() === requestId.toLowerCase() &&
        parsed.args.zeroForOne === zeroForOne
      ) {
        matches.push(parsed.args.result);
      }
    } catch {
      // Ignore logs emitted by token contracts.
    }
  }
  if (matches.length !== 1) {
    throw new Error("encrypted quote result event is missing or ambiguous");
  }
  return matches[0];
}

async function requestPrivateQuote(
  context: PoolContext,
  wallet: CotiWallet,
  amountIn: bigint,
  zeroForOne: boolean,
  requestId: string,
  label: string,
): Promise<bigint> {
  const selector = context.pool.interface.getFunction("requestQuoteExactInput")?.selector;
  if (!selector) throw new Error("transactional quote selector unavailable");
  const encryptedInput = await wallet.encryptValue256(amountIn, context.address, selector);
  const caller = await wallet.getAddress();
  const receipt = await submit(
    label,
    context.pool.requestQuoteExactInput(
      encryptedInput,
      zeroForOne,
      requestId,
      COTI_TESTNET_TX_OVERRIDES,
    ),
  );
  return wallet.decryptValue256(
    encryptedQuoteFromReceipt(
      context.pool,
      receipt,
      caller,
      requestId,
      zeroForOne,
    ) as never,
  );
}

async function main(): Promise<void> {
  stage = "configuration";
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== 7_082_400n) {
    throw new Error(`expected COTI testnet 7082400, received ${network.chainId}`);
  }
  const privateKey = requiredPrivateKey("COTI_TESTNET_PRIVATE_KEY");
  const aesKey = process.env.COTI_AES_KEY?.trim();
  if (!aesKey) throw new Error("missing COTI_AES_KEY");

  const tokenAddressA = requiredAddress("COTI_TOKEN0");
  const tokenAddressB = requiredAddress("COTI_TOKEN1");
  const tokenDecimalsA = requiredUInt("COTI_TOKEN0_DECIMALS");
  const tokenDecimalsB = requiredUInt("COTI_TOKEN1_DECIMALS");
  const feeBps = requiredUInt("COTI_FEE_BPS", 30);
  const quoteFeeBps = requiredUInt("COTI_QUOTE_FEE_BPS");
  if (quoteFeeBps === feeBps) throw new Error("COTI_QUOTE_FEE_BPS must differ from COTI_FEE_BPS");
  const liquidityAmount0 = requiredBigInt("COTI_LIQUIDITY_AMOUNT0");
  const liquidityAmount1 = requiredBigInt("COTI_LIQUIDITY_AMOUNT1");
  const quoteLiquidityAmount0 = requiredBigInt("COTI_QUOTE_LIQUIDITY_AMOUNT0");
  const quoteLiquidityAmount1 = requiredBigInt("COTI_QUOTE_LIQUIDITY_AMOUNT1");
  const secondLiquidityAmount0 = requiredBigInt("COTI_SECOND_LP_AMOUNT0");
  const secondLiquidityAmount1 = requiredBigInt("COTI_SECOND_LP_AMOUNT1");
  const swapAmount0 = requiredBigInt("COTI_SWAP_AMOUNT0");
  const swapAmount1 = requiredBigInt("COTI_SWAP_AMOUNT1");
  const secondLpRemoveMin0 = requiredPositiveBigInt("COTI_SECOND_LP_REMOVE_MIN0");
  const secondLpRemoveMin1 = requiredPositiveBigInt("COTI_SECOND_LP_REMOVE_MIN1");
  const personalRemoveMin0 = requiredPositiveBigInt("COTI_PERSONAL_REMOVE_MIN0");
  const personalRemoveMin1 = requiredPositiveBigInt("COTI_PERSONAL_REMOVE_MIN1");
  const fullExitMin0 = requiredPositiveBigInt("COTI_FULL_EXIT_MIN0");
  const fullExitMin1 = requiredPositiveBigInt("COTI_FULL_EXIT_MIN1");
  const lockSeconds = requiredUInt("COTI_TEST_LOCK_SECONDS", 10);
  requireConfidentialFeeAccrual(swapAmount0, feeBps);
  requireConfidentialFeeAccrual(swapAmount0, quoteFeeBps);
  requireConfidentialFeeAccrual(swapAmount1, feeBps);
  const secondPrivateKey = requiredPrivateKey("COTI_SECOND_LP_PRIVATE_KEY");
  const secondAesKey = process.env.COTI_SECOND_LP_AES_KEY?.trim();
  if (!secondAesKey) throw new Error("missing COTI_SECOND_LP_AES_KEY");
  const quotePrivateKey = requiredPrivateKey("COTI_QUOTE_PRIVATE_KEY");
  const quoteAesKey = process.env.COTI_QUOTE_AES_KEY?.trim();
  if (!quoteAesKey) throw new Error("missing COTI_QUOTE_AES_KEY");
  stage = "identity initialization";
  const [deployer] = await ethers.getSigners();
  const wallet = new CotiWallet(privateKey, ethers.provider, { aesKey });
  wallet.setAesKey(aesKey);
  const walletAddress = await wallet.getAddress();
  if ((await deployer.getAddress()).toLowerCase() !== walletAddress.toLowerCase()) {
    throw new Error("configured deployer and COTI wallet do not match");
  }
  const secondWallet = new CotiWallet(secondPrivateKey, ethers.provider, { aesKey: secondAesKey });
  secondWallet.setAesKey(secondAesKey);
  const secondWalletAddress = await secondWallet.getAddress();
  const quoteWallet = new CotiWallet(quotePrivateKey, ethers.provider, { aesKey: quoteAesKey });
  quoteWallet.setAesKey(quoteAesKey);
  const quoteWalletAddress = await quoteWallet.getAddress();
  if (
    secondWalletAddress.toLowerCase() === walletAddress.toLowerCase() ||
    quoteWalletAddress.toLowerCase() === walletAddress.toLowerCase() ||
    quoteWalletAddress.toLowerCase() === secondWalletAddress.toLowerCase()
  ) {
    throw new Error("deployer, second LP and quote identity must be separate accounts");
  }

  const configuredFactoryAddress = requiredAddress("COTI_FACTORY");
  const configuredFeeVaultAddress = requiredAddress("COTI_FEE_VAULT");
  stage = "reviewed deployment provenance";
  const deploymentRecord = await verifyConfiguredTestnetDeployment(
    requiredTestnetDeploymentRecordPath(),
    ethers.provider,
    [
      {
        recordKey: "confidentialFactory",
        contractName: "ConfidentialCPMMFactory",
        address: configuredFactoryAddress,
      },
      {
        recordKey: "feeVault",
        contractName: "CipherDEXFeeVault",
        address: configuredFeeVaultAddress,
      },
    ],
  );
  assertReviewedPrivateTokens(deploymentRecord, [tokenAddressA, tokenAddressB]);
  const privateTokenCodehashes = await resolvePrivateTokenCodehashes(
    ethers.provider,
    [tokenAddressA, tokenAddressB],
  );

  if (process.env.COTI_POOL?.trim() || process.env.COTI_QUOTE_POOL?.trim()) {
    throw new Error(
      "the destructive full scenario does not accept COTI_POOL or COTI_QUOTE_POOL; " +
      "it always deploys an isolated disposable factory",
    );
  }
  let poolAddress: string | undefined;
  let quotePoolAddress: string | undefined;
  let trustedFactoryAddress = configuredFactoryAddress;
  let trustedFeeVaultAddress = configuredFeeVaultAddress;
  let trustedLpTokenFactoryAddress: string | undefined;
  let trustedLpTokenFactoryRuntimeCodehash: string | undefined;
  let createdPrimaryPool = false;
  let createdQuotePool = false;
  if (!poolAddress) {
    stage = "fee vault deployment";
    const feeVaultFactory = await ethers.getContractFactory("CipherDEXFeeVault", wallet);
    const feeVault = await deployFunded(
      "fee vault deployment",
      () => feeVaultFactory.deploy(walletAddress, { gasLimit: FEE_VAULT_DEPLOY_GAS_LIMIT }),
    );
    const feeVaultAddress = await feeVault.getAddress();
    trustedFeeVaultAddress = feeVaultAddress;
    console.log(`fee vault deployed: ${feeVaultAddress}`);
    stage = "private LP token factory deployment";
    const privateLpFactory = await ethers.getContractFactory("PrivateLPTokenFactory", wallet);
    const lpTokenFactory = await deployFunded(
      "private LP token factory deployment",
      () => privateLpFactory.deploy({ gasLimit: PRIVATE_LP_FACTORY_DEPLOY_GAS_LIMIT }),
    );
    const lpTokenFactoryAddress = await lpTokenFactory.getAddress();
    trustedLpTokenFactoryAddress = lpTokenFactoryAddress;
    trustedLpTokenFactoryRuntimeCodehash = ethers.keccak256(
      await ethers.provider.getCode(lpTokenFactoryAddress),
    );
    console.log(`private LP token factory deployed: ${lpTokenFactoryAddress}`);
    stage = "confidential factory deployment";
    const factoryFactory = await ethers.getContractFactory("ConfidentialCPMMFactory", wallet);
    const factory = await deployFunded(
      "confidential factory deployment",
      () => factoryFactory.deploy(
        feeVaultAddress,
        lpTokenFactoryAddress,
        privateTokenCodehashes,
        { gasLimit: CONFIDENTIAL_FACTORY_DEPLOY_GAS_LIMIT },
      ),
    );
    const factoryAddress = await factory.getAddress();
    trustedFactoryAddress = factoryAddress;
    console.log(`factory deployed: ${factoryAddress}`);
    await submit(
      "confidential fee-vault factory binding",
      feeVault.setConfidentialFactory(factoryAddress, {
        gasLimit: FEE_VAULT_BIND_GAS_LIMIT,
      }),
    );
    if ((await feeVault.confidentialFactory()).toLowerCase() !== factoryAddress.toLowerCase()) {
      throw new Error("fee vault did not bind the confidential factory");
    }
    await submit(
      "pool creation",
      factory.createPool(
        tokenAddressA,
        tokenAddressB,
        tokenDecimalsA,
        tokenDecimalsB,
        feeBps,
        { gasLimit: CONFIDENTIAL_POOL_CREATE_GAS_LIMIT },
      ),
    );
    const [sortedToken0, sortedToken1, sortedDecimals0, sortedDecimals1] =
      tokenAddressA.toLowerCase() < tokenAddressB.toLowerCase()
        ? [tokenAddressA, tokenAddressB, tokenDecimalsA, tokenDecimalsB] as const
        : [tokenAddressB, tokenAddressA, tokenDecimalsB, tokenDecimalsA] as const;
    const key = await factory.poolKey(
      sortedToken0,
      sortedToken1,
      sortedDecimals0,
      sortedDecimals1,
      feeBps,
    );
    poolAddress = await factory.getPool(key);
    if (!poolAddress || poolAddress === ethers.ZeroAddress) {
      throw new Error("factory did not return a pool address");
    }
    createdPrimaryPool = true;
    await submit(
      "quote-candidate pool creation",
      factory.createPool(
        tokenAddressA,
        tokenAddressB,
        tokenDecimalsA,
        tokenDecimalsB,
        quoteFeeBps,
        { gasLimit: CONFIDENTIAL_POOL_CREATE_GAS_LIMIT },
      ),
    );
    const quoteKey = await factory.poolKey(
      sortedToken0,
      sortedToken1,
      sortedDecimals0,
      sortedDecimals1,
      quoteFeeBps,
    );
    quotePoolAddress = await factory.getPool(quoteKey);
    if (!quotePoolAddress || quotePoolAddress === ethers.ZeroAddress) {
      throw new Error("factory did not return the quote-candidate pool address");
    }
    createdQuotePool = true;
  }
  if (!ethers.isAddress(poolAddress)) throw new Error("invalid COTI_POOL");
  if (!trustedFactoryAddress || !ethers.isAddress(trustedFactoryAddress)) {
    throw new Error("missing or invalid COTI_FACTORY");
  }
  if (!trustedFeeVaultAddress || !ethers.isAddress(trustedFeeVaultAddress)) {
    throw new Error("missing or invalid COTI_FEE_VAULT");
  }
  if (!quotePoolAddress || !ethers.isAddress(quotePoolAddress)) {
    throw new Error("missing or invalid COTI_QUOTE_POOL");
  }
  if (quotePoolAddress.toLowerCase() === poolAddress.toLowerCase()) {
    throw new Error("COTI_POOL and COTI_QUOTE_POOL must be different fee-tier pools");
  }
  if (
    !trustedLpTokenFactoryAddress ||
    !ethers.isAddress(trustedLpTokenFactoryAddress) ||
    !trustedLpTokenFactoryRuntimeCodehash ||
    !/^0x[0-9a-f]{64}$/iu.test(trustedLpTokenFactoryRuntimeCodehash)
  ) {
    throw new Error("missing reviewed private LP-token factory provenance");
  }
  console.log(`pool: ${poolAddress}`);
  console.log(`quote candidate pool: ${quotePoolAddress}`);

  stage = "pool configuration validation";
  const poolContext = await loadPoolContext(poolAddress, wallet);
  const quotePoolContext = await loadPoolContext(quotePoolAddress, wallet);
  if (!(await poolContext.pool.initialized())) createdPrimaryPool = true;
  if (!(await quotePoolContext.pool.initialized())) createdQuotePool = true;
  const [expectedToken0, expectedToken1, expectedDecimals0, expectedDecimals1] =
    tokenAddressA.toLowerCase() < tokenAddressB.toLowerCase()
      ? [tokenAddressA, tokenAddressB, tokenDecimalsA, tokenDecimalsB] as const
      : [tokenAddressB, tokenAddressA, tokenDecimalsB, tokenDecimalsA] as const;
  const discoveryFactoryAddress = trustedFactoryAddress;
  const discoveryFactory = await ethers.getContractAt(
    "ConfidentialCPMMFactory",
    discoveryFactoryAddress,
    quoteWallet,
  );
  const discoveryLpTokenFactory = await ethers.getContractAt(
    "PrivateLPTokenFactory",
    trustedLpTokenFactoryAddress,
    quoteWallet,
  );
  const [factoryCode, feeVaultCode, factoryVersionValue] = await Promise.all([
    ethers.provider.getCode(discoveryFactoryAddress),
    ethers.provider.getCode(trustedFeeVaultAddress),
    discoveryFactory.PROTOCOL_VERSION(),
  ]);
  const discoveryProtocolVersion = Number(factoryVersionValue);
  if (
    factoryCode === "0x" ||
    feeVaultCode === "0x" ||
    discoveryProtocolVersion !== CIPHERDEX_PROTOCOL_VERSION
  ) {
    throw new Error("trusted factory or fee vault is not a deployed CipherDEX v2 contract");
  }
  for (const context of [poolContext, quotePoolContext]) {
    if (
      context.token0Address.toLowerCase() !== expectedToken0.toLowerCase() ||
      context.token1Address.toLowerCase() !== expectedToken1.toLowerCase()
    ) {
      throw new Error("quote candidate token pair does not match the configured canonical pair");
    }
  }
  for (const context of [poolContext, quotePoolContext]) {
    const key = await discoveryFactory.poolKey(
      context.token0Address,
      context.token1Address,
      expectedDecimals0,
      expectedDecimals1,
      context.feeBps,
    );
    const [recognized, canonicalPool] = await Promise.all([
      discoveryFactory.isPool(context.address),
      discoveryFactory.getPool(key),
    ]);
    if (
      (await context.pool.bootstrapper()).toLowerCase() !== trustedFactoryAddress.toLowerCase() ||
      context.feeVault.toLowerCase() !== trustedFeeVaultAddress.toLowerCase() ||
      Number(await context.pool.PROTOCOL_VERSION()) !== CIPHERDEX_PROTOCOL_VERSION ||
      !recognized ||
      String(canonicalPool).toLowerCase() !== context.address.toLowerCase()
    ) {
      throw new Error(
        "configured pool candidate is not canonical in the trusted v2 factory and vault",
      );
    }
  }
  if (poolContext.feeBps !== feeBps || quotePoolContext.feeBps !== quoteFeeBps) {
    throw new Error("configured pool fee tiers do not match the deployed candidates");
  }
  if (!createdPrimaryPool || !createdQuotePool) {
    throw new Error(
      "the full scenario requires fresh uninitialized pools because confidential reserves " +
      "cannot be read or quoted gaslessly on the current COTI runtime",
    );
  }
  if (
    poolContext.feeVault === ethers.ZeroAddress ||
    quotePoolContext.feeVault === ethers.ZeroAddress ||
    poolContext.feeVault.toLowerCase() !== quotePoolContext.feeVault.toLowerCase()
  ) {
    throw new Error("configured pool candidates do not share a valid fee vault");
  }
  for (const context of [poolContext, quotePoolContext]) {
    const policy = getCipherDEXV1FeePolicy(context.feeBps);
    if (
      policy.protocolFeeShareNumerator !== 1 ||
      policy.protocolFeeShareDenominator !== 6 ||
      policy.extraNativeSwapFee
    ) {
      throw new Error("configured pool candidate does not match the CipherDEX v1 fee policy");
    }
  }

  const pool = poolContext.pool;
  const token0 = poolContext.token0;
  const token1 = poolContext.token1;
  const lockSelector = pool.interface.getFunction("lockShares")?.selector;
  const removeSelector = pool.interface.getFunction("removeLiquidity")?.selector;
  if (!lockSelector || !removeSelector) {
    throw new Error("pool selector unavailable");
  }

  stage = "primary pool approval preparation";
  await approvePoolInputs(
    poolContext,
    wallet,
    (createdPrimaryPool ? liquidityAmount0 : 0n) + swapAmount0,
    (createdPrimaryPool ? liquidityAmount1 : 0n) + swapAmount1,
    "primary pool",
  );
  stage = "quote-candidate pool approval preparation";
  await approvePoolInputs(
    quotePoolContext,
    wallet,
    (createdQuotePool ? quoteLiquidityAmount0 : 0n) + swapAmount0,
    (createdQuotePool ? quoteLiquidityAmount1 : 0n) + swapAmount1,
    "quote-candidate pool",
  );

  stage = "primary private balance validation";
  const beforeAdd0 = await readPrivateBalance(token0, walletAddress, wallet);
  const beforeAdd1 = await readPrivateBalance(token1, walletAddress, wallet);
  const required0 =
    (createdPrimaryPool ? liquidityAmount0 : 0n) +
    (createdQuotePool ? quoteLiquidityAmount0 : 0n) +
    swapAmount0;
  const required1 =
    (createdPrimaryPool ? liquidityAmount1 : 0n) +
    (createdQuotePool ? quoteLiquidityAmount1 : 0n) +
    swapAmount1;
  if (beforeAdd0 < required0) throw new Error("insufficient private test-token 0 balance");
  if (beforeAdd1 < required1) throw new Error("insufficient private test-token 1 balance");

  stage = "primary liquidity preparation";
  if (createdPrimaryPool) {
    await addPrivateLiquidity(
      poolContext,
      wallet,
      liquidityAmount0,
      liquidityAmount1,
      "primary liquidity add",
    );
  }
  const initialShares = await readPrivateShares(pool, wallet);
  if (initialShares <= 0n) throw new Error("liquidity add returned no private shares");
  if (createdPrimaryPool) {
    const expectedInitialShares =
      liquidityAmount0 * 10n ** BigInt(18 - expectedDecimals0) <
      liquidityAmount1 * 10n ** BigInt(18 - expectedDecimals1)
        ? liquidityAmount0 * 10n ** BigInt(18 - expectedDecimals0)
        : liquidityAmount1 * 10n ** BigInt(18 - expectedDecimals1);
    if (initialShares !== expectedInitialShares) {
      throw new Error("arbitrary-ratio initial share denomination mismatch");
    }
  }
  if (createdQuotePool) {
    await addPrivateLiquidity(
      quotePoolContext,
      wallet,
      quoteLiquidityAmount0,
      quoteLiquidityAmount1,
      "quote-candidate liquidity add",
    );
  }

  stage = "second LP preparation";
  const secondContext = await loadPoolContext(poolAddress, secondWallet);
  await approvePoolInputs(
    secondContext,
    secondWallet,
    secondLiquidityAmount0,
    secondLiquidityAmount1,
    "second LP",
  );
  const secondBefore0 = await readPrivateBalance(
    secondContext.token0,
    secondWalletAddress,
    secondWallet,
  );
  const secondBefore1 = await readPrivateBalance(
    secondContext.token1,
    secondWalletAddress,
    secondWallet,
  );
  if (secondBefore0 < secondLiquidityAmount0 || secondBefore1 < secondLiquidityAmount1) {
    throw new Error("second LP has insufficient private test-token balance");
  }
  await addPrivateLiquidity(
    secondContext,
    secondWallet,
    secondLiquidityAmount0,
    secondLiquidityAmount1,
    "second LP proportional add",
  );
  const secondShares = await readPrivateShares(secondContext.pool, secondWallet);
  if (secondShares <= 0n) throw new Error("second LP received no private shares");
  if ((await readPrivateShares(pool, wallet)) !== initialShares) {
    throw new Error("second LP add changed the first LP share balance");
  }
  const expectedSecondShares0 = (secondLiquidityAmount0 * initialShares) / liquidityAmount0;
  const expectedSecondShares1 = (secondLiquidityAmount1 * initialShares) / liquidityAmount1;
  const expectedSecondShares =
    expectedSecondShares0 < expectedSecondShares1 ? expectedSecondShares0 : expectedSecondShares1;
  const expectedSpend0 = ceilDiv(expectedSecondShares * liquidityAmount0, initialShares);
  const expectedSpend1 = ceilDiv(expectedSecondShares * liquidityAmount1, initialShares);
  {
    const secondAfter0 = await readPrivateBalance(
      secondContext.token0,
      secondWalletAddress,
      secondWallet,
    );
    const secondAfter1 = await readPrivateBalance(
      secondContext.token1,
      secondWalletAddress,
      secondWallet,
    );
    if (
      secondShares !== expectedSecondShares ||
      secondBefore0 - secondAfter0 !== expectedSpend0 ||
      secondBefore1 - secondAfter1 !== expectedSpend1
    ) {
      throw new Error("second LP proportional acceptance or no-donation invariant failed");
    }
  }

  stage = "walletless transactional quote candidate evaluation";
  const logicalRequestId = ethers.keccak256(
    ethers.solidityPacked(
      ["address", "address", "address", "uint256"],
      [quoteWalletAddress, poolAddress, quotePoolAddress, await ethers.provider.getBlockNumber()],
    ),
  );
  const quoteEvaluations: LocallyVerifiedQuote[] = [];
  const quoteStarted = Date.now();
  for (const candidateAddress of [poolAddress, quotePoolAddress]) {
    const candidate = await loadPoolContext(candidateAddress, quoteWallet);
    const candidateInitializedBefore = Boolean(await candidate.pool.initialized());
    const candidateFeeCount0Before = BigInt(await candidate.pool.protocolFeeSwapCount0());
    const candidateFeeCount1Before = BigInt(await candidate.pool.protocolFeeSwapCount1());
    const candidateRequestId = ethers.keccak256(
      ethers.solidityPacked(["bytes32", "address"], [logicalRequestId, candidateAddress]),
    );
    const decryptedOutput = await requestPrivateQuote(
      candidate,
      quoteWallet,
      swapAmount0,
      true,
      candidateRequestId,
      `walletless encrypted quote fee ${candidate.feeBps}`,
    );
    if (decryptedOutput <= 0n) throw new Error("quote candidate returned zero");
    if (
      Boolean(await candidate.pool.initialized()) !== candidateInitializedBefore ||
      BigInt(await candidate.pool.protocolFeeSwapCount0()) !== candidateFeeCount0Before ||
      BigInt(await candidate.pool.protocolFeeSwapCount1()) !== candidateFeeCount1Before
    ) {
      throw new Error("transactional quote changed pool accounting state");
    }
    const discovery: ConfidentialPoolDiscovery = {
      disclosureSchemaVersion: DISCLOSURE_SCHEMA_VERSION,
      protocolVersion: discoveryProtocolVersion,
      pool: candidateAddress,
      token0: candidate.token0Address,
      token1: candidate.token1Address,
      token0Decimals: expectedDecimals0,
      token1Decimals: expectedDecimals1,
      feeBps: candidate.feeBps,
      feeVault: candidate.feeVault,
      feePolicy: getCipherDEXV1FeePolicy(candidate.feeBps),
      privacyMode: PRIVACY_MODE.AMOUNT_CONFIDENTIAL_PRIVATE_LP,
      poolKind: "private-erc20-cpmm-v2",
      quoteTransport: CONFIDENTIAL_QUOTE_TRANSPORT.TRANSACTION_EVENT,
    };
    const verifiedDiscovery = await verifyConfidentialPoolDiscovery(
      discovery,
      {
        expectedChainId: 7_082_400,
        expectedFactory: discoveryFactoryAddress,
        expectedFeeVault: trustedFeeVaultAddress,
        expectedProtocolVersion: discoveryProtocolVersion,
        expectedLPTokenFactory: trustedLpTokenFactoryAddress,
        expectedLPTokenFactoryRuntimeCodehash: trustedLpTokenFactoryRuntimeCodehash,
      },
      {
        readChainId: async () => (await ethers.provider.getNetwork()).chainId,
        getCode: (address) => ethers.provider.getCode(address),
        hashRuntimeCode: (code) => ethers.keccak256(code),
        readFactoryProtocolVersion: async () => discoveryFactory.PROTOCOL_VERSION(),
        readFactoryLPTokenFactory: async () => discoveryFactory.lpTokenFactory(),
        readFactoryLPTokenFactoryRuntimeCodehash: async () =>
          discoveryFactory.PRIVATE_LP_TOKEN_FACTORY_RUNTIME_CODEHASH(),
        isLPTokenIssued: async (_lpFactory, candidatePool, lpToken, issuer) =>
          discoveryLpTokenFactory.isIssuedToken(candidatePool, lpToken, issuer),
        isFactoryPrivateTokenApproved: async (_factoryAddress, token) =>
          discoveryFactory.isApprovedPrivateToken(token),
        isFactoryPool: async (_factoryAddress, candidatePool) =>
          discoveryFactory.isPool(candidatePool),
        getCanonicalPool: async (_factoryAddress, candidateDiscovery) => {
          const key = await discoveryFactory.poolKey(
            candidateDiscovery.token0,
            candidateDiscovery.token1,
            candidateDiscovery.token0Decimals,
            candidateDiscovery.token1Decimals,
            candidateDiscovery.feeBps,
          );
          return discoveryFactory.getPool(key);
        },
        readPoolState: async (candidatePool) => {
          const onchainPool = await ethers.getContractAt(
            "ConfidentialCPMM",
            candidatePool,
            quoteWallet,
          );
          const [
            protocolVersion,
            privacyMode,
            token0,
            token1,
            token0Decimals,
            token1Decimals,
            onchainFeeBps,
            feeVault,
            lpToken,
          ] = await Promise.all([
            onchainPool.PROTOCOL_VERSION(),
            onchainPool.PRIVACY_MODE(),
            onchainPool.token0(),
            onchainPool.token1(),
            onchainPool.token0Decimals(),
            onchainPool.token1Decimals(),
            onchainPool.feeBps(),
            onchainPool.feeVault(),
            onchainPool.lpToken(),
          ]);
          return {
            protocolVersion,
            privacyMode,
            token0,
            token1,
            token0Decimals,
            token1Decimals,
            feeBps: onchainFeeBps,
            feeVault,
            lpToken,
          };
        },
      },
    );
    quoteEvaluations.push({
      discovery: verifiedDiscovery,
      requestId: candidateRequestId,
      amountIn: swapAmount0,
      zeroForOne: true,
      decryptedAmountOut: decryptedOutput,
    });
  }
  const selectedQuote = quoteEvaluations.reduce<LocallyVerifiedQuote | undefined>(
    (best, candidate) => {
      if (!best) return candidate;
      if (candidate.decryptedAmountOut > best.decryptedAmountOut) return candidate;
      if (
        candidate.decryptedAmountOut === best.decryptedAmountOut &&
        candidate.discovery.feeBps < best.discovery.feeBps
      ) return candidate;
      return best;
    },
    undefined,
  );
  if (!selectedQuote) throw new Error("no locally verified quote candidate selected");
  const selectedContext = await loadPoolContext(selectedQuote.discovery.pool, wallet);
  const selectedPool = selectedContext.pool;
  const protocolFeeCount0Before = BigInt(await selectedPool.protocolFeeSwapCount0());
  const protocolFeeCount1Before = BigInt(await selectedPool.protocolFeeSwapCount1());
  const selectedSwapSelector = selectedPool.interface.getFunction("swapExactInput")?.selector;
  if (!selectedSwapSelector) throw new Error("selected pool swap selector unavailable");
  const localQuote = selectedQuote.decryptedAmountOut;
  console.log(
    `walletless quote selection: candidates=${quoteEvaluations.length} ` +
      `pool=${selectedContext.address} feeBps=${selectedContext.feeBps} ` +
      `latencyMs=${Date.now() - quoteStarted}`,
  );

  const swapMinimum = await wallet.encryptValue256(
    minimumWithSlippage(localQuote),
    selectedContext.address,
    selectedSwapSelector,
  );
  const swapInput0 = await wallet.encryptValue256(
    swapAmount0,
    selectedContext.address,
    selectedSwapSelector,
  );
  const expiredSwapDeadline0 = BigInt(Math.floor(Date.now() / 1000) - 1);
  await expectMinedFailure("expired swap check", () =>
    selectedPool.swapExactInput(
      swapInput0,
      swapMinimum,
      true,
      expiredSwapDeadline0,
      COTI_TESTNET_TX_OVERRIDES,
    ),
  );

  const beforeSwap0 = await readPrivateBalance(token0, walletAddress, wallet);
  const beforeSwap1 = await readPrivateBalance(token1, walletAddress, wallet);

  const deliberatelyHighMinimum = await wallet.encryptValue256(
    localQuote + 1n,
    selectedContext.address,
    selectedSwapSelector,
  );
  await expectMinedFailure("failed slippage check", () =>
    selectedPool.swapExactInput(
      swapInput0,
      deliberatelyHighMinimum,
      true,
      BigInt(Math.floor(Date.now() / 1000) + 600),
      COTI_TESTNET_TX_OVERRIDES,
    ),
  );
  const afterFailedSlippage0 = await readPrivateBalance(token0, walletAddress, wallet);
  const afterFailedSlippage1 = await readPrivateBalance(token1, walletAddress, wallet);
  if (afterFailedSlippage0 !== beforeSwap0 || afterFailedSlippage1 !== beforeSwap1) {
    throw new Error("failed slippage changed private balances");
  }

  await submit(
    "swap token0 to token1",
    selectedPool.swapExactInput(
      swapInput0,
      swapMinimum,
      true,
      BigInt(Math.floor(Date.now() / 1000) + 600),
      COTI_TESTNET_TX_OVERRIDES,
    ),
  );
  const afterSwap0 = await readPrivateBalance(token0, walletAddress, wallet);
  const afterSwap1 = await readPrivateBalance(token1, walletAddress, wallet);
  if (
    beforeSwap0 - afterSwap0 !== swapAmount0 ||
    afterSwap1 - beforeSwap1 !== localQuote
  ) {
    throw new Error("selected quote did not match first private swap settlement");
  }
  if (BigInt(await selectedPool.protocolFeeSwapCount0()) !== protocolFeeCount0Before + 1n) {
    throw new Error("token0 protocol-fee batch did not record exactly one successful swap");
  }

  await expectMinedFailure("replayed encrypted input check", () =>
    selectedPool.swapExactInput(
      swapInput0,
      swapMinimum,
      true,
      BigInt(Math.floor(Date.now() / 1000) + 600),
      COTI_TESTNET_TX_OVERRIDES,
    ),
  );

  const reverseQuoteContext = await loadPoolContext(selectedContext.address, quoteWallet);
  const reverseQuoteRequestId = ethers.keccak256(
    ethers.solidityPacked(["bytes32", "uint8"], [logicalRequestId, 1]),
  );
  const reverseQuote = await requestPrivateQuote(
    reverseQuoteContext,
    quoteWallet,
    swapAmount1,
    false,
    reverseQuoteRequestId,
    "walletless reverse encrypted quote",
  );
  const swapInput1 = await wallet.encryptValue256(
    swapAmount1,
    selectedContext.address,
    selectedSwapSelector,
  );
  const swapMinimum1 = await wallet.encryptValue256(
    minimumWithSlippage(reverseQuote),
    selectedContext.address,
    selectedSwapSelector,
  );
  const swapDeadline1 = BigInt(Math.floor(Date.now() / 1000) + 600);
  const beforeReverse0 = await readPrivateBalance(token0, walletAddress, wallet);
  const beforeReverse1 = await readPrivateBalance(token1, walletAddress, wallet);
  await submit(
    "swap token1 to token0",
    selectedPool.swapExactInput(
      swapInput1,
      swapMinimum1,
      false,
      swapDeadline1,
      COTI_TESTNET_TX_OVERRIDES,
    ),
  );
  const afterReverse0 = await readPrivateBalance(token0, walletAddress, wallet);
  const afterReverse1 = await readPrivateBalance(token1, walletAddress, wallet);
  if (
    afterReverse0 - beforeReverse0 !== reverseQuote ||
    beforeReverse1 - afterReverse1 !== swapAmount1
  ) {
    throw new Error("reverse quote did not match private swap settlement");
  }
  if (BigInt(await selectedPool.protocolFeeSwapCount1()) !== protocolFeeCount1Before + 1n) {
    throw new Error("token1 protocol-fee batch did not record exactly one successful swap");
  }
  await expectMinedFailure("premature confidential fee collection check", () =>
    selectedPool.collectProtocolFees(true, true, COTI_TESTNET_TX_OVERRIDES),
  );

  const secondRemoveSelector = secondContext.pool.interface.getFunction("removeLiquidity")?.selector;
  if (!secondRemoveSelector) throw new Error("second LP remove selector unavailable");
  const secondExitBefore0 = await readPrivateBalance(
    secondContext.token0,
    secondWalletAddress,
    secondWallet,
  );
  const secondExitBefore1 = await readPrivateBalance(
    secondContext.token1,
    secondWalletAddress,
    secondWallet,
  );
  const secondRemoveInput = await secondWallet.encryptValue256(
    secondShares,
    poolAddress,
    secondRemoveSelector,
  );
  const secondRemoveMinimum0 = await secondWallet.encryptValue256(
    secondLpRemoveMin0,
    poolAddress,
    secondRemoveSelector,
  );
  const secondRemoveMinimum1 = await secondWallet.encryptValue256(
    secondLpRemoveMin1,
    poolAddress,
    secondRemoveSelector,
  );
  await submit(
    "second LP full personal exit",
    secondContext.pool.removeLiquidity(
      secondRemoveInput,
      secondRemoveMinimum0,
      secondRemoveMinimum1,
      BigInt(Math.floor(Date.now() / 1000) + 600),
      COTI_TESTNET_TX_OVERRIDES,
    ),
  );
  if ((await readPrivateShares(secondContext.pool, secondWallet)) !== 0n) {
    throw new Error("second LP full personal exit left shares behind");
  }
  const secondExitAfter0 = await readPrivateBalance(
    secondContext.token0,
    secondWalletAddress,
    secondWallet,
  );
  const secondExitAfter1 = await readPrivateBalance(
    secondContext.token1,
    secondWalletAddress,
    secondWallet,
  );
  if (secondExitAfter0 <= secondExitBefore0 || secondExitAfter1 <= secondExitBefore1) {
    throw new Error("second LP exit did not return both private assets");
  }

  if (initialShares < 4n) throw new Error("test liquidity produced too few shares for lock scenarios");
  const timedAmount = initialShares / 4n;
  const timedDeadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const timedUnlock = BigInt(Math.floor(Date.now() / 1000) + lockSeconds);
  const timedInput = await wallet.encryptValue256(timedAmount, poolAddress, lockSelector);
  const timedReceipt = await submit(
    "timed LP lock",
    pool.lockShares(
      timedInput,
      timedUnlock,
      false,
      timedDeadline,
      COTI_TESTNET_TX_OVERRIDES,
    ),
  );
  const timedLockId = lockIdFromReceipt(pool, timedReceipt, false);
  await delay(lockSeconds * 1000 + 2_000);
  await submit(
    "timed LP unlock",
    pool.unlockShares(timedLockId, COTI_TESTNET_TX_OVERRIDES),
  );

  const permanentAmount = initialShares / 4n;
  const permanentInput = await wallet.encryptValue256(permanentAmount, poolAddress, lockSelector);
  const permanentReceipt = await submit(
    "permanent LP lock",
    pool.lockShares(
      permanentInput,
      0,
      true,
      BigInt(Math.floor(Date.now() / 1000) + 600),
      COTI_TESTNET_TX_OVERRIDES,
    ),
  );
  const permanentLockId = lockIdFromReceipt(pool, permanentReceipt, true);
  if (!permanentLockId) throw new Error("permanent lock id missing");

  const remainingShares = await readPrivateShares(pool, wallet);
  if (remainingShares <= 0n) throw new Error("no shares left for personal-exit scenario");
  const beforePersonalExit0 = await readPrivateBalance(token0, walletAddress, wallet);
  const beforePersonalExit1 = await readPrivateBalance(token1, walletAddress, wallet);
  const removeInput = await wallet.encryptValue256(remainingShares, poolAddress, removeSelector);
  const removeMinimum0 = await wallet.encryptValue256(
    personalRemoveMin0,
    poolAddress,
    removeSelector,
  );
  const removeMinimum1 = await wallet.encryptValue256(
    personalRemoveMin1,
    poolAddress,
    removeSelector,
  );
  await submit(
    "remaining personal liquidity removal",
    pool.removeLiquidity(
      removeInput,
      removeMinimum0,
      removeMinimum1,
      BigInt(Math.floor(Date.now() / 1000) + 600),
      COTI_TESTNET_TX_OVERRIDES,
    ),
  );
  if ((await readPrivateShares(pool, wallet)) !== 0n) {
    throw new Error("remaining personal liquidity removal left shares behind");
  }

  const afterRemove0 = await readPrivateBalance(token0, walletAddress, wallet);
  const afterRemove1 = await readPrivateBalance(token1, walletAddress, wallet);
  if (afterRemove0 <= beforePersonalExit0 || afterRemove1 <= beforePersonalExit1) {
    throw new Error("personal liquidity removal did not return both private assets");
  }
  if (!(await pool.initialized())) {
    throw new Error("permanently locked liquidity was incorrectly removed");
  }

  // The independent quote-candidate pool has no locks or other LPs. Removing
  // its entire private LP supply exercises the true full-exit branch and must
  // return both reserves, clear the holder's balance and de-initialize it.
  const quotePoolShares = await readPrivateShares(quotePoolContext.pool, wallet);
  if (quotePoolShares <= 0n) throw new Error("quote pool has no shares for full exit");
  const quoteRemoveSelector = quotePoolContext.pool.interface.getFunction("removeLiquidity")?.selector;
  if (!quoteRemoveSelector) throw new Error("quote pool remove selector unavailable");
  const beforeQuoteExit0 = await readPrivateBalance(quotePoolContext.token0, walletAddress, wallet);
  const beforeQuoteExit1 = await readPrivateBalance(quotePoolContext.token1, walletAddress, wallet);
  const quoteRemoveInput = await wallet.encryptValue256(
    quotePoolShares,
    quotePoolAddress,
    quoteRemoveSelector,
  );
  const quoteRemoveMinimum0 = await wallet.encryptValue256(
    fullExitMin0,
    quotePoolAddress,
    quoteRemoveSelector,
  );
  const quoteRemoveMinimum1 = await wallet.encryptValue256(
    fullExitMin1,
    quotePoolAddress,
    quoteRemoveSelector,
  );
  await submit(
    "true full private liquidity removal",
    quotePoolContext.pool.removeLiquidity(
      quoteRemoveInput,
      quoteRemoveMinimum0,
      quoteRemoveMinimum1,
      BigInt(Math.floor(Date.now() / 1000) + 600),
      COTI_TESTNET_TX_OVERRIDES,
    ),
  );
  if ((await readPrivateShares(quotePoolContext.pool, wallet)) !== 0n) {
    throw new Error("true full private liquidity removal left shares behind");
  }
  if (await quotePoolContext.pool.initialized()) {
    throw new Error("true full private liquidity removal left pool initialized");
  }
  const afterQuoteExit0 = await readPrivateBalance(quotePoolContext.token0, walletAddress, wallet);
  const afterQuoteExit1 = await readPrivateBalance(quotePoolContext.token1, walletAddress, wallet);
  if (afterQuoteExit0 <= beforeQuoteExit0 || afterQuoteExit1 <= beforeQuoteExit1) {
    throw new Error("true full exit did not return both private reserves");
  }
  console.log("COTI testnet scenario completed without printing private values.");
}

void main().catch((error: unknown) => {
  console.error(
    `COTI testnet scenario failed during ${stage}; ` +
      `${safeTestnetErrorSummary(error)}; ` +
      "private payloads were suppressed.",
  );
  process.exitCode = 1;
});
