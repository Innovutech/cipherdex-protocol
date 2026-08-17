import { ethers } from "hardhat";
import { deployFeeVault } from "./deployFeeVault";

export async function deployPublicFactory(beneficiary?: string) {
  const vault = await deployFeeVault(beneficiary);
  const factory = await (
    await ethers.getContractFactory("PublicCPMMFactory")
  ).deploy(await vault.getAddress());
  await factory.waitForDeployment();
  await vault.setPublicFactory(await factory.getAddress());
  return { vault, factory };
}

export async function createPublicPool(
  factory: Awaited<ReturnType<typeof deployPublicFactory>>["factory"],
  tokenA: string,
  tokenB: string,
  decimalsA: number,
  decimalsB: number,
  feeBps = 30,
) {
  await factory.createPool(tokenA, tokenB, decimalsA, decimalsB, feeBps);
  const key = await factory.poolKey(tokenA, tokenB, decimalsA, decimalsB, feeBps);
  const address = await factory.getPool(key);
  return ethers.getContractAt("PublicCPMM", address);
}
