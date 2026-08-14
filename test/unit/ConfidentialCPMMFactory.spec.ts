import { expect } from "chai";
import { ethers } from "hardhat";

describe("ConfidentialCPMMFactory", function () {
  it("creates one canonical permissionless pool and rejects duplicates", async function () {
    const metadataFactory = await ethers.getContractFactory("MockTokenMetadata");
    const tokenA = await metadataFactory.deploy(18);
    const tokenB = await metadataFactory.deploy(6);
    await tokenA.waitForDeployment();
    await tokenB.waitForDeployment();
    const factoryFactory = await ethers.getContractFactory("ConfidentialCPMMFactory");
    const factory = await factoryFactory.deploy();
    await factory.waitForDeployment();

    const tokenAAddress = await tokenA.getAddress();
    const tokenBAddress = await tokenB.getAddress();
    const tx = await factory.createPool(tokenBAddress, tokenAAddress, 6, 18, 30);
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

    const poolContract = await ethers.getContractAt("ConfidentialCPMM", pool);
    expect(await poolContract.bootstrapper()).to.equal(await factory.getAddress());
    await expect(
      poolContract.bootstrapLiquidity(
        await (await ethers.getSigners())[0].getAddress(),
        1n,
        1n,
        1n,
        0n,
        2n,
      ),
    ).to.be.revertedWithCustomError(poolContract, "BootstrapUnauthorized");

    await expect(
      factory.createPool(tokenAAddress, tokenBAddress, 18, 6, 30),
    ).to.be.revertedWithCustomError(factory, "PoolAlreadyExists");
  });
});
