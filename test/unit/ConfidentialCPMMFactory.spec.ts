import { expect } from "chai";
import { ethers } from "hardhat";
import { deployFeeVault } from "../helpers/deployFeeVault";

describe("ConfidentialCPMMFactory", function () {
  it("creates one canonical permissionless pool and rejects duplicates", async function () {
    const metadataFactory = await ethers.getContractFactory("MockTokenMetadata");
    const tokenA = await metadataFactory.deploy(18);
    const tokenB = await metadataFactory.deploy(6);
    await tokenA.waitForDeployment();
    await tokenB.waitForDeployment();
    const vault = await deployFeeVault();
    const factoryFactory = await ethers.getContractFactory("ConfidentialCPMMFactory");
    const factory = await factoryFactory.deploy(await vault.getAddress());
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
    expect(await factory.feeVault()).to.equal(await vault.getAddress());
    expect(await factory.isApprovedFeeTier(5)).to.equal(true);
    expect(await factory.isApprovedFeeTier(30)).to.equal(true);
    expect(await factory.isApprovedFeeTier(100)).to.equal(true);
    expect(await factory.isApprovedFeeTier(25)).to.equal(false);
    const [deployer] = await ethers.getSigners();
    const lpTokenFactoryAddress = await factory.lpTokenFactory();
    expect(lpTokenFactoryAddress).to.not.equal(ethers.ZeroAddress);
    expect(await factory.bootstrapAdapter()).to.equal(ethers.ZeroAddress);
    const lpTokenFactory = await ethers.getContractAt("PrivateLPTokenFactory", lpTokenFactoryAddress);
    expect(await lpTokenFactory.owner()).to.equal(await factory.getAddress());
    const [, outsider] = await ethers.getSigners();
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
    expect(await poolContract.feeBps()).to.equal(30n);
    expect(await poolContract.feeVault()).to.equal(await vault.getAddress());
    expect(await poolContract.PROTOCOL_FEE_SHARE_NUMERATOR()).to.equal(1n);
    expect(await poolContract.PROTOCOL_FEE_SHARE_DENOMINATOR()).to.equal(6n);
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
    await expect(
      factory.createPool(tokenAAddress, tokenBAddress, 18, 6, 25),
    ).to.be.revertedWithCustomError(factory, "InvalidFee");
  });

  it("binds canonical identity to pair, fee, privacy mode and protocol version", async function () {
    const metadataFactory = await ethers.getContractFactory("MockTokenMetadata");
    const tokenA = await metadataFactory.deploy(18);
    const tokenB = await metadataFactory.deploy(6);
    await tokenA.waitForDeployment();
    await tokenB.waitForDeployment();

    const vault = await deployFeeVault();
    const factory = await (await ethers.getContractFactory("ConfidentialCPMMFactory")).deploy(
      await vault.getAddress(),
    );
    await factory.waitForDeployment();
    expect(await factory.PRIVACY_MODE()).to.equal(1n);
    expect(await factory.PROTOCOL_VERSION()).to.equal(1n);

    const a = await tokenA.getAddress();
    const b = await tokenB.getAddress();
    const [token0, token1] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
    const key = await factory.poolKey(a, b, 18, 6, 30);
    const reverseKey = await factory.poolKey(b, a, 6, 18, 30);
    const expected = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "address", "uint256", "uint8", "uint256"],
        [token0, token1, 30, 1, 1],
      ),
    );
    expect(key).to.equal(reverseKey);
    expect(key).to.equal(expected);
    expect(await factory.poolKey(a, b, 0, 0, 30)).to.equal(key);
    expect(await factory.poolKey(a, b, 18, 6, 100)).to.not.equal(key);
  });
});
