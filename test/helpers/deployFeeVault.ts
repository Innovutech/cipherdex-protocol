import { ethers } from "../../hardhat/runtime.js";

export async function deployFeeVault(beneficiary?: string) {
  const [defaultBeneficiary] = await ethers.getSigners();
  const vault = await (await ethers.getContractFactory("CipherDEXFeeVault")).deploy(
    beneficiary ?? defaultBeneficiary.address,
  );
  await vault.waitForDeployment();
  return vault;
}
