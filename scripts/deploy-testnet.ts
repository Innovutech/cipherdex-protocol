import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BaseContract, ContractFactory, ContractTransactionResponse } from "ethers";
import { artifacts, ethers } from "../hardhat/runtime.js";
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
import {
  trustedGitArguments,
  trustedGitEnvironment,
  trustedGitExecutable,
} from "./trusted-git";
import {
  FundedWallet,
  openFundedRecoveryJournal,
  withFundedTransactionEvidence,
} from "./funded-transaction-wallet";
import type { FundedRecoveryJournal } from "./funded-recovery-journal";

const execFileAsync = promisify(execFile);

const TESTNET_DEPLOY_GAS_LIMITS = {
  feeVault: 2_500_000n,
  privateLpTokenFactory: 8_000_000n,
  confidentialPoolDeployer: 5_000_000n,
  confidentialStrategyRegistry: 3_000_000n,
  confidentialFactory: 8_000_000n,
  confidentialLaunchStrategy: 5_000_000n,
  confidentialBestExecutionRouter: 3_000_000n,
  publicFactory: 4_500_000n,
  publicQuoter: 400_000n,
  publicRouter: 1_250_000n,
  vaultBinding: 250_000n,
  routerBinding: 250_000n,
  stackBinding: 500_000n,
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
  setBestExecutionRouter(
    address: string,
    overrides?: { gasLimit: bigint },
  ): Promise<ContractTransactionResponse>;
  lpTokenFactory(): Promise<string>;
  feeVault(): Promise<string>;
  bestExecutionRouter(): Promise<string>;
  poolDeployer(): Promise<string>;
  initializationStrategyRegistry(): Promise<string>;
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

type PoolDeployerHandle = FactoryBoundHandle & {
  bindFactory(
    address: string,
    overrides?: { gasLimit: bigint },
  ): Promise<ContractTransactionResponse>;
};

type StrategyRegistryHandle = FactoryBoundHandle & {
  bindFactory(
    address: string,
    overrides?: { gasLimit: bigint },
  ): Promise<ContractTransactionResponse>;
  registerInitializationStrategy(
    address: string,
    overrides?: { gasLimit: bigint },
  ): Promise<ContractTransactionResponse>;
  finalize(overrides?: { gasLimit: bigint }): Promise<ContractTransactionResponse>;
  finalized(): Promise<boolean>;
  isRegisteredStrategy(address: string): Promise<boolean>;
};

type LaunchStrategyHandle = FactoryBoundHandle & {
  strategyRegistry(): Promise<string>;
  launchAuthority(): Promise<string>;
  migrator(): Promise<string>;
};

type LaunchpadMigratorHandle = VersionedFactoryBoundHandle & {
  initializationStrategy(): Promise<string>;
};

type PublicFactoryHandle = BaseContract & {
  feeVault(): Promise<string>;
};

async function deployAndReport<T extends BaseContract>(
  label: string,
  factory: ContractFactory,
  recoveryJournal: FundedRecoveryJournal,
  onMined: (evidence: MinedDeploymentEvidence) => Promise<void>,
  ...args: unknown[]
): Promise<DeploymentResult<T>> {
  let contract: T | undefined;
  const evidence = await submitDeploymentTransaction(
    `${label} deployment`,
    recoveryJournal,
    async () => {
      contract = await factory.deploy(...args) as T;
      const transaction = contract.deploymentTransaction();
      if (!transaction) throw new Error(`${label} deployment transaction unavailable`);
      return transaction;
    },
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

async function submitDeploymentTransaction(
  label: string,
  recoveryJournal: FundedRecoveryJournal,
  operation: () => Promise<ContractTransactionResponse>,
) {
  try {
    const evidence = await withFundedTransactionEvidence(
      label,
      recoveryJournal,
      () => requireMinedSuccess(
        label,
        operation,
        (hash) => ethers.provider.getTransactionReceipt(hash),
      ),
    );
    recoveryJournal.recordTransaction(
      evidence.transactionHash,
      "mined-success",
      evidence.receipt.blockNumber,
    );
    return evidence;
  } catch (error) {
    const hash = transactionHashFromError(error);
    if (hash) {
      if (!recoveryJournal.transactions.some((transaction) =>
        transaction.hash.toLowerCase() === hash.toLowerCase()
      )) {
        throw new Error("deployment transaction was not locally signed and journaled", {
          cause: error,
        });
      }
      recoveryJournal.recordTransaction(
        hash,
        error instanceof MinedTransactionStatusError ? "mined-failure" : "outcome-unknown",
      );
    }
    throw error;
  }
}

async function requireCleanSourceCommit(): Promise<string> {
  const git = trustedGitExecutable();
  const gitOptions = { env: trustedGitEnvironment() } as const;
  const [head, status] = await Promise.all([
    execFileAsync(git, trustedGitArguments(["rev-parse", "--verify", "HEAD"]), gitOptions),
    execFileAsync(
      git,
      trustedGitArguments(["status", "--porcelain=v1", "--untracked-files=all"]),
      gitOptions,
    ),
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
  const privateKey = process.env.COTI_TESTNET_PRIVATE_KEY?.trim();
  if (!privateKey) throw new Error("COTI_TESTNET_PRIVATE_KEY is required");
  const deployer = new FundedWallet(privateKey, ethers.provider);
  const deployerAddress = await deployer.getAddress();
  const recoveryJournal = openFundedRecoveryJournal(privateKey, {
    runner: "deployment",
    sourceCommit: deployedSourceCommit,
    chainId: Number(network.chainId),
    owner: deployerAddress,
    deployment: {
      recordPath: `deployments/coti-testnet-${deployedSourceCommit.toLowerCase()}.json`,
      recordSha256: "0".repeat(64),
      manifestCommit: deployedSourceCommit.toLowerCase(),
      sourceCommit: deployedSourceCommit.toLowerCase(),
    },
  });
  const unresolved = await recoveryJournal.reconcileTransactions(ethers.provider);
  if (unresolved.length > 0) {
    throw new Error(
      `deployment has unresolved transaction ${unresolved[0]}; ` +
        "reconcile or identically rebroadcast it before deploying again",
    );
  }

  stage = "configuration validation";
  const feeBeneficiary = process.env.CIPHERDEX_FEE_BENEFICIARY?.trim();
  if (!feeBeneficiary || !ethers.isAddress(feeBeneficiary)) {
    throw new Error("CIPHERDEX_FEE_BENEFICIARY must be a valid dedicated fee address");
  }
  const launchAuthority = process.env.CIPHERDEX_LAUNCH_AUTHORITY?.trim();
  if (!launchAuthority || !ethers.isAddress(launchAuthority)) {
    throw new Error("CIPHERDEX_LAUNCH_AUTHORITY must be a valid dedicated authority address");
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
  const feeVaultFactory = await ethers.getContractFactory("CipherDEXFeeVault", deployer);
  const feeVaultDeployment = await deployAndReport<FeeVaultHandle>(
    "CipherDEXFeeVault",
    feeVaultFactory,
    recoveryJournal,
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
    await ethers.getContractFactory("PrivateLPTokenFactory", deployer),
    recoveryJournal,
    recordTransaction,
    { gasLimit: TESTNET_DEPLOY_GAS_LIMITS.privateLpTokenFactory },
  );
  await recordDeployment("confidentialLpTokenFactory", privateLpTokenFactoryDeployment, {
    constructorArgs: [],
  });

  const launchStrategyArtifact = await artifacts.readArtifact(
    "ConfidentialLaunchInitializationStrategy",
  );
  const reviewedLaunchStrategyCodehash = ethers.keccak256(
    launchStrategyArtifact.deployedBytecode,
  );
  stage = "ConfidentialInitializationStrategyRegistry deployment";
  const strategyRegistryDeployment = await deployAndReport<StrategyRegistryHandle>(
    "ConfidentialInitializationStrategyRegistry",
    await ethers.getContractFactory("ConfidentialInitializationStrategyRegistry", deployer),
    recoveryJournal,
    recordTransaction,
    [reviewedLaunchStrategyCodehash],
    { gasLimit: TESTNET_DEPLOY_GAS_LIMITS.confidentialStrategyRegistry },
  );
  await recordDeployment(
    "confidentialInitializationStrategyRegistry",
    strategyRegistryDeployment,
    {
      reviewedStrategyCodehashes: [reviewedLaunchStrategyCodehash],
      constructorArgs: [[reviewedLaunchStrategyCodehash]],
    },
  );

  stage = "ConfidentialCPMMDeployer deployment";
  const poolDeployerDeployment = await deployAndReport<PoolDeployerHandle>(
    "ConfidentialCPMMDeployer",
    await ethers.getContractFactory("ConfidentialCPMMDeployer", deployer),
    recoveryJournal,
    recordTransaction,
    { gasLimit: TESTNET_DEPLOY_GAS_LIMITS.confidentialPoolDeployer },
  );
  await recordDeployment("confidentialPoolDeployer", poolDeployerDeployment, {
    constructorArgs: [],
  });

  stage = "ConfidentialCPMMFactory deployment";
  const factoryFactory = await ethers.getContractFactory("ConfidentialCPMMFactory", deployer);
  const factoryDeployment = await deployAndReport<ConfidentialFactoryHandle>(
    "ConfidentialCPMMFactory",
    factoryFactory,
    recoveryJournal,
    recordTransaction,
    feeVaultDeployment.address,
    privateLpTokenFactoryDeployment.address,
    poolDeployerDeployment.address,
    poolDeployerDeployment.artifact.runtimeCodehash,
    privateTokenCodehashes,
    strategyRegistryDeployment.address,
    strategyRegistryDeployment.artifact.runtimeCodehash,
    { gasLimit: TESTNET_DEPLOY_GAS_LIMITS.confidentialFactory },
  );
  await recordDeployment("confidentialFactory", factoryDeployment, {
    reviewedPrivateTokens,
    approvedPrivateTokenCodehashes: privateTokenCodehashes,
    constructorArgs: [
      feeVaultDeployment.address,
      privateLpTokenFactoryDeployment.address,
      poolDeployerDeployment.address,
      poolDeployerDeployment.artifact.runtimeCodehash,
      privateTokenCodehashes,
      strategyRegistryDeployment.address,
      strategyRegistryDeployment.artifact.runtimeCodehash,
    ],
  });
  const factory = factoryDeployment.contract;

  stage = "confidential fee-vault factory binding";
  const vaultBindingEvidence = await submitDeploymentTransaction(
    "confidential fee-vault factory binding",
    recoveryJournal,
    () => feeVaultDeployment.contract.setConfidentialFactory(
      factoryDeployment.address,
      { gasLimit: TESTNET_DEPLOY_GAS_LIMITS.vaultBinding },
    ),
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

  stage = "confidential pool-deployer factory binding";
  const poolDeployerBindingEvidence = await submitDeploymentTransaction(
    stage,
    recoveryJournal,
    () => poolDeployerDeployment.contract.bindFactory(
      factoryDeployment.address,
      { gasLimit: TESTNET_DEPLOY_GAS_LIMITS.stackBinding },
    ),
  );
  await recordTransaction({
    label: stage,
    transactionHash: poolDeployerBindingEvidence.transactionHash,
    gasUsed: poolDeployerBindingEvidence.receipt.gasUsed.toString(),
  });
  journalContracts.confidentialPoolDeployerBinding = {
    address: factoryDeployment.address,
    target: poolDeployerDeployment.address,
    function: "bindFactory",
    args: [factoryDeployment.address],
    transaction: poolDeployerBindingEvidence.transactionHash,
    gasUsed: poolDeployerBindingEvidence.receipt.gasUsed.toString(),
  };
  await writeJournal("in-progress");

  stage = "confidential strategy-registry factory binding";
  const strategyRegistryBindingEvidence = await submitDeploymentTransaction(
    stage,
    recoveryJournal,
    () => strategyRegistryDeployment.contract.bindFactory(
      factoryDeployment.address,
      { gasLimit: TESTNET_DEPLOY_GAS_LIMITS.stackBinding },
    ),
  );
  await recordTransaction({
    label: stage,
    transactionHash: strategyRegistryBindingEvidence.transactionHash,
    gasUsed: strategyRegistryBindingEvidence.receipt.gasUsed.toString(),
  });
  journalContracts.confidentialStrategyRegistryBinding = {
    address: factoryDeployment.address,
    target: strategyRegistryDeployment.address,
    function: "bindFactory",
    args: [factoryDeployment.address],
    transaction: strategyRegistryBindingEvidence.transactionHash,
    gasUsed: strategyRegistryBindingEvidence.receipt.gasUsed.toString(),
  };
  await writeJournal("in-progress");

  stage = "ConfidentialLaunchInitializationStrategy deployment";
  const launchStrategyDeployment = await deployAndReport<LaunchStrategyHandle>(
    "ConfidentialLaunchInitializationStrategy",
    await ethers.getContractFactory("ConfidentialLaunchInitializationStrategy", deployer),
    recoveryJournal,
    recordTransaction,
    factoryDeployment.address,
    strategyRegistryDeployment.address,
    launchAuthority,
    { gasLimit: TESTNET_DEPLOY_GAS_LIMITS.confidentialLaunchStrategy },
  );
  await recordDeployment(
    "confidentialLaunchInitializationStrategy",
    launchStrategyDeployment,
    {
      launchAuthority,
      constructorArgs: [
        factoryDeployment.address,
        strategyRegistryDeployment.address,
        launchAuthority,
      ],
    },
  );

  stage = "ConfidentialLaunchpadMigrator constructor-child verification";
  const launchpadAddress = ethers.getAddress(
    await launchStrategyDeployment.contract.migrator(),
  );
  const launchpadArtifact = await verifyDeployedRuntimeArtifactWithProvenance(
    "ConfidentialLaunchpadMigrator",
    launchpadAddress,
    ethers.provider,
  );
  const launchpadDeployment: DeploymentResult<LaunchpadMigratorHandle> = {
    contract: await ethers.getContractAt(
      "ConfidentialLaunchpadMigrator",
      launchpadAddress,
      deployer,
    ) as LaunchpadMigratorHandle,
    address: launchpadAddress,
    deploymentTx: launchStrategyDeployment.deploymentTx,
    gasUsed: launchStrategyDeployment.gasUsed,
    artifact: launchpadArtifact,
  };
  await recordDeployment("launchpadMigrator", launchpadDeployment, {
    creationKind: "strategy-constructor-child",
    creationParent: launchStrategyDeployment.address,
    constructorArgs: [factoryDeployment.address, launchStrategyDeployment.address],
  });

  stage = "confidential initialization-strategy registration";
  const strategyRegistrationEvidence = await submitDeploymentTransaction(
    stage,
    recoveryJournal,
    () => strategyRegistryDeployment.contract.registerInitializationStrategy(
      launchStrategyDeployment.address,
      { gasLimit: TESTNET_DEPLOY_GAS_LIMITS.stackBinding },
    ),
  );
  await recordTransaction({
    label: stage,
    transactionHash: strategyRegistrationEvidence.transactionHash,
    gasUsed: strategyRegistrationEvidence.receipt.gasUsed.toString(),
  });
  journalContracts.confidentialStrategyRegistration = {
    address: launchStrategyDeployment.address,
    target: strategyRegistryDeployment.address,
    function: "registerInitializationStrategy",
    args: [launchStrategyDeployment.address],
    transaction: strategyRegistrationEvidence.transactionHash,
    gasUsed: strategyRegistrationEvidence.receipt.gasUsed.toString(),
  };
  await writeJournal("in-progress");

  stage = "confidential strategy-registry finalization";
  const strategyFinalizationEvidence = await submitDeploymentTransaction(
    stage,
    recoveryJournal,
    () => strategyRegistryDeployment.contract.finalize({
      gasLimit: TESTNET_DEPLOY_GAS_LIMITS.stackBinding,
    }),
  );
  await recordTransaction({
    label: stage,
    transactionHash: strategyFinalizationEvidence.transactionHash,
    gasUsed: strategyFinalizationEvidence.receipt.gasUsed.toString(),
  });
  journalContracts.confidentialStrategyRegistryFinalization = {
    target: strategyRegistryDeployment.address,
    function: "finalize",
    args: [],
    transaction: strategyFinalizationEvidence.transactionHash,
    gasUsed: strategyFinalizationEvidence.receipt.gasUsed.toString(),
  };
  await writeJournal("in-progress");

  stage = "ConfidentialBestExecutionRouter deployment";
  const confidentialRouterDeployment = await deployAndReport<VersionedFactoryBoundHandle>(
    "ConfidentialBestExecutionRouter",
    await ethers.getContractFactory("ConfidentialBestExecutionRouter", deployer),
    recoveryJournal,
    recordTransaction,
    factoryDeployment.address,
    { gasLimit: TESTNET_DEPLOY_GAS_LIMITS.confidentialBestExecutionRouter },
  );
  await recordDeployment("confidentialBestExecutionRouter", confidentialRouterDeployment, {
    protocolVersion: "2",
    factory: factoryDeployment.address,
    constructorArgs: [factoryDeployment.address],
  });
  stage = "confidential best-execution router binding";
  const bestExecutionRouterEvidence = await submitDeploymentTransaction(
    stage,
    recoveryJournal,
    () => factory.setBestExecutionRouter(
      confidentialRouterDeployment.address,
      { gasLimit: TESTNET_DEPLOY_GAS_LIMITS.routerBinding },
    ),
  );
  const bestExecutionRouterReceipt = bestExecutionRouterEvidence.receipt;
  await recordTransaction({
    label: stage,
    transactionHash: bestExecutionRouterEvidence.transactionHash,
    gasUsed: bestExecutionRouterReceipt.gasUsed.toString(),
  });
  journalContracts.bestExecutionRouterBinding = {
    address: confidentialRouterDeployment.address,
    target: factoryDeployment.address,
    function: "setBestExecutionRouter",
    args: [confidentialRouterDeployment.address],
    transaction: bestExecutionRouterEvidence.transactionHash,
    gasUsed: bestExecutionRouterReceipt.gasUsed.toString(),
  };
  await writeJournal("in-progress");

  stage = "PublicCPMMFactory deployment";
  const publicFactoryFactory = await ethers.getContractFactory("PublicCPMMFactory", deployer);
  const publicFactoryDeployment = await deployAndReport<PublicFactoryHandle>(
    "PublicCPMMFactory",
    publicFactoryFactory,
    recoveryJournal,
    recordTransaction,
    feeVaultDeployment.address,
    { gasLimit: TESTNET_DEPLOY_GAS_LIMITS.publicFactory },
  );
  await recordDeployment("publicFactory", publicFactoryDeployment, {
    constructorArgs: [feeVaultDeployment.address],
  });

  stage = "public fee-vault factory binding";
  const publicVaultBindingEvidence = await submitDeploymentTransaction(
    "public fee-vault factory binding",
    recoveryJournal,
    () => feeVaultDeployment.contract.setPublicFactory(
      publicFactoryDeployment.address,
      { gasLimit: TESTNET_DEPLOY_GAS_LIMITS.vaultBinding },
    ),
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
  const publicQuoterFactory = await ethers.getContractFactory("PublicCPMMQuoter", deployer);
  const publicQuoterDeployment = await deployAndReport<FactoryBoundHandle>(
    "PublicCPMMQuoter",
    publicQuoterFactory,
    recoveryJournal,
    recordTransaction,
    publicFactoryDeployment.address,
    { gasLimit: TESTNET_DEPLOY_GAS_LIMITS.publicQuoter },
  );
  await recordDeployment("publicQuoter", publicQuoterDeployment, {
    constructorArgs: [publicFactoryDeployment.address],
  });

  stage = "PublicCPMMRouter deployment";
  const publicRouterFactory = await ethers.getContractFactory("PublicCPMMRouter", deployer);
  const publicRouterDeployment = await deployAndReport<FactoryBoundHandle>(
    "PublicCPMMRouter",
    publicRouterFactory,
    recoveryJournal,
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
    deployedPoolDeployer,
    deployedStrategyRegistry,
    deployedBestExecutionRouter,
    confidentialRouterFactory,
    confidentialRouterVersion,
    migratorFactory,
    migratorStrategy,
    poolDeployerFactory,
    strategyRegistryFactory,
    strategyRegistryFinalized,
    strategyRegistered,
    launchStrategyFactory,
    launchStrategyRegistry,
    deployedLaunchAuthority,
    launchStrategyMigrator,
    publicFeeVault,
    quoterFactory,
    routerFactory,
  ] = await Promise.all([
    feeVaultDeployment.contract.beneficiary(),
    feeVaultDeployment.contract.confidentialFactory(),
    feeVaultDeployment.contract.publicFactory(),
    factory.feeVault(),
    factory.lpTokenFactory(),
    factory.poolDeployer(),
    factory.initializationStrategyRegistry(),
    factory.bestExecutionRouter(),
    confidentialRouterDeployment.contract.factory(),
    confidentialRouterDeployment.contract.PROTOCOL_VERSION(),
    launchpadDeployment.contract.factory(),
    launchpadDeployment.contract.initializationStrategy(),
    poolDeployerDeployment.contract.factory(),
    strategyRegistryDeployment.contract.factory(),
    strategyRegistryDeployment.contract.finalized(),
    strategyRegistryDeployment.contract.isRegisteredStrategy(
      launchStrategyDeployment.address,
    ),
    launchStrategyDeployment.contract.factory(),
    launchStrategyDeployment.contract.strategyRegistry(),
    launchStrategyDeployment.contract.launchAuthority(),
    launchStrategyDeployment.contract.migrator(),
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
    !sameAddress(String(deployedPoolDeployer), poolDeployerDeployment.address) ||
    !sameAddress(String(deployedStrategyRegistry), strategyRegistryDeployment.address) ||
    !sameAddress(String(deployedBestExecutionRouter), confidentialRouterDeployment.address) ||
    !sameAddress(String(confidentialRouterFactory), factoryDeployment.address) ||
    confidentialRouterVersion !== 2n ||
    !sameAddress(String(migratorFactory), factoryDeployment.address) ||
    !sameAddress(String(migratorStrategy), launchStrategyDeployment.address) ||
    !sameAddress(String(poolDeployerFactory), factoryDeployment.address) ||
    !sameAddress(String(strategyRegistryFactory), factoryDeployment.address) ||
    strategyRegistryFinalized !== true ||
    strategyRegistered !== true ||
    !sameAddress(String(launchStrategyFactory), factoryDeployment.address) ||
    !sameAddress(String(launchStrategyRegistry), strategyRegistryDeployment.address) ||
    !sameAddress(String(deployedLaunchAuthority), launchAuthority) ||
    !sameAddress(String(launchStrategyMigrator), launchpadDeployment.address) ||
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
  console.log(`confidentialPoolDeployer=${poolDeployerDeployment.address}`);
  console.log(`confidentialInitializationStrategyRegistry=${strategyRegistryDeployment.address}`);
  console.log(`confidentialLaunchInitializationStrategy=${launchStrategyDeployment.address}`);
  console.log(`cipherdexLaunchAuthority=${launchAuthority}`);
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
      "confidential best execution is single-hop across the bounded v3 fee-and-strategy namespace only",
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
