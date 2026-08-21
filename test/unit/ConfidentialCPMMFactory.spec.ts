import { expect } from "chai";
import { ethers } from "../../hardhat/runtime.js";
import { signLaunchCommitment } from "../helpers/confidentialLaunch";
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

    expect(await factory.PROTOCOL_VERSION()).to.equal(3n);
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

  it("commits launch-protected pools for compatible unlisted token runtimes", async function () {
    const [authority, creator] = await ethers.getSigners();
    const deployment = await deployConfidentialFactory();
    const launch = await configureConfidentialLaunch(deployment, authority.address);
    const variant = await (
      await ethers.getContractFactory("MockTokenMetadataVariant")
    ).deploy(8, ethers.id("launch-private-token-implementation"));
    await variant.waitForDeployment();
    const tokenA = await deployment.representativeTokens[0].getAddress();
    const tokenB = await variant.getAddress();
    const signed = await signLaunchCommitment({
      authority,
      creator,
      factory: deployment.factory,
      migrator: launch.migrator,
      strategy: launch.strategy,
      tokenA,
      tokenB,
      decimalsA: 18,
      decimalsB: 8,
    });

    await expect(launch.strategy.commitLaunch(
      signed.commitment,
      signed.creatorAuthorization,
      signed.authorityAuthorization,
    )).to.emit(launch.strategy, "LaunchCommitted");
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
        [token0, token1, 30, 1, 3, ethers.ZeroAddress],
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

  it("commits a protected pool without blocking the standard market", async function () {
    const [authority, creator, outsider] = await ethers.getSigners();
    const deployment = await deployConfidentialFactory();
    const launch = await configureConfidentialLaunch(
      deployment,
      authority.address,
    );
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
    const signed = await signLaunchCommitment({
      authority,
      creator,
      factory,
      migrator: launch.migrator,
      strategy: launch.strategy,
      tokenA,
      tokenB,
      decimalsA: 18,
      decimalsB: 6,
    });

    const [expectedProtectedPool, commitmentHash] =
      await launch.strategy.connect(outsider).commitLaunch.staticCall(
        signed.commitment,
        signed.creatorAuthorization,
        signed.authorityAuthorization,
      );
    await expect(
      launch.strategy.connect(outsider).commitLaunch(
        signed.commitment,
        signed.creatorAuthorization,
        signed.authorityAuthorization,
      ),
    ).to.emit(launch.strategy, "LaunchCommitted");

    const protectedKey = await factory.poolKey(
      tokenA,
      tokenB,
      18,
      6,
      30,
      await launch.strategy.getAddress(),
    );
    const protectedPool = await factory.getPool(protectedKey);
    const protectedContract = await ethers.getContractAt(
      "ConfidentialCPMM",
      protectedPool,
    );
    expect(protectedPool).to.equal(expectedProtectedPool);
    expect(protectedPool).to.not.equal(standardPool);
    expect(await factory.allPoolsLength()).to.equal(2n);
    expect(await protectedContract.initializationStrategy()).to.equal(
      await launch.strategy.getAddress(),
    );
    expect(await protectedContract.initialized()).to.equal(false);
    const record = await launch.strategy.getLaunch(signed.commitment.launchId);
    expect(record.pool).to.equal(protectedPool);
    expect(record.commitmentHash).to.equal(commitmentHash);
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
        signed.commitment.launchId,
        await launch.migrator.getAddress(),
        protectedPool,
        creator.address,
        commitmentHash,
      ),
    ).to.be.revertedWithCustomError(
      launch.strategy,
      "InitializationUnauthorized",
    );
    await expect(
      launch.strategy.commitLaunch(
        signed.commitment,
        signed.creatorAuthorization,
        signed.authorityAuthorization,
      ),
    ).to.be.revertedWithCustomError(launch.strategy, "LaunchAlreadyExists");

    const replacement = await signLaunchCommitment({
      authority,
      creator,
      factory,
      migrator: launch.migrator,
      strategy: launch.strategy,
      tokenA,
      tokenB,
      decimalsA: 18,
      decimalsB: 6,
      launchId: ethers.id("replacement-launch"),
    });
    await expect(
      launch.strategy.commitLaunch(
        replacement.commitment,
        replacement.creatorAuthorization,
        replacement.authorityAuthorization,
      ),
    ).to.be.revertedWithCustomError(launch.strategy, "ActiveLaunchExists");

    await launch.strategy.connect(creator).cancelLaunch(signed.commitment.launchId);
    const mismatchedMetadata = await signLaunchCommitment({
      authority,
      creator,
      factory,
      migrator: launch.migrator,
      strategy: launch.strategy,
      tokenA,
      tokenB,
      decimalsA: 17,
      decimalsB: 6,
      launchId: ethers.id("mismatched-metadata-launch"),
    });
    await expect(
      launch.strategy.commitLaunch(
        mismatchedMetadata.commitment,
        mismatchedMetadata.creatorAuthorization,
        mismatchedMetadata.authorityAuthorization,
      ),
    ).to.be.revertedWithCustomError(factory, "InvalidTokenDecimals");
    await launch.strategy.commitLaunch(
      replacement.commitment,
      replacement.creatorAuthorization,
      replacement.authorityAuthorization,
    );
    expect((await launch.strategy.getLaunch(replacement.commitment.launchId)).pool)
      .to.equal(protectedPool);
    expect(await factory.allPoolsLength()).to.equal(2n);
  });

  it("registers two reviewed strategies with independent pinned migrators", async function () {
    const [authority, secondAuthority] = await ethers.getSigners();
    const deployment = await deployConfidentialFactory();
    const strategyFactory = await ethers.getContractFactory(
      "ConfidentialLaunchInitializationStrategy",
    );
    const strategyAddresses: string[] = [];
    const migratorAddresses: string[] = [];

    for (const launchAuthority of [authority.address, secondAuthority.address]) {
      const strategy = await strategyFactory.deploy(
        await deployment.factory.getAddress(),
        await deployment.strategyRegistry.getAddress(),
        launchAuthority,
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

  it("requires genuinely independent creator and launch-authority approvals", async function () {
    const [, creator] = await ethers.getSigners();
    const deployment = await deployConfidentialFactory();
    const launch = await configureConfidentialLaunch(
      deployment,
      creator.address,
    );
    const signed = await signLaunchCommitment({
      authority: creator,
      creator,
      factory: deployment.factory,
      migrator: launch.migrator,
      strategy: launch.strategy,
      tokenA: await deployment.representativeTokens[0].getAddress(),
      tokenB: await deployment.representativeTokens[1].getAddress(),
      decimalsA: 18,
      decimalsB: 6,
    });

    await expect(
      launch.strategy.commitLaunch(
        signed.commitment,
        signed.creatorAuthorization,
        signed.authorityAuthorization,
      ),
    ).to.be.revertedWithCustomError(launch.strategy, "InvalidCommitment");
  });

  it("expires, supersedes, and consumes a protected launch exactly once", async function () {
    const [authority, creator, outsider] = await ethers.getSigners();
    const deployment = await deployConfidentialFactory();
    const launch = await configureConfidentialLaunch(
      deployment,
      authority.address,
    );
    const tokenA = await deployment.representativeTokens[0].getAddress();
    const tokenB = await deployment.representativeTokens[1].getAddress();
    const latest = await ethers.provider.getBlock("latest");
    if (!latest) throw new Error("Latest block unavailable");
    const expired = await signLaunchCommitment({
      authority,
      creator,
      factory: deployment.factory,
      migrator: launch.migrator,
      strategy: launch.strategy,
      tokenA,
      tokenB,
      decimalsA: 18,
      decimalsB: 6,
      launchId: ethers.id("expiring-launch"),
      authorizationDeadline: BigInt(latest.timestamp + 1),
      migrationDeadline: BigInt(latest.timestamp + 2),
    });
    await launch.strategy.connect(outsider).commitLaunch(
      expired.commitment,
      expired.creatorAuthorization,
      expired.authorityAuthorization,
    );
    await ethers.provider.send("evm_increaseTime", [3]);
    await ethers.provider.send("evm_mine", []);
    await expect(launch.strategy.expireLaunch(expired.commitment.launchId))
      .to.emit(launch.strategy, "LaunchExpired");

    const replacement = await signLaunchCommitment({
      authority,
      creator,
      factory: deployment.factory,
      migrator: launch.migrator,
      strategy: launch.strategy,
      tokenA,
      tokenB,
      decimalsA: 18,
      decimalsB: 6,
      launchId: ethers.id("replacement-after-expiry"),
    });
    const [, commitmentHash] = await launch.strategy.commitLaunch.staticCall(
      replacement.commitment,
      replacement.creatorAuthorization,
      replacement.authorityAuthorization,
    );
    await launch.strategy.commitLaunch(
      replacement.commitment,
      replacement.creatorAuthorization,
      replacement.authorityAuthorization,
    );
    const record = await launch.strategy.getLaunch(replacement.commitment.launchId);
    const factoryAddress = await deployment.factory.getAddress();
    await ethers.provider.send("hardhat_setBalance", [
      factoryAddress,
      "0x1000000000000000000",
    ]);
    await ethers.provider.send("hardhat_impersonateAccount", [factoryAddress]);
    const factorySigner = await ethers.getSigner(factoryAddress);
    try {
      await expect(
        launch.strategy.connect(factorySigner).authorizeInitialization(
          replacement.commitment.launchId,
          await launch.migrator.getAddress(),
          record.pool,
          creator.address,
          ethers.id("wrong-commitment"),
        ),
      ).to.be.revertedWithCustomError(
        launch.strategy,
        "InitializationUnauthorized",
      );
      await expect(
        launch.strategy.connect(factorySigner).authorizeInitialization(
          replacement.commitment.launchId,
          await launch.migrator.getAddress(),
          record.pool,
          creator.address,
          commitmentHash,
        ),
      ).to.emit(launch.strategy, "LaunchInitializationAuthorized");
      await expect(
        launch.strategy.connect(factorySigner).authorizeInitialization(
          replacement.commitment.launchId,
          await launch.migrator.getAddress(),
          record.pool,
          creator.address,
          commitmentHash,
        ),
      ).to.be.revertedWithCustomError(launch.strategy, "LaunchNotActive");
    } finally {
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [
        factoryAddress,
      ]);
    }

    const forbiddenReplacement = await signLaunchCommitment({
      authority,
      creator,
      factory: deployment.factory,
      migrator: launch.migrator,
      strategy: launch.strategy,
      tokenA,
      tokenB,
      decimalsA: 18,
      decimalsB: 6,
      launchId: ethers.id("replacement-after-completion"),
    });
    await expect(
      launch.strategy.commitLaunch(
        forbiddenReplacement.commitment,
        forbiddenReplacement.creatorAuthorization,
        forbiddenReplacement.authorityAuthorization,
      ),
    ).to.be.revertedWithCustomError(
      launch.strategy,
      "CompletedPoolCannotBeSuperseded",
    );
  });
});
