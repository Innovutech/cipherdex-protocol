import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BaseContract, ContractFactory, ContractTransactionResponse } from "ethers";
import { ethers } from "hardhat";
import {
  DeploymentRecordWriter,
  type DeploymentJournalTransaction,
  type MinedDeploymentEvidence,
  upsertMinedDeploymentTransaction,
} from "./deployment-record";
import { resolvePrivateTokenCodehashes } from "./private-token-codehashes";
import {
  verifyDeployedRuntimeArtifactWithProvenance,
  type RuntimeArtifactProvenance,
} from "./runtime-artifact";
import {
  MinedTransactionStatusError,
  requireMinedSuccess,
  safeTestnetErrorSummary,
  transactionHashFromError,
  UnknownBroadcastOutcomeError,
} from "./testnet-transaction-evidence";
import { trustedGitExecutable } from "./trusted-git";

const execFileAsync = promisify(execFile);

const TESTNET_DEPLOY_GAS_LIMITS = {
  feeVault: 1_000_000n,
  privateLpTokenFactory: 8_000_000n,
  confidentialFactory: 8_000_000n,
  confidentialBestExecutionRouter: 3_000_000n,
  launchpadMigrator: 2_500_000n,
  publicFactory: 3_000_000n,
  publicQuoter: 400_000n,
  publicRouter: 800_000n,
  vaultBinding: 250_000n,
  adapterBinding: 250_000n,
  routerBinding: 250_000n,
} as const;

type DeploymentResult<T extends BaseContract = BaseContract> = {
  contract: T;
  address: string;
  deploymentTx: string | null;
  gasUsed: string | null;
  artifact: RuntimeArtifactProvenance;
};

class PostMinedDeploymentError extends Error {
  readonly transactionHash: string;

  constructor(label: string, transactionHash: string, cause: unknown) {
    super(`${label} post-mined verification failed; transactionHash=${transactionHash}`, {
      cause,
    });
    this.name = "PostMinedDeploymentError";
    this.transactionHash = transactionHash;
  }
}

type ConfidentialFactoryHandle = BaseContract & {
  setBootstrapAdapter(
    address: string,
    overrides?: { gasLimit: bigint },
  ): Promise<ContractTransactionResponse>;
  setBestExecutionRouter(
    address: string,
    overrides?: { gasLimit: bigint },
  ): Promise<ContractTransactionResponse>;
  lpTokenFactory(): Promise<string>;
  feeVault(): Promise<string>;
  bootstrapAdapter(): Promise<string>;
  bestExecutionRouter(): Promise<string>;
};

type FeeVaultHandle = BaseContract & {
  beneficiary(): Promise<string>;
  confidentialFactory(): Promise<string>;
  publicFactory(): Promise<string>;
  setConfidentialFactory(
    address: string,
    overrides?: { gasLimit: bigint },
  ): Promise<ContractTransactionResponse>;
  setPublicFactory(
    address: string,
    overrides?: { gasLimit: bigint },
  ): Promise<ContractTransactionResponse>;
};

type FactoryBoundHandle = BaseContract & {
  factory(): Promise<string>;
};

type VersionedFactoryBoundHandle = FactoryBoundHandle & {
  PROTOCOL_VERSION(): Promise<bigint>;
};

type PublicFactoryHandle = BaseContract & {
  feeVault(): Promise<string>;
};

async function deployAndReport<T extends BaseContract>(
  label: string,
  factory: ContractFactory,
  onMined: (evidence: MinedDeploymentEvidence) => Promise<void>,
  ...args: unknown[]
): Promise<DeploymentResult<T>> {
  let contract: T | undefined;
  const evidence = await requireMinedSuccess(
    `${label} deployment`,
    async () => {
      contract = await factory.deploy(...args) as T;
      const transaction = contract.deploymentTransaction();
      if (!transaction) throw new Error(`${label} deployment transaction unavailable`);
      return transaction;
    },
    (hash) => ethers.provider.getTransactionReceipt(hash),
  );
  const receipt = evidence.receipt;
  try {
    await onMined({
      label: `${label} deployment`,
      transactionHash: evidence.transactionHash,
      gasUsed: receipt?.gasUsed?.toString() ?? null,
    });
  } catch (error) {
    if (error instanceof PostMinedDeploymentError) throw error;
    throw new PostMinedDeploymentError(label, evidence.transactionHash, error);
  }

  try {
    const receiptAddress = receipt.contractAddress ?? undefined;
    if (receiptAddress && !ethers.isAddress(receiptAddress)) {
      throw new Error(`${label} deployment receipt returned an invalid contract address`);
    }
    if (!contract && receiptAddress) {
      contract = factory.attach(receiptAddress) as T;
    }
    if (!contract) {
      throw new Error(
        `${label} deployment mined without a recoverable contract handle; do not retry automatically`,
      );
    }
    const address = await contract.getAddress();
    if (receiptAddress && address.toLowerCase() !== receiptAddress.toLowerCase()) {
      throw new Error(`${label} recovered contract handle does not match the mined receipt`);
    }
    await onMined({
      label: `${label} deployment`,
      address,
      transactionHash: evidence.transactionHash,
      gasUsed: receipt.gasUsed?.toString() ?? null,
    });
    const artifact = await verifyDeployedRuntimeArtifactWithProvenance(label, address);
    console.log(
      `${label} deployed at ${address} ` +
        `tx=${evidence.transactionHash} ` +
        `gas=${receipt.gasUsed?.toString() ?? "unknown"}`,
    );
    return {
      contract,
      address,
      deploymentTx: evidence.transactionHash,
      gasUsed: receipt.gasUsed?.toString() ?? null,
      artifact,
    };
  } catch (error) {
    if (error instanceof PostMinedDeploymentError) throw error;
    throw new PostMinedDeploymentError(label, evidence.transactionHash, error);
  }
}

async function requireCleanSourceCommit(): Promise<string> {
  const git = trustedGitExecutable();
  const [head, status] = await Promise.all([
    execFileAsync(git, ["rev-parse", "--verify", "HEAD"]),
    execFileAsync(git, ["status", "--porcelain=v1", "--untracked-files=all"]),
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

function requiredDeploymentRecordPath(): string {
  const outputPath = process.env.COTI_DEPLOYMENT_RECORD?.trim();
  if (!outputPath) throw new Error("COTI_DEPLOYMENT_RECORD is required");
  return outputPath;
}

async function main(): Promise<void> {
  const deploymentRecordPath = requiredDeploymentRecordPath();
  const deployedSourceCommit = await requireCleanSourceCommit();
  const createdAt = new Date().toISOString();
  const journalTransactions: DeploymentJournalTransaction[] = [];
  const journalContracts: Record<string, unknown> = {};
  const journalCompiler: Record<string, RuntimeArtifactProvenance> = {};
  let stage = "deployment record reservation";
  const deploymentRecord = await DeploymentRecordWriter.reserve(
    deploymentRecordPath,
    deployedSourceCommit,
    {
      schemaVersion: 2,
      network: "cotiTestnet",
      chainId: "7082400",
      sourceCommit: deployedSourceCommit,
      createdAt,
      stage,
    },
  );

  const writeJournal = async (
    status: "in-progress" | "complete" | "failed" | "outcome-unknown",
    extra: Record<string, unknown> = {},
  ): Promise<void> => {
    await deploymentRecord.write({
      schemaVersion: 2,
      status,
      network: "cotiTestnet",
      chainId: "7082400",
      sourceCommit: deployedSourceCommit,
      createdAt,
      updatedAt: new Date().toISOString(),
      stage,
      compiler: journalCompiler,
      contracts: journalContracts,
      transactions: journalTransactions,
      ...extra,
    });
  };

  const recordTransaction = async (
    evidence: MinedDeploymentEvidence,
  ): Promise<void> => {
    upsertMinedDeploymentTransaction(journalTransactions, evidence);
    try {
      await writeJournal("in-progress");
    } catch (error) {
      throw new PostMinedDeploymentError(
        evidence.label,
        evidence.transactionHash,
        error,
      );
    }
  };

  const recordDeployment = async (
    key: string,
    deployment: DeploymentResult,
    details: Record<string, unknown> = {},
  ): Promise<void> => {
    journalCompiler[deployment.artifact.contractName] = deployment.artifact;
    journalContracts[key] = {
      address: deployment.address,
      runtimeCodehash: deployment.artifact.runtimeCodehash,
      deploymentTx: deployment.deploymentTx,
      gasUsed: deployment.gasUsed,
      ...details,
    };
    await writeJournal("in-progress");
  };

  try {
  stage = "network validation";
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== 7_082_400n) {
    throw new Error(`deployment is restricted to COTI testnet (got chain ${network.chainId})`);
  }

  stage = "configuration validation";
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

  stage = "CipherDEXFeeVault deployment";
  const feeVaultFactory = await ethers.getContractFactory("CipherDEXFeeVault");
  const feeVaultDeployment = await deployAndReport<FeeVaultHandle>(
    "CipherDEXFeeVault",
    feeVaultFactory,
    recordTransaction,
    feeBeneficiary,
    { gasLimit: TESTNET_DEPLOY_GAS_LIMITS.feeVault },
  );
  await recordDeployment("feeVault", feeVaultDeployment, {
    beneficiary: feeBeneficiary,
    constructorArgs: [feeBeneficiary],
  });

  stage = "PrivateLPTokenFactory deployment";
  const privateLpTokenFactoryDeployment = await deployAndReport(
    "PrivateLPTokenFactory",
    await ethers.getContractFactory("PrivateLPTokenFactory"),
    recordTransaction,
    { gasLimit: TESTNET_DEPLOY_GAS_LIMITS.privateLpTokenFactory },
  );
  await recordDeployment("confidentialLpTokenFactory", privateLpTokenFactoryDeployment, {
    constructorArgs: [],
  });

  stage = "ConfidentialCPMMFactory deployment";
  const factoryFactory = await ethers.getContractFactory("ConfidentialCPMMFactory");
  const factoryDeployment = await deployAndReport<ConfidentialFactoryHandle>(
    "ConfidentialCPMMFactory",
    factoryFactory,
    recordTransaction,
    feeVaultDeployment.address,
    privateLpTokenFactoryDeployment.address,
    privateTokenCodehashes,
    { gasLimit: TESTNET_DEPLOY_GAS_LIMITS.confidentialFactory },
  );
  await recordDeployment("confidentialFactory", factoryDeployment, {
    reviewedPrivateTokens,
    approvedPrivateTokenCodehashes: privateTokenCodehashes,
    constructorArgs: [
      feeVaultDeployment.address,
      privateLpTokenFactoryDeployment.address,
      privateTokenCodehashes,
    ],
  });
  const factory = factoryDeployment.contract;

  stage = "confidential fee-vault factory binding";
  const vaultBindingEvidence = await requireMinedSuccess(
    "confidential fee-vault factory binding",
    () => feeVaultDeployment.contract.setConfidentialFactory(
      factoryDeployment.address,
      { gasLimit: TESTNET_DEPLOY_GAS_LIMITS.vaultBinding },
    ),
    (hash) => ethers.provider.getTransactionReceipt(hash),
  );
  const vaultBindingReceipt = vaultBindingEvidence.receipt;
  await recordTransaction({
    label: "confidential fee-vault factory binding",
    transactionHash: vaultBindingEvidence.transactionHash,
    gasUsed: vaultBindingReceipt?.gasUsed?.toString() ?? null,
  });
  journalContracts.confidentialFeeVaultBinding = {
    address: factoryDeployment.address,
    target: feeVaultDeployment.address,
    function: "setConfidentialFactory",
    args: [factoryDeployment.address],
    transaction: vaultBindingEvidence.transactionHash,
    gasUsed: vaultBindingReceipt?.gasUsed?.toString() ?? null,
  };
  await writeJournal("in-progress");

  stage = "ConfidentialBestExecutionRouter deployment";
  const confidentialRouterDeployment = await deployAndReport<VersionedFactoryBoundHandle>(
    "ConfidentialBestExecutionRouter",
    await ethers.getContractFactory("ConfidentialBestExecutionRouter"),
    recordTransaction,
    factoryDeployment.address,
    { gasLimit: TESTNET_DEPLOY_GAS_LIMITS.confidentialBestExecutionRouter },
  );
  await recordDeployment("confidentialBestExecutionRouter", confidentialRouterDeployment, {
    protocolVersion: "1",
    factory: factoryDeployment.address,
    constructorArgs: [factoryDeployment.address],
  });
  stage = "confidential best-execution router binding";
  const bestExecutionRouterEvidence = await requireMinedSuccess(
    "confidential best-execution router binding",
    () => factory.setBestExecutionRouter(
      confidentialRouterDeployment.address,
      { gasLimit: TESTNET_DEPLOY_GAS_LIMITS.routerBinding },
    ),
    (hash) => ethers.provider.getTransactionReceipt(hash),
  );
  const bestExecutionRouterReceipt = bestExecutionRouterEvidence.receipt;
  await recordTransaction({
    label: "confidential best-execution router binding",
    transactionHash: bestExecutionRouterEvidence.transactionHash,
    gasUsed: bestExecutionRouterReceipt?.gasUsed?.toString() ?? null,
  });
  journalContracts.bestExecutionRouterBinding = {
    address: confidentialRouterDeployment.address,
    target: factoryDeployment.address,
    function: "setBestExecutionRouter",
    args: [confidentialRouterDeployment.address],
    transaction: bestExecutionRouterEvidence.transactionHash,
    gasUsed: bestExecutionRouterReceipt?.gasUsed?.toString() ?? null,
  };
  await writeJournal("in-progress");
  console.log(
    `confidential best-execution router configured: ${confidentialRouterDeployment.address} ` +
      `tx=${bestExecutionRouterEvidence.transactionHash} ` +
      `gas=${bestExecutionRouterReceipt?.gasUsed?.toString() ?? "unknown"}`,
  );

  stage = "ConfidentialLaunchpadMigrator deployment";
  const launchpadFactory = await ethers.getContractFactory("ConfidentialLaunchpadMigrator");
  const launchpadDeployment = await deployAndReport<FactoryBoundHandle>(
    "ConfidentialLaunchpadMigrator",
    launchpadFactory,
    recordTransaction,
    factoryDeployment.address,
    { gasLimit: TESTNET_DEPLOY_GAS_LIMITS.launchpadMigrator },
  );
  await recordDeployment("launchpadMigrator", launchpadDeployment, {
    constructorArgs: [factoryDeployment.address],
  });
  stage = "launchpad adapter binding";
  const adapterEvidence = await requireMinedSuccess(
    "launchpad adapter binding",
    () => factory.setBootstrapAdapter(launchpadDeployment.address, {
      gasLimit: TESTNET_DEPLOY_GAS_LIMITS.adapterBinding,
    }),
    (hash) => ethers.provider.getTransactionReceipt(hash),
  );
  const adapterReceipt = adapterEvidence.receipt;
  await recordTransaction({
    label: "launchpad adapter binding",
    transactionHash: adapterEvidence.transactionHash,
    gasUsed: adapterReceipt?.gasUsed?.toString() ?? null,
  });
  journalContracts.bootstrapAdapterBinding = {
    address: launchpadDeployment.address,
    target: factoryDeployment.address,
    function: "setBootstrapAdapter",
    args: [launchpadDeployment.address],
    transaction: adapterEvidence.transactionHash,
    gasUsed: adapterReceipt?.gasUsed?.toString() ?? null,
  };
  await writeJournal("in-progress");
  console.log(
    `launchpad adapter configured: ${launchpadDeployment.address} ` +
      `tx=${adapterEvidence.transactionHash} ` +
      `gas=${adapterReceipt?.gasUsed?.toString() ?? "unknown"}`,
  );

  stage = "PublicCPMMFactory deployment";
  const publicFactoryFactory = await ethers.getContractFactory("PublicCPMMFactory");
  const publicFactoryDeployment = await deployAndReport<PublicFactoryHandle>(
    "PublicCPMMFactory",
    publicFactoryFactory,
    recordTransaction,
    feeVaultDeployment.address,
    { gasLimit: TESTNET_DEPLOY_GAS_LIMITS.publicFactory },
  );
  await recordDeployment("publicFactory", publicFactoryDeployment, {
    constructorArgs: [feeVaultDeployment.address],
  });

  stage = "public fee-vault factory binding";
  const publicVaultBindingEvidence = await requireMinedSuccess(
    "public fee-vault factory binding",
    () => feeVaultDeployment.contract.setPublicFactory(
      publicFactoryDeployment.address,
      { gasLimit: TESTNET_DEPLOY_GAS_LIMITS.vaultBinding },
    ),
    (hash) => ethers.provider.getTransactionReceipt(hash),
  );
  const publicVaultBindingReceipt = publicVaultBindingEvidence.receipt;
  await recordTransaction({
    label: "public fee-vault factory binding",
    transactionHash: publicVaultBindingEvidence.transactionHash,
    gasUsed: publicVaultBindingReceipt?.gasUsed?.toString() ?? null,
  });
  journalContracts.publicFeeVaultBinding = {
    address: publicFactoryDeployment.address,
    target: feeVaultDeployment.address,
    function: "setPublicFactory",
    args: [publicFactoryDeployment.address],
    transaction: publicVaultBindingEvidence.transactionHash,
    gasUsed: publicVaultBindingReceipt?.gasUsed?.toString() ?? null,
  };
  await writeJournal("in-progress");

  stage = "PublicCPMMQuoter deployment";
  const publicQuoterFactory = await ethers.getContractFactory("PublicCPMMQuoter");
  const publicQuoterDeployment = await deployAndReport<FactoryBoundHandle>(
    "PublicCPMMQuoter",
    publicQuoterFactory,
    recordTransaction,
    publicFactoryDeployment.address,
    { gasLimit: TESTNET_DEPLOY_GAS_LIMITS.publicQuoter },
  );
  await recordDeployment("publicQuoter", publicQuoterDeployment, {
    constructorArgs: [publicFactoryDeployment.address],
  });

  stage = "PublicCPMMRouter deployment";
  const publicRouterFactory = await ethers.getContractFactory("PublicCPMMRouter");
  const publicRouterDeployment = await deployAndReport<FactoryBoundHandle>(
    "PublicCPMMRouter",
    publicRouterFactory,
    recordTransaction,
    publicFactoryDeployment.address,
    { gasLimit: TESTNET_DEPLOY_GAS_LIMITS.publicRouter },
  );
  await recordDeployment("publicRouter", publicRouterDeployment, {
    constructorArgs: [publicFactoryDeployment.address],
  });

  stage = "post-deployment immutable binding verification";
  const sameAddress = (actual: string, expected: string): boolean =>
    actual.toLowerCase() === expected.toLowerCase();
  const [
    deployedBeneficiary,
    deployedConfidentialFactory,
    deployedPublicFactory,
    confidentialFeeVault,
    deployedLpTokenFactory,
    deployedBootstrapAdapter,
    deployedBestExecutionRouter,
    confidentialRouterFactory,
    confidentialRouterVersion,
    migratorFactory,
    publicFeeVault,
    quoterFactory,
    routerFactory,
  ] = await Promise.all([
    feeVaultDeployment.contract.beneficiary(),
    feeVaultDeployment.contract.confidentialFactory(),
    feeVaultDeployment.contract.publicFactory(),
    factory.feeVault(),
    factory.lpTokenFactory(),
    factory.bootstrapAdapter(),
    factory.bestExecutionRouter(),
    confidentialRouterDeployment.contract.factory(),
    confidentialRouterDeployment.contract.PROTOCOL_VERSION(),
    launchpadDeployment.contract.factory(),
    publicFactoryDeployment.contract.feeVault(),
    publicQuoterDeployment.contract.factory(),
    publicRouterDeployment.contract.factory(),
  ]);
  if (
    !sameAddress(String(deployedBeneficiary), feeBeneficiary) ||
    !sameAddress(String(deployedConfidentialFactory), factoryDeployment.address) ||
    !sameAddress(String(deployedPublicFactory), publicFactoryDeployment.address) ||
    !sameAddress(String(confidentialFeeVault), feeVaultDeployment.address) ||
    !sameAddress(String(deployedLpTokenFactory), privateLpTokenFactoryDeployment.address) ||
    !sameAddress(String(deployedBootstrapAdapter), launchpadDeployment.address) ||
    !sameAddress(String(deployedBestExecutionRouter), confidentialRouterDeployment.address) ||
    !sameAddress(String(confidentialRouterFactory), factoryDeployment.address) ||
    confidentialRouterVersion !== 1n ||
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
  console.log(`confidentialBestExecutionRouter=${confidentialRouterDeployment.address}`);
  console.log(`launchpadMigrator=${launchpadDeployment.address}`);
  console.log(`publicFactory=${publicFactoryDeployment.address}`);
  console.log(`chainId=${network.chainId}`);

  stage = "deployment completion journal";
  journalContracts.confidentialBestExecutionRouter = {
    ...(journalContracts.confidentialBestExecutionRouter as Record<string, unknown>),
    protocolVersion: confidentialRouterVersion.toString(),
  };
  await writeJournal("complete", {
    feePolicy: {
      approvedTotalFeeBps: [5, 30, 100],
      protocolFeeShare: { numerator: 1, denominator: 6 },
      confidentialCollection: {
        minimumPoolSwaps: 8,
        minimumPoolDelaySeconds: 3600,
        minimumVaultSweepDelaySeconds: 86400,
        vaultEpochSeconds: 86400,
        minimumVaultAggregatedSwaps: 8,
        vaultResidenceEpochs: 2,
      },
    },
    limitations: [
      "testnet-only",
      "not externally audited",
      "no mainnet deployment",
      "public and confidential modes are separate canonical registries",
      "confidential exact best quotes require paid MPC transactions on the tested runtime",
      "confidential best execution is single-hop across canonical v1 fee tiers only",
      "no PoD synchronous pool adapter",
    ],
  });
  console.log(`deployment record: ${deploymentRecord.outputPath}`);
  } catch (error) {
    const transactionHash = transactionHashFromError(error);
    const outcome: DeploymentJournalTransaction["outcome"] =
      error instanceof UnknownBroadcastOutcomeError
        ? "outcome-unknown"
        : error instanceof MinedTransactionStatusError
          ? "mined-failure"
          : transactionHash
            ? "post-mined-error"
            : "local-failure";
    if (
      transactionHash &&
      !journalTransactions.some(
        (entry) => entry.transactionHash.toLowerCase() === transactionHash.toLowerCase(),
      )
    ) {
      journalTransactions.push(Object.freeze({
        label: stage,
        transactionHash,
        outcome,
        gasUsed: null,
      }));
    }
    try {
      await writeJournal(
        outcome === "outcome-unknown" ? "outcome-unknown" : "failed",
        {
          failure: {
            classification: outcome,
            transactionHash: transactionHash ?? null,
          },
        },
      );
    } catch (journalError) {
      throw new AggregateError(
        [error, journalError],
        "deployment failed and its terminal evidence journal could not be persisted",
      );
    }
    throw error;
  } finally {
    await deploymentRecord.close();
  }
}

void main().catch((error: unknown) => {
  console.error(`COTI testnet deployment failed: ${safeTestnetErrorSummary(error)}`);
  process.exitCode = 1;
});
