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
    const lpTokenFactoryAddress = await factory.lpTokenFactory();
    expect(lpTokenFactoryAddress).to.not.equal(ethers.ZeroAddress);
    expect(await factory.bootstrapAdapter()).to.equal(ethers.ZeroAddress);
    const lpTokenFactory = await ethers.getContractAt("PrivateLPTokenFactory", lpTokenFactoryAddress);
    expect(await lpTokenFactory.owner()).to.equal(await factory.getAddress());
    const [deployer, outsider] = await ethers.getSigners();
    expect(await factory.bootstrapConfigurator()).to.equal(deployer.address);
    await expect(
      lpTokenFactory.connect(outsider).create(pool),
    ).to.be.revertedWithCustomError(lpTokenFactory, "Unauthorized");

    const migratorFactory = await ethers.getContractFactory("ConfidentialLaunchpadMigrator");
    const migrator = await migratorFactory.deploy(await factory.getAddress());
    await migrator.waitForDeployment();
    await expect(
      factory.connect(outsider).setBootstrapAdapter(await migrator.getAddress()),
    ).to.be.revertedWithCustomError(factory, "BootstrapAdapterUnauthorized");
    await factory.setBootstrapAdapter(await migrator.getAddress());
    expect(await factory.bootstrapAdapter()).to.equal(await migrator.getAddress());
    await expect(
      factory.setBootstrapAdapter(await migrator.getAddress()),
    ).to.be.revertedWithCustomError(factory, "BootstrapAdapterAlreadyConfigured");
    await expect(
      factory.connect(outsider).bootstrapPool(
        pool,
        outsider.address,
        1n,
        1n,
        1n,
        0n,
        2n,
      ),
    ).to.be.revertedWithCustomError(factory, "BootstrapAdapterUnauthorized");
    expect(await factory.allPoolsLength()).to.equal(1n);
    expect(await factory.allPools(0)).to.equal(pool);

    const poolContract = await ethers.getContractAt("ConfidentialCPMM", pool);
    expect(await poolContract.bootstrapper()).to.equal(await factory.getAddress());
    const shareTokenAddress = await poolContract.lpToken();
    expect(shareTokenAddress).to.not.equal(ethers.ZeroAddress);
    const shareToken = await ethers.getContractAt("PrivateLPToken", shareTokenAddress);
    expect(await shareToken.pool()).to.equal(pool);
    expect(await shareToken.publicAmountsEnabled()).to.equal(false);
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
