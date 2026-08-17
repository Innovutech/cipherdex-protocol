import { expect } from "chai";
import { ethers } from "hardhat";
import { deployConfidentialFactory } from "../helpers/deployConfidentialFactory";

describe("ConfidentialCPMMFactory", function () {
  it("requires a deployed LP-token factory", async function () {
    const [, outsider] = await ethers.getSigners();
    const { approvedCodehash, vault } = await deployConfidentialFactory();
    const factory = await ethers.getContractFactory("ConfidentialCPMMFactory");

    await expect(factory.deploy(await vault.getAddress(), ethers.ZeroAddress, [approvedCodehash]))
      .to.be.revertedWithCustomError(factory, "InvalidLPTokenFactory");
    await expect(factory.deploy(await vault.getAddress(), outsider.address, [approvedCodehash]))
      .to.be.revertedWithCustomError(factory, "InvalidLPTokenFactory");
    const lpTokenFactory = await (
      await ethers.getContractFactory("PrivateLPTokenFactory")
    ).deploy();
    await lpTokenFactory.waitForDeployment();
    await expect(factory.deploy(
      await vault.getAddress(),
      await lpTokenFactory.getAddress(),
      [],
    )).to.be.revertedWithCustomError(factory, "InvalidPrivateTokenCodehash");
  });

  it("creates one canonical permissionless pool and rejects duplicates", async function () {
    const metadataFactory = await ethers.getContractFactory("MockTokenMetadata");
    const tokenA = await metadataFactory.deploy(18);
    const tokenB = await metadataFactory.deploy(6);
    await tokenA.waitForDeployment();
    await tokenB.waitForDeployment();
    const { approvedCodehash, approvedCodehashes, factory, lpTokenFactory, vault } =
      await deployConfidentialFactory();

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
    expect(await factory.isApprovedPrivateTokenCodehash(approvedCodehash)).to.equal(true);
    expect(await factory.isApprovedPrivateToken(tokenAAddress)).to.equal(true);
    expect(await factory.isApprovedPrivateToken(tokenBAddress)).to.equal(true);
    expect(await factory.isApprovedPrivateToken(ethers.ZeroAddress)).to.equal(false);
    expect(await factory.approvedPrivateTokenCodehashesLength())
      .to.equal(BigInt(approvedCodehashes.length));
    for (let index = 0; index < approvedCodehashes.length; index++) {
      expect(await factory.approvedPrivateTokenCodehash(index))
        .to.equal(approvedCodehashes[index]);
    }
    const [deployer] = await ethers.getSigners();
    const lpTokenFactoryAddress = await factory.lpTokenFactory();
    expect(lpTokenFactoryAddress).to.equal(await lpTokenFactory.getAddress());
    expect(await factory.bootstrapAdapter()).to.equal(ethers.ZeroAddress);
    expect(await factory.bestExecutionRouter()).to.equal(ethers.ZeroAddress);
    const [, outsider] = await ethers.getSigners();
    expect(await factory.bootstrapConfigurator()).to.equal(deployer.address);
    const decoyAddress = await lpTokenFactory.connect(outsider).create.staticCall(pool);
    await lpTokenFactory.connect(outsider).create(pool);
    const decoy = await ethers.getContractAt("PrivateLPToken", decoyAddress);
    expect(await decoy.pool()).to.equal(pool);

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
      factory.setBestExecutionRouter(await migrator.getAddress()),
    ).to.be.revertedWithCustomError(factory, "InvalidBestExecutionRouter");
    const bestExecutionRouter = await (
      await ethers.getContractFactory("ConfidentialBestExecutionRouter")
    ).deploy(await factory.getAddress());
    await bestExecutionRouter.waitForDeployment();
    await expect(
      factory.connect(outsider).setBestExecutionRouter(
        await bestExecutionRouter.getAddress(),
      ),
    ).to.be.revertedWithCustomError(factory, "BestExecutionRouterUnauthorized");
    await expect(
      factory.setBestExecutionRouter(await bestExecutionRouter.getAddress()),
    ).to.emit(factory, "BestExecutionRouterConfigured")
      .withArgs(await bestExecutionRouter.getAddress());
    expect(await factory.bestExecutionRouter())
      .to.equal(await bestExecutionRouter.getAddress());
    await expect(
      factory.setBestExecutionRouter(await bestExecutionRouter.getAddress()),
    ).to.be.revertedWithCustomError(factory, "BestExecutionRouterAlreadyConfigured");
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
    await expect(
      poolContract.connect(outsider).quoteExactInputForRouter(0n, true),
    ).to.be.revertedWithCustomError(poolContract, "BestExecutionRouterUnauthorized");
    await expect(
      poolContract.connect(outsider).initializeLPToken(decoyAddress),
    ).to.be.revertedWithCustomError(poolContract, "BootstrapUnauthorized");
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
    await expect(shareToken["burn(uint256)"](1n))
      .to.be.revertedWithCustomError(shareToken, "HolderBurnDisabled");
    await expect(shareToken.burnGt(1n))
      .to.be.revertedWithCustomError(shareToken, "HolderBurnDisabled");
    await expect(shareToken["burn(((uint256,uint256),bytes))"]({
      ciphertext: { ciphertextHigh: 1n, ciphertextLow: 2n },
      signature: "0x1234",
    })).to.be.revertedWithCustomError(shareToken, "HolderBurnDisabled");
    await expect(
      poolContract.bootstrapLiquidity(
        await (await ethers.getSigners())[0].getAddress(),
        outsider.address,
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

    const unapprovedPrivateToken = await (
      await ethers.getContractFactory("PrivateLPToken")
    ).deploy(outsider.address);
    await unapprovedPrivateToken.waitForDeployment();
    expect(await factory.isApprovedPrivateToken(await unapprovedPrivateToken.getAddress()))
      .to.equal(false);
    await expect(
      factory.createPool(
        tokenAAddress,
        await unapprovedPrivateToken.getAddress(),
        18,
        18,
        30,
      ),
    ).to.be.revertedWithCustomError(factory, "UnsupportedPrivateTokenImplementation");
  });

  it("binds canonical identity to pair, fee, privacy mode and protocol version", async function () {
    const metadataFactory = await ethers.getContractFactory("MockTokenMetadata");
    const tokenA = await metadataFactory.deploy(18);
    const tokenB = await metadataFactory.deploy(6);
    await tokenA.waitForDeployment();
    await tokenB.waitForDeployment();

    const { factory } = await deployConfidentialFactory();
    expect(await factory.PRIVACY_MODE()).to.equal(1n);
    expect(await factory.PROTOCOL_VERSION()).to.equal(2n);

    const a = await tokenA.getAddress();
    const b = await tokenB.getAddress();
    const [token0, token1] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
    const key = await factory.poolKey(a, b, 18, 6, 30);
    const reverseKey = await factory.poolKey(b, a, 6, 18, 30);
    const expected = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "address", "uint256", "uint8", "uint256"],
        [token0, token1, 30, 1, 2],
      ),
    );
    expect(key).to.equal(reverseKey);
    expect(key).to.equal(expected);
    expect(await factory.poolKey(a, b, 0, 0, 30)).to.equal(key);
    expect(await factory.poolKey(a, b, 18, 6, 100)).to.not.equal(key);
  });

  it("reuses the canonical pool for launchpad bootstrap without a parallel namespace", async function () {
    const [deployer, outsider] = await ethers.getSigners();
    const metadataFactory = await ethers.getContractFactory("MockTokenMetadata");
    const tokenA = await metadataFactory.deploy(18);
    const tokenB = await metadataFactory.deploy(6);
    await Promise.all([tokenA.waitForDeployment(), tokenB.waitForDeployment()]);

    const { factory } = await deployConfidentialFactory();
    const adapter = await (await ethers.getContractFactory("MockBootstrapAdapter")).deploy();
    await adapter.waitForDeployment();
    await factory.connect(deployer).setBootstrapAdapter(await adapter.getAddress());

    const a = await tokenA.getAddress();
    const b = await tokenB.getAddress();
    await factory.connect(outsider).createPool(a, b, 18, 6, 30);
    const manualKey = await factory.poolKey(a, b, 18, 6, 30);
    const manualPool = await factory.getPool(manualKey);

    await expect(
      factory.connect(outsider).getOrCreatePoolForBootstrap(a, b, 18, 6, 30),
    ).to.be.revertedWithCustomError(factory, "BootstrapAdapterUnauthorized");

    expect(
      await adapter.getOrCreatePoolForBootstrap.staticCall(
        await factory.getAddress(),
        a,
        b,
        18,
        6,
        30,
      ),
    ).to.equal(manualPool);
    await adapter.getOrCreatePoolForBootstrap(
      await factory.getAddress(),
      a,
      b,
      18,
      6,
      30,
    );
    expect(await factory.getPool(manualKey)).to.equal(manualPool);
    expect(await factory.allPoolsLength()).to.equal(1n);

    await adapter.getOrCreatePoolForBootstrap(
      await factory.getAddress(),
      a,
      b,
      18,
      6,
      100,
    );
    const secondKey = await factory.poolKey(a, b, 18, 6, 100);
    const secondPool = await factory.getPool(secondKey);
    expect(secondPool).to.not.equal(ethers.ZeroAddress);
    expect(await factory.isPool(secondPool)).to.equal(true);
    expect(await factory.allPoolsLength()).to.equal(2n);
  });
});
