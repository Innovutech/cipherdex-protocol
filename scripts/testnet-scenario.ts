import { Wallet as CotiWallet } from "@coti-io/coti-ethers";
import { Contract } from "ethers";
import { ethers } from "hardhat";

const POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function feeBps() view returns (uint256)",
  "function myShares() returns ((uint256,uint256))",
  "function quoteExactInput(((uint256,uint256),bytes),bool) returns ((uint256,uint256))",
  "function swapExactInput(((uint256,uint256),bytes),((uint256,uint256),bytes),bool,uint64) returns ((uint256,uint256))",
  "function addLiquidity(((uint256,uint256),bytes),((uint256,uint256),bytes),((uint256,uint256),bytes),uint64) returns ((uint256,uint256))",
  "function removeLiquidity(((uint256,uint256),bytes),((uint256,uint256),bytes),((uint256,uint256),bytes),uint64) returns ((uint256,uint256),(uint256,uint256))",
  "function lockShares(((uint256,uint256),bytes),uint64,bool,uint64) returns (bytes32)",
  "function unlockShares(bytes32)",
  "event LiquidityLocked(bytes32 indexed lockId,address indexed owner,uint64 unlockTime,bool permanent)",
];

const TOKEN_ABI = [
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns ((uint256,uint256))",
  "function approve(address,((uint256,uint256),bytes))",
];

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

async function submit(
  label: string,
  transaction: Promise<{ hash: string; wait(): Promise<any> }>,
): Promise<any> {
  const started = Date.now();
  const tx = await transaction;
  const receipt = await tx.wait();
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
  const ciphertext = await pool.myShares.staticCall();
  return wallet.decryptValue256(ciphertext);
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

async function main(): Promise<void> {
  const privateKey = requiredPrivateKey("COTI_TESTNET_PRIVATE_KEY");
  const aesKey = process.env.COTI_AES_KEY?.trim();
  if (!aesKey) throw new Error("missing COTI_AES_KEY");

  const tokenAddressA = requiredAddress("COTI_TOKEN0");
  const tokenAddressB = requiredAddress("COTI_TOKEN1");
  const tokenDecimalsA = requiredUInt("COTI_TOKEN0_DECIMALS");
  const tokenDecimalsB = requiredUInt("COTI_TOKEN1_DECIMALS");
  const feeBps = requiredUInt("COTI_FEE_BPS", 30);
  const liquidityAmount0 = requiredBigInt("COTI_LIQUIDITY_AMOUNT0");
  const liquidityAmount1 = requiredBigInt("COTI_LIQUIDITY_AMOUNT1");
  const swapAmount0 = requiredBigInt("COTI_SWAP_AMOUNT0");
  const swapAmount1 = requiredBigInt("COTI_SWAP_AMOUNT1");
  const lockSeconds = requiredUInt("COTI_TEST_LOCK_SECONDS", 10);

  const [deployer] = await ethers.getSigners();
  const wallet = new CotiWallet(privateKey, ethers.provider, { aesKey });
  wallet.setAesKey(aesKey);
  const walletAddress = await wallet.getAddress();
  if ((await deployer.getAddress()).toLowerCase() !== walletAddress.toLowerCase()) {
    throw new Error("configured deployer and COTI wallet do not match");
  }

  let poolAddress = process.env.COTI_POOL?.trim();
  if (!poolAddress) {
    const factoryFactory = await ethers.getContractFactory("ConfidentialCPMMFactory", deployer);
    const factory = await factoryFactory.deploy();
    await factory.waitForDeployment();
    const factoryAddress = await factory.getAddress();
    console.log(`factory deployed: ${factoryAddress}`);
    const creation = await submit(
      "pool creation",
      factory.createPool(
        tokenAddressA,
        tokenAddressB,
        tokenDecimalsA,
        tokenDecimalsB,
        feeBps,
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
  }
  if (!ethers.isAddress(poolAddress)) throw new Error("invalid COTI_POOL");
  console.log(`pool: ${poolAddress}`);

  const pool = new Contract(poolAddress, POOL_ABI, wallet);
  const poolToken0Address = await pool.token0();
  const poolToken1Address = await pool.token1();
  const token0 = new Contract(poolToken0Address, TOKEN_ABI, wallet);
  const token1 = new Contract(poolToken1Address, TOKEN_ABI, wallet);
  const approveSelector0 = token0.interface.getFunction("approve")?.selector;
  const approveSelector1 = token1.interface.getFunction("approve")?.selector;
  if (!approveSelector0 || !approveSelector1) throw new Error("approval selector unavailable");

  const addSelector = pool.interface.getFunction("addLiquidity")?.selector;
  const quoteSelector = pool.interface.getFunction("quoteExactInput")?.selector;
  const swapSelector = pool.interface.getFunction("swapExactInput")?.selector;
  const lockSelector = pool.interface.getFunction("lockShares")?.selector;
  const removeSelector = pool.interface.getFunction("removeLiquidity")?.selector;
  if (!addSelector || !quoteSelector || !swapSelector || !lockSelector || !removeSelector) {
    throw new Error("pool selector unavailable");
  }

  const approvedAmount0 = liquidityAmount0 + swapAmount0;
  const approvedAmount1 = liquidityAmount1 + swapAmount1;
  const zeroApproval0 = await wallet.encryptValue256(0n, poolToken0Address, approveSelector0);
  const zeroApproval1 = await wallet.encryptValue256(0n, poolToken1Address, approveSelector1);
  const approval0 = await wallet.encryptValue256(approvedAmount0, poolToken0Address, approveSelector0);
  const approval1 = await wallet.encryptValue256(approvedAmount1, poolToken1Address, approveSelector1);
  await submit("token0 approval reset", token0.approve(poolAddress, zeroApproval0));
  await submit("token1 approval reset", token1.approve(poolAddress, zeroApproval1));
  await submit("token0 approval", token0.approve(poolAddress, approval0));
  await submit("token1 approval", token1.approve(poolAddress, approval1));

  const beforeAdd0 = await readPrivateBalance(token0, walletAddress, wallet);
  const beforeAdd1 = await readPrivateBalance(token1, walletAddress, wallet);
  if (beforeAdd0 < liquidityAmount0 + swapAmount0 || beforeAdd1 < liquidityAmount1 + swapAmount1) {
    throw new Error("insufficient private test-token balance");
  }

  const addAmount0 = await wallet.encryptValue256(liquidityAmount0, poolAddress, addSelector);
  const addAmount1 = await wallet.encryptValue256(liquidityAmount1, poolAddress, addSelector);
  const addMinimum = await wallet.encryptValue256(0n, poolAddress, addSelector);
  const addDeadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  await submit("liquidity add", pool.addLiquidity(addAmount0, addAmount1, addMinimum, addDeadline));
  const initialShares = await readPrivateShares(pool, wallet);
  if (initialShares <= 0n) throw new Error("liquidity add returned no private shares");

  const quoteInput = await wallet.encryptValue256(swapAmount0, poolAddress, quoteSelector);
  const quoteStarted = Date.now();
  const quoteOutput = await pool.quoteExactInput.staticCall(quoteInput, true);
  const quoteElapsed = Date.now() - quoteStarted;
  const localQuote = await wallet.decryptValue256(quoteOutput);
  if (localQuote <= 0n) throw new Error("private quote returned zero");
  console.log(`private quote: latencyMs=${quoteElapsed}`);

  const swapMinimum = await wallet.encryptValue256(0n, poolAddress, swapSelector);
  const swapInput0 = await wallet.encryptValue256(swapAmount0, poolAddress, swapSelector);
  const swapDeadline0 = BigInt(Math.floor(Date.now() / 1000) + 600);
  const beforeSwap0 = await readPrivateBalance(token0, walletAddress, wallet);
  const beforeSwap1 = await readPrivateBalance(token1, walletAddress, wallet);
  await submit("swap token0 to token1", pool.swapExactInput(swapInput0, swapMinimum, true, swapDeadline0));
  const afterSwap0 = await readPrivateBalance(token0, walletAddress, wallet);
  const afterSwap1 = await readPrivateBalance(token1, walletAddress, wallet);
  if (afterSwap0 >= beforeSwap0 || afterSwap1 <= beforeSwap1) {
    throw new Error("first private swap balance invariant failed");
  }

  const swapInput1 = await wallet.encryptValue256(swapAmount1, poolAddress, swapSelector);
  const swapMinimum1 = await wallet.encryptValue256(0n, poolAddress, swapSelector);
  const swapDeadline1 = BigInt(Math.floor(Date.now() / 1000) + 600);
  const beforeReverse0 = await readPrivateBalance(token0, walletAddress, wallet);
  const beforeReverse1 = await readPrivateBalance(token1, walletAddress, wallet);
  await submit("swap token1 to token0", pool.swapExactInput(swapInput1, swapMinimum1, false, swapDeadline1));
  const afterReverse0 = await readPrivateBalance(token0, walletAddress, wallet);
  const afterReverse1 = await readPrivateBalance(token1, walletAddress, wallet);
  if (afterReverse0 <= beforeReverse0 || afterReverse1 >= beforeReverse1) {
    throw new Error("reverse private swap balance invariant failed");
  }

  if (initialShares < 4n) throw new Error("test liquidity produced too few shares for lock scenarios");
  const timedAmount = initialShares / 4n;
  const timedDeadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const timedUnlock = BigInt(Math.floor(Date.now() / 1000) + lockSeconds);
  const timedInput = await wallet.encryptValue256(timedAmount, poolAddress, lockSelector);
  const timedReceipt = await submit(
    "timed LP lock",
    pool.lockShares(timedInput, timedUnlock, false, timedDeadline),
  );
  const timedLockId = lockIdFromReceipt(pool, timedReceipt, false);
  await delay(lockSeconds * 1000 + 2_000);
  await submit("timed LP unlock", pool.unlockShares(timedLockId));

  const permanentAmount = initialShares / 4n;
  const permanentInput = await wallet.encryptValue256(permanentAmount, poolAddress, lockSelector);
  const permanentReceipt = await submit(
    "permanent LP lock",
    pool.lockShares(
      permanentInput,
      0,
      true,
      BigInt(Math.floor(Date.now() / 1000) + 600),
    ),
  );
  const permanentLockId = lockIdFromReceipt(pool, permanentReceipt, true);
  if (!permanentLockId) throw new Error("permanent lock id missing");

  const remainingShares = await readPrivateShares(pool, wallet);
  if (remainingShares <= 0n) throw new Error("no shares left for full-exit scenario");
  const removeInput = await wallet.encryptValue256(remainingShares, poolAddress, removeSelector);
  const removeMinimum0 = await wallet.encryptValue256(0n, poolAddress, removeSelector);
  const removeMinimum1 = await wallet.encryptValue256(0n, poolAddress, removeSelector);
  await submit(
    "full private liquidity removal",
    pool.removeLiquidity(
      removeInput,
      removeMinimum0,
      removeMinimum1,
      BigInt(Math.floor(Date.now() / 1000) + 600),
    ),
  );
  if ((await readPrivateShares(pool, wallet)) !== 0n) {
    throw new Error("full private liquidity removal left shares behind");
  }

  const afterRemove0 = await readPrivateBalance(token0, walletAddress, wallet);
  const afterRemove1 = await readPrivateBalance(token1, walletAddress, wallet);
  if (afterRemove0 <= beforeAdd0 - liquidityAmount0 || afterRemove1 <= beforeAdd1 - liquidityAmount1) {
    throw new Error("private liquidity removal balance invariant failed");
  }
  console.log("COTI testnet scenario completed without printing private values.");
}

void main().catch(() => {
  console.error("COTI testnet scenario failed; inspect the local testnet environment without sharing private payloads.");
  process.exitCode = 1;
});
