import { expect } from "chai";
import { ethers } from "hardhat";

describe("ConfidentialCPMMFactory", function () {
  it("creates one canonical permissionless pool and rejects duplicates", async function () {
    const [tokenA, tokenB] = await ethers.getSigners();
    const factoryFactory = await ethers.getContractFactory("ConfidentialCPMMFactory");
    const factory = await factoryFactory.deploy();
    await factory.waitForDeployment();

    const tx = await factory.createPool(tokenB.address, tokenA.address, 6, 18, 30);
    const receipt = await tx.wait();
    const created = receipt?.logs
      .map((log) => {
        try {
          return factory.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((log) => log?.name === "PoolCreated");

    expect(created).to.not.equal(undefined);
    const pool = created?.args.pool as string;
    expect(await factory.isPool(pool)).to.equal(true);
    expect(await factory.allPoolsLength()).to.equal(1n);
    expect(await factory.allPools(0)).to.equal(pool);

    await expect(
      factory.createPool(tokenA.address, tokenB.address, 18, 6, 30),
    ).to.be.revertedWithCustomError(factory, "PoolAlreadyExists");
  });
});

