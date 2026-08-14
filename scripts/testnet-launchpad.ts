import { Wallet as CotiWallet } from "@coti-io/coti-ethers";
import { Contract, ethers } from "ethers";
import { ethers as hardhatEthers } from "hardhat";

const TOKEN_ABI = [
  "function decimals() view returns (uint8)",
  "function approve(address,((uint256,uint256),bytes))",
];

const MIGRATOR_ABI = [
  "function migrate(address,address,uint8,uint8,uint256,((uint256,uint256),bytes),((uint256,uint256),bytes),((uint256,uint256),bytes),((uint256,uint256),bytes),((uint256,uint256),bytes),uint64) returns (address,(uint256,uint256))",
  "event LaunchpadMigration(address indexed creator,address indexed pool)",
];

const POOL_ABI = [
  "function initialized() view returns (bool)",
  "function myShares() returns ((uint256,uint256))",
];

const requiredAddress = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value || !ethers.isAddress(value)) throw new Error(`missing ${name}`);
  return value;
};

const requiredPrivateKey = (): string => {
  const value = process.env.COTI_TESTNET_PRIVATE_KEY?.trim();
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error("missing COTI_TESTNET_PRIVATE_KEY");
  }
  return value;
};

const requiredBigInt = (name: string): bigint => {
  const value = process.env[name]?.trim();
  if (!value || !/^\d+$/.test(value)) throw new Error(`missing ${name}`);
  return BigInt(value);
};

const optionalBigInt = (name: string, fallback: bigint): bigint => {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`invalid ${name}`);
  return BigInt(value);
};

const requiredUInt = (name: string, fallback?: number): number => {
  const value = process.env[name]?.trim();
  if (!value && fallback !== undefined) return fallback;
  if (!value || !/^\d+$/.test(value)) throw new Error(`missing ${name}`);
  return Number(value);
};

const submit = async (
  label: string,
  transaction: Promise<{ hash: string; wait(): Promise<any> }>,
): Promise<any> => {
  const started = Date.now();
  const tx = await transaction;
  const receipt = await tx.wait();
  console.log(`${label}: tx=${tx.hash} gas=${receipt?.gasUsed?.toString() ?? "unknown"} latencyMs=${Date.now() - started}`);
  return receipt;
};

const scaleTo18 = (amount: bigint, decimals: number): bigint => {
  if (decimals > 18) throw new Error("token decimals exceed 18");
  return amount * 10n ** BigInt(18 - decimals);
};

async function main(): Promise<void> {
  const privateKey = requiredPrivateKey();
  const aesKey = process.env.COTI_AES_KEY?.trim();
  if (!aesKey) throw new Error("missing COTI_AES_KEY");

  const tokenA = requiredAddress("COTI_TOKEN0");
  const tokenB = requiredAddress("COTI_TOKEN1");
  const decimalsA = requiredUInt("COTI_TOKEN0_DECIMALS");
  const decimalsB = requiredUInt("COTI_TOKEN1_DECIMALS");
  const feeBps = requiredUInt("COTI_LAUNCHPAD_FEE_BPS", 30);
  const suppliedAmountA = requiredBigInt("COTI_LIQUIDITY_AMOUNT0");
  const suppliedAmountB = requiredBigInt("COTI_LIQUIDITY_AMOUNT1");
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

  const [canonicalToken0, canonicalToken1, canonicalDecimals0, canonicalDecimals1] =
    tokenA.toLowerCase() < tokenB.toLowerCase()
      ? [tokenA, tokenB, decimalsA, decimalsB] as const
      : [tokenB, tokenA, decimalsB, decimalsA] as const;
  const [amount0, amount1] = tokenA.toLowerCase() < tokenB.toLowerCase()
    ? [suppliedAmountA, suppliedAmountB]
    : [suppliedAmountB, suppliedAmountA];
  const normalized0 = scaleTo18(amount0, canonicalDecimals0);
  const normalized1 = scaleTo18(amount1, canonicalDecimals1);
  if (normalized0 === 0n || normalized1 === 0n) throw new Error("launchpad amounts must be positive");

  const ratioNumerator = normalized1 * 10n ** 18n;
  const minDerivedPrice = ratioNumerator / normalized0;
  const maxDerivedPrice = (ratioNumerator + normalized0 - 1n) / normalized0;
  const minShares = optionalBigInt("COTI_LAUNCHPAD_MIN_SHARES", 0n);
  const minPrice = optionalBigInt("COTI_LAUNCHPAD_MIN_PRICE_X18", minDerivedPrice);
  const maxPrice = optionalBigInt("COTI_LAUNCHPAD_MAX_PRICE_X18", maxDerivedPrice);

  const [deployer] = await hardhatEthers.getSigners();
  const wallet = new CotiWallet(privateKey, hardhatEthers.provider, { aesKey });
  const walletAddress = await wallet.getAddress();
  if ((await deployer.getAddress()).toLowerCase() !== walletAddress.toLowerCase()) {
    throw new Error("configured deployer and COTI wallet do not match");
  }

  const factoryFactory = await hardhatEthers.getContractFactory("ConfidentialCPMMFactory", deployer);
  const factory = await factoryFactory.deploy();
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();

  const migratorFactory = await hardhatEthers.getContractFactory("ConfidentialLaunchpadMigrator", deployer);
  const migratorDeployment = await migratorFactory.deploy(factoryAddress);
  await migratorDeployment.waitForDeployment();
  const migratorAddress = await migratorDeployment.getAddress();
  console.log(`factory deployed: ${factoryAddress}`);
  console.log(`launchpad migrator deployed: ${migratorAddress}`);

  const token0 = new Contract(canonicalToken0, TOKEN_ABI, wallet);
  const token1 = new Contract(canonicalToken1, TOKEN_ABI, wallet);
  const approveSelector0 = token0.interface.getFunction("approve")?.selector;
  const approveSelector1 = token1.interface.getFunction("approve")?.selector;
  const migrateSelector = new Contract(migratorAddress, MIGRATOR_ABI, wallet)
    .interface.getFunction("migrate")?.selector;
  if (!approveSelector0 || !approveSelector1 || !migrateSelector) {
    throw new Error("required selector unavailable");
  }

  const zeroApproval0 = await wallet.encryptValue256(0n, canonicalToken0, approveSelector0);
  const zeroApproval1 = await wallet.encryptValue256(0n, canonicalToken1, approveSelector1);
  const approval0 = await wallet.encryptValue256(amount0, canonicalToken0, approveSelector0);
  const approval1 = await wallet.encryptValue256(amount1, canonicalToken1, approveSelector1);
  await submit("token0 launchpad approval reset", token0.approve(migratorAddress, zeroApproval0));
  await submit("token1 launchpad approval reset", token1.approve(migratorAddress, zeroApproval1));
  await submit("token0 launchpad approval", token0.approve(migratorAddress, approval0));
  await submit("token1 launchpad approval", token1.approve(migratorAddress, approval1));

  const input0 = await wallet.encryptValue256(amount0, migratorAddress, migrateSelector);
  const input1 = await wallet.encryptValue256(amount1, migratorAddress, migrateSelector);
  const minSharesInput = await wallet.encryptValue256(minShares, migratorAddress, migrateSelector);
  const minPriceInput = await wallet.encryptValue256(minPrice, migratorAddress, migrateSelector);
  const maxPriceInput = await wallet.encryptValue256(maxPrice, migratorAddress, migrateSelector);
  const migrator = new Contract(migratorAddress, MIGRATOR_ABI, wallet);
  const receipt = await submit(
    "atomic launchpad migration",
    migrator.migrate(
      tokenA,
      tokenB,
      decimalsA,
      decimalsB,
      feeBps,
      input0,
      input1,
      minSharesInput,
      minPriceInput,
      maxPriceInput,
      deadline,
    ),
  );

  let poolAddress: string | null = null;
  for (const log of receipt?.logs ?? []) {
    try {
      const parsed = migrator.interface.parseLog({ topics: log.topics, data: log.data });
      if (parsed?.name === "LaunchpadMigration") poolAddress = parsed.args.pool as string;
    } catch {
      // Ignore logs emitted by the factory and token contracts.
    }
  }
  if (!poolAddress || !ethers.isAddress(poolAddress)) throw new Error("launchpad pool event missing");

  const pool = new Contract(poolAddress, POOL_ABI, wallet);
  if (!(await pool.initialized())) throw new Error("launchpad pool was not initialized");
  const shares = await pool.myShares.staticCall();
  await wallet.decryptValue256(shares);
  console.log(`launchpad pool: ${poolAddress}`);
  console.log("COTI launchpad migration completed without printing private values.");
}

void main().catch(() => {
  console.error("COTI launchpad migration failed; inspect the local testnet environment without sharing private payloads.");
  process.exitCode = 1;
});
