import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { promisify } from "node:util";
import { BaseContract, ContractFactory, ContractTransactionResponse } from "ethers";
import { ethers } from "hardhat";

const execFileAsync = promisify(execFile);

const TESTNET_DEPLOY_GAS_LIMITS = {
  feeVault: 1_000_000n,
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

async function sourceCommit(): Promise<string> {
  const configured = process.env.COTI_SOURCE_COMMIT?.trim();
  if (configured) return configured;
  try {
    const result = await execFileAsync("git", ["rev-parse", "--verify", "HEAD"]);
    return result.stdout.trim() || "unknown";
  } catch {
    return "unknown";
  }
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
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== 7_082_400n) {
    throw new Error(`deployment is restricted to COTI testnet (got chain ${network.chainId})`);
  }

  const feeBeneficiary = process.env.CIPHERDEX_FEE_BENEFICIARY?.trim();
  if (!feeBeneficiary || !ethers.isAddress(feeBeneficiary)) {
    throw new Error("CIPHERDEX_FEE_BENEFICIARY must be a valid dedicated fee address");
  }

  const feeVaultFactory = await ethers.getContractFactory("CipherDEXFeeVault");
  const feeVaultDeployment = await deployAndReport(
    "CipherDEXFeeVault",
    feeVaultFactory,
    feeBeneficiary,
    { gasLimit: TESTNET_DEPLOY_GAS_LIMITS.feeVault },
  );

  const factoryFactory = await ethers.getContractFactory("ConfidentialCPMMFactory");
  const factoryDeployment = await deployAndReport<ConfidentialFactoryHandle>(
    "ConfidentialCPMMFactory",
    factoryFactory,
    feeVaultDeployment.address,
    { gasLimit: TESTNET_DEPLOY_GAS_LIMITS.confidentialFactory },
  );
  const factory = factoryDeployment.contract;

  const launchpadFactory = await ethers.getContractFactory("ConfidentialLaunchpadMigrator");
  const launchpadDeployment = await deployAndReport(
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
  const publicFactoryDeployment = await deployAndReport(
    "PublicCPMMFactory",
    publicFactoryFactory,
    feeVaultDeployment.address,
    { gasLimit: TESTNET_DEPLOY_GAS_LIMITS.publicFactory },
  );

  const publicQuoterFactory = await ethers.getContractFactory("PublicCPMMQuoter");
  const publicQuoterDeployment = await deployAndReport(
    "PublicCPMMQuoter",
    publicQuoterFactory,
    publicFactoryDeployment.address,
    { gasLimit: TESTNET_DEPLOY_GAS_LIMITS.publicQuoter },
  );

  const publicRouterFactory = await ethers.getContractFactory("PublicCPMMRouter");
  const publicRouterDeployment = await deployAndReport(
    "PublicCPMMRouter",
    publicRouterFactory,
    publicFactoryDeployment.address,
    { gasLimit: TESTNET_DEPLOY_GAS_LIMITS.publicRouter },
  );

  const confidentialLpTokenFactory = await factory.lpTokenFactory();
  console.log(`confidentialLpTokenFactory=${confidentialLpTokenFactory}`);
  console.log(`feeVault=${feeVaultDeployment.address}`);
  console.log(`feeBeneficiary=${feeBeneficiary}`);
  console.log(`confidentialFactory=${factoryDeployment.address}`);
  console.log(`launchpadMigrator=${launchpadDeployment.address}`);
  console.log(`publicFactory=${publicFactoryDeployment.address}`);
  console.log(`chainId=${network.chainId}`);

  await writeDeploymentRecord({
    schemaVersion: 1,
    network: "cotiTestnet",
    chainId: network.chainId.toString(),
    sourceCommit: await sourceCommit(),
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
        deploymentTx: feeVaultDeployment.deploymentTx,
        gasUsed: feeVaultDeployment.gasUsed,
      },
      confidentialFactory: {
        address: factoryDeployment.address,
        deploymentTx: factoryDeployment.deploymentTx,
        gasUsed: factoryDeployment.gasUsed,
      },
      confidentialLpTokenFactory: { address: confidentialLpTokenFactory },
      launchpadMigrator: {
        address: launchpadDeployment.address,
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
        deploymentTx: publicFactoryDeployment.deploymentTx,
        gasUsed: publicFactoryDeployment.gasUsed,
      },
      publicQuoter: {
        address: publicQuoterDeployment.address,
        deploymentTx: publicQuoterDeployment.deploymentTx,
        gasUsed: publicQuoterDeployment.gasUsed,
      },
      publicRouter: {
        address: publicRouterDeployment.address,
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
      "no public/private pool mode",
      "no PoD synchronous pool adapter",
    ],
  });
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "deployment failed");
  process.exitCode = 1;
});
