import { artifacts, ethers } from "../../hardhat/runtime.js";

export async function deployObservableConfidentialFactory() {
  const [beneficiary] = await ethers.getSigners();
  const vault = await (
    await ethers.getContractFactory("CipherDEXConfidentialFeeVault")
  ).deploy(await beneficiary.getAddress());
  await vault.waitForDeployment();

  const lpTokenFactory = await (
    await ethers.getContractFactory("PrivateLPTokenFactory")
  ).deploy();
  await lpTokenFactory.waitForDeployment();

  const strategyArtifact = await artifacts.readArtifact(
    "ObservableConfidentialLaunchInitializationStrategy",
  );
  const strategyRuntimeCodehash = ethers.keccak256(
    strategyArtifact.deployedBytecode,
  );
  const strategyRegistry = await (
    await ethers.getContractFactory(
      "ObservableConfidentialInitializationStrategyRegistry",
    )
  ).deploy([strategyRuntimeCodehash]);
  await strategyRegistry.waitForDeployment();
  const strategyRegistryRuntimeCodehash = ethers.keccak256(
    await ethers.provider.getCode(await strategyRegistry.getAddress()),
  );

  const poolDeployer = await (
    await ethers.getContractFactory("ObservableConfidentialCPMMDeployer")
  ).deploy();
  await poolDeployer.waitForDeployment();
  const poolDeployerRuntimeCodehash = ethers.keccak256(
    await ethers.provider.getCode(await poolDeployer.getAddress()),
  );

  const routerArtifact = await artifacts.readArtifact(
    "ObservableConfidentialBestExecutionRouter",
  );
  const routerRuntimeCodehash = ethers.keccak256(
    routerArtifact.deployedBytecode,
  );

  const factory = await (
    await ethers.getContractFactory("ObservableConfidentialCPMMFactory")
  ).deploy(
    await vault.getAddress(),
    await lpTokenFactory.getAddress(),
    await poolDeployer.getAddress(),
    poolDeployerRuntimeCodehash,
    await strategyRegistry.getAddress(),
    strategyRegistryRuntimeCodehash,
  );
  await factory.waitForDeployment();
  if (
    String(await factory.BEST_EXECUTION_ROUTER_RUNTIME_CODEHASH()).toLowerCase() !==
    routerRuntimeCodehash.toLowerCase()
  ) {
    throw new Error("observable router artifact hash does not match factory policy");
  }
  await vault.setConfidentialFactory(await factory.getAddress());
  await poolDeployer.bindFactory(await factory.getAddress());
  await strategyRegistry.bindFactory(await factory.getAddress());

  return {
    beneficiary,
    factory,
    lpTokenFactory,
    poolDeployer,
    poolDeployerRuntimeCodehash,
    routerRuntimeCodehash,
    strategyRegistry,
    strategyRegistryRuntimeCodehash,
    strategyRuntimeCodehash,
    vault,
  };
}

export async function configureObservableConfidentialLaunch(
  deployment: Awaited<ReturnType<typeof deployObservableConfidentialFactory>>,
) {
  const strategy = await (
    await ethers.getContractFactory(
      "ObservableConfidentialLaunchInitializationStrategy",
    )
  ).deploy(
    await deployment.factory.getAddress(),
    await deployment.strategyRegistry.getAddress(),
  );
  await strategy.waitForDeployment();
  const migrator = await ethers.getContractAt(
    "ObservableConfidentialLaunchpadMigrator",
    await strategy.migrator(),
  );
  await deployment.strategyRegistry.registerInitializationStrategy(
    await strategy.getAddress(),
  );
  await deployment.strategyRegistry.finalize();
  const router = await (
    await ethers.getContractFactory(
      "ObservableConfidentialBestExecutionRouter",
    )
  ).deploy(await deployment.factory.getAddress());
  await router.waitForDeployment();
  await deployment.factory.setBestExecutionRouter(await router.getAddress());
  return { migrator, router, strategy };
}
