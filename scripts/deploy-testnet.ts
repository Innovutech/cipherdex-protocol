import { ethers } from "hardhat";

const requiredAddress = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value || !ethers.isAddress(value)) throw new Error(`${name} must be a valid address`);
  return value;
};

const requiredUInt = (name: string, fallback?: string): number => {
  const value = process.env[name]?.trim() ?? fallback;
  if (!value || !/^\d+$/.test(value)) throw new Error(`${name} must be an unsigned integer`);
  return Number(value);
};

async function main(): Promise<void> {
  const token0 = requiredAddress("COTI_TOKEN0");
  const token1 = requiredAddress("COTI_TOKEN1");
  const decimals0 = requiredUInt("COTI_TOKEN0_DECIMALS", "18");
  const decimals1 = requiredUInt("COTI_TOKEN1_DECIMALS", "18");
  const feeBps = requiredUInt("COTI_FEE_BPS", "30");

  const factory = await ethers.getContractFactory("ConfidentialCPMM");
  const pool = await factory.deploy(token0, token1, decimals0, decimals1, feeBps);
  await pool.waitForDeployment();

  console.log(`ConfidentialCPMM deployed at ${await pool.getAddress()}`);
  console.log(`token0=${token0}`);
  console.log(`token1=${token1}`);
  console.log(`chainId=7082400`);
  console.log(`feeBps=${feeBps}`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "deployment failed");
  process.exitCode = 1;
});

