import { Interface, concat, type InterfaceAbi } from "ethers";
import { artifacts } from "hardhat";

type JsonRecord = Record<string, unknown>;

type DeploymentArtifact = Readonly<{
  abi: InterfaceAbi;
  bytecode: string;
}>;

export type DeploymentEvidenceProvider = Readonly<{
  getTransaction(hash: string): Promise<Readonly<{
    to: string | null;
    data: string;
  }> | null>;
  getTransactionReceipt(hash: string): Promise<Readonly<{
    status: number | bigint | null;
    contractAddress: string | null;
    gasUsed: bigint;
  }> | null>;
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

export const CANONICAL_TESTNET_DEPLOYMENTS = Object.freeze([
  Object.freeze({ key: "feeVault", contractName: "CipherDEXFeeVault", label: "CipherDEXFeeVault deployment" }),
  Object.freeze({ key: "confidentialLpTokenFactory", contractName: "PrivateLPTokenFactory", label: "PrivateLPTokenFactory deployment" }),
  Object.freeze({ key: "confidentialFactory", contractName: "ConfidentialCPMMFactory", label: "ConfidentialCPMMFactory deployment" }),
  Object.freeze({ key: "confidentialBestExecutionRouter", contractName: "ConfidentialBestExecutionRouter", label: "ConfidentialBestExecutionRouter deployment" }),
  Object.freeze({ key: "launchpadMigrator", contractName: "ConfidentialLaunchpadMigrator", label: "ConfidentialLaunchpadMigrator deployment" }),
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
  }),
  Object.freeze({
    key: "publicFeeVaultBinding",
    label: "public fee-vault factory binding",
    contractName: "CipherDEXFeeVault",
    functionName: "setPublicFactory",
  }),
  Object.freeze({
    key: "bestExecutionRouterBinding",
    label: "confidential best-execution router binding",
    contractName: "ConfidentialCPMMFactory",
    functionName: "setBestExecutionRouter",
  }),
  Object.freeze({
    key: "bootstrapAdapterBinding",
    label: "launchpad adapter binding",
    contractName: "ConfidentialCPMMFactory",
    functionName: "setBootstrapAdapter",
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

  return Object.freeze({
    feeVault: [requireAddress(feeVault, "beneficiary", "contracts.feeVault")],
    confidentialLpTokenFactory: [],
    confidentialFactory: [
      feeVaultAddress,
      requireAddress(lpFactory, "address", "contracts.confidentialLpTokenFactory"),
      reviewedCodehashes,
    ],
    confidentialBestExecutionRouter: [confidentialFactoryAddress],
    launchpadMigrator: [confidentialFactoryAddress],
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
): Promise<unknown> {
  const contractInterface = new Interface(artifact.abi);
  const result = await provider.call({
    to: address,
    data: contractInterface.encodeFunctionData(functionName),
  });
  return contractInterface.decodeFunctionResult(functionName, result)[0];
}

export async function verifyDeploymentTransactionEvidence(
  record: JsonRecord,
  provider: DeploymentEvidenceProvider,
  readArtifact: ArtifactReader = (contractName) => artifacts.readArtifact(contractName),
): Promise<void> {
  const contracts = asRecord(record.contracts, "deployment record contracts");
  const transactions = asArray(record.transactions, "deployment record transactions")
    .map((entry, index) => asRecord(entry, `deployment record transactions[${index}]`));
  const expectedCount = CANONICAL_TESTNET_DEPLOYMENTS.length + BINDINGS.length;
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
  for (const deployment of CANONICAL_TESTNET_DEPLOYMENTS) {
    const label = `contracts.${deployment.key}`;
    const contract = asRecord(contracts[deployment.key], label);
    const address = requireAddress(contract, "address", label);
    const hash = requireHash(contract, "deploymentTx", label);
    const gasUsed = requireGas(contract, "gasUsed", label);
    const args = asArray(contract.constructorArgs, `${label}.constructorArgs`);
    assertJsonEqual(args, canonicalArgs[deployment.key], `${label}.constructorArgs`);

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
    if (!transaction.to || !sameAddress(transaction.to, target) || receipt.contractAddress !== null) {
      throw new Error(`${label} receipt does not prove the recorded binding target`);
    }
    if (receipt.gasUsed !== gasUsed) throw new Error(`${label} gas usage does not match its receipt`);
    const contractInterface = new Interface(artifact.abi);
    const expectedData = contractInterface.encodeFunctionData(binding.functionName, args);
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
  const addressOf = (key: string): string =>
    requireAddress(asRecord(contracts[key], `contracts.${key}`), "address", `contracts.${key}`);
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
  await assertAddressState("ConfidentialCPMMFactory", "confidentialFactory", "bestExecutionRouter", confidentialRouterAddress);
  await assertAddressState("ConfidentialCPMMFactory", "confidentialFactory", "bootstrapAdapter", migratorAddress);
  await assertAddressState("ConfidentialBestExecutionRouter", "confidentialBestExecutionRouter", "factory", confidentialFactoryAddress);
  await assertAddressState("ConfidentialLaunchpadMigrator", "launchpadMigrator", "factory", confidentialFactoryAddress);
  await assertAddressState("PublicCPMMFactory", "publicFactory", "feeVault", feeVaultAddress);
  await assertAddressState("PublicCPMMQuoter", "publicQuoter", "factory", publicFactoryAddress);
  await assertAddressState("PublicCPMMRouter", "publicRouter", "factory", publicFactoryAddress);

  const routerVersion = await readState(
    provider,
    await artifactFor("ConfidentialBestExecutionRouter"),
    confidentialRouterAddress,
    "PROTOCOL_VERSION",
  );
  if (BigInt(String(routerVersion)) !== 1n) {
    throw new Error("confidential best-execution router protocol version is not v1");
  }
}
