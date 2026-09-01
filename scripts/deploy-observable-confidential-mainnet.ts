import { ContractFactory } from "ethers";
import { artifacts, ethers } from "../hardhat/runtime.js";

import {
  DeploymentRecordWriter,
  type DeploymentJournalTransaction,
  upsertMinedDeploymentTransaction,
} from "./deployment-record";
import {
  deployAndReport,
  requireCleanSourceCommit,
  requiredDeploymentRecordPath,
  submitDeploymentTransaction,
} from "./deploy-protocol";
import {
  FundedWallet,
  openFundedRecoveryJournal,
  openFundedRecoveryJournalWithSecret,
} from "./funded-transaction-wallet";
import type { FundedRecoveryJournal } from "./funded-recovery-journal";
import { requiredFundedRecoveryDirectory } from "./funded-runtime-state";
import {
  CastLedgerWallet,
  type ReviewedCastLedgerConfiguration,
} from "./cast-ledger-wallet";
import { safeTestnetErrorSummary } from "./testnet-transaction-evidence";
import { verifyDeployedRuntimeArtifactWithProvenance } from "./runtime-artifact";

const CHAIN_ID = 2_632_500n;
const RECORD_SLUG = "coti-mainnet-observable-confidential";
const GAS_LIMIT = 30_000_000n;
const OBSERVABLE_ROUTER_RUNTIME_CODEHASH =
  "0xedc7d19bbe720d6e1265e935ee9a30f3dc68b07f94821ea12b715fba43b9e46e";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredAddress(name: string): string {
  const value = required(name);
  if (!ethers.isAddress(value) || value === ethers.ZeroAddress) {
    throw new Error(`${name} must be a nonzero address`);
  }
  return ethers.getAddress(value);
}

async function main(): Promise<void> {
  const sourceCommit = (await requireCleanSourceCommit()).toLowerCase();
  if (required("CIPHERDEX_MAINNET_APPROVED_COMMIT").toLowerCase() !== sourceCommit) {
    throw new Error("CIPHERDEX_MAINNET_APPROVED_COMMIT must equal the source commit");
  }
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== CHAIN_ID) {
    throw new Error(`observable deployment requires COTI mainnet ${CHAIN_ID}`);
  }

  const feeBeneficiary = requiredAddress("CIPHERDEX_FEE_BENEFICIARY");
  const lpTokenFactoryAddress = requiredAddress(
    "CIPHERDEX_EXISTING_PRIVATE_LP_FACTORY",
  );
  const ledgerAddress = process.env.CIPHERDEX_LEDGER_ADDRESS?.trim();
  const privateKey = process.env.COTI_MAINNET_PRIVATE_KEY?.trim();
  if (Boolean(ledgerAddress) === Boolean(privateKey)) {
    throw new Error("configure exactly one mainnet signer: Ledger or private key");
  }
  const recoverySecret = required("CIPHERDEX_DEPLOYMENT_RECOVERY_KEY");

  let signer: FundedWallet | CastLedgerWallet;
  let signerRecord: Record<string, unknown>;
  if (ledgerAddress) {
    const castConfiguration: ReviewedCastLedgerConfiguration = Object.freeze({
      executable: required("CIPHERDEX_CAST_PATH"),
      executableSha256: required("CIPHERDEX_CAST_SHA256"),
      ledgerAddress: requiredAddress("CIPHERDEX_LEDGER_ADDRESS"),
      derivationPath:
        process.env.CIPHERDEX_LEDGER_DERIVATION_PATH?.trim() ??
        "m/44'/60'/0'/0/0",
      rpcUrl: required("COTI_MAINNET_RPC_URL"),
    });
    signer = await CastLedgerWallet.create(castConfiguration, ethers.provider);
    await signer.verifyDeviceAddress();
    signerRecord = {
      type: "ledger-via-cast",
      address: await signer.getAddress(),
      derivationPath: castConfiguration.derivationPath,
      castVersion: signer.castIdentity.version,
      castSha256: signer.castIdentity.executableSha256,
    };
  } else {
    if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
      throw new Error("COTI_MAINNET_PRIVATE_KEY must be a 32-byte private key");
    }
    signer = new FundedWallet(privateKey, ethers.provider);
    signerRecord = { type: "private-key", address: await signer.getAddress() };
  }
  const signerAddress = ethers.getAddress(await signer.getAddress());

  const recordPath = requiredDeploymentRecordPath();
  const deploymentBinding = {
    recordPath: `deployments/${RECORD_SLUG}-${sourceCommit}.json`,
    recordSha256: "0".repeat(64),
    manifestCommit: sourceCommit,
    sourceCommit,
  } as const;
  const journal = privateKey
    ? openFundedRecoveryJournal(privateKey, {
      runner: "observable-confidential-deployment",
      sourceCommit,
      chainId: Number(CHAIN_ID),
      owner: signerAddress,
      directory: requiredFundedRecoveryDirectory(),
      deployment: deploymentBinding,
    })
    : openFundedRecoveryJournalWithSecret(recoverySecret, {
      runner: "observable-confidential-deployment",
      sourceCommit,
      chainId: Number(CHAIN_ID),
      owner: signerAddress,
      directory: requiredFundedRecoveryDirectory(),
      deployment: deploymentBinding,
    });
  const unresolved = await journal.reconcileTransactions(ethers.provider);
  if (unresolved.length > 0) {
    throw new Error("observable deployment has an unresolved transaction; do not retry");
  }
  if (journal.transactions.length > 0) {
    throw new Error("observable deployment journal is not fresh; recover before retrying");
  }
  const writer = await DeploymentRecordWriter.reserve(
    recordPath,
    sourceCommit,
    {
      schemaVersion: 2,
      network: "cotiMainnet",
      chainId: CHAIN_ID.toString(),
      sourceCommit,
      deploymentKind: "observable-confidential",
    },
    process.cwd(),
    RECORD_SLUG,
  );

  const transactions: DeploymentJournalTransaction[] = [];
  const contracts: Record<string, unknown> = {
    deploymentSigner: signerRecord,
    reusedPrivateLPTokenFactory: { address: lpTokenFactoryAddress },
  };
  const compiler: Record<string, unknown> = {};
  const writeProgress = async (status = "in-progress") => writer.write({
    schemaVersion: 2,
    status,
    network: "cotiMainnet",
    chainId: CHAIN_ID.toString(),
    sourceCommit,
    deploymentKind: "observable-confidential",
    feeBeneficiary,
    contracts,
    compiler,
    transactions,
    limitations: [
      "Price observations publish on 50-bps bucket crossings and are non-authoritative.",
      "Exact swaps still require paid encrypted quotes and encrypted minimum output.",
      "No external audit is claimed.",
    ],
  });
  const onMined = async (evidence: Parameters<typeof upsertMinedDeploymentTransaction>[1]) => {
    upsertMinedDeploymentTransaction(transactions, evidence);
    await writeProgress();
  };

  try {
    const lpFactoryArtifact = await verifyDeployedRuntimeArtifactWithProvenance(
      "PrivateLPTokenFactory",
      lpTokenFactoryAddress,
      ethers.provider,
    );
    contracts.reusedPrivateLPTokenFactory = {
      address: lpTokenFactoryAddress,
      runtimeCodehash: lpFactoryArtifact.runtimeCodehash,
    };
    compiler.PrivateLPTokenFactory = lpFactoryArtifact;

    const strategyArtifact = await artifacts.readArtifact(
      "ObservableConfidentialLaunchInitializationStrategy",
    );
    const routerArtifact = await artifacts.readArtifact(
      "ObservableConfidentialBestExecutionRouter",
    );
    const strategyCodehash = ethers.keccak256(strategyArtifact.deployedBytecode);
    const routerCodehash = ethers.keccak256(routerArtifact.deployedBytecode);
    if (routerCodehash !== OBSERVABLE_ROUTER_RUNTIME_CODEHASH) {
      throw new Error(
        `observable router artifact hash mismatch: ${routerCodehash}`,
      );
    }

    const deployContract = async (
      contractName: string,
      args: readonly unknown[],
    ) => {
      const factory = await ethers.getContractFactory(contractName, signer as never);
      const result = await deployAndReport(
        contractName,
        factory as unknown as ContractFactory,
        journal,
        onMined,
        ...args,
        { gasLimit: GAS_LIMIT },
      );
      contracts[contractName] = {
        address: result.address,
        deploymentTx: result.deploymentTx,
        gasUsed: result.gasUsed,
        runtimeCodehash: result.artifact.runtimeCodehash,
        constructorArguments: args,
      };
      compiler[contractName] = result.artifact;
      await writeProgress();
      return result;
    };

    const vault = await deployContract(
      "CipherDEXConfidentialFeeVault",
      [feeBeneficiary],
    );
    const poolDeployer = await deployContract(
      "ObservableConfidentialCPMMDeployer",
      [],
    );
    const registry = await deployContract(
      "ObservableConfidentialInitializationStrategyRegistry",
      [[strategyCodehash]],
    );
    const factory = await deployContract(
      "ObservableConfidentialCPMMFactory",
      [
        vault.address,
        lpTokenFactoryAddress,
        poolDeployer.address,
        poolDeployer.artifact.runtimeCodehash,
        registry.address,
        registry.artifact.runtimeCodehash,
      ],
    );

    const bind = async (
      label: string,
      operation: () => Promise<any>,
    ) => {
      const evidence = await submitDeploymentTransaction(label, journal, operation);
      await onMined({
        label,
        transactionHash: evidence.transactionHash,
        gasUsed: evidence.receipt.gasUsed.toString(),
      });
      return evidence;
    };
    await bind("observable fee vault binding", () =>
      vault.contract.getFunction("setConfidentialFactory")(
        factory.address,
        { gasLimit: GAS_LIMIT },
      ));
    await bind("observable pool deployer binding", () =>
      poolDeployer.contract.getFunction("bindFactory")(
        factory.address,
        { gasLimit: GAS_LIMIT },
      ));
    await bind("observable strategy registry binding", () =>
      registry.contract.getFunction("bindFactory")(
        factory.address,
        { gasLimit: GAS_LIMIT },
      ));

    const strategy = await deployContract(
      "ObservableConfidentialLaunchInitializationStrategy",
      [factory.address, registry.address],
    );
    const migratorAddress = ethers.getAddress(
      String(await strategy.contract.getFunction("migrator").staticCall()),
    );
    const migratorArtifact = await verifyDeployedRuntimeArtifactWithProvenance(
      "ObservableConfidentialLaunchpadMigrator",
      migratorAddress,
      ethers.provider,
    );
    contracts.ObservableConfidentialLaunchpadMigrator = {
      address: migratorAddress,
      creationTransactionHash: strategy.deploymentTx,
      runtimeCodehash: migratorArtifact.runtimeCodehash,
      constructorArguments: [factory.address, strategy.address],
    };
    compiler.ObservableConfidentialLaunchpadMigrator = migratorArtifact;

    await bind("observable strategy registration", () =>
      registry.contract.getFunction("registerInitializationStrategy")(
        strategy.address,
        { gasLimit: GAS_LIMIT },
      ));
    await bind("observable strategy registry finalization", () =>
      registry.contract.getFunction("finalize")({ gasLimit: GAS_LIMIT }));

    const router = await deployContract(
      "ObservableConfidentialBestExecutionRouter",
      [factory.address],
    );
    await bind("observable best-execution router binding", () =>
      factory.contract.getFunction("setBestExecutionRouter")(
        router.address,
        { gasLimit: GAS_LIMIT },
      ));

    const [store0, store1, size0, size1, creationCodeHash] = await Promise.all([
      poolDeployer.contract.getFunction("creationCodeStore0").staticCall(),
      poolDeployer.contract.getFunction("creationCodeStore1").staticCall(),
      poolDeployer.contract.getFunction("creationCodeSize0").staticCall(),
      poolDeployer.contract.getFunction("creationCodeSize1").staticCall(),
      poolDeployer.contract.getFunction("creationCodeHash").staticCall(),
    ]);
    const poolArtifact = await artifacts.readArtifact("ObservableConfidentialCPMM");
    if (
      String(creationCodeHash).toLowerCase() !==
        ethers.keccak256(poolArtifact.bytecode).toLowerCase() ||
      BigInt(String(size0)) + BigInt(String(size1)) !==
        BigInt((poolArtifact.bytecode.length - 2) / 2)
    ) throw new Error("observable pool creation-code stores are invalid");
    contracts.observablePoolCreationCode = {
      store0: ethers.getAddress(String(store0)),
      store1: ethers.getAddress(String(store1)),
      size0: String(size0),
      size1: String(size1),
      creationCodeHash: String(creationCodeHash),
      store0RuntimeCodehash: ethers.keccak256(
        await ethers.provider.getCode(String(store0)),
      ),
      store1RuntimeCodehash: ethers.keccak256(
        await ethers.provider.getCode(String(store1)),
      ),
    };

    const [vaultFactory, deployerFactory, registryFactory, registryFinalized, boundRouter] =
      await Promise.all([
        vault.contract.getFunction("confidentialFactory").staticCall(),
        poolDeployer.contract.getFunction("factory").staticCall(),
        registry.contract.getFunction("factory").staticCall(),
        registry.contract.getFunction("finalized").staticCall(),
        factory.contract.getFunction("bestExecutionRouter").staticCall(),
      ]);
    if (
      ethers.getAddress(String(vaultFactory)) !== factory.address ||
      ethers.getAddress(String(deployerFactory)) !== factory.address ||
      ethers.getAddress(String(registryFactory)) !== factory.address ||
      registryFinalized !== true ||
      ethers.getAddress(String(boundRouter)) !== router.address
    ) throw new Error("observable deployment binding verification failed");

    journal.markRun("passed");
    await writeProgress("complete");
    console.log(`Observable confidential mainnet deployment complete: ${factory.address}`);
  } catch (error) {
    journal.markRun("failed");
    await writeProgress("failed");
    throw error;
  } finally {
    await writer.close();
  }
}

void main().catch((error: unknown) => {
  console.error(
    `Observable confidential mainnet deployment failed: ${safeTestnetErrorSummary(error)}`,
  );
  process.exitCode = 1;
});
