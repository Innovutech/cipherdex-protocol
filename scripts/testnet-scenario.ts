import { Wallet as CotiWallet } from "@coti-io/coti-ethers";
import { Contract } from "ethers";
import { ethers } from "hardhat";
import {
  CONFIDENTIAL_QUOTE_TRANSPORT,
  DISCLOSURE_SCHEMA_VERSION,
  PRIVACY_MODE,
  getCipherDEXV1FeePolicy,
  selectBestConfidentialPoolQuote,
  type ConfidentialPoolDiscovery,
  type ConfidentialQuoteEvaluation,
} from "../sdk/src";
import {
  CONFIDENTIAL_POOL_TESTNET_ABI,
  PRIVATE_ERC20_TESTNET_ABI,
} from "./coti-testnet-abi";

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

const CONFIDENTIAL_FACTORY_DEPLOY_GAS_LIMIT = 8_000_000n;
const CONFIDENTIAL_POOL_CREATE_GAS_LIMIT = 6_500_000n;
const FEE_VAULT_DEPLOY_GAS_LIMIT = 1_000_000n;
const COTI_TESTNET_TX_OVERRIDES = {
  gasLimit: BigInt(process.env.COTI_TESTNET_GAS_LIMIT ?? "30000000"),
} as const;

let stage = "configuration";

function safeErrorSummary(error: unknown): string {
  if (!error || typeof error !== "object") return "code=unknown";
  const record = error as {
    name?: unknown;
    message?: unknown;
    code?: unknown;
    shortMessage?: unknown;
    info?: { error?: { message?: unknown } };
  };
  const code = typeof record.code === "string" ? record.code : "unknown";
  const name = typeof record.name === "string" ? record.name : "Error";
  const detailCandidates = [record.shortMessage, record.info?.error?.message, record.message];
  const detail = detailCandidates.find(
    (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
  );
  if (!detail) return `name=${name} code=${code}`;
  const redacted = detail
    .replace(/0x[0-9a-fA-F]{16,}/g, "[redacted-hex]")
    .replace(/\s+/g, " ")
    .slice(0, 240);
  return `name=${name} code=${code} detail=${redacted}`;
}

type PoolContext = {
  address: string;
  pool: Contract;
  token0Address: string;
  token1Address: string;
  token0: Contract;
  token1: Contract;
  feeBps: number;
  feeVault: string;
};

async function submit(
  label: string,
  transaction: Promise<{ hash: string; wait(): Promise<any> }>,
): Promise<any> {
  stage = label;
  const started = Date.now();
  const tx = await transaction;
  let receipt: any;
  try {
    receipt = await tx.wait();
  } catch (error) {
    console.log(`${label}: tx=${tx.hash} failed latencyMs=${Date.now() - started}`);
    throw error;
  }
  const gasUsed = receipt?.gasUsed?.toString() ?? "unknown";
  console.log(`${label}: tx=${tx.hash} gas=${gasUsed} latencyMs=${Date.now() - started}`);
  return receipt;
}

async function readPrivateBalance(
  token: Contract,
  owner: string,
  wallet: CotiWallet,
): Promise<bigint> {
  const ciphertext = await token.balanceOf.staticCall(owner);
  return wallet.decryptValue256(ciphertext);
}

async function readPrivateShares(pool: Contract, wallet: CotiWallet): Promise<bigint> {
  const privateLpToken = String(await pool.lpToken());
  if (privateLpToken !== ethers.ZeroAddress) {
    const owner = await wallet.getAddress();
    const lpToken = new Contract(privateLpToken, PRIVATE_ERC20_TESTNET_ABI, wallet);
    const ciphertext = await lpToken.balanceOf.staticCall(owner);
    return wallet.decryptValue256(ciphertext);
  }
  const ciphertext = await pool.myShares.staticCall();
  return wallet.decryptValue256(ciphertext);
}

async function loadPoolContext(address: string, wallet: CotiWallet): Promise<PoolContext> {
  const pool = new Contract(address, CONFIDENTIAL_POOL_TESTNET_ABI, wallet);
  const token0Address = String(await pool.token0());
  const token1Address = String(await pool.token1());
  return {
    address,
    pool,
    token0Address,
    token1Address,
    token0: new Contract(token0Address, PRIVATE_ERC20_TESTNET_ABI, wallet),
    token1: new Contract(token1Address, PRIVATE_ERC20_TESTNET_ABI, wallet),
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
  const minimum = await wallet.encryptValue256(0n, context.address, selector);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  await submit(
    label,
    context.pool.addLiquidity(
      encrypted0,
      encrypted1,
      minimum,
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
  for (const log of receipt?.logs ?? []) {
    try {
      const parsed = pool.interface.parseLog({ topics: log.topics, data: log.data });
      if (
        parsed?.name === "ConfidentialQuoteResult" &&
        String(parsed.args.caller).toLowerCase() === caller.toLowerCase() &&
        String(parsed.args.requestId).toLowerCase() === requestId.toLowerCase() &&
        parsed.args.zeroForOne === zeroForOne
      ) {
        return parsed.args.result;
      }
    } catch {
      // Ignore logs emitted by unrelated contracts.
    }
  }
  throw new Error("encrypted quote result event missing");
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
  const encryptedResult = encryptedQuoteFromReceipt(
    context.pool,
    receipt,
    caller,
    requestId,
    zeroForOne,
  );
  return wallet.decryptValue256(encryptedResult as never);
}

async function main(): Promise<void> {
  stage = "configuration";
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
  const lockSeconds = requiredUInt("COTI_TEST_LOCK_SECONDS", 10);

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

  let poolAddress = process.env.COTI_POOL?.trim();
  let quotePoolAddress = process.env.COTI_QUOTE_POOL?.trim();
  let createdPrimaryPool = false;
  let createdQuotePool = false;
  if (!poolAddress) {
    stage = "fee vault deployment";
    const feeVaultFactory = await ethers.getContractFactory("CipherDEXFeeVault", wallet);
    const feeVault = await feeVaultFactory.deploy(walletAddress, {
      gasLimit: FEE_VAULT_DEPLOY_GAS_LIMIT,
    });
    await feeVault.waitForDeployment();
    const feeVaultAddress = await feeVault.getAddress();
    console.log(`fee vault deployed: ${feeVaultAddress}`);
    stage = "confidential factory deployment";
    const factoryFactory = await ethers.getContractFactory("ConfidentialCPMMFactory", wallet);
    const factory = await factoryFactory.deploy(feeVaultAddress, {
      gasLimit: CONFIDENTIAL_FACTORY_DEPLOY_GAS_LIMIT,
    });
    await factory.waitForDeployment();
    const factoryAddress = await factory.getAddress();
    console.log(`factory deployed: ${factoryAddress}`);
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
  if (!quotePoolAddress || !ethers.isAddress(quotePoolAddress)) {
    throw new Error("missing or invalid COTI_QUOTE_POOL");
  }
  if (quotePoolAddress.toLowerCase() === poolAddress.toLowerCase()) {
    throw new Error("COTI_POOL and COTI_QUOTE_POOL must be different fee-tier pools");
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
  for (const context of [poolContext, quotePoolContext]) {
    if (
      context.token0Address.toLowerCase() !== expectedToken0.toLowerCase() ||
      context.token1Address.toLowerCase() !== expectedToken1.toLowerCase()
    ) {
      throw new Error("quote candidate token pair does not match the configured canonical pair");
    }
  }
  if (poolContext.feeBps !== feeBps || quotePoolContext.feeBps !== quoteFeeBps) {
    throw new Error("configured pool fee tiers do not match the deployed candidates");
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
  if (createdPrimaryPool) {
    const expectedSecondShares0 = (secondLiquidityAmount0 * initialShares) / liquidityAmount0;
    const expectedSecondShares1 = (secondLiquidityAmount1 * initialShares) / liquidityAmount1;
    const expectedSecondShares =
      expectedSecondShares0 < expectedSecondShares1 ? expectedSecondShares0 : expectedSecondShares1;
    const expectedSpend0 = ceilDiv(expectedSecondShares * liquidityAmount0, initialShares);
    const expectedSpend1 = ceilDiv(expectedSecondShares * liquidityAmount1, initialShares);
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

  stage = "walletless quote candidate preparation";
  const quoteRequestId = ethers.keccak256(
    ethers.solidityPacked(
      ["address", "address", "address", "uint256"],
      [quoteWalletAddress, poolAddress, quotePoolAddress, await ethers.provider.getBlockNumber()],
    ),
  );
  const quoteEvaluations: ConfidentialQuoteEvaluation[] = [];
  const quoteStarted = Date.now();
  for (const candidateAddress of [poolAddress, quotePoolAddress]) {
    stage = "walletless encrypted quote evaluation";
    const candidate = await loadPoolContext(candidateAddress, quoteWallet);
    const candidateRequestId = ethers.keccak256(ethers.solidityPacked(
      ["bytes32", "address"],
      [quoteRequestId, candidateAddress],
    ));
    const decryptedOutput = await requestPrivateQuote(
      candidate,
      quoteWallet,
      swapAmount0,
      true,
      candidateRequestId,
      `walletless encrypted quote fee ${candidate.feeBps}`,
    );
    if (decryptedOutput <= 0n) throw new Error("quote candidate returned zero");
    const discovery: ConfidentialPoolDiscovery = {
      disclosureSchemaVersion: DISCLOSURE_SCHEMA_VERSION,
      protocolVersion: 1,
      pool: candidateAddress,
      token0: candidate.token0Address,
      token1: candidate.token1Address,
      token0Decimals: expectedDecimals0,
      token1Decimals: expectedDecimals1,
      feeBps: candidate.feeBps,
      feeVault: candidate.feeVault,
      feePolicy: getCipherDEXV1FeePolicy(candidate.feeBps),
      privacyMode: PRIVACY_MODE.AMOUNT_CONFIDENTIAL_PRIVATE_LP,
      poolKind: "private-erc20-cpmm-v1",
      quoteTransport: CONFIDENTIAL_QUOTE_TRANSPORT.TRANSACTION_EVENT,
    };
    quoteEvaluations.push({
      discovery,
      requestId: quoteRequestId,
      zeroForOne: true,
      decryptedAmountOut: decryptedOutput,
    });
  }
  const selectedQuote = selectBestConfidentialPoolQuote(quoteEvaluations);
  if (!selectedQuote) throw new Error("no confidential quote candidate selected");
  const selectedContext = await loadPoolContext(selectedQuote.discovery.pool, wallet);
  const selectedPool = selectedContext.pool;
  const selectedPoolWasCreated = selectedContext.address.toLowerCase() === poolAddress.toLowerCase()
    ? createdPrimaryPool
    : createdQuotePool;
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
    (localQuote * 99n) / 100n,
    selectedContext.address,
    selectedSwapSelector,
  );
  const swapInput0 = await wallet.encryptValue256(
    swapAmount0,
    selectedContext.address,
    selectedSwapSelector,
  );
  const expiredSwapDeadline0 = BigInt(Math.floor(Date.now() / 1000) - 1);
  let expiredSwapRejected = false;
  try {
    await submit(
      "expired swap check",
      selectedPool.swapExactInput(
        swapInput0,
        swapMinimum,
        true,
        expiredSwapDeadline0,
        COTI_TESTNET_TX_OVERRIDES,
      ),
    );
  } catch {
    expiredSwapRejected = true;
  }
  if (!expiredSwapRejected) throw new Error("expired private swap was accepted");

  const beforeSwap0 = await readPrivateBalance(token0, walletAddress, wallet);
  const beforeSwap1 = await readPrivateBalance(token1, walletAddress, wallet);

  const deliberatelyHighMinimum = await wallet.encryptValue256(
    localQuote + 1n,
    selectedContext.address,
    selectedSwapSelector,
  );
  let slippageRejected = false;
  try {
    await submit(
      "failed slippage check",
      selectedPool.swapExactInput(
        swapInput0,
        deliberatelyHighMinimum,
        true,
        BigInt(Math.floor(Date.now() / 1000) + 600),
        COTI_TESTNET_TX_OVERRIDES,
      ),
    );
  } catch {
    slippageRejected = true;
  }
  if (!slippageRejected) throw new Error("private swap accepted an excessive minimum output");
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
  if (afterSwap0 >= beforeSwap0 || afterSwap1 <= beforeSwap1) {
    throw new Error("first private swap balance invariant failed");
  }
  if (
    selectedPoolWasCreated &&
    BigInt(await selectedPool.protocolFeeSwapCount0()) !== protocolFeeCount0Before + 1n
  ) {
    throw new Error("token0 protocol-fee batch did not record exactly one successful swap");
  }

  let replayRejected = false;
  try {
    await submit(
      "replayed encrypted input check",
      selectedPool.swapExactInput(
        swapInput0,
        swapMinimum,
        true,
        BigInt(Math.floor(Date.now() / 1000) + 600),
        COTI_TESTNET_TX_OVERRIDES,
      ),
    );
  } catch {
    replayRejected = true;
  }
  if (!replayRejected) throw new Error("replayed encrypted swap input was accepted");

  const quoteSelectedContext = await loadPoolContext(selectedContext.address, quoteWallet);
  const reverseQuoteRequestId = ethers.keccak256(ethers.solidityPacked(
    ["bytes32", "uint8"],
    [quoteRequestId, 1],
  ));
  const reverseQuote = await requestPrivateQuote(
    quoteSelectedContext,
    quoteWallet,
    swapAmount1,
    false,
    reverseQuoteRequestId,
    "walletless encrypted reverse quote",
  );
  if (reverseQuote <= 0n) throw new Error("reverse private quote returned zero");
  const swapInput1 = await wallet.encryptValue256(
    swapAmount1,
    selectedContext.address,
    selectedSwapSelector,
  );
  const swapMinimum1 = await wallet.encryptValue256(
    (reverseQuote * 99n) / 100n,
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
  if (afterReverse0 <= beforeReverse0 || afterReverse1 >= beforeReverse1) {
    throw new Error("reverse private swap balance invariant failed");
  }
  if (selectedPoolWasCreated) {
    if (
      BigInt(await selectedPool.protocolFeeSwapCount1()) !== protocolFeeCount1Before + 1n
    ) {
      throw new Error("token1 protocol-fee batch did not record exactly one successful swap");
    }
    let earlyCollectionRejected = false;
    try {
      await submit(
        "premature confidential fee collection check",
        selectedPool.collectProtocolFees(true, true, COTI_TESTNET_TX_OVERRIDES),
      );
    } catch {
      earlyCollectionRejected = true;
    }
    if (!earlyCollectionRejected) {
      throw new Error("confidential protocol fees were collectible before the batch threshold");
    }
  }

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
    0n,
    poolAddress,
    secondRemoveSelector,
  );
  const secondRemoveMinimum1 = await secondWallet.encryptValue256(
    0n,
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
  const removeMinimum0 = await wallet.encryptValue256(0n, poolAddress, removeSelector);
  const removeMinimum1 = await wallet.encryptValue256(0n, poolAddress, removeSelector);
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
    0n,
    quotePoolAddress,
    quoteRemoveSelector,
  );
  const quoteRemoveMinimum1 = await wallet.encryptValue256(
    0n,
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
      `${safeErrorSummary(error)}; ` +
      "private payloads were suppressed.",
  );
  process.exitCode = 1;
});
