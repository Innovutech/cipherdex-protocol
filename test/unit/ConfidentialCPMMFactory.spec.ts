import { expect } from "chai";
import { ethers } from "../../hardhat/runtime.js";
import { prepareLaunchAsPinnedMigrator } from "../helpers/confidentialLaunch";
import {
  configureConfidentialLaunch,
  deployConfidentialFactory,
} from "../helpers/deployConfidentialFactory";

describe("ConfidentialCPMMFactory", function () {
  it("requires authenticated immutable deployment dependencies", async function () {
    const [, outsider] = await ethers.getSigners();
    const deployment = await deployConfidentialFactory();
    const factoryFactory = await ethers.getContractFactory(
      "ConfidentialCPMMFactory",
    );
    const vault = await deployment.vault.getAddress();
    const lpTokenFactory = await deployment.lpTokenFactory.getAddress();
    const poolDeployer = await deployment.poolDeployer.getAddress();
    const registry = await deployment.strategyRegistry.getAddress();
    const unreviewedStrategy = await (
      await ethers.getContractFactory("MockBootstrapAdapter")
    ).deploy();
    await unreviewedStrategy.waitForDeployment();

    await expect(factoryFactory.deploy(
      vault,
      ethers.ZeroAddress,
      poolDeployer,
      deployment.poolDeployerRuntimeCodehash,
      registry,
      deployment.strategyRegistryRuntimeCodehash,
    ))
      .to.be.revertedWithCustomError(factoryFactory, "InvalidLPTokenFactory");
    await expect(factoryFactory.deploy(
      vault,
      lpTokenFactory,
      outsider.address,
      deployment.poolDeployerRuntimeCodehash,
      registry,
      deployment.strategyRegistryRuntimeCodehash,
    ))
      .to.be.revertedWithCustomError(factoryFactory, "InvalidPoolDeployer");
    await expect(factoryFactory.deploy(
      vault,
      lpTokenFactory,
      poolDeployer,
      deployment.poolDeployerRuntimeCodehash,
      outsider.address,
      deployment.strategyRegistryRuntimeCodehash,
    ))
      .to.be.revertedWithCustomError(
        factoryFactory,
        "InvalidInitializationStrategyRegistry",
      );
    await expect(
      deployment.strategyRegistry.registerInitializationStrategy(
        await unreviewedStrategy.getAddress(),
      ),
    ).to.be.revertedWithCustomError(
      deployment.strategyRegistry,
      "InvalidInitializationStrategy",
    );
  });

  it("creates one canonical standard pool and preserves pool security metadata", async function () {
    const [, outsider] = await ethers.getSigners();
    const deployment = await deployConfidentialFactory();
    const { factory, lpTokenFactory, representativeTokens, vault } = deployment;
    const launch = await configureConfidentialLaunch(deployment);
    const tokenAAddress = await representativeTokens[0].getAddress();
    const tokenBAddress = await representativeTokens[1].getAddress();

    const tx = await factory.createPool(
      tokenBAddress,
      tokenAAddress,
      6,
      18,
      30,
    );
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
    const poolContract = await ethers.getContractAt("ConfidentialCPMM", pool);

    expect(await factory.PROTOCOL_VERSION()).to.equal(1n);
    expect(await poolContract.PROTOCOL_VERSION()).to.equal(1n);
    expect(await deployment.poolDeployer.DEPLOYER_VERSION()).to.equal(1n);
    expect(await deployment.strategyRegistry.REGISTRY_VERSION()).to.equal(1n);
    expect(await launch.strategy.PROTOCOL_VERSION()).to.equal(1n);
    expect(await launch.strategy.STRATEGY_VERSION()).to.equal(1n);
    expect(await launch.migrator.PROTOCOL_VERSION()).to.equal(1n);
    expect(await factory.PRIVACY_MODE()).to.equal(1n);
    expect(await factory.isPool(pool)).to.equal(true);
    expect(await factory.allPoolsLength()).to.equal(1n);
    expect(await factory.allPools(0)).to.equal(pool);
    expect(await factory.feeVault()).to.equal(await vault.getAddress());
    expect(await vault.confidentialFactory()).to.equal(await factory.getAddress());
    expect(await factory.isApprovedFeeTier(5)).to.equal(true);
    expect(await factory.isApprovedFeeTier(30)).to.equal(true);
    expect(await factory.isApprovedFeeTier(100)).to.equal(true);
    expect(await factory.isApprovedFeeTier(25)).to.equal(false);
    expect(await factory.isCompatiblePrivateToken(tokenAAddress)).to.equal(true);
    expect(await factory.isCompatiblePrivateToken(tokenBAddress)).to.equal(true);
    expect(await factory.initializationStrategyRegistryFinalized()).to.equal(true);
    expect(await factory.initializationStrategiesLength()).to.equal(1n);
    expect(await factory.initializationStrategyAt(0)).to.equal(ethers.ZeroAddress);
    expect(await factory.initializationStrategyAt(1)).to.equal(
      await launch.strategy.getAddress(),
    );
    expect(
      await factory.initializationStrategyClass(await launch.strategy.getAddress()),
    ).to.equal(1n);
    expect(await poolContract.initializationStrategy()).to.equal(ethers.ZeroAddress);
    expect(await poolContract.bootstrapper()).to.equal(await factory.getAddress());
    expect(await poolContract.feeBps()).to.equal(30n);
    expect(await poolContract.feeVault()).to.equal(await vault.getAddress());

    const shareTokenAddress = await poolContract.lpToken();
    const shareToken = await ethers.getContractAt("PrivateLPToken", shareTokenAddress);
    expect(await shareToken.pool()).to.equal(pool);
    expect(
      await lpTokenFactory.isIssuedToken(
        pool,
        shareTokenAddress,
        await factory.getAddress(),
      ),
    ).to.equal(true);
    expect(await shareToken.publicAmountsEnabled()).to.equal(false);

    await expect(
      factory.createPool(tokenAAddress, tokenBAddress, 18, 6, 30),
    ).to.be.revertedWithCustomError(factory, "PoolAlreadyExists");
    await expect(
      factory.createPool(tokenAAddress, tokenBAddress, 18, 6, 25),
    ).to.be.revertedWithCustomError(factory, "InvalidFee");
    await expect(
      factory.connect(outsider).bootstrapPool(
        await launch.strategy.getAddress(),
        ethers.id("unauthorized-launch"),
        ethers.id("unauthorized-commitment"),
        pool,
        outsider.address,
        1n,
        1n,
        1n,
        0n,
        2n,
      ),
    ).to.be.revertedWithCustomError(factory, "InitializationStrategyUnauthorized");
  });

  it("admits compatible private-token runtimes without prior bytecode approval", async function () {
    const deployment = await deployConfidentialFactory();
    const { factory, representativeTokens } = deployment;
    const variant = await (
      await ethers.getContractFactory("MockTokenMetadataVariant")
    ).deploy(8, ethers.id("independent-private-token-implementation"));
    await variant.waitForDeployment();
    const tokenA = await representativeTokens[0].getAddress();
    const tokenB = await variant.getAddress();
    const [baseCode, variantCode] = await Promise.all([
      ethers.provider.getCode(tokenA),
      ethers.provider.getCode(tokenB),
    ]);

    expect(ethers.keccak256(baseCode)).to.not.equal(ethers.keccak256(variantCode));
    expect(await factory.isCompatiblePrivateToken(tokenA)).to.equal(true);
    expect(await factory.isCompatiblePrivateToken(tokenB)).to.equal(true);
    await expect(factory.createPool(tokenB, tokenA, 8, 18, 30))
      .to.emit(factory, "PoolCreated");
  });

  it("rejects structurally incompatible tokens and invalid decimal metadata", async function () {
    const [, noCode] = await ethers.getSigners();
    const deployment = await deployConfidentialFactory();
    const { factory, representativeTokens } = deployment;
    const compatible = await representativeTokens[0].getAddress();
    const publicToken = await (
      await ethers.getContractFactory("MockERC20")
    ).deploy("Public", "PUB", 18);
    const invalidDecimals = await (
      await ethers.getContractFactory("MockTokenMetadataVariant")
    ).deploy(19, ethers.id("invalid-decimals"));
    await Promise.all([publicToken.waitForDeployment(), invalidDecimals.waitForDeployment()]);

    expect(await factory.isCompatiblePrivateToken(noCode.address)).to.equal(false);
    expect(await factory.isCompatiblePrivateToken(await publicToken.getAddress()))
      .to.equal(false);
    expect(await factory.isCompatiblePrivateToken(await invalidDecimals.getAddress()))
      .to.equal(false);
    await expect(factory.createPool(compatible, noCode.address, 18, 18, 30))
      .to.be.revertedWithCustomError(factory, "UnsupportedPrivateToken");
    await expect(
      factory.createPool(compatible, await publicToken.getAddress(), 18, 18, 30),
    ).to.be.revertedWithCustomError(factory, "UnsupportedPrivateToken");
    await expect(
      factory.createPool(compatible, await invalidDecimals.getAddress(), 18, 19, 30),
    ).to.be.revertedWithCustomError(factory, "InvalidTokenDecimals");
    await expect(
      factory.createPool(
        compatible,
        await representativeTokens[1].getAddress(),
        18,
        18,
        30,
      ),
    ).to.be.revertedWithCustomError(factory, "InvalidTokenDecimals");
  });

  it("prepares launch-protected pools for compatible unlisted token runtimes", async function () {
    const [, creator] = await ethers.getSigners();
    const deployment = await deployConfidentialFactory();
    const launch = await configureConfidentialLaunch(deployment);
    const variant = await (
      await ethers.getContractFactory("MockTokenMetadataVariant")
    ).deploy(8, ethers.id("launch-private-token-implementation"));
    await variant.waitForDeployment();
    const tokenA = await deployment.representativeTokens[0].getAddress();
    const tokenB = await variant.getAddress();
    const prepared = await prepareLaunchAsPinnedMigrator({
      creator: creator.address,
      migrator: launch.migrator,
      strategy: launch.strategy,
      tokenA,
      tokenB,
      decimalsA: 18,
      decimalsB: 8,
    });

    await expect(prepared.transaction).to.emit(launch.strategy, "LaunchPrepared");
    const key = await deployment.factory.poolKey(
      tokenA,
      tokenB,
      18,
      8,
      30,
      await launch.strategy.getAddress(),
    );
    expect(await deployment.factory.getPool(key)).to.not.equal(ethers.ZeroAddress);
  });

  it("binds canonical identity to the complete pool key", async function () {
    const deployment = await deployConfidentialFactory();
    const launch = await configureConfidentialLaunch(deployment);
    const { factory, representativeTokens } = deployment;
    const a = await representativeTokens[0].getAddress();
    const b = await representativeTokens[1].getAddress();
    const [token0, token1] =
      a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
    const standardKey = await factory.poolKey(a, b, 18, 6, 30, ethers.ZeroAddress);
    const reverseKey = await factory.poolKey(b, a, 6, 18, 30, ethers.ZeroAddress);
    const protectedKey = await factory.poolKey(
      a,
      b,
      18,
      6,
      30,
      await launch.strategy.getAddress(),
    );
    const expected = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "address", "uint256", "uint8", "uint256", "address"],
        [token0, token1, 30, 1, 1, ethers.ZeroAddress],
      ),
    );

    expect(standardKey).to.equal(reverseKey);
    expect(standardKey).to.equal(expected);
    expect(await factory.poolKey(a, b, 0, 0, 30, ethers.ZeroAddress)).to.equal(
      standardKey,
    );
    expect(protectedKey).to.not.equal(standardKey);
    expect(await factory.poolKey(a, b, 18, 6, 100, ethers.ZeroAddress)).to.not.equal(
      standardKey,
    );
  });

  it("prepares and consumes a protected launch without blocking the standard market", async function () {
    const [, creator, outsider] = await ethers.getSigners();
    const deployment = await deployConfidentialFactory();
    const launch = await configureConfidentialLaunch(deployment);
    const { factory, representativeTokens } = deployment;
    const tokenA = await representativeTokens[0].getAddress();
    const tokenB = await representativeTokens[1].getAddress();
    await factory.createPool(tokenA, tokenB, 18, 6, 30);
    const standardKey = await factory.poolKey(
      tokenA,
      tokenB,
      18,
      6,
      30,
      ethers.ZeroAddress,
    );
    const standardPool = await factory.getPool(standardKey);
    await expect(
      launch.strategy.connect(outsider).prepareLaunch(
        ethers.id("unauthorized-launch"),
        creator.address,
        tokenA,
        tokenB,
        18,
        6,
        30,
        2n ** 63n,
        ethers.id("unauthorized-authorization"),
      ),
    ).to.be.revertedWithCustomError(launch.strategy, "StrategyCodeChanged");

    const protectedKey = await factory.poolKey(
      tokenA,
      tokenB,
      18,
      6,
      30,
      await launch.strategy.getAddress(),
    );
    expect(await factory.getPool(protectedKey)).to.equal(ethers.ZeroAddress);

    const prepared = await prepareLaunchAsPinnedMigrator({
      creator: creator.address,
      migrator: launch.migrator,
      strategy: launch.strategy,
      tokenA,
      tokenB,
      decimalsA: 18,
      decimalsB: 6,
    });
    await expect(prepared.transaction).to.emit(launch.strategy, "LaunchPrepared");
    const protectedPool = await factory.getPool(protectedKey);
    const protectedContract = await ethers.getContractAt(
      "ConfidentialCPMM",
      protectedPool,
    );
    expect(protectedPool).to.not.equal(standardPool);
    expect(await factory.allPoolsLength()).to.equal(2n);
    expect(await protectedContract.initializationStrategy()).to.equal(
      await launch.strategy.getAddress(),
    );
    expect(await protectedContract.initialized()).to.equal(false);
    const record = await launch.strategy.getLaunch(prepared.launchId);
    expect(record.pool).to.equal(protectedPool);
    expect(record.authorizationHash).to.equal(prepared.authorizationHash);
    expect(record.status).to.equal(1n);

    const emptyInput = {
      ciphertext: { ciphertextHigh: 0n, ciphertextLow: 0n },
      signature: "0x",
    };
    await expect(
      protectedContract.connect(outsider).addLiquidity(
        emptyInput,
        emptyInput,
        emptyInput,
        emptyInput,
        emptyInput,
        false,
        2n ** 63n,
      ),
    ).to.be.revertedWithCustomError(
      protectedContract,
      "ProtectedInitializationRequired",
    );
    await expect(
      launch.strategy.connect(outsider).authorizeInitialization(
        prepared.launchId,
        await launch.migrator.getAddress(),
        protectedPool,
        creator.address,
        prepared.authorizationHash,
      ),
    ).to.be.revertedWithCustomError(
      launch.strategy,
      "InitializationUnauthorized",
    );
    await expect(
      prepareLaunchAsPinnedMigrator({
        creator: creator.address,
        migrator: launch.migrator,
        strategy: launch.strategy,
        tokenA,
        tokenB,
        decimalsA: 18,
        decimalsB: 6,
        launchId: ethers.id("replacement-launch"),
      }),
    ).to.be.revertedWithCustomError(launch.strategy, "ActiveLaunchExists");

    const factoryAddress = await factory.getAddress();
    await ethers.provider.send("hardhat_setBalance", [
      factoryAddress,
      "0x1000000000000000000",
    ]);
    await ethers.provider.send("hardhat_impersonateAccount", [factoryAddress]);
    const factorySigner = await ethers.getSigner(factoryAddress);
    try {
      await expect(
        launch.strategy.connect(factorySigner).authorizeInitialization(
          prepared.launchId,
          await launch.migrator.getAddress(),
          protectedPool,
          creator.address,
          prepared.authorizationHash,
        ),
      ).to.emit(launch.strategy, "LaunchInitializationAuthorized");
      await expect(
        launch.strategy.connect(factorySigner).authorizeInitialization(
          prepared.launchId,
          await launch.migrator.getAddress(),
          protectedPool,
          creator.address,
          prepared.authorizationHash,
        ),
      ).to.be.revertedWithCustomError(launch.strategy, "LaunchNotActive");
    } finally {
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [factoryAddress]);
    }

    expect((await launch.strategy.getLaunch(prepared.launchId)).status).to.equal(2n);
    await expect(
      prepareLaunchAsPinnedMigrator({
        creator: creator.address,
        migrator: launch.migrator,
        strategy: launch.strategy,
        tokenA,
        tokenB,
        decimalsA: 18,
        decimalsB: 6,
        launchId: ethers.id("replacement-after-completion"),
      }),
    ).to.be.revertedWithCustomError(
      launch.strategy,
      "CompletedPoolCannotBeSuperseded",
    );
  });

  it("registers two reviewed strategies with independent pinned migrators", async function () {
    const deployment = await deployConfidentialFactory();
    const strategyFactory = await ethers.getContractFactory(
      "ConfidentialLaunchInitializationStrategy",
    );
    const strategyAddresses: string[] = [];
    const migratorAddresses: string[] = [];

    for (let index = 0; index < 2; index += 1) {
      const strategy = await strategyFactory.deploy(
        await deployment.factory.getAddress(),
        await deployment.strategyRegistry.getAddress(),
      );
      await strategy.waitForDeployment();
      strategyAddresses.push(await strategy.getAddress());
      migratorAddresses.push(await strategy.migrator());
    }

    for (const strategy of strategyAddresses) {
      await deployment.strategyRegistry.registerInitializationStrategy(strategy);
    }
    await deployment.strategyRegistry.finalize();

    expect(await deployment.factory.initializationStrategiesLength()).to.equal(2n);
    expect(await deployment.factory.initializationStrategyAt(1)).to.equal(
      strategyAddresses[0],
    );
    expect(await deployment.factory.initializationStrategyAt(2)).to.equal(
      strategyAddresses[1],
    );
    expect(await deployment.factory.initializationStrategyClass(strategyAddresses[0]))
      .to.equal(1n);
    expect(await deployment.factory.initializationStrategyClass(strategyAddresses[1]))
      .to.equal(2n);
    expect(migratorAddresses[0]).to.not.equal(migratorAddresses[1]);
  });

});
