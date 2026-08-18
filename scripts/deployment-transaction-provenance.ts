import { Interface, concat, getAddress, keccak256, type InterfaceAbi } from "ethers";
import { artifacts } from "../hardhat/runtime.js";

type JsonRecord = Record<string, unknown>;

type DeploymentArtifact = Readonly<{
  abi: InterfaceAbi;
  bytecode: string;
}>;

export type DeploymentEvidenceProvider = Readonly<{
  getTransaction(hash: string): Promise<Readonly<{
    from: string;
    to: string | null;
    data: string;
  }> | null>;
  getTransactionReceipt(hash: string): Promise<Readonly<{
    status: number | bigint | null;
    contractAddress: string | null;
    gasUsed: bigint;
    logs: readonly Readonly<{
      address: string;
      topics: readonly string[];
      data: string;
    }>[];
  }> | null>;
  getCode(address: string): Promise<string>;
  call(transaction: Readonly<{ to: string; data: string }>): Promise<string>;
}>;

type ArtifactReader = (contractName: string) => Promise<DeploymentArtifact>;

const HASH_PATTERN = /^0x[0-9a-f]{64}$/iu;

function asRecord(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function requiredString(record: JsonRecord, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label}.${key} must be a non-empty string`);
  }
  return value;
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function sameHex(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function requireAddress(record: JsonRecord, key: string, label: string): string {
  const value = requiredString(record, key, label);
  if (!/^0x[0-9a-f]{40}$/iu.test(value)) {
    throw new Error(`${label}.${key} must be an address`);
  }
  return value;
}

function requireHash(record: JsonRecord, key: string, label: string): string {
  const value = requiredString(record, key, label);
  if (!HASH_PATTERN.test(value)) throw new Error(`${label}.${key} must be a transaction hash`);
  return value;
}

function requireGas(record: JsonRecord, key: string, label: string): bigint {
  const value = requiredString(record, key, label);
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`${label}.${key} must be positive gas`);
  return BigInt(value);
}

type CanonicalTestnetDeployment = Readonly<{
  key: string;
  contractName: string;
  label: string;
  kind?: "strategy-constructor-child";
  parentKey?: string;
}>;

export const CANONICAL_TESTNET_DEPLOYMENTS: readonly CanonicalTestnetDeployment[] = Object.freeze([
  Object.freeze({ key: "feeVault", contractName: "CipherDEXFeeVault", label: "CipherDEXFeeVault deployment" }),
  Object.freeze({ key: "confidentialLpTokenFactory", contractName: "PrivateLPTokenFactory", label: "PrivateLPTokenFactory deployment" }),
  Object.freeze({ key: "confidentialInitializationStrategyRegistry", contractName: "ConfidentialInitializationStrategyRegistry", label: "ConfidentialInitializationStrategyRegistry deployment" }),
  Object.freeze({ key: "confidentialPoolDeployer", contractName: "ConfidentialCPMMDeployer", label: "ConfidentialCPMMDeployer deployment" }),
  Object.freeze({ key: "confidentialFactory", contractName: "ConfidentialCPMMFactory", label: "ConfidentialCPMMFactory deployment" }),
  Object.freeze({ key: "confidentialLaunchInitializationStrategy", contractName: "ConfidentialLaunchInitializationStrategy", label: "ConfidentialLaunchInitializationStrategy deployment" }),
  Object.freeze({ key: "confidentialBestExecutionRouter", contractName: "ConfidentialBestExecutionRouter", label: "ConfidentialBestExecutionRouter deployment" }),
  Object.freeze({
    key: "launchpadMigrator",
    contractName: "ConfidentialLaunchpadMigrator",
    label: "ConfidentialLaunchInitializationStrategy deployment",
    kind: "strategy-constructor-child" as const,
    parentKey: "confidentialLaunchInitializationStrategy",
  }),
  Object.freeze({ key: "publicFactory", contractName: "PublicCPMMFactory", label: "PublicCPMMFactory deployment" }),
  Object.freeze({ key: "publicQuoter", contractName: "PublicCPMMQuoter", label: "PublicCPMMQuoter deployment" }),
  Object.freeze({ key: "publicRouter", contractName: "PublicCPMMRouter", label: "PublicCPMMRouter deployment" }),
]);

const BINDINGS = Object.freeze([
  Object.freeze({
    key: "confidentialFeeVaultBinding",
    label: "confidential fee-vault factory binding",
    contractName: "CipherDEXFeeVault",
    functionName: "setConfidentialFactory",
    targetKey: "feeVault",
    argumentKeys: ["confidentialFactory"],
  }),
  Object.freeze({
    key: "confidentialPoolDeployerBinding",
    label: "confidential pool-deployer factory binding",
    contractName: "ConfidentialCPMMDeployer",
    functionName: "bindFactory",
    targetKey: "confidentialPoolDeployer",
    argumentKeys: ["confidentialFactory"],
  }),
  Object.freeze({
    key: "confidentialStrategyRegistryBinding",
    label: "confidential strategy-registry factory binding",
    contractName: "ConfidentialInitializationStrategyRegistry",
    functionName: "bindFactory",
    targetKey: "confidentialInitializationStrategyRegistry",
    argumentKeys: ["confidentialFactory"],
  }),
  Object.freeze({
    key: "publicFeeVaultBinding",
    label: "public fee-vault factory binding",
    contractName: "CipherDEXFeeVault",
    functionName: "setPublicFactory",
    targetKey: "feeVault",
    argumentKeys: ["publicFactory"],
  }),
  Object.freeze({
    key: "bestExecutionRouterBinding",
    label: "confidential best-execution router binding",
    contractName: "ConfidentialCPMMFactory",
    functionName: "setBestExecutionRouter",
    targetKey: "confidentialFactory",
    argumentKeys: ["confidentialBestExecutionRouter"],
  }),
  Object.freeze({
    key: "confidentialStrategyRegistration",
    label: "confidential initialization-strategy registration",
    contractName: "ConfidentialInitializationStrategyRegistry",
    functionName: "registerInitializationStrategy",
    targetKey: "confidentialInitializationStrategyRegistry",
    argumentKeys: ["confidentialLaunchInitializationStrategy"],
  }),
  Object.freeze({
    key: "confidentialStrategyRegistryFinalization",
    label: "confidential strategy-registry finalization",
    contractName: "ConfidentialInitializationStrategyRegistry",
    functionName: "finalize",
    targetKey: "confidentialInitializationStrategyRegistry",
    argumentKeys: [],
  }),
]);

function expectedConstructorArgs(contracts: JsonRecord): Readonly<Record<string, unknown[]>> {
  const feeVault = asRecord(contracts.feeVault, "contracts.feeVault");
  const lpFactory = asRecord(
    contracts.confidentialLpTokenFactory,
    "contracts.confidentialLpTokenFactory",
  );
  const confidentialFactory = asRecord(
    contracts.confidentialFactory,
    "contracts.confidentialFactory",
  );
  const strategyRegistry = asRecord(
    contracts.confidentialInitializationStrategyRegistry,
    "contracts.confidentialInitializationStrategyRegistry",
  );
  const poolDeployer = asRecord(
    contracts.confidentialPoolDeployer,
    "contracts.confidentialPoolDeployer",
  );
  const launchStrategy = asRecord(
    contracts.confidentialLaunchInitializationStrategy,
    "contracts.confidentialLaunchInitializationStrategy",
  );
  const confidentialRouter = asRecord(
    contracts.confidentialBestExecutionRouter,
    "contracts.confidentialBestExecutionRouter",
  );
  const launchpadMigrator = asRecord(contracts.launchpadMigrator, "contracts.launchpadMigrator");
  const publicFactory = asRecord(contracts.publicFactory, "contracts.publicFactory");
  const publicQuoter = asRecord(contracts.publicQuoter, "contracts.publicQuoter");
  const publicRouter = asRecord(contracts.publicRouter, "contracts.publicRouter");

  const feeVaultAddress = requireAddress(feeVault, "address", "contracts.feeVault");
  const confidentialFactoryAddress = requireAddress(
    confidentialFactory,
    "address",
    "contracts.confidentialFactory",
  );
  const publicFactoryAddress = requireAddress(publicFactory, "address", "contracts.publicFactory");
  const reviewedCodehashes = asArray(
    confidentialFactory.approvedPrivateTokenCodehashes,
    "contracts.confidentialFactory.approvedPrivateTokenCodehashes",
  );
  if (
    reviewedCodehashes.length === 0 ||
    reviewedCodehashes.some((value) => typeof value !== "string" || !HASH_PATTERN.test(value))
  ) {
    throw new Error("confidential factory approved private-token codehashes are invalid");
  }
  const reviewedStrategyCodehashes = asArray(
    strategyRegistry.reviewedStrategyCodehashes,
    "contracts.confidentialInitializationStrategyRegistry.reviewedStrategyCodehashes",
  );
  if (
    reviewedStrategyCodehashes.length === 0 ||
    reviewedStrategyCodehashes.some(
      (value) => typeof value !== "string" || !HASH_PATTERN.test(value),
    )
  ) {
    throw new Error("confidential initialization-strategy codehashes are invalid");
  }
  const strategyRegistryRuntimeCodehash = requiredString(
    strategyRegistry,
    "runtimeCodehash",
    "contracts.confidentialInitializationStrategyRegistry",
  );
  const poolDeployerRuntimeCodehash = requiredString(
    poolDeployer,
    "runtimeCodehash",
    "contracts.confidentialPoolDeployer",
  );
  if (
    !HASH_PATTERN.test(strategyRegistryRuntimeCodehash) ||
    !HASH_PATTERN.test(poolDeployerRuntimeCodehash)
  ) {
    throw new Error("confidential dependency runtime codehashes are invalid");
  }
  const strategyRegistryAddress = requireAddress(
    strategyRegistry,
    "address",
    "contracts.confidentialInitializationStrategyRegistry",
  );
  const poolDeployerAddress = requireAddress(
    poolDeployer,
    "address",
    "contracts.confidentialPoolDeployer",
  );
  const launchStrategyAddress = requireAddress(
    launchStrategy,
    "address",
    "contracts.confidentialLaunchInitializationStrategy",
  );

  return Object.freeze({
    feeVault: [requireAddress(feeVault, "beneficiary", "contracts.feeVault")],
    confidentialLpTokenFactory: [],
    confidentialInitializationStrategyRegistry: [reviewedStrategyCodehashes],
    confidentialPoolDeployer: [],
    confidentialFactory: [
      feeVaultAddress,
      requireAddress(lpFactory, "address", "contracts.confidentialLpTokenFactory"),
      poolDeployerAddress,
      poolDeployerRuntimeCodehash,
      reviewedCodehashes,
      strategyRegistryAddress,
      strategyRegistryRuntimeCodehash,
    ],
    confidentialLaunchInitializationStrategy: [
      confidentialFactoryAddress,
      strategyRegistryAddress,
      requireAddress(
        launchStrategy,
        "launchAuthority",
        "contracts.confidentialLaunchInitializationStrategy",
      ),
    ],
    confidentialBestExecutionRouter: [confidentialFactoryAddress],
    launchpadMigrator: [confidentialFactoryAddress, launchStrategyAddress],
    publicFactory: [feeVaultAddress],
    publicQuoter: [publicFactoryAddress],
    publicRouter: [publicFactoryAddress],
  });
}

function assertJsonEqual(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} does not match canonical deployment relationships`);
  }
}

async function readState(
  provider: DeploymentEvidenceProvider,
  artifact: DeploymentArtifact,
  address: string,
  functionName: string,
  args: readonly unknown[] = [],
): Promise<unknown> {
  const contractInterface = new Interface(artifact.abi);
  const result = await provider.call({
    to: address,
    data: contractInterface.encodeFunctionData(functionName, args),
  });
  return contractInterface.decodeFunctionResult(functionName, result)[0];
}

export async function verifyDeploymentTransactionEvidence(
  record: JsonRecord,
  provider: DeploymentEvidenceProvider,
  readArtifact: ArtifactReader = (contractName) => artifacts.readArtifact(contractName),
): Promise<void> {
  const contracts = asRecord(record.contracts, "deployment record contracts");
  const addressOf = (key: string): string =>
    requireAddress(asRecord(contracts[key], `contracts.${key}`), "address", `contracts.${key}`);
  const transactions = asArray(record.transactions, "deployment record transactions")
    .map((entry, index) => asRecord(entry, `deployment record transactions[${index}]`));
  const directDeploymentCount = CANONICAL_TESTNET_DEPLOYMENTS.filter(
    (deployment) => deployment.kind !== "strategy-constructor-child",
  ).length;
  const expectedCount = directDeploymentCount + BINDINGS.length;
  if (transactions.length !== expectedCount) {
    throw new Error(`deployment record must contain exactly ${expectedCount} canonical transactions`);
  }

  const transactionByHash = new Map<string, JsonRecord>();
  for (const transaction of transactions) {
    const hash = requireHash(transaction, "transactionHash", "deployment transaction").toLowerCase();
    if (transactionByHash.has(hash)) throw new Error("deployment transaction hashes must be unique");
    if (transaction.outcome !== "mined-success") {
      throw new Error("every canonical deployment transaction must be mined-success");
    }
    requireGas(transaction, "gasUsed", "deployment transaction");
    transactionByHash.set(hash, transaction);
  }

  const canonicalArgs = expectedConstructorArgs(contracts);
  let deploymentAuthority: string | null = null;
  for (const deployment of CANONICAL_TESTNET_DEPLOYMENTS) {
    const label = `contracts.${deployment.key}`;
    const contract = asRecord(contracts[deployment.key], label);
    const address = requireAddress(contract, "address", label);
    const hash = requireHash(contract, "deploymentTx", label);
    const gasUsed = requireGas(contract, "gasUsed", label);
    const args = asArray(contract.constructorArgs, `${label}.constructorArgs`);
    assertJsonEqual(args, canonicalArgs[deployment.key], `${label}.constructorArgs`);

    if (deployment.kind === "strategy-constructor-child") {
      if (!deployment.parentKey) {
        throw new Error(`${label} lacks a constructor-child parent key`);
      }
      if (contract.creationKind !== deployment.kind) {
        throw new Error(`${label} creation kind is invalid`);
      }
      const parent = asRecord(
        contracts[deployment.parentKey],
        `contracts.${deployment.parentKey}`,
      );
      const parentAddress = requireAddress(
        parent,
        "address",
        `contracts.${deployment.parentKey}`,
      );
      const parentHash = requireHash(
        parent,
        "deploymentTx",
        `contracts.${deployment.parentKey}`,
      );
      if (
        !sameAddress(
          requireAddress(contract, "creationParent", label),
          parentAddress,
        ) ||
        !sameHex(hash, parentHash)
      ) {
        throw new Error(`${label} is not bound to its reviewed parent deployment`);
      }
      const [receipt, childArtifact, childCode, strategyArtifact] = await Promise.all([
        provider.getTransactionReceipt(parentHash),
        readArtifact(deployment.contractName),
        provider.getCode(address),
        readArtifact("ConfidentialLaunchInitializationStrategy"),
      ]);
      if (!receipt || BigInt(receipt.status ?? 0) !== 1n || childCode === "0x") {
        throw new Error(`${label} constructor-child deployment is unavailable`);
      }
      const strategyInterface = new Interface(strategyArtifact.abi);
      const configured = receipt.logs.flatMap((log) => {
        if (!sameAddress(log.address, parentAddress)) return [];
        try {
          const parsed = strategyInterface.parseLog({
            topics: [...log.topics],
            data: log.data,
          });
          return parsed?.name === "MigratorConfigured" ? [parsed] : [];
        } catch {
          return [];
        }
      }).filter((event) =>
        sameAddress(String(event.args.migrator), address) &&
        sameHex(String(event.args.runtimeCodehash), keccak256(childCode))
      );
      if (configured.length !== 1) {
        throw new Error(`${label} lacks a unique constructor-child configuration event`);
      }
      if (
        childArtifact.bytecode.length === 0 ||
        !sameHex(
          requiredString(contract, "runtimeCodehash", label),
          keccak256(childCode),
        )
      ) {
        throw new Error(`${label} runtime provenance is invalid`);
      }
      continue;
    }

    const transactionRecord = transactionByHash.get(hash.toLowerCase());
    if (!transactionRecord || transactionRecord.label !== deployment.label) {
      throw new Error(`${label} transaction is missing or mislabeled`);
    }
    if (
      requireGas(transactionRecord, "gasUsed", "deployment transaction") !== gasUsed ||
      !sameAddress(requireAddress(transactionRecord, "contractAddress", "deployment transaction"), address)
    ) {
      throw new Error(`${label} transaction journal evidence does not match the contract record`);
    }

    const [transaction, receipt, artifact] = await Promise.all([
      provider.getTransaction(hash),
      provider.getTransactionReceipt(hash),
      readArtifact(deployment.contractName),
    ]);
    if (!transaction || !receipt || BigInt(receipt.status ?? 0) !== 1n) {
      throw new Error(`${label} does not have a successful mined transaction and receipt`);
    }
    const transactionSender = getAddress(transaction.from);
    if (deploymentAuthority === null) deploymentAuthority = transactionSender;
    if (transactionSender !== deploymentAuthority) {
      throw new Error(`${label} was not sent by the canonical deployment authority`);
    }
    if (transaction.to !== null || !receipt.contractAddress || !sameAddress(receipt.contractAddress, address)) {
      throw new Error(`${label} receipt does not prove deployment at the recorded address`);
    }
    if (receipt.gasUsed !== gasUsed) throw new Error(`${label} gas usage does not match its receipt`);
    const deploymentInterface = new Interface(artifact.abi);
    const expectedData = concat([artifact.bytecode, deploymentInterface.encodeDeploy(args)]);
    if (!sameHex(transaction.data, expectedData)) {
      throw new Error(`${label} creation calldata does not match the reviewed artifact and constructor args`);
    }
  }

  for (const binding of BINDINGS) {
    const label = `contracts.${binding.key}`;
    const contract = asRecord(contracts[binding.key], label);
    const target = requireAddress(contract, "target", label);
    const hash = requireHash(contract, "transaction", label);
    const gasUsed = requireGas(contract, "gasUsed", label);
    const args = asArray(contract.args, `${label}.args`);
    const canonicalTarget = addressOf(binding.targetKey);
    const canonicalArguments = binding.argumentKeys.map(addressOf);
    if (!sameAddress(target, canonicalTarget)) {
      throw new Error(`${label} target does not match the canonical deployment`);
    }
    assertJsonEqual(args, canonicalArguments, `${label}.args`);
    if (contract.function !== binding.functionName) {
      throw new Error(`${label} function does not match the canonical binding`);
    }
    const transactionRecord = transactionByHash.get(hash.toLowerCase());
    if (!transactionRecord || transactionRecord.label !== binding.label) {
      throw new Error(`${label} transaction is missing or mislabeled`);
    }
    if (requireGas(transactionRecord, "gasUsed", "binding transaction") !== gasUsed) {
      throw new Error(`${label} gas usage does not match the transaction journal`);
    }

    const [transaction, receipt, artifact] = await Promise.all([
      provider.getTransaction(hash),
      provider.getTransactionReceipt(hash),
      readArtifact(binding.contractName),
    ]);
    if (!transaction || !receipt || BigInt(receipt.status ?? 0) !== 1n) {
      throw new Error(`${label} does not have a successful mined transaction and receipt`);
    }
    if (
      deploymentAuthority === null ||
      getAddress(transaction.from) !== deploymentAuthority
    ) {
      throw new Error(`${label} was not sent by the canonical deployment authority`);
    }
    if (!transaction.to || !sameAddress(transaction.to, canonicalTarget) || receipt.contractAddress !== null) {
      throw new Error(`${label} receipt does not prove the recorded binding target`);
    }
    if (receipt.gasUsed !== gasUsed) throw new Error(`${label} gas usage does not match its receipt`);
    const contractInterface = new Interface(artifact.abi);
    const expectedData = contractInterface.encodeFunctionData(
      binding.functionName,
      canonicalArguments,
    );
    if (!sameHex(transaction.data, expectedData)) {
      throw new Error(`${label} calldata does not match the canonical binding`);
    }
  }

  const artifactsByName = new Map<string, DeploymentArtifact>();
  const artifactFor = async (name: string): Promise<DeploymentArtifact> => {
    const cached = artifactsByName.get(name);
    if (cached) return cached;
    const artifact = await readArtifact(name);
    artifactsByName.set(name, artifact);
    return artifact;
  };
  const assertAddressState = async (
    contractName: string,
    contractKey: string,
    functionName: string,
    expectedAddress: string,
  ): Promise<void> => {
    const actual = await readState(
      provider,
      await artifactFor(contractName),
      addressOf(contractKey),
      functionName,
    );
    if (typeof actual !== "string" || !sameAddress(actual, expectedAddress)) {
      throw new Error(`${contractKey}.${functionName} does not match canonical post-deployment state`);
    }
  };

  const feeVaultAddress = addressOf("feeVault");
  const confidentialFactoryAddress = addressOf("confidentialFactory");
  const lpFactoryAddress = addressOf("confidentialLpTokenFactory");
  const strategyRegistryAddress = addressOf(
    "confidentialInitializationStrategyRegistry",
  );
  const poolDeployerAddress = addressOf("confidentialPoolDeployer");
  const launchStrategyAddress = addressOf(
    "confidentialLaunchInitializationStrategy",
  );
  const confidentialRouterAddress = addressOf("confidentialBestExecutionRouter");
  const migratorAddress = addressOf("launchpadMigrator");
  const publicFactoryAddress = addressOf("publicFactory");
  await assertAddressState("CipherDEXFeeVault", "feeVault", "beneficiary", requireAddress(
    asRecord(contracts.feeVault, "contracts.feeVault"),
    "beneficiary",
    "contracts.feeVault",
  ));
  await assertAddressState("CipherDEXFeeVault", "feeVault", "confidentialFactory", confidentialFactoryAddress);
  await assertAddressState("CipherDEXFeeVault", "feeVault", "publicFactory", publicFactoryAddress);
  await assertAddressState("ConfidentialCPMMFactory", "confidentialFactory", "feeVault", feeVaultAddress);
  await assertAddressState("ConfidentialCPMMFactory", "confidentialFactory", "lpTokenFactory", lpFactoryAddress);
  await assertAddressState("ConfidentialCPMMFactory", "confidentialFactory", "poolDeployer", poolDeployerAddress);
  await assertAddressState(
    "ConfidentialCPMMFactory",
    "confidentialFactory",
    "initializationStrategyRegistry",
    strategyRegistryAddress,
  );
  await assertAddressState("ConfidentialCPMMFactory", "confidentialFactory", "bestExecutionRouter", confidentialRouterAddress);
  await assertAddressState("ConfidentialBestExecutionRouter", "confidentialBestExecutionRouter", "factory", confidentialFactoryAddress);
  await assertAddressState("ConfidentialLaunchpadMigrator", "launchpadMigrator", "factory", confidentialFactoryAddress);
  await assertAddressState("ConfidentialLaunchpadMigrator", "launchpadMigrator", "initializationStrategy", launchStrategyAddress);
  await assertAddressState("ConfidentialCPMMDeployer", "confidentialPoolDeployer", "factory", confidentialFactoryAddress);
  await assertAddressState(
    "ConfidentialInitializationStrategyRegistry",
    "confidentialInitializationStrategyRegistry",
    "factory",
    confidentialFactoryAddress,
  );
  await assertAddressState(
    "ConfidentialLaunchInitializationStrategy",
    "confidentialLaunchInitializationStrategy",
    "factory",
    confidentialFactoryAddress,
  );
  await assertAddressState(
    "ConfidentialLaunchInitializationStrategy",
    "confidentialLaunchInitializationStrategy",
    "strategyRegistry",
    strategyRegistryAddress,
  );
  await assertAddressState(
    "ConfidentialLaunchInitializationStrategy",
    "confidentialLaunchInitializationStrategy",
    "migrator",
    migratorAddress,
  );
  await assertAddressState("PublicCPMMFactory", "publicFactory", "feeVault", feeVaultAddress);
  await assertAddressState("PublicCPMMQuoter", "publicQuoter", "factory", publicFactoryAddress);
  await assertAddressState("PublicCPMMRouter", "publicRouter", "factory", publicFactoryAddress);

  const routerVersion = await readState(
    provider,
    await artifactFor("ConfidentialBestExecutionRouter"),
    confidentialRouterAddress,
    "PROTOCOL_VERSION",
  );
  if (BigInt(String(routerVersion)) !== 2n) {
    throw new Error("confidential best-execution router protocol version is not v2");
  }
  const [registryFinalized, strategyRegistered, strategyClass] = await Promise.all([
    readState(
      provider,
      await artifactFor("ConfidentialInitializationStrategyRegistry"),
      strategyRegistryAddress,
      "finalized",
    ),
    readState(
      provider,
      await artifactFor("ConfidentialInitializationStrategyRegistry"),
      strategyRegistryAddress,
      "isRegisteredStrategy",
      [launchStrategyAddress],
    ),
    readState(
      provider,
      await artifactFor("ConfidentialInitializationStrategyRegistry"),
      strategyRegistryAddress,
      "initializationStrategyClass",
      [launchStrategyAddress],
    ),
  ]);
  if (registryFinalized !== true || strategyRegistered !== true || BigInt(String(strategyClass)) !== 1n) {
    throw new Error("confidential initialization-strategy registry is not canonically finalized");
  }
}
