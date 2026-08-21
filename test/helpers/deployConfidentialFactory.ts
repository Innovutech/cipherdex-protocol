import { artifacts, ethers } from "../../hardhat/runtime.js";
import { deployFeeVault } from "./deployFeeVault";

export async function deployConfidentialFactory() {
  const vault = await deployFeeVault();
  const representativeFactory = await ethers.getContractFactory("MockTokenMetadata");
  const representativeTokens = await Promise.all([
    representativeFactory.deploy(18),
    representativeFactory.deploy(6),
  ]);
  await Promise.all(representativeTokens.map((token) => token.waitForDeployment()));
  const lpTokenFactory = await (
    await ethers.getContractFactory("PrivateLPTokenFactory")
  ).deploy();
  await lpTokenFactory.waitForDeployment();

  const strategyArtifact = await artifacts.readArtifact(
    "ConfidentialLaunchInitializationStrategy",
  );
  const strategyRuntimeCodehash = ethers.keccak256(
    strategyArtifact.deployedBytecode,
  );
  const strategyRegistry = await (
    await ethers.getContractFactory("ConfidentialInitializationStrategyRegistry")
  ).deploy([strategyRuntimeCodehash]);
  await strategyRegistry.waitForDeployment();
  const strategyRegistryRuntimeCodehash = ethers.keccak256(
    await ethers.provider.getCode(await strategyRegistry.getAddress()),
  );
  const poolDeployer = await (
    await ethers.getContractFactory("ConfidentialCPMMDeployer")
  ).deploy();
  await poolDeployer.waitForDeployment();
  const poolDeployerRuntimeCodehash = ethers.keccak256(
    await ethers.provider.getCode(await poolDeployer.getAddress()),
  );

  const factory = await (
    await ethers.getContractFactory("ConfidentialCPMMFactory")
  ).deploy(
    await vault.getAddress(),
    await lpTokenFactory.getAddress(),
    await poolDeployer.getAddress(),
    poolDeployerRuntimeCodehash,
    await strategyRegistry.getAddress(),
    strategyRegistryRuntimeCodehash,
  );
  await factory.waitForDeployment();
  await vault.setConfidentialFactory(await factory.getAddress());
  await poolDeployer.bindFactory(await factory.getAddress());
  await strategyRegistry.bindFactory(await factory.getAddress());

  return {
    factory,
    lpTokenFactory,
    poolDeployer,
    poolDeployerRuntimeCodehash,
    representativeTokens,
    strategyRegistry,
    strategyRegistryRuntimeCodehash,
    strategyRuntimeCodehash,
    vault,
  };
}

export async function configureConfidentialLaunch(
  deployment: Awaited<ReturnType<typeof deployConfidentialFactory>>,
  launchAuthority?: string,
) {
  const [, defaultAuthority] = await ethers.getSigners();
  const authority = launchAuthority ?? defaultAuthority.address;
  const strategy = await (
    await ethers.getContractFactory("ConfidentialLaunchInitializationStrategy")
  ).deploy(
    await deployment.factory.getAddress(),
    await deployment.strategyRegistry.getAddress(),
    authority,
  );
  await strategy.waitForDeployment();
  const migrator = await ethers.getContractAt(
    "ConfidentialLaunchpadMigrator",
    await strategy.migrator(),
  );
  await deployment.strategyRegistry.registerInitializationStrategy(
    await strategy.getAddress(),
  );
  await deployment.strategyRegistry.finalize();

  return { authority, migrator, strategy };
}
