import { ethers } from "hardhat";
import { deployFeeVault } from "./deployFeeVault";

export async function deployConfidentialFactory() {
  const vault = await deployFeeVault();
  const representativeFactory = await ethers.getContractFactory("MockTokenMetadata");
  const representativeTokens = await Promise.all([
    representativeFactory.deploy(18),
    representativeFactory.deploy(6),
  ]);
  await Promise.all(representativeTokens.map((token) => token.waitForDeployment()));
  const representativeCodes = await Promise.all(
    representativeTokens.map(async (token) =>
      ethers.provider.getCode(await token.getAddress())),
  );
  const approvedCodehashes = [
    ...new Set(representativeCodes.map((code) => ethers.keccak256(code))),
  ];
  const approvedCodehash = approvedCodehashes[0];
  const lpTokenFactory = await (
    await ethers.getContractFactory("PrivateLPTokenFactory")
  ).deploy();
  await lpTokenFactory.waitForDeployment();

  const factory = await (
    await ethers.getContractFactory("ConfidentialCPMMFactory")
  ).deploy(
    await vault.getAddress(),
    await lpTokenFactory.getAddress(),
    approvedCodehashes,
  );
  await factory.waitForDeployment();
  await vault.setConfidentialFactory(await factory.getAddress());

  return {
    approvedCodehash,
    approvedCodehashes,
    factory,
    lpTokenFactory,
    representativeTokens,
    vault,
  };
}
