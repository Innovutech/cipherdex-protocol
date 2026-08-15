import { ContractFactory } from "ethers";
import { ethers } from "hardhat";

async function deployAndReport(
  label: string,
  factory: ContractFactory,
  ...args: unknown[]
): Promise<any> {
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  const deploymentTransaction = contract.deploymentTransaction();
  const receipt = deploymentTransaction ? await deploymentTransaction.wait() : null;
  console.log(
    `${label} deployed at ${await contract.getAddress()} ` +
      `tx=${deploymentTransaction?.hash ?? "unknown"} ` +
      `gas=${receipt?.gasUsed?.toString() ?? "unknown"}`,
  );
  return contract;
}

async function main(): Promise<void> {
  const factoryFactory = await ethers.getContractFactory("ConfidentialCPMMFactory");
  const factory = await deployAndReport("ConfidentialCPMMFactory", factoryFactory);

  const launchpadFactory = await ethers.getContractFactory("ConfidentialLaunchpadMigrator");
  const launchpad = await deployAndReport(
    "ConfidentialLaunchpadMigrator",
    launchpadFactory,
    await factory.getAddress(),
  );

  const publicFactoryFactory = await ethers.getContractFactory("PublicCPMMFactory");
  const publicFactory = await deployAndReport("PublicCPMMFactory", publicFactoryFactory);

  const publicQuoterFactory = await ethers.getContractFactory("PublicCPMMQuoter");
  await deployAndReport(
    "PublicCPMMQuoter",
    publicQuoterFactory,
    await publicFactory.getAddress(),
  );

  const publicRouterFactory = await ethers.getContractFactory("PublicCPMMRouter");
  await deployAndReport(
    "PublicCPMMRouter",
    publicRouterFactory,
    await publicFactory.getAddress(),
  );

  console.log(`confidentialLpTokenFactory=${await factory.lpTokenFactory()}`);
  console.log(`confidentialFactory=${await factory.getAddress()}`);
  console.log(`launchpadMigrator=${await launchpad.getAddress()}`);
  console.log(`publicFactory=${await publicFactory.getAddress()}`);
  console.log(`chainId=7082400`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "deployment failed");
  process.exitCode = 1;
});
