import { ethers } from "hardhat";

async function main(): Promise<void> {
  const factoryFactory = await ethers.getContractFactory("ConfidentialCPMMFactory");
  const factory = await factoryFactory.deploy();
  await factory.waitForDeployment();

  const launchpadFactory = await ethers.getContractFactory("ConfidentialLaunchpadMigrator");
  const launchpad = await launchpadFactory.deploy(await factory.getAddress());
  await launchpad.waitForDeployment();

  console.log(`ConfidentialCPMMFactory deployed at ${await factory.getAddress()}`);
  console.log(`ConfidentialLaunchpadMigrator deployed at ${await launchpad.getAddress()}`);
  console.log(`chainId=7082400`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "deployment failed");
  process.exitCode = 1;
});
