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
  openFundedRecoveryJournalWithSecret,
  withFundedTransactionEvidence,
} from "./funded-transaction-wallet";
import type { FundedRecoveryJournal } from "./funded-recovery-journal";
import { requiredFundedRecoveryDirectory } from "./funded-runtime-state";
import {
  CastLedgerWallet,
  type ReviewedCastLedgerConfiguration,
} from "./cast-ledger-wallet";

const execFileAsync = promisify(execFile);

export type DeploymentProfileName = "coti-testnet" | "coti-mainnet";

const DEPLOYMENT_PROFILES = Object.freeze({
  "coti-testnet": Object.freeze({
    network: "cotiTestnet",
    chainId: 7_082_400n,
    recordSlug: "coti-testnet",
    production: false,
  }),
  "coti-mainnet": Object.freeze({
    network: "cotiMainnet",
    chainId: 2_632_500n,
    recordSlug: "coti-mainnet",
    production: true,
  }),
});

const TESTNET_DEPLOY_GAS_LIMITS = {
  feeVault: 2_500_000n,
  privateLpTokenFactory: 8_000_000n,
  confidentialPoolDeployer: 5_000_000n,
  confidentialStrategyRegistry: 3_000_000n,
  confidentialFactory: 8_000_000n,
  confidentialLaunchStrategy: 5_000_000n,
  confidentialBestExecutionRouter: 3_000_000n,
  publicFactory: 5_500_000n,
  publicQuoter: 400_000n,
  publicRouter: 1_250_000n,
  publicLiquidityRouter: 2_000_000n,
  wrappedNative: 1_500_000n,
  publicNativeRouter: 3_500_000n,
  vaultBinding: 250_000n,
  routerBinding: 250_000n,
  stackBinding: 500_000n,
} as const;

export const DEPLOYMENT_MAX_GAS_UNITS =
  Object.values(TESTNET_DEPLOY_GAS_LIMITS).reduce((total, gasLimit) => total + gasLimit, 0n) +
  TESTNET_DEPLOY_GAS_LIMITS.vaultBinding +
  3n * TESTNET_DEPLOY_GAS_LIMITS.stackBinding;

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
  migrator(): Promise<string>;
};

type LaunchpadMigratorHandle = VersionedFactoryBoundHandle & {
  initializationStrategy(): Promise<string>;
};

type PublicFactoryHandle = BaseContract & {
  feeVault(): Promise<string>;
  lpTokenFactory(): Promise<string>;
};

type NativeRouterHandle = VersionedFactoryBoundHandle & {
  publicRouter(): Promise<string>;
  publicLiquidityRouter(): Promise<string>;
  wrappedNative(): Promise<string>;
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

export async function requireCleanSourceCommit(): Promise<string> {
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

export function requiredDeploymentRecordPath(): string {
  const outputPath = process.env.COTI_DEPLOYMENT_RECORD?.trim();
  if (!outputPath) throw new Error("COTI_DEPLOYMENT_RECORD is required");
  return outputPath;
}

export async function deployProtocol(profileName: DeploymentProfileName): Promise<void> {
  const profile = DEPLOYMENT_PROFILES[profileName];
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
      network: profile.network,
      chainId: profile.chainId.toString(),
      sourceCommit: deployedSourceCommit,
      createdAt,
      stage,
    },
    process.cwd(),
    profile.recordSlug,
  );

  const writeJournal = async (
    status: "in-progress" | "complete" | "failed" | "outcome-unknown",
    extra: Record<string, unknown> = {},
  ): Promise<void> => {
    await deploymentRecord.write({
      schemaVersion: 2,
      status,
      network: profile.network,
      chainId: profile.chainId.toString(),
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
  if (network.chainId !== profile.chainId) {
    throw new Error(
      `deployment is restricted to ${profile.network} chain ${profile.chainId} ` +
        `(got chain ${network.chainId})`,
    );
  }
  let deployer: FundedWallet | CastLedgerWallet;
  let recoveryJournal: FundedRecoveryJournal;
  if (profile.production) {
    if (process.env.COTI_TESTNET_PRIVATE_KEY?.trim()) {
      throw new Error("mainnet deployment refuses COTI_TESTNET_PRIVATE_KEY");
    }
    const approvedCommit = process.env.CIPHERDEX_MAINNET_APPROVED_COMMIT?.trim().toLowerCase();
    if (approvedCommit !== deployedSourceCommit.toLowerCase()) {
      throw new Error("CIPHERDEX_MAINNET_APPROVED_COMMIT must equal the deployed source commit");
    }
    const rpcUrl = process.env.COTI_MAINNET_RPC_URL?.trim();
    if (!rpcUrl) throw new Error("COTI_MAINNET_RPC_URL is required for mainnet deployment");
    const ledgerAddress = process.env.CIPHERDEX_LEDGER_ADDRESS?.trim();
    const mainnetPrivateKey = process.env.COTI_MAINNET_PRIVATE_KEY?.trim();
    if (Boolean(ledgerAddress) === Boolean(mainnetPrivateKey)) {
      throw new Error(
        "configure exactly one mainnet signer: CIPHERDEX_LEDGER_ADDRESS or COTI_MAINNET_PRIVATE_KEY",
      );
    }
    const recoverySecret = process.env.CIPHERDEX_DEPLOYMENT_RECOVERY_KEY?.trim();
    if (!recoverySecret) {
      throw new Error("CIPHERDEX_DEPLOYMENT_RECOVERY_KEY is required");
    }
    let signerRecord: Record<string, unknown>;
    if (ledgerAddress) {
      if (!ethers.isAddress(ledgerAddress)) {
        throw new Error("CIPHERDEX_LEDGER_ADDRESS must be a valid address");
      }
      const castConfiguration: ReviewedCastLedgerConfiguration = Object.freeze({
        executable: process.env.CIPHERDEX_CAST_PATH?.trim() ?? "",
        executableSha256: process.env.CIPHERDEX_CAST_SHA256?.trim() ?? "",
        ledgerAddress,
        derivationPath:
          process.env.CIPHERDEX_LEDGER_DERIVATION_PATH?.trim() ?? "m/44'/60'/0'/0/0",
        rpcUrl,
      });
      deployer = await CastLedgerWallet.create(castConfiguration, ethers.provider);
      await deployer.verifyDeviceAddress();
      signerRecord = {
        type: "ledger-via-cast",
        address: ethers.getAddress(ledgerAddress),
        derivationPath: castConfiguration.derivationPath,
        castVersion: deployer.castIdentity.version,
        castSha256: deployer.castIdentity.executableSha256,
      };
    } else {
      deployer = new FundedWallet(mainnetPrivateKey!, ethers.provider);
      signerRecord = {
        type: "private-key",
        address: await deployer.getAddress(),
      };
    }
    const mainnetDeployerAddress = await deployer.getAddress();
    recoveryJournal = openFundedRecoveryJournalWithSecret(recoverySecret, {
      runner: "deployment",
      sourceCommit: deployedSourceCommit,
      chainId: Number(network.chainId),
      owner: mainnetDeployerAddress,
      directory: requiredFundedRecoveryDirectory(),
      deployment: {
        recordPath: `deployments/${profile.recordSlug}-${deployedSourceCommit.toLowerCase()}.json`,
        recordSha256: "0".repeat(64),
        manifestCommit: deployedSourceCommit.toLowerCase(),
        sourceCommit: deployedSourceCommit.toLowerCase(),
      },
    });
    journalContracts.deploymentSigner = signerRecord;
  } else {
    const privateKey = process.env.COTI_TESTNET_PRIVATE_KEY?.trim();
    if (!privateKey) throw new Error("COTI_TESTNET_PRIVATE_KEY is required");
    deployer = new FundedWallet(privateKey, ethers.provider);
    const deployerAddress = await deployer.getAddress();
    recoveryJournal = openFundedRecoveryJournal(privateKey, {
      runner: "deployment",
      sourceCommit: deployedSourceCommit,
      chainId: Number(network.chainId),
      owner: deployerAddress,
      directory: requiredFundedRecoveryDirectory(),
      deployment: {
        recordPath: `deployments/${profile.recordSlug}-${deployedSourceCommit.toLowerCase()}.json`,
        recordSha256: "0".repeat(64),
        manifestCommit: deployedSourceCommit.toLowerCase(),
        sourceCommit: deployedSourceCommit.toLowerCase(),
      },
    });
    journalContracts.deploymentSigner = {
      type: "local-testnet-key",
      address: deployerAddress,
    };
  }
  const deployerAddress = await deployer.getAddress();
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
    strategyRegistryDeployment.address,
    strategyRegistryDeployment.artifact.runtimeCodehash,
    { gasLimit: TESTNET_DEPLOY_GAS_LIMITS.confidentialFactory },
  );
  await recordDeployment("confidentialFactory", factoryDeployment, {
    constructorArgs: [
      feeVaultDeployment.address,
      privateLpTokenFactoryDeployment.address,
      poolDeployerDeployment.address,
      poolDeployerDeployment.artifact.runtimeCodehash,
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
    { gasLimit: TESTNET_DEPLOY_GAS_LIMITS.confidentialLaunchStrategy },
  );
  await recordDeployment(
    "confidentialLaunchInitializationStrategy",
    launchStrategyDeployment,
    {
      constructorArgs: [
        factoryDeployment.address,
        strategyRegistryDeployment.address,
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
  const recordedLaunchpadProtocolVersion =
    await launchpadDeployment.contract.PROTOCOL_VERSION();
  await recordDeployment("launchpadMigrator", launchpadDeployment, {
    protocolVersion: recordedLaunchpadProtocolVersion.toString(),
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
  const recordedConfidentialRouterProtocolVersion =
    await confidentialRouterDeployment.contract.PROTOCOL_VERSION();
  await recordDeployment("confidentialBestExecutionRouter", confidentialRouterDeployment, {
    protocolVersion: recordedConfidentialRouterProtocolVersion.toString(),
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
  const publicLpTokenFactory = await publicFactoryDeployment.contract.lpTokenFactory();
  const publicLpTokenFactoryArtifact =
    await verifyDeployedRuntimeArtifactWithProvenance(
      "PublicLPTokenFactory",
      publicLpTokenFactory,
    );
  journalCompiler.PublicLPTokenFactory = publicLpTokenFactoryArtifact;
  await recordDeployment("publicFactory", publicFactoryDeployment, {
    constructorArgs: [feeVaultDeployment.address],
    lpTokenFactory: publicLpTokenFactory,
    lpTokenFactoryRuntimeCodehash:
      publicLpTokenFactoryArtifact.runtimeCodehash,
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

  stage = "PublicCPMMLiquidityRouter deployment";
  const publicLiquidityRouterDeployment = await deployAndReport<VersionedFactoryBoundHandle>(
    "PublicCPMMLiquidityRouter",
    await ethers.getContractFactory("PublicCPMMLiquidityRouter", deployer),
    recoveryJournal,
    recordTransaction,
    publicFactoryDeployment.address,
    { gasLimit: TESTNET_DEPLOY_GAS_LIMITS.publicLiquidityRouter },
  );
  await recordDeployment("publicLiquidityRouter", publicLiquidityRouterDeployment, {
    protocolVersion: "1",
    factory: publicFactoryDeployment.address,
    constructorArgs: [publicFactoryDeployment.address],
  });

  stage = "WrappedNativeToken deployment";
  const wrappedNativeDeployment = await deployAndReport(
    "WrappedNativeToken",
    await ethers.getContractFactory("WrappedNativeToken", deployer),
    recoveryJournal,
    recordTransaction,
    "Wrapped COTI",
    "WCOTI",
    { gasLimit: TESTNET_DEPLOY_GAS_LIMITS.wrappedNative },
  );
  await recordDeployment("wrappedNative", wrappedNativeDeployment, {
    constructorArgs: ["Wrapped COTI", "WCOTI"],
  });

  stage = "PublicCPMMNativeRouter deployment";
  const publicNativeRouterDeployment = await deployAndReport<NativeRouterHandle>(
    "PublicCPMMNativeRouter",
    await ethers.getContractFactory("PublicCPMMNativeRouter", deployer),
    recoveryJournal,
    recordTransaction,
    publicFactoryDeployment.address,
    publicRouterDeployment.address,
    publicLiquidityRouterDeployment.address,
    wrappedNativeDeployment.address,
    { gasLimit: TESTNET_DEPLOY_GAS_LIMITS.publicNativeRouter },
  );
  await recordDeployment("publicNativeRouter", publicNativeRouterDeployment, {
    protocolVersion: "1",
    factory: publicFactoryDeployment.address,
    publicRouter: publicRouterDeployment.address,
    publicLiquidityRouter: publicLiquidityRouterDeployment.address,
    wrappedNative: wrappedNativeDeployment.address,
    constructorArgs: [
      publicFactoryDeployment.address,
      publicRouterDeployment.address,
      publicLiquidityRouterDeployment.address,
      wrappedNativeDeployment.address,
    ],
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
    launchStrategyMigrator,
    publicFeeVault,
    quoterFactory,
    routerFactory,
    liquidityRouterFactory,
    liquidityRouterVersion,
    deployedPublicLpTokenFactory,
    nativeRouterFactory,
    nativeRouterVersion,
    nativeRouterPublicRouter,
    nativeRouterLiquidityRouter,
    nativeRouterWrappedNative,
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
    launchStrategyDeployment.contract.migrator(),
    publicFactoryDeployment.contract.feeVault(),
    publicQuoterDeployment.contract.factory(),
    publicRouterDeployment.contract.factory(),
    publicLiquidityRouterDeployment.contract.factory(),
    publicLiquidityRouterDeployment.contract.PROTOCOL_VERSION(),
    publicFactoryDeployment.contract.lpTokenFactory(),
    publicNativeRouterDeployment.contract.factory(),
    publicNativeRouterDeployment.contract.PROTOCOL_VERSION(),
    publicNativeRouterDeployment.contract.publicRouter(),
    publicNativeRouterDeployment.contract.publicLiquidityRouter(),
    publicNativeRouterDeployment.contract.wrappedNative(),
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
    confidentialRouterVersion !== 1n ||
    !sameAddress(String(migratorFactory), factoryDeployment.address) ||
    !sameAddress(String(migratorStrategy), launchStrategyDeployment.address) ||
    !sameAddress(String(poolDeployerFactory), factoryDeployment.address) ||
    !sameAddress(String(strategyRegistryFactory), factoryDeployment.address) ||
    strategyRegistryFinalized !== true ||
    strategyRegistered !== true ||
    !sameAddress(String(launchStrategyFactory), factoryDeployment.address) ||
    !sameAddress(String(launchStrategyRegistry), strategyRegistryDeployment.address) ||
    !sameAddress(String(launchStrategyMigrator), launchpadDeployment.address) ||
    !sameAddress(String(publicFeeVault), feeVaultDeployment.address) ||
    !sameAddress(String(quoterFactory), publicFactoryDeployment.address) ||
    !sameAddress(String(routerFactory), publicFactoryDeployment.address) ||
    !sameAddress(String(liquidityRouterFactory), publicFactoryDeployment.address) ||
    liquidityRouterVersion !== 1n ||
    !sameAddress(String(deployedPublicLpTokenFactory), publicLpTokenFactory) ||
    !sameAddress(String(nativeRouterFactory), publicFactoryDeployment.address) ||
    nativeRouterVersion !== 1n ||
    !sameAddress(String(nativeRouterPublicRouter), publicRouterDeployment.address) ||
    !sameAddress(
      String(nativeRouterLiquidityRouter),
      publicLiquidityRouterDeployment.address
    ) ||
    !sameAddress(String(nativeRouterWrappedNative), wrappedNativeDeployment.address)
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
  console.log(`confidentialBestExecutionRouter=${confidentialRouterDeployment.address}`);
  console.log(`launchpadMigrator=${launchpadDeployment.address}`);
  console.log(`publicFactory=${publicFactoryDeployment.address}`);
  console.log(`publicLpTokenFactory=${publicLpTokenFactory}`);
  console.log(`publicLiquidityRouter=${publicLiquidityRouterDeployment.address}`);
  console.log(`wrappedNative=${wrappedNativeDeployment.address}`);
  console.log(`publicNativeRouter=${publicNativeRouterDeployment.address}`);
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
      ...(profile.production ? [] : ["testnet-only"]),
      "not externally audited",
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

export async function runDeploymentCommand(profileName: DeploymentProfileName): Promise<void> {
  await deployProtocol(profileName);
}
