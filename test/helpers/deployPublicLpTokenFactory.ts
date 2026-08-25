import { ethers } from "../../hardhat/runtime.js";

export async function deployPublicLpTokenFactory() {
  const factory = await (
    await ethers.getContractFactory("PublicLPTokenFactory")
  ).deploy();
  await factory.waitForDeployment();
  return factory;
}
