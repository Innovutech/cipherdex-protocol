import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { promisify } from "node:util";
import { BaseContract, ContractFactory, ContractTransactionResponse } from "ethers";
import { ethers } from "hardhat";
import { resolvePrivateTokenCodehashes } from "./private-token-codehashes";

const execFileAsync = promisify(execFile);

const TESTNET_DEPLOY_GAS_LIMITS = {
  feeVault: 1_000_000n,
  privateLpTokenFactory: 8_000_000n,
  confidentialFactory: 8_000_000n,
  launchpadMigrator: 2_500_000n,
  publicFactory: 3_000_000n,
  publicQuoter: 400_000n,
  publicRouter: 800_000n,
  adapterBinding: 250_000n,
} as const;

type DeploymentResult<T extends BaseContract = BaseContract> = {
  contract: T;
  address: string;
  deploymentTx: string | null;
  gasUsed: string | null;
};

type ConfidentialFactoryHandle = BaseContract & {
  setBootstrapAdapter(
    address: string,
    overrides?: { gasLimit: bigint },
  ): Promise<ContractTransactionResponse>;
  lpTokenFactory(): Promise<string>;
  feeVault(): Promise<string>;
  bootstrapAdapter(): Promise<string>;
};

type FeeVaultHandle = BaseContract & {
  beneficiary(): Promise<string>;
};

type FactoryBoundHandle = BaseContract & {
  factory(): Promise<string>;
};

type PublicFactoryHandle = BaseContract & {
  feeVault(): Promise<string>;
};

async function deployAndReport<T extends BaseContract>(
  label: string,
  factory: ContractFactory,
  ...args: unknown[]
): Promise<DeploymentResult<T>> {
  const contract = await factory.deploy(...args) as T;
  await contract.waitForDeployment();
  const deploymentTransaction = contract.deploymentTransaction();
  const receipt = deploymentTransaction ? await deploymentTransaction.wait() : null;
  const address = await contract.getAddress();
  console.log(
    `${label} deployed at ${address} ` +
      `tx=${deploymentTransaction?.hash ?? "unknown"} ` +
      `gas=${receipt?.gasUsed?.toString() ?? "unknown"}`,
  );
  return {
    contract,
    address,
    deploymentTx: deploymentTransaction?.hash ?? null,
    gasUsed: receipt?.gasUsed?.toString() ?? null,
  };
}

async function requireCleanSourceCommit(): Promise<string> {
  const [head, status] = await Promise.all([
    execFileAsync("git", ["rev-parse", "--verify", "HEAD"]),
    execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=all"]),
  ]);
  const commit = head.stdout.trim();
  if (!/^[0-9a-f]{40}$/i.test(commit)) {
    throw new Error("deployment source commit is unavailable");
  }
  if (status.stdout.trim().length > 0) {
    throw new Error("deployment requires a clean Git worktree before any transaction is sent");
  }
  return commit;
}

async function runtimeCodehash(address: string): Promise<string> {
  const code = await ethers.provider.getCode(address);
  if (code === "0x") throw new Error(`deployed contract has no runtime code: ${address}`);
  return ethers.keccak256(code);
}

async function writeDeploymentRecord(record: Record<string, unknown>): Promise<void> {
  const outputPath = process.env.COTI_DEPLOYMENT_RECORD?.trim();
  if (!outputPath) {
    console.log("deployment record not written; set COTI_DEPLOYMENT_RECORD to persist it");
    return;
  }
  const normalizedPath = outputPath.replaceAll("\\", "/");
  if (!normalizedPath.startsWith("deployments/") || !normalizedPath.endsWith(".json")) {
    throw new Error("COTI_DEPLOYMENT_RECORD must stay under deployments/");
  }
  const deploymentRoot = resolve("deployments");
  const resolvedOutput = resolve(outputPath);
  const relativeOutput = relative(deploymentRoot, resolvedOutput);
  if (
    relativeOutput === "" ||
    relativeOutput.startsWith("..") ||
    relativeOutput.includes(":") ||
    resolve(deploymentRoot, relativeOutput) !== resolvedOutput
  ) {
    throw new Error("COTI_DEPLOYMENT_RECORD must resolve inside deployments/");
  }
  await mkdir("deployments", { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log(`deployment record: ${outputPath}`);
}

async function main(): Promise<void> {
  const deployedSourceCommit = await requireCleanSourceCommit();
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== 7_082_400n) {
    throw new Error(`deployment is restricted to COTI testnet (got chain ${network.chainId})`);
  }

  const feeBeneficiary = process.env.CIPHERDEX_FEE_BENEFICIARY?.trim();
  if (!feeBeneficiary || !ethers.isAddress(feeBeneficiary)) {
    throw new Error("CIPHERDEX_FEE_BENEFICIARY must be a valid dedicated fee address");
  }
  const reviewedPrivateTokens = ["COTI_TOKEN0", "COTI_TOKEN1"].map((name) => {
    const address = process.env[name]?.trim();
    if (!address || !ethers.isAddress(address)) {
      throw new Error(`${name} must identify a reviewed deployed private token`);
    }
    return address;
  });
  const privateTokenCodehashes = await resolvePrivateTokenCodehashes(
    ethers.provider,
    reviewedPrivateTokens,
  );

  const feeVaultFactory = await ethers.getContractFactory("CipherDEXFeeVault");
  const feeVaultDeployment = await deployAndReport<FeeVaultHandle>(
    "CipherDEXFeeVault",
    feeVaultFactory,
    feeBeneficiary,
    { gasLimit: TESTNET_DEPLOY_GAS_LIMITS.feeVault },
  );

  const privateLpTokenFactoryDeployment = await deployAndReport(
    "PrivateLPTokenFactory",
    await ethers.getContractFactory("PrivateLPTokenFactory"),
    { gasLimit: TESTNET_DEPLOY_GAS_LIMITS.privateLpTokenFactory },
  );

  const factoryFactory = await ethers.getContractFactory("ConfidentialCPMMFactory");
  const factoryDeployment = await deployAndReport<ConfidentialFactoryHandle>(
    "ConfidentialCPMMFactory",
    factoryFactory,
    feeVaultDeployment.address,
    privateLpTokenFactoryDeployment.address,
    privateTokenCodehashes,
    { gasLimit: TESTNET_DEPLOY_GAS_LIMITS.confidentialFactory },
  );
  const factory = factoryDeployment.contract;

  const launchpadFactory = await ethers.getContractFactory("ConfidentialLaunchpadMigrator");
  const launchpadDeployment = await deployAndReport<FactoryBoundHandle>(
    "ConfidentialLaunchpadMigrator",
    launchpadFactory,
    factoryDeployment.address,
    { gasLimit: TESTNET_DEPLOY_GAS_LIMITS.launchpadMigrator },
  );
  const adapterTx = await factory.setBootstrapAdapter(launchpadDeployment.address, {
    gasLimit: TESTNET_DEPLOY_GAS_LIMITS.adapterBinding,
  });
  const adapterReceipt = await adapterTx.wait();
  console.log(
    `launchpad adapter configured: ${launchpadDeployment.address} ` +
      `tx=${adapterTx.hash} gas=${adapterReceipt?.gasUsed?.toString() ?? "unknown"}`,
  );

  const publicFactoryFactory = await ethers.getContractFactory("PublicCPMMFactory");
  const publicFactoryDeployment = await deployAndReport<PublicFactoryHandle>(
    "PublicCPMMFactory",
    publicFactoryFactory,
    feeVaultDeployment.address,
    { gasLimit: TESTNET_DEPLOY_GAS_LIMITS.publicFactory },
  );

  const publicQuoterFactory = await ethers.getContractFactory("PublicCPMMQuoter");
  const publicQuoterDeployment = await deployAndReport<FactoryBoundHandle>(
    "PublicCPMMQuoter",
    publicQuoterFactory,
    publicFactoryDeployment.address,
    { gasLimit: TESTNET_DEPLOY_GAS_LIMITS.publicQuoter },
  );

  const publicRouterFactory = await ethers.getContractFactory("PublicCPMMRouter");
  const publicRouterDeployment = await deployAndReport<FactoryBoundHandle>(
    "PublicCPMMRouter",
    publicRouterFactory,
    publicFactoryDeployment.address,
    { gasLimit: TESTNET_DEPLOY_GAS_LIMITS.publicRouter },
  );

  const sameAddress = (actual: string, expected: string): boolean =>
    actual.toLowerCase() === expected.toLowerCase();
  const [
    deployedBeneficiary,
    confidentialFeeVault,
    deployedLpTokenFactory,
    deployedBootstrapAdapter,
    migratorFactory,
    publicFeeVault,
    quoterFactory,
    routerFactory,
  ] = await Promise.all([
    feeVaultDeployment.contract.beneficiary(),
    factory.feeVault(),
    factory.lpTokenFactory(),
    factory.bootstrapAdapter(),
    launchpadDeployment.contract.factory(),
    publicFactoryDeployment.contract.feeVault(),
    publicQuoterDeployment.contract.factory(),
    publicRouterDeployment.contract.factory(),
  ]);
  if (
    !sameAddress(String(deployedBeneficiary), feeBeneficiary) ||
    !sameAddress(String(confidentialFeeVault), feeVaultDeployment.address) ||
    !sameAddress(String(deployedLpTokenFactory), privateLpTokenFactoryDeployment.address) ||
    !sameAddress(String(deployedBootstrapAdapter), launchpadDeployment.address) ||
    !sameAddress(String(migratorFactory), factoryDeployment.address) ||
    !sameAddress(String(publicFeeVault), feeVaultDeployment.address) ||
    !sameAddress(String(quoterFactory), publicFactoryDeployment.address) ||
    !sameAddress(String(routerFactory), publicFactoryDeployment.address)
  ) {
    throw new Error("post-deployment immutable binding verification failed");
  }
  console.log("post-deployment immutable bindings verified");

  const confidentialLpTokenFactory = privateLpTokenFactoryDeployment.address;
  console.log(`confidentialLpTokenFactory=${confidentialLpTokenFactory}`);
  console.log(`feeVault=${feeVaultDeployment.address}`);
  console.log(`feeBeneficiary=${feeBeneficiary}`);
  console.log(`confidentialFactory=${factoryDeployment.address}`);
  console.log(`launchpadMigrator=${launchpadDeployment.address}`);
  console.log(`publicFactory=${publicFactoryDeployment.address}`);
  console.log(`chainId=${network.chainId}`);

  const runtimeCodehashes = Object.fromEntries(
    await Promise.all(
      [
        ["feeVault", feeVaultDeployment.address],
        ["confidentialFactory", factoryDeployment.address],
        ["confidentialLpTokenFactory", confidentialLpTokenFactory],
        ["launchpadMigrator", launchpadDeployment.address],
        ["publicFactory", publicFactoryDeployment.address],
        ["publicQuoter", publicQuoterDeployment.address],
        ["publicRouter", publicRouterDeployment.address],
      ].map(async ([name, address]) => [name, await runtimeCodehash(address)]),
    ),
  );

  await writeDeploymentRecord({
    schemaVersion: 1,
    network: "cotiTestnet",
    chainId: network.chainId.toString(),
    sourceCommit: deployedSourceCommit,
    compiler: {
      solc: "0.8.28",
      evmVersion: "paris",
      confidentialViaIR: true,
      publicViaIR: false,
      metadataBytecodeHash: "none",
    },
    contracts: {
      feeVault: {
        address: feeVaultDeployment.address,
        beneficiary: feeBeneficiary,
        runtimeCodehash: runtimeCodehashes.feeVault,
        deploymentTx: feeVaultDeployment.deploymentTx,
        gasUsed: feeVaultDeployment.gasUsed,
      },
      confidentialFactory: {
        address: factoryDeployment.address,
        reviewedPrivateTokens,
        approvedPrivateTokenCodehashes: privateTokenCodehashes,
        runtimeCodehash: runtimeCodehashes.confidentialFactory,
        deploymentTx: factoryDeployment.deploymentTx,
        gasUsed: factoryDeployment.gasUsed,
      },
      confidentialLpTokenFactory: {
        address: confidentialLpTokenFactory,
        runtimeCodehash: runtimeCodehashes.confidentialLpTokenFactory,
        deploymentTx: privateLpTokenFactoryDeployment.deploymentTx,
        gasUsed: privateLpTokenFactoryDeployment.gasUsed,
      },
      launchpadMigrator: {
        address: launchpadDeployment.address,
        runtimeCodehash: runtimeCodehashes.launchpadMigrator,
        deploymentTx: launchpadDeployment.deploymentTx,
        gasUsed: launchpadDeployment.gasUsed,
      },
      bootstrapAdapterBinding: {
        address: launchpadDeployment.address,
        transaction: adapterTx.hash,
        gasUsed: adapterReceipt?.gasUsed?.toString() ?? null,
      },
      publicFactory: {
        address: publicFactoryDeployment.address,
        runtimeCodehash: runtimeCodehashes.publicFactory,
        deploymentTx: publicFactoryDeployment.deploymentTx,
        gasUsed: publicFactoryDeployment.gasUsed,
      },
      publicQuoter: {
        address: publicQuoterDeployment.address,
        runtimeCodehash: runtimeCodehashes.publicQuoter,
        deploymentTx: publicQuoterDeployment.deploymentTx,
        gasUsed: publicQuoterDeployment.gasUsed,
      },
      publicRouter: {
        address: publicRouterDeployment.address,
        runtimeCodehash: runtimeCodehashes.publicRouter,
        deploymentTx: publicRouterDeployment.deploymentTx,
        gasUsed: publicRouterDeployment.gasUsed,
      },
    },
    feePolicy: {
      approvedTotalFeeBps: [5, 30, 100],
      protocolFeeShare: { numerator: 1, denominator: 6 },
      confidentialCollection: {
        minimumPoolSwaps: 8,
        minimumPoolDelaySeconds: 3600,
        minimumVaultSweepDelaySeconds: 86400,
      },
    },
    limitations: [
      "testnet-only",
      "not externally audited",
      "no mainnet deployment",
      "public and confidential modes are separate canonical registries",
      "no PoD synchronous pool adapter",
    ],
  });
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "deployment failed");
  process.exitCode = 1;
});
