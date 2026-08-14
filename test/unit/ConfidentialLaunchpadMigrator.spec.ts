import { expect } from "chai";
import { ethers } from "hardhat";

describe("ConfidentialLaunchpadMigrator", function () {
  it("keeps the factory binding immutable and rejects a zero factory", async function () {
    const factoryFactory = await ethers.getContractFactory("ConfidentialCPMMFactory");
    const factory = await factoryFactory.deploy();
    await factory.waitForDeployment();

    const migratorFactory = await ethers.getContractFactory("ConfidentialLaunchpadMigrator");
    const migrator = await migratorFactory.deploy(await factory.getAddress());
    await migrator.waitForDeployment();

    expect(await migrator.PROTOCOL_VERSION()).to.equal(1n);
    expect(await migrator.factory()).to.equal(await factory.getAddress());
    await expect(migratorFactory.deploy(ethers.ZeroAddress))
      .to.be.revertedWithCustomError(migrator, "InvalidFactory");
  });
});
