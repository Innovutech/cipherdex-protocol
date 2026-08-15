import { ethers } from "hardhat";

export async function deployFeeVault(beneficiary?: string) {
  const [defaultBeneficiary] = await ethers.getSigners();
  const vault = await (await ethers.getContractFactory("CipherDEXFeeVault")).deploy(
    beneficiary ?? defaultBeneficiary.address,
  );
  await vault.waitForDeployment();
  return vault;
}
