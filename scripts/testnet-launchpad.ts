import { Contract, TransactionReceipt, ethers } from "ethers";
import { artifacts, ethers as hardhatEthers } from "../hardhat/runtime.js";
import {
  LAUNCH_COMMITMENT_EIP712_TYPES,
  LAUNCH_INITIALIZATION_EIP712_DOMAIN,
  LAUNCHPAD_MIGRATION_EIP712_TYPES,
  LAUNCHPAD_MIGRATOR_EIP712_DOMAIN,
} from "../sdk/src/index";
import {
  CONFIDENTIAL_FACTORY_TESTNET_ABI,
  CONFIDENTIAL_POOL_TESTNET_ABI,
  PRIVATE_ERC20_TESTNET_ABI,
} from "./coti-testnet-abi";
import { decryptPrivateValue256 } from "./coti-testnet-values";
import { assertCompatiblePrivateTokens } from "./private-token-compatibility";
import { verifyDeployedRuntimeArtifact } from "./runtime-artifact";
import {
  type FundedRecoveryJournal,
  type RecoveryResource,
  verifyRecoveryResourceCreation,
} from "./funded-recovery-journal";
import { writePreparedFundedRunEvidence } from "./funded-run-evidence";
import { createFundedDeploymentBinding } from "./funded-deployment-binding";
import {
  deriveFundedTestAmount,
  minimumInputWithProtocolFee,
} from "./funded-balance-budget";
import {
  FundedCotiWallet as CotiWallet,
  FundedWallet,
  openFundedRecoveryJournal,
  withFundedTransactionEvidence,
} from "./funded-transaction-wallet";
import { requiredFundedRecoveryDirectory } from "./funded-runtime-state";
import {
  recoverPrivateAllowanceObligations,
  setRecoverablePrivateAllowance,
} from "./funded-private-allowance";
import {
  requiredTestnetDeploymentRecordPath,
  verifyConfiguredTestnetDeployment,
} from "./testnet-deployment-provenance";
import {
  futureChainDeadline,
  requireMinedFailureSelector,
  requireMinedFailure,
  requireMinedSuccess,
  safeTestnetErrorSummary,
  UnknownBroadcastOutcomeError,
} from "./testnet-transaction-evidence";
import { minimumWithSlippage } from "./testnet-slippage";

const FEE_VAULT_DEPLOY_GAS_LIMIT = 2_500_000n;
const PRIVATE_LP_FACTORY_DEPLOY_GAS_LIMIT = 8_000_000n;
const CONFIDENTIAL_FACTORY_DEPLOY_GAS_LIMIT = 8_000_000n;
const POOL_DEPLOYER_DEPLOY_GAS_LIMIT = 5_000_000n;
const STRATEGY_REGISTRY_DEPLOY_GAS_LIMIT = 3_000_000n;
const INITIALIZATION_STRATEGY_DEPLOY_GAS_LIMIT = 5_000_000n;
const FEE_VAULT_BIND_GAS_LIMIT = 250_000n;
const STACK_BIND_GAS_LIMIT = 500_000n;
const gasLimitText = process.env.COTI_TESTNET_GAS_LIMIT?.trim() ?? "30000000";
if (!/^\d+$/.test(gasLimitText) || BigInt(gasLimitText) === 0n) {
  throw new Error("COTI_TESTNET_GAS_LIMIT must be a positive integer");
}
const COTI_TESTNET_TX_GAS_LIMIT = BigInt(gasLimitText);
const EXPECTED_CHAIN_ID = 7_082_400n;
const STACK_RESOURCE_ID = "launchpad-stack";
const POOL_RESOURCE_ID = "launchpad-pool";
const FUNDED_LAUNCHPAD_DEADLINE_WINDOW_SECONDS = 3_600n;
const MINIMUM_MIGRATION_SUBMISSION_WINDOW_SECONDS = 300n;
const PRICE_OUTSIDE_BOUNDS_SELECTOR = ethers.id("PriceOutsideBounds()").slice(0, 10);
const INVALID_LAUNCH_COMMITMENT_SELECTOR = ethers.id("InvalidLaunchCommitment()").slice(0, 10);

let stage = "configuration";
let configuredLaunchpadProof = false;
let recoveryJournal: FundedRecoveryJournal | undefined;
let recoveryWallet: CotiWallet | undefined;
let recoveryOwner: string | undefined;

type Submitted = Readonly<{
  transactionHash: string;
  receipt: TransactionReceipt;
}>;

type FundedDeployment = Readonly<{
  contract: any;
  address: string;
  transactionHash: string;
}>;

const requiredAddress = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value || !ethers.isAddress(value)) throw new Error(`missing ${name}`);
  return value;
};

const requiredPrivateKey = (name = "COTI_TESTNET_PRIVATE_KEY"): string => {
  const value = process.env[name]?.trim();
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`missing ${name}`);
  }
  return value;
};

function journal(): FundedRecoveryJournal {
  if (!recoveryJournal) throw new Error("funded recovery journal is not initialized");
  return recoveryJournal;
}

async function configuredDeploymentHandle(
  contracts: Readonly<Record<string, Record<string, unknown>>>,
  key: string,
  contractName: string,
  signer: CotiWallet,
): Promise<Readonly<{
  contract: any;
  address: string;
  transactionHash: string;
  constructorArguments: readonly unknown[];
}>> {
  const record = contracts[key];
  const address = record?.address;
  const transactionHash = record?.deploymentTx;
  const constructorArguments = record?.constructorArgs;
  if (
    typeof address !== "string" ||
    !ethers.isAddress(address) ||
    typeof transactionHash !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(transactionHash) ||
    !Array.isArray(constructorArguments)
  ) {
    throw new Error(`configured deployment record is invalid for ${key}`);
  }
  return Object.freeze({
    contract: await hardhatEthers.getContractAt(contractName, address, signer),
    address: ethers.getAddress(address),
    transactionHash,
    constructorArguments: Object.freeze([...constructorArguments]),
  });
}

const optionalBigInt = (name: string, fallback: bigint): bigint => {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`invalid ${name}`);
  return BigInt(value);
};

async function readPrivateBalance(
  token: Contract,
  owner: string,
  wallet: CotiWallet,
): Promise<bigint> {
  const ciphertext = await token.balanceOf.staticCall(owner);
  return decryptPrivateValue256(wallet, ciphertext);
}

const optionalDisposition = (): number | undefined => {
  const value = process.env.COTI_LAUNCHPAD_DISPOSITION?.trim();
  if (!value) return undefined;
  if (!/^\d+$/.test(value)) throw new Error("invalid COTI_LAUNCHPAD_DISPOSITION");
  const disposition = Number(value);
  if (!Number.isInteger(disposition) || disposition < 0 || disposition > 2) {
    throw new Error("COTI_LAUNCHPAD_DISPOSITION must be 0, 1 or 2");
  }
  return disposition;
};

const requiredUInt = (name: string, fallback?: number): number => {
  const value = process.env[name]?.trim();
  if (!value && fallback !== undefined) return fallback;
  if (!value || !/^\d+$/.test(value)) throw new Error(`missing ${name}`);
  return Number(value);
};

const submit = async (
  label: string,
  operation: () => Promise<{ hash: string; wait(): Promise<any> }>,
): Promise<Submitted> => {
  const started = Date.now();
  const evidence = await withFundedTransactionEvidence(
    label,
    journal(),
    () => requireMinedSuccess(
      label,
      operation,
      (hash) => hardhatEthers.provider.getTransactionReceipt(hash),
    ),
  );
  journal().recordTransaction(
    evidence.transactionHash,
    "mined-success",
    evidence.receipt.blockNumber,
  );
  const receipt = evidence.receipt;
  console.log(
    `${label}: tx=${evidence.transactionHash} gas=${receipt.gasUsed.toString()} ` +
      `latencyMs=${Date.now() - started}`,
  );
  return Object.freeze({ transactionHash: evidence.transactionHash, receipt });
};

const deployFunded = async (
  label: string,
  operation: () => Promise<any>,
): Promise<FundedDeployment> => {
  let contract: any;
  const submitted = await submit(
    label,
    async () => {
      contract = await operation();
      const transaction = contract.deploymentTransaction();
      if (!transaction) throw new Error(`${label} transaction unavailable`);
      return transaction;
    },
  );
  if (!contract) {
    throw new Error(`${label} mined without a contract handle; do not retry automatically`);
  }
  return Object.freeze({
    contract,
    address: ethers.getAddress(await contract.getAddress()),
    transactionHash: submitted.transactionHash,
  });
};

const expectMinedFailure = async (
  label: string,
  operation: () => Promise<{
    hash: string;
    wait(): Promise<TransactionReceipt | null>;
  }>,
  expectedSelector: string,
): Promise<Submitted> => {
  stage = label;
  const evidence = await withFundedTransactionEvidence(
    label,
    journal(),
    () => requireMinedFailure(
      label,
      operation,
      (hash) => hardhatEthers.provider.getTransactionReceipt(hash),
    ),
  );
  journal().recordTransaction(
    evidence.transactionHash,
    "mined-failure",
    evidence.receipt.blockNumber,
  );
  const failedTransaction = await hardhatEthers.provider.getTransaction(
    evidence.transactionHash,
  );
  if (
    !failedTransaction ||
    evidence.receipt.gasUsed >= failedTransaction.gasLimit
  ) {
    throw new Error(`${label} exhausted its reviewed gas limit`);
  }
  const selectorEvidence = await requireMinedFailureSelector(
    label,
    evidence.transactionHash,
    evidence.receipt.blockNumber,
    expectedSelector,
    (hash) => hardhatEthers.provider.getTransaction(hash),
    (transaction, blockTag) => hardhatEthers.provider.send("eth_call", [{
      from: transaction.from,
      to: transaction.to,
      data: transaction.data,
      value: ethers.toQuantity(transaction.value),
    }, ethers.toQuantity(blockTag)]),
    { allowUnavailable: true },
  );
  console.log(
    `${label}: rejected onchain tx=${evidence.transactionHash} ` +
      `expectedSelector=${expectedSelector} selectorEvidence=${selectorEvidence}`,
  );
  return Object.freeze({
    transactionHash: evidence.transactionHash,
    receipt: evidence.receipt,
  });
};

const scaleTo18 = (amount: bigint, decimals: number): bigint => {
  if (decimals > 18) throw new Error("token decimals exceed 18");
  return amount * 10n ** BigInt(18 - decimals);
};

const inputCommitment = (input: {
  ciphertext: { ciphertextHigh: bigint; ciphertextLow: bigint };
  signature: string | Uint8Array;
}): string => ethers.keccak256(
  ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint256", "uint256", "bytes32"],
    [
      input.ciphertext.ciphertextHigh,
      input.ciphertext.ciphertextLow,
      ethers.keccak256(input.signature),
    ],
  ),
);

const encryptedInputsHash = (...inputs: Parameters<typeof inputCommitment>[0][]): string =>
  ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32", "bytes32", "bytes32", "bytes32"],
      inputs.map(inputCommitment),
    ),
  );

function metadataAddress(resource: RecoveryResource, key: string): string {
  const value = resource.metadata[key];
  if (typeof value !== "string" || !ethers.isAddress(value)) {
    throw new Error(`launchpad recovery metadata ${key} is invalid`);
  }
  return ethers.getAddress(value);
}

async function readPrivateAllowance(
  token: Contract,
  owner: string,
  spender: string,
  wallet: CotiWallet,
): Promise<bigint> {
  const allowance = await token.allowance.staticCall(owner, spender);
  return decryptPrivateValue256(wallet, allowance.ownerCiphertext);
}

async function clearPrivateAllowance(
  token: Contract,
  tokenAddress: string,
  spender: string,
  wallet: CotiWallet,
  label: string,
): Promise<string | undefined> {
  const hashes = await setRecoverablePrivateAllowance({
    journal: journal(),
    wallet,
    token,
    tokenAddress,
    spender,
    amount: 0n,
    label,
    overrides: { gasLimit: COTI_TESTNET_TX_GAS_LIMIT },
    submit,
  });
  return hashes.at(-1);
}

async function removeLaunchpadShares(
  pool: Contract,
  wallet: CotiWallet,
  shares: bigint,
  label: string,
): Promise<string | undefined> {
  if (shares <= 0n) return undefined;

  const selector = pool.interface.getFunction("removeLiquidity")?.selector;
  if (!selector) throw new Error("launchpad remove-liquidity selector unavailable");
  const [encryptedShares, encryptedMinimum0, encryptedMinimum1] = await Promise.all([
    wallet.encryptValue256(shares, await pool.getAddress(), selector),
    wallet.encryptValue256(1n, await pool.getAddress(), selector),
    wallet.encryptValue256(1n, await pool.getAddress(), selector),
  ]);
  const recovery = await submit(
    label,
    () => pool.removeLiquidity(
      encryptedShares,
      encryptedMinimum0,
      encryptedMinimum1,
      BigInt(Math.floor(Date.now() / 1000) + 600),
      { gasLimit: COTI_TESTNET_TX_GAS_LIMIT },
    ),
  );
  return recovery.transactionHash;
}

async function exitAllLaunchpadShares(
  pool: Contract,
  wallet: CotiWallet,
  label: string,
): Promise<string | undefined> {
  const shares = await decryptPrivateValue256(
    wallet,
    await pool.myShares.staticCall(),
  );
  return removeLaunchpadShares(pool, wallet, shares, label);
}

function encryptedQuoteFromReceipt(
  pool: Contract,
  receipt: TransactionReceipt,
  caller: string,
  requestId: string,
): unknown {
  const poolAddress = String(pool.target).toLowerCase();
  const matches: unknown[] = [];
  for (const log of receipt.logs) {
    if (String(log.address).toLowerCase() !== poolAddress) continue;
    try {
      const parsed = pool.interface.parseLog({ topics: log.topics, data: log.data });
      if (
        parsed?.name === "ConfidentialQuoteResult" &&
        String(parsed.args.caller).toLowerCase() === caller.toLowerCase() &&
        String(parsed.args.requestId).toLowerCase() === requestId.toLowerCase() &&
        parsed.args.zeroForOne === true
      ) matches.push(parsed.args.result);
    } catch {
      // Ignore logs emitted by the private tokens and other stack contracts.
    }
  }
  if (matches.length !== 1) {
    throw new Error("launchpad direct quote result is missing or ambiguous");
  }
  return matches[0];
}

async function recoverLaunchpadResources(): Promise<void> {
  if (!recoveryJournal || !recoveryWallet || !recoveryOwner) return;
  const stack = recoveryJournal.activeResources.find((resource) =>
    resource.id === STACK_RESOURCE_ID
  );
  let poolResource = recoveryJournal.activeResources.find((resource) =>
    resource.id === POOL_RESOURCE_ID
  );

  if (!poolResource && stack) {
    await verifyRecoveryResourceCreation(recoveryJournal, stack, hardhatEthers.provider);
    const factoryAddress = metadataAddress(stack, "factoryAddress");
    const migratorAddress = metadataAddress(stack, "migratorAddress");
    const initializationStrategyAddress = metadataAddress(
      stack,
      "initializationStrategyAddress",
    );
    const token0Address = metadataAddress(stack, "token0Address");
    const token1Address = metadataAddress(stack, "token1Address");
    const decimals0 = Number(stack.metadata.decimals0);
    const decimals1 = Number(stack.metadata.decimals1);
    const feeBps = Number(stack.metadata.feeBps);
    if (
      !Number.isInteger(decimals0) ||
      !Number.isInteger(decimals1) ||
      decimals0 < 0 ||
      decimals1 < 0 ||
      decimals0 > 18 ||
      decimals1 > 18 ||
      !Number.isInteger(feeBps) ||
      feeBps <= 0
    ) throw new Error("launchpad recovery metadata is invalid");
    const factory = await hardhatEthers.getContractAt(
      "ConfidentialCPMMFactory",
      factoryAddress,
      recoveryWallet,
    );
    const key = await factory.poolKey(
      token0Address,
      token1Address,
      decimals0,
      decimals1,
      feeBps,
      initializationStrategyAddress,
    );
    const poolAddress = ethers.getAddress(await factory.getPool(key));
    const successfulCommitments = recoveryJournal.transactions.filter((transaction) =>
      transaction.label === "launch commitment" &&
      transaction.status === "mined-success"
    );
    if (successfulCommitments.length > 1) {
      throw new Error("launchpad recovery found multiple successful commitments");
    }
    if (poolAddress === ethers.ZeroAddress) {
      if (successfulCommitments.length !== 0) {
        throw new Error("successful launch commitment has no canonical pool to recover");
      }
    } else {
      if (!(await factory.isPool(poolAddress))) {
        throw new Error("launchpad recovery found a non-canonical factory pool");
      }
      const factoryReceipt = await hardhatEthers.provider.getTransactionReceipt(
        stack.creationTransactionHash,
      );
      if (!factoryReceipt || factoryReceipt.status !== 1) {
        throw new Error("launchpad recovery cannot prove the factory deployment block");
      }
      const createdEvents = await factory.queryFilter(
        factory.filters.PoolCreated(token0Address, token1Address),
        factoryReceipt.blockNumber,
        "latest",
      );
      const matchingCreatedEvents = createdEvents.filter((event: any) =>
        event.args &&
        ethers.getAddress(String(event.args.token0)) === token0Address &&
        ethers.getAddress(String(event.args.token1)) === token1Address &&
        Number(event.args.token0Decimals) === decimals0 &&
        Number(event.args.token1Decimals) === decimals1 &&
        Number(event.args.feeBps) === feeBps &&
        ethers.getAddress(String(event.args.initializationStrategy)) ===
          initializationStrategyAddress &&
        ethers.getAddress(String(event.args.pool)) === poolAddress
      );
      if (matchingCreatedEvents.length !== 1) {
        throw new Error("launchpad recovery cannot uniquely prove canonical pool creation");
      }
      const creationTransactionHash = matchingCreatedEvents[0].transactionHash;
      if (
        successfulCommitments.length === 1 &&
        successfulCommitments[0].hash.toLowerCase() !== creationTransactionHash.toLowerCase()
      ) {
        throw new Error("launchpad recovery journal does not match canonical pool creation");
      }
      const creationReceipt = await hardhatEthers.provider.getTransactionReceipt(
        creationTransactionHash,
      );
      if (!creationReceipt || creationReceipt.status !== 1) {
        throw new Error("launchpad canonical pool creation receipt is unavailable");
      }
      const journaledCreation = recoveryJournal.transactions.find((transaction) =>
        transaction.hash.toLowerCase() === creationTransactionHash.toLowerCase()
      );
      if (!journaledCreation) {
        recoveryJournal.recordObservedMinedTransaction(
          "atomic launchpad migration recovery",
          creationTransactionHash,
          creationReceipt.blockNumber,
        );
      } else if (journaledCreation.status !== "mined-success") {
        throw new Error("launchpad canonical pool creation is not journaled as mined-success");
      }
      recoveryJournal.recordResource({
        id: POOL_RESOURCE_ID,
        kind: "launchpad-pool",
        address: poolAddress,
        creationTransactionHash,
        metadata: {
          factoryAddress,
          migratorAddress,
          token0Address,
          token1Address,
          decimals0,
          decimals1,
          feeBps,
          initializationStrategyAddress,
        },
      });
      poolResource = recoveryJournal.activeResources.find((resource) =>
        resource.id === POOL_RESOURCE_ID
      );
      if (!poolResource) {
        throw new Error("launchpad recovery could not persist the reconstructed pool");
      }
    }
  }

  if (poolResource) {
    await verifyRecoveryResourceCreation(recoveryJournal, poolResource, hardhatEthers.provider);
    if (poolResource.kind !== "launchpad-pool") {
      throw new Error("unsupported launchpad pool recovery resource");
    }
    const factoryAddress = metadataAddress(poolResource, "factoryAddress");
    const migratorAddress = metadataAddress(poolResource, "migratorAddress");
    const initializationStrategyAddress = metadataAddress(
      poolResource,
      "initializationStrategyAddress",
    );
    const token0Address = metadataAddress(poolResource, "token0Address");
    const token1Address = metadataAddress(poolResource, "token1Address");
    const decimals0 = Number(poolResource.metadata.decimals0);
    const decimals1 = Number(poolResource.metadata.decimals1);
    const feeBps = Number(poolResource.metadata.feeBps);
    if (
      !Number.isInteger(decimals0) ||
      !Number.isInteger(decimals1) ||
      decimals0 < 0 ||
      decimals1 < 0 ||
      decimals0 > 18 ||
      decimals1 > 18 ||
      !Number.isInteger(feeBps) ||
      feeBps <= 0
    ) throw new Error("launchpad pool recovery metadata is invalid");
    await Promise.all([
      verifyDeployedRuntimeArtifact("ConfidentialCPMMFactory", factoryAddress),
      verifyDeployedRuntimeArtifact("ConfidentialLaunchpadMigrator", migratorAddress),
      verifyDeployedRuntimeArtifact(
        "ConfidentialLaunchInitializationStrategy",
        initializationStrategyAddress,
      ),
      verifyDeployedRuntimeArtifact("ConfidentialCPMM", poolResource.address),
    ]);
    const factory = await hardhatEthers.getContractAt(
      "ConfidentialCPMMFactory",
      factoryAddress,
      recoveryWallet,
    );
    const pool = new Contract(poolResource.address, CONFIDENTIAL_POOL_TESTNET_ABI, recoveryWallet);
    const key = await factory.poolKey(
      token0Address,
      token1Address,
      decimals0,
      decimals1,
      feeBps,
      initializationStrategyAddress,
    );
    if (
      ethers.getAddress(await factory.getPool(key)) !== ethers.getAddress(poolResource.address) ||
      !(await factory.isPool(poolResource.address)) ||
      ethers.getAddress(await pool.token0()) !== token0Address ||
      ethers.getAddress(await pool.token1()) !== token1Address ||
      Number(await pool.feeBps()) !== feeBps ||
      ethers.getAddress(await pool.initializationStrategy()) !==
        initializationStrategyAddress ||
      ethers.getAddress(await pool.bootstrapper()) !== factoryAddress
    ) throw new Error("launchpad pool recovery canonical provenance changed");
    const recoveryTransactionHash = await exitAllLaunchpadShares(
      pool,
      recoveryWallet,
      configuredLaunchpadProof
        ? "full configured launchpad-pool exit"
        : "full disposable launchpad-pool exit",
    );
    const token0 = new Contract(token0Address, PRIVATE_ERC20_TESTNET_ABI, recoveryWallet);
    const token1 = new Contract(token1Address, PRIVATE_ERC20_TESTNET_ABI, recoveryWallet);
    if (
      await readPrivateBalance(token0, poolResource.address, recoveryWallet) !== 0n ||
      await readPrivateBalance(token1, poolResource.address, recoveryWallet) !== 0n ||
      Boolean(await pool.initialized())
    ) throw new Error("disposable launchpad pool recovery left private-token residue");
    recoveryJournal.markRecovered(
      POOL_RESOURCE_ID,
      [recoveryTransactionHash ?? poolResource.creationTransactionHash],
    );
  }

  if (stack) {
    await verifyRecoveryResourceCreation(recoveryJournal, stack, hardhatEthers.provider);
    if (stack.kind !== "launchpad-stack") {
      throw new Error("unsupported launchpad stack recovery resource");
    }
    const migratorAddress = metadataAddress(stack, "migratorAddress");
    const token0Address = metadataAddress(stack, "token0Address");
    const token1Address = metadataAddress(stack, "token1Address");
    const token0 = new Contract(token0Address, PRIVATE_ERC20_TESTNET_ABI, recoveryWallet);
    const token1 = new Contract(token1Address, PRIVATE_ERC20_TESTNET_ABI, recoveryWallet);
    const allowanceReset0 = await clearPrivateAllowance(
      token0,
      token0Address,
      migratorAddress,
      recoveryWallet,
      "launchpad token0 allowance recovery",
    );
    const allowanceReset1 = await clearPrivateAllowance(
      token1,
      token1Address,
      migratorAddress,
      recoveryWallet,
      "launchpad token1 allowance recovery",
    );
    if (
      await readPrivateAllowance(token0, recoveryOwner, migratorAddress, recoveryWallet) !== 0n ||
      await readPrivateAllowance(token1, recoveryOwner, migratorAddress, recoveryWallet) !== 0n
    ) throw new Error("launchpad allowance recovery left private allowance");
    const allowanceResetHashes = [allowanceReset0, allowanceReset1].filter(
      (hash): hash is string => Boolean(hash),
    );
    recoveryJournal.markRecovered(
      STACK_RESOURCE_ID,
      allowanceResetHashes.length > 0
        ? allowanceResetHashes
        : [stack.creationTransactionHash],
    );
  }
}

async function main(): Promise<void> {
  const privateKey = requiredPrivateKey();
  const launchAuthorityPrivateKey = requiredPrivateKey("COTI_QUOTE_PRIVATE_KEY");
  const aesKey = process.env.COTI_AES_KEY?.trim();
  if (!aesKey) throw new Error("missing COTI_AES_KEY");

  const tokenA = requiredAddress("COTI_TOKEN0");
  const tokenB = requiredAddress("COTI_TOKEN1");
  const configuredFactory = requiredAddress("COTI_FACTORY");
  const configuredFeeVault = requiredAddress("COTI_FEE_VAULT");
  const configuredProofValue = process.env.CIPHERDEX_CONFIGURED_LAUNCHPAD_PROOF?.trim();
  if (configuredProofValue && configuredProofValue !== "1") {
    throw new Error("CIPHERDEX_CONFIGURED_LAUNCHPAD_PROOF must be 1 when set");
  }
  const configuredProof = configuredProofValue === "1";
  configuredLaunchpadProof = configuredProof;
  const network = await hardhatEthers.provider.getNetwork();
  if (network.chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(`expected COTI testnet ${EXPECTED_CHAIN_ID}, received ${network.chainId}`);
  }
  const launchAuthority = new FundedWallet(
    launchAuthorityPrivateKey,
    hardhatEthers.provider,
  );
  const wallet = new CotiWallet(privateKey, hardhatEthers.provider, { aesKey });
  wallet.setAesKey(aesKey);
  const walletAddress = await wallet.getAddress();
  const launchAuthorityAddress = await launchAuthority.getAddress();
  const deployer = wallet;
  if (launchAuthorityAddress.toLowerCase() === walletAddress.toLowerCase()) {
    throw new Error("launch authority must be distinct from the pool creator");
  }
  stage = "reviewed deployment provenance";
  const deploymentRecord = await verifyConfiguredTestnetDeployment(
    requiredTestnetDeploymentRecordPath(),
    hardhatEthers.provider,
    [
      {
        recordKey: "confidentialFactory",
        contractName: "ConfidentialCPMMFactory",
        address: configuredFactory,
      },
      {
        recordKey: "feeVault",
        contractName: "CipherDEXFeeVault",
        address: configuredFeeVault,
      },
    ],
  );
  const configuredFactoryContract = new Contract(
    configuredFactory,
    CONFIDENTIAL_FACTORY_TESTNET_ABI,
    hardhatEthers.provider,
  );
  await assertCompatiblePrivateTokens(configuredFactoryContract, [tokenA, tokenB]);
  const [tokenACode, tokenBCode] = await Promise.all([
    hardhatEthers.provider.getCode(tokenA),
    hardhatEthers.provider.getCode(tokenB),
  ]);
  const tokenACodehash = ethers.keccak256(tokenACode).toLowerCase();
  const tokenBCodehash = ethers.keccak256(tokenBCode).toLowerCase();
  if (
    configuredProof &&
    (
      tokenACodehash === "0xcd4b4b3329cd64190c49fdfbe7feb3b2a81cfcb50c36f50d4d603c76906589b2" ||
      tokenACodehash === "0xf5ce6496ad15db187e8fe1516468c34ed3740a2aab043fcec60be7b05a4a161c" ||
      tokenBCodehash === "0xcd4b4b3329cd64190c49fdfbe7feb3b2a81cfcb50c36f50d4d603c76906589b2" ||
      tokenBCodehash === "0xf5ce6496ad15db187e8fe1516468c34ed3740a2aab043fcec60be7b05a4a161c" ||
      tokenACodehash === tokenBCodehash
    )
  ) {
    throw new Error("configured launchpad proof requires two distinct non-reference runtimes");
  }
  const decimalsA = requiredUInt("COTI_TOKEN0_DECIMALS");
  const decimalsB = requiredUInt("COTI_TOKEN1_DECIMALS");
  stage = "onchain private-token decimal validation";
  const tokenARead = new Contract(tokenA, PRIVATE_ERC20_TESTNET_ABI, wallet);
  const tokenBRead = new Contract(tokenB, PRIVATE_ERC20_TESTNET_ABI, wallet);
  const [onchainDecimalsAValue, onchainDecimalsBValue] = await Promise.all([
    tokenARead.decimals(),
    tokenBRead.decimals(),
  ]);
  const onchainDecimalsA = Number(onchainDecimalsAValue);
  const onchainDecimalsB = Number(onchainDecimalsBValue);
  if (
    decimalsA > 18 ||
    decimalsB > 18 ||
    onchainDecimalsA !== decimalsA ||
    onchainDecimalsB !== decimalsB
  ) {
    throw new Error("configured private-token decimals do not match reviewed onchain metadata");
  }
  const feeBps = requiredUInt("COTI_LAUNCHPAD_FEE_BPS", 30);
  const [availableA, availableB] = await Promise.all([
    readPrivateBalance(tokenARead, walletAddress, wallet),
    readPrivateBalance(tokenBRead, walletAddress, wallet),
  ]);
  const minimumSeedAmount = minimumInputWithProtocolFee(feeBps) * 20n;
  const suppliedAmountA = deriveFundedTestAmount(
    availableA,
    minimumSeedAmount,
  ).amount;
  const suppliedAmountB = deriveFundedTestAmount(
    availableB,
    minimumSeedAmount,
  ).amount;
  const [canonicalToken0, canonicalToken1, canonicalDecimals0, canonicalDecimals1] =
    tokenA.toLowerCase() < tokenB.toLowerCase()
      ? [tokenA, tokenB, decimalsA, decimalsB] as const
      : [tokenB, tokenA, decimalsB, decimalsA] as const;
  const [amount0, amount1] = tokenA.toLowerCase() < tokenB.toLowerCase()
    ? [suppliedAmountA, suppliedAmountB]
    : [suppliedAmountB, suppliedAmountA];
  const normalized0 = scaleTo18(amount0, canonicalDecimals0);
  const normalized1 = scaleTo18(amount1, canonicalDecimals1);
  if (normalized0 === 0n || normalized1 === 0n) throw new Error("launchpad amounts must be positive");

  const ratioNumerator = normalized1 * 10n ** 18n;
  const minDerivedPrice = ratioNumerator / normalized0;
  const maxDerivedPrice = (ratioNumerator + normalized0 - 1n) / normalized0;
  const minShares = optionalBigInt("COTI_LAUNCHPAD_MIN_SHARES", 0n);
  const minPrice = optionalBigInt("COTI_LAUNCHPAD_MIN_PRICE_X18", minDerivedPrice);
  const maxPrice = optionalBigInt("COTI_LAUNCHPAD_MAX_PRICE_X18", maxDerivedPrice);
  const disposition = optionalDisposition();
  if (disposition !== undefined && disposition !== 0) {
    throw new Error(
      "funded launchpad validation requires creator-held LP so every disposable asset can be recovered",
    );
  }
  const unlockTime = 0n;
  if (process.env.COTI_LAUNCHPAD_UNLOCK_TIME) {
    throw new Error("funded creator-held launchpad validation does not accept an unlock time");
  }

  const sourceCommit = deploymentRecord.sourceCommit;
  recoveryJournal = openFundedRecoveryJournal(privateKey, {
    runner: configuredProof ? "configured-launchpad" : "launchpad",
    sourceCommit,
    chainId: Number(network.chainId),
    owner: walletAddress,
    directory: requiredFundedRecoveryDirectory(),
    deployment: await createFundedDeploymentBinding(deploymentRecord),
  });
  recoveryWallet = wallet;
  recoveryOwner = walletAddress;
  const unresolved = await recoveryJournal.reconcileTransactions(hardhatEthers.provider);
  if (unresolved.length > 0) {
    throw new Error(
      `funded launchpad recovery has ${unresolved.length} transaction(s) with unknown outcome; do not retry`,
    );
  }
  await recoverPrivateAllowanceObligations({
    journal: recoveryJournal,
    wallets: [wallet],
    overrides: { gasLimit: COTI_TESTNET_TX_GAS_LIMIT },
    submit,
  });
  if (
    recoveryJournal.runStatus === "evidence-pending" ||
    recoveryJournal.runStatus === "evidence-failed"
  ) {
    const finalEvidence = await writePreparedFundedRunEvidence({
      journal: recoveryJournal,
      provider: hardhatEthers.provider,
      attestationSigner: wallet,
    });
    console.log(`fundedEvidence=${finalEvidence.path}`);
    return;
  }
  if (recoveryJournal.activeResources.length > 0) {
    await recoverLaunchpadResources();
    recoveryJournal.markRun("failed");
    throw new Error("interrupted launchpad proof was recovered; rerun from a fresh journal");
  }

  let feeVaultDeployment: any;
  let feeVault: any;
  let lpTokenFactoryDeployment: any;
  let lpTokenFactory: any;
  let strategyRegistryDeployment: any;
  let strategyRegistry: any;
  let strategyRegistryRuntimeCodehash: string;
  let poolDeployerDeployment: any;
  let poolDeployer: any;
  let poolDeployerRuntimeCodehash: string;
  let factoryDeployment: any;
  let factory: any;
  let factoryAddress: string;
  let strategyDeployment: any;
  let strategy: any;
  let initializationStrategyAddress: string;
  let migratorAddress: string;
  let migrator: any;
  const strategyArtifact = await artifacts.readArtifact(
    "ConfidentialLaunchInitializationStrategy",
  );
  const reviewedStrategyRuntimeCodehash = ethers.keccak256(
    strategyArtifact.deployedBytecode,
  );

  if (configuredProof) {
    const contracts = deploymentRecord.contracts as Readonly<
      Record<string, Record<string, unknown>>
    >;
    feeVaultDeployment = await configuredDeploymentHandle(
      contracts,
      "feeVault",
      "CipherDEXFeeVault",
      wallet,
    );
    lpTokenFactoryDeployment = await configuredDeploymentHandle(
      contracts,
      "confidentialLpTokenFactory",
      "PrivateLPTokenFactory",
      wallet,
    );
    strategyRegistryDeployment = await configuredDeploymentHandle(
      contracts,
      "confidentialInitializationStrategyRegistry",
      "ConfidentialInitializationStrategyRegistry",
      wallet,
    );
    poolDeployerDeployment = await configuredDeploymentHandle(
      contracts,
      "confidentialPoolDeployer",
      "ConfidentialCPMMDeployer",
      wallet,
    );
    factoryDeployment = await configuredDeploymentHandle(
      contracts,
      "confidentialFactory",
      "ConfidentialCPMMFactory",
      wallet,
    );
    strategyDeployment = await configuredDeploymentHandle(
      contracts,
      "confidentialLaunchInitializationStrategy",
      "ConfidentialLaunchInitializationStrategy",
      wallet,
    );
    feeVault = feeVaultDeployment.contract;
    lpTokenFactory = lpTokenFactoryDeployment.contract;
    strategyRegistry = strategyRegistryDeployment.contract;
    poolDeployer = poolDeployerDeployment.contract;
    factory = factoryDeployment.contract;
    factoryAddress = factoryDeployment.address;
    strategy = strategyDeployment.contract;
    initializationStrategyAddress = strategyDeployment.address;
    strategyRegistryRuntimeCodehash = ethers.keccak256(
      await hardhatEthers.provider.getCode(strategyRegistryDeployment.address),
    );
    poolDeployerRuntimeCodehash = ethers.keccak256(
      await hardhatEthers.provider.getCode(poolDeployerDeployment.address),
    );
    migratorAddress = ethers.getAddress(String(await strategy.migrator()));
    migrator = await hardhatEthers.getContractAt(
      "ConfidentialLaunchpadMigrator",
      migratorAddress,
      wallet,
    );
    if (
      factoryAddress !== configuredFactory ||
      feeVaultDeployment.address !== configuredFeeVault ||
      ethers.getAddress(String(await factory.initializationStrategyAt(1))) !==
        initializationStrategyAddress ||
      ethers.keccak256(await hardhatEthers.provider.getCode(initializationStrategyAddress)) !==
        reviewedStrategyRuntimeCodehash
    ) {
      throw new Error("configured launchpad stack does not match the reviewed deployment");
    }
  } else {
  const feeVaultFactory = await hardhatEthers.getContractFactory("CipherDEXFeeVault", deployer);
  feeVaultDeployment = await deployFunded(
    "fee vault deployment",
    () => feeVaultFactory.deploy(walletAddress, { gasLimit: FEE_VAULT_DEPLOY_GAS_LIMIT }),
  );
  feeVault = feeVaultDeployment.contract;
  await verifyDeployedRuntimeArtifact("CipherDEXFeeVault", feeVaultDeployment.address);
  const privateLpFactory = await hardhatEthers.getContractFactory("PrivateLPTokenFactory", deployer);
  lpTokenFactoryDeployment = await deployFunded(
    "private LP token factory deployment",
    () => privateLpFactory.deploy({ gasLimit: PRIVATE_LP_FACTORY_DEPLOY_GAS_LIMIT }),
  );
  lpTokenFactory = lpTokenFactoryDeployment.contract;
  await verifyDeployedRuntimeArtifact(
    "PrivateLPTokenFactory",
    lpTokenFactoryDeployment.address,
  );
  const strategyRegistryFactory = await hardhatEthers.getContractFactory(
    "ConfidentialInitializationStrategyRegistry",
    deployer,
  );
  strategyRegistryDeployment = await deployFunded(
    "initialization strategy registry deployment",
    () => strategyRegistryFactory.deploy(
      [reviewedStrategyRuntimeCodehash],
      { gasLimit: STRATEGY_REGISTRY_DEPLOY_GAS_LIMIT },
    ),
  );
  strategyRegistry = strategyRegistryDeployment.contract;
  await verifyDeployedRuntimeArtifact(
    "ConfidentialInitializationStrategyRegistry",
    strategyRegistryDeployment.address,
  );
  strategyRegistryRuntimeCodehash = ethers.keccak256(
    await hardhatEthers.provider.getCode(strategyRegistryDeployment.address),
  );

  const poolDeployerFactory = await hardhatEthers.getContractFactory(
    "ConfidentialCPMMDeployer",
    deployer,
  );
  poolDeployerDeployment = await deployFunded(
    "confidential pool deployer deployment",
    () => poolDeployerFactory.deploy({ gasLimit: POOL_DEPLOYER_DEPLOY_GAS_LIMIT }),
  );
  poolDeployer = poolDeployerDeployment.contract;
  await verifyDeployedRuntimeArtifact(
    "ConfidentialCPMMDeployer",
    poolDeployerDeployment.address,
  );
  poolDeployerRuntimeCodehash = ethers.keccak256(
    await hardhatEthers.provider.getCode(poolDeployerDeployment.address),
  );

  const factoryFactory = await hardhatEthers.getContractFactory("ConfidentialCPMMFactory", deployer);
  factoryDeployment = await deployFunded(
    "confidential factory deployment",
    async () => factoryFactory.deploy(
      feeVaultDeployment.address,
      lpTokenFactoryDeployment.address,
      poolDeployerDeployment.address,
      poolDeployerRuntimeCodehash,
      strategyRegistryDeployment.address,
      strategyRegistryRuntimeCodehash,
      { gasLimit: CONFIDENTIAL_FACTORY_DEPLOY_GAS_LIMIT },
    ),
  );
  factory = factoryDeployment.contract;
  factoryAddress = factoryDeployment.address;
  await verifyDeployedRuntimeArtifact("ConfidentialCPMMFactory", factoryAddress);
  await submit(
    "confidential fee-vault factory binding",
    () => feeVault.setConfidentialFactory(factoryAddress, {
      gasLimit: FEE_VAULT_BIND_GAS_LIMIT,
    }),
  );
  if ((await feeVault.confidentialFactory()).toLowerCase() !== factoryAddress.toLowerCase()) {
    throw new Error("fee vault did not bind the confidential factory");
  }

  await submit(
    "pool deployer factory binding",
    () => poolDeployer.bindFactory(factoryAddress, { gasLimit: STACK_BIND_GAS_LIMIT }),
  );
  await submit(
    "strategy registry factory binding",
    () => strategyRegistry.bindFactory(factoryAddress, { gasLimit: STACK_BIND_GAS_LIMIT }),
  );

  const strategyFactory = await hardhatEthers.getContractFactory(
    "ConfidentialLaunchInitializationStrategy",
    deployer,
  );
  strategyDeployment = await deployFunded(
    "launch initialization strategy deployment",
    () => strategyFactory.deploy(
      factoryAddress,
      strategyRegistryDeployment.address,
      launchAuthorityAddress,
      { gasLimit: INITIALIZATION_STRATEGY_DEPLOY_GAS_LIMIT },
    ),
  );
  strategy = strategyDeployment.contract;
  initializationStrategyAddress = strategyDeployment.address;
  await verifyDeployedRuntimeArtifact(
    "ConfidentialLaunchInitializationStrategy",
    initializationStrategyAddress,
  );
  if (
    ethers.keccak256(
      await hardhatEthers.provider.getCode(initializationStrategyAddress),
    ) !== reviewedStrategyRuntimeCodehash
  ) {
    throw new Error("deployed initialization strategy codehash is not reviewed");
  }

  migratorAddress = ethers.getAddress(String(await strategy.migrator()));
  migrator = await hardhatEthers.getContractAt(
    "ConfidentialLaunchpadMigrator",
    migratorAddress,
    deployer,
  );
  await verifyDeployedRuntimeArtifact("ConfidentialLaunchpadMigrator", migratorAddress);
  await submit(
    "initialization strategy registration",
    () => strategyRegistry.registerInitializationStrategy(
      initializationStrategyAddress,
      { gasLimit: STACK_BIND_GAS_LIMIT },
    ),
  );
  await submit(
    "initialization strategy registry finalization",
    () => strategyRegistry.finalize({ gasLimit: STACK_BIND_GAS_LIMIT }),
  );

  if ((await strategy.migrator()).toLowerCase() !== migratorAddress.toLowerCase()) {
    throw new Error("initialization strategy did not bind its migrator");
  }
  console.log(`disposable launchpad factory deployed: ${factoryAddress}`);
  console.log(`disposable launch strategy deployed: ${initializationStrategyAddress}`);
  console.log(`disposable launchpad migrator deployed: ${migratorAddress}`);

  recoveryJournal.recordResource({
    id: STACK_RESOURCE_ID,
    kind: "launchpad-stack",
    address: factoryAddress,
    creationTransactionHash: factoryDeployment.transactionHash,
    metadata: {
      factoryAddress,
      migratorAddress,
      initializationStrategyAddress,
      launchAuthorityAddress,
      token0Address: canonicalToken0,
      token1Address: canonicalToken1,
      decimals0: canonicalDecimals0,
      decimals1: canonicalDecimals1,
      feeBps,
      feeVaultAddress: feeVaultDeployment.address,
      lpFactoryAddress: lpTokenFactoryDeployment.address,
      poolDeployerAddress: poolDeployerDeployment.address,
      strategyRegistryAddress: strategyRegistryDeployment.address,
      feeVaultTx: feeVaultDeployment.transactionHash,
      lpFactoryTx: lpTokenFactoryDeployment.transactionHash,
      factoryTx: factoryDeployment.transactionHash,
      poolDeployerTx: poolDeployerDeployment.transactionHash,
      strategyRegistryTx: strategyRegistryDeployment.transactionHash,
      strategyTx: strategyDeployment.transactionHash,
      migratorTx: strategyDeployment.transactionHash,
    },
  });
  }

  const token0 = new Contract(canonicalToken0, PRIVATE_ERC20_TESTNET_ABI, wallet);
  const token1 = new Contract(canonicalToken1, PRIVATE_ERC20_TESTNET_ABI, wallet);
  const migrateSelector = migrator.interface
    .getFunction(disposition === undefined ? "migrate" : "migrateWithDisposition")?.selector;
  if (!migrateSelector) {
    throw new Error("required selector unavailable");
  }

  const canonicalPoolKey = await factory.poolKey(
    canonicalToken0,
    canonicalToken1,
    canonicalDecimals0,
    canonicalDecimals1,
    feeBps,
    initializationStrategyAddress,
  );
  if (await factory.getPool(canonicalPoolKey) !== ethers.ZeroAddress) {
    throw new Error("launchpad proof requires an empty canonical pool slot");
  }
  const launchDeadlineBlock = await hardhatEthers.provider.getBlock("latest");
  if (!launchDeadlineBlock) throw new Error("latest COTI block unavailable for launch deadline");
  const deadline = futureChainDeadline(
    launchDeadlineBlock.timestamp,
    FUNDED_LAUNCHPAD_DEADLINE_WINDOW_SECONDS,
  );
  const launchId = ethers.hexlify(ethers.randomBytes(32));
  const launchCommitment = {
    launchId,
    creator: walletAddress,
    token0: canonicalToken0,
    token1: canonicalToken1,
    decimals0: canonicalDecimals0,
    decimals1: canonicalDecimals1,
    feeBps,
    privacyMode: 1,
    poolVersion: 3,
    factory: factoryAddress,
    migrator: migratorAddress,
    initializationStrategy: initializationStrategyAddress,
    launchAuthority: launchAuthorityAddress,
    chainId: network.chainId,
    authorizationDeadline: deadline,
    migrationDeadline: deadline,
  } as const;
  const launchDomain = {
    ...LAUNCH_INITIALIZATION_EIP712_DOMAIN,
    chainId: network.chainId,
    verifyingContract: initializationStrategyAddress,
  };
  stage = "launch commitment signing";
  const creatorLaunchAuthorization = await wallet.signTypedData(
    launchDomain,
    { LaunchCommitment: [...LAUNCH_COMMITMENT_EIP712_TYPES] },
    launchCommitment,
  );
  const authorityLaunchAuthorization = await launchAuthority.signTypedData(
    launchDomain,
    { LaunchCommitment: [...LAUNCH_COMMITMENT_EIP712_TYPES] },
    launchCommitment,
  );
  const [predictedPoolAddressValue, launchCommitmentHash] =
    await strategy.commitLaunch.staticCall(
      launchCommitment,
      creatorLaunchAuthorization,
      authorityLaunchAuthorization,
    );
  const predictedPoolAddress = ethers.getAddress(predictedPoolAddressValue);
  if (await hardhatEthers.provider.getCode(predictedPoolAddress) !== "0x") {
    throw new Error("predicted protected pool address is already deployed");
  }
  stage = "launch commitment";
  const launchCommitmentTransaction = await submit(
    stage,
    () => strategy.commitLaunch(
      launchCommitment,
      creatorLaunchAuthorization,
      authorityLaunchAuthorization,
      { gasLimit: COTI_TESTNET_TX_GAS_LIMIT },
    ),
  );
  if (
    ethers.getAddress(await factory.getPool(canonicalPoolKey)) !==
      predictedPoolAddress ||
    await hardhatEthers.provider.getCode(predictedPoolAddress) === "0x"
  ) {
    throw new Error("launch commitment did not create the canonical protected pool");
  }
  const committedPool = await hardhatEthers.getContractAt(
    "ConfidentialCPMM",
    predictedPoolAddress,
    wallet,
  );
  if (await committedPool.initialized()) {
    throw new Error("launch commitment unexpectedly initialized the protected pool");
  }
  recoveryJournal.recordResource({
    id: POOL_RESOURCE_ID,
    kind: "launchpad-pool",
    address: predictedPoolAddress,
    creationTransactionHash: launchCommitmentTransaction.transactionHash,
    metadata: {
      factoryAddress,
      migratorAddress,
      initializationStrategyAddress,
      token0Address: canonicalToken0,
      token1Address: canonicalToken1,
      decimals0: canonicalDecimals0,
      decimals1: canonicalDecimals1,
      feeBps,
    },
  });

  await setRecoverablePrivateAllowance({
    journal: journal(), wallet, token: token0, tokenAddress: canonicalToken0,
    spender: migratorAddress, amount: amount0, label: "token0 launchpad approval",
    overrides: { gasLimit: COTI_TESTNET_TX_GAS_LIMIT }, submit,
  });
  await setRecoverablePrivateAllowance({
    journal: journal(), wallet, token: token1, tokenAddress: canonicalToken1,
    spender: migratorAddress, amount: amount1, label: "token1 launchpad approval",
    overrides: { gasLimit: COTI_TESTNET_TX_GAS_LIMIT }, submit,
  });

  stage = "migration input encryption";
  const input0 = await wallet.encryptValue256(amount0, migratorAddress, migrateSelector);
  const input1 = await wallet.encryptValue256(amount1, migratorAddress, migrateSelector);
  const minSharesInput = await wallet.encryptValue256(minShares, migratorAddress, migrateSelector);
  const minPriceInput = await wallet.encryptValue256(minPrice, migratorAddress, migrateSelector);
  const maxPriceInput = await wallet.encryptValue256(maxPrice, migratorAddress, migrateSelector);
  const withDisposition = disposition !== undefined;
  const signAuthorization = (
    signedAmount0: typeof input0,
    signedAmount1: typeof input1,
    signedMinShares: typeof minSharesInput,
    signedMinPrice: typeof minPriceInput,
    signedMaxPrice: typeof maxPriceInput,
  ) => wallet.signTypedData(
      {
        ...LAUNCHPAD_MIGRATOR_EIP712_DOMAIN,
        chainId: network.chainId,
        verifyingContract: migratorAddress,
      },
      { Migration: [...LAUNCHPAD_MIGRATION_EIP712_TYPES] },
      {
        launchId,
        launchCommitmentHash,
        initializationStrategy: initializationStrategyAddress,
        creator: walletAddress,
        tokenA,
        tokenB,
        decimalsA,
        decimalsB,
        feeBps,
        encryptedInputsHash: encryptedInputsHash(
          signedAmount0,
          signedAmount1,
          signedMinShares,
          signedMinPrice,
          signedMaxPrice,
        ),
        deadline,
        withDisposition,
        disposition: disposition ?? 0,
        unlockTime,
      },
    );
  stage = "migration authorization signing";
  const authorization = await signAuthorization(
    input0,
    input1,
    minSharesInput,
    minPriceInput,
    maxPriceInput,
  );
  const migrationRequest = [
    launchId,
    launchCommitmentHash,
    tokenA,
    tokenB,
    decimalsA,
    decimalsB,
    feeBps,
    input0,
    input1,
    minSharesInput,
    minPriceInput,
    maxPriceInput,
    deadline,
    authorization,
  ];

  if (maxDerivedPrice >= ethers.MaxUint256) {
    throw new Error("derived launchpad price leaves no room for a rollback probe");
  }
  const rejectedPrice = maxDerivedPrice + 1n;
  stage = "rollback probe input encryption";
  const rejectedInput0 = await wallet.encryptValue256(amount0, migratorAddress, migrateSelector);
  const rejectedInput1 = await wallet.encryptValue256(amount1, migratorAddress, migrateSelector);
  const rejectedMinSharesInput = await wallet.encryptValue256(
    minShares,
    migratorAddress,
    migrateSelector,
  );
  const rejectedMinPriceInput = await wallet.encryptValue256(
    rejectedPrice,
    migratorAddress,
    migrateSelector,
  );
  const rejectedMaxPriceInput = await wallet.encryptValue256(
    rejectedPrice,
    migratorAddress,
    migrateSelector,
  );
  stage = "rollback probe authorization signing";
  const rejectedAuthorization = await signAuthorization(
    rejectedInput0,
    rejectedInput1,
    rejectedMinSharesInput,
    rejectedMinPriceInput,
    rejectedMaxPriceInput,
  );
  const rejectedRequest = [
    launchId,
    launchCommitmentHash,
    tokenA,
    tokenB,
    decimalsA,
    decimalsB,
    feeBps,
    rejectedInput0,
    rejectedInput1,
    rejectedMinSharesInput,
    rejectedMinPriceInput,
    rejectedMaxPriceInput,
    deadline,
    rejectedAuthorization,
  ];
  if (
    ethers.getAddress(await factory.getPool(canonicalPoolKey)) !==
      predictedPoolAddress ||
    await committedPool.initialized()
  ) {
    throw new Error("launchpad rollback probe requires the committed uninitialized pool");
  }
  stage = "rollback probe balance snapshot";
  const beforeRejected0 = await readPrivateBalance(token0, walletAddress, wallet);
  const beforeRejected1 = await readPrivateBalance(token1, walletAddress, wallet);
  if (beforeRejected0 < amount0 || beforeRejected1 < amount1) {
    throw new Error("configured launchpad amounts exceed the available private balance");
  }
  const rejectedMigration = await expectMinedFailure("rejected launchpad price-bound probe", () =>
    disposition === undefined
      ? migrator.migrate(rejectedRequest, { gasLimit: COTI_TESTNET_TX_GAS_LIMIT })
      : migrator.migrateWithDisposition(rejectedRequest, disposition, unlockTime, {
          gasLimit: COTI_TESTNET_TX_GAS_LIMIT,
        }),
    PRICE_OUTSIDE_BOUNDS_SELECTOR,
  );
  const rejectedBlock = await hardhatEthers.provider.getBlock(
    rejectedMigration.receipt.blockNumber,
  );
  if (!rejectedBlock || BigInt(rejectedBlock.timestamp) > deadline) {
    throw new Error("launchpad price-bound proof mined after its reviewed deadline");
  }
  if (
    ethers.getAddress(await factory.getPool(canonicalPoolKey)) !==
      predictedPoolAddress ||
    await committedPool.initialized()
  ) {
    throw new Error("failed launchpad migration changed the committed pool state");
  }
  if (
    (await readPrivateBalance(token0, walletAddress, wallet)) !== beforeRejected0 ||
    (await readPrivateBalance(token1, walletAddress, wallet)) !== beforeRejected1
  ) {
    throw new Error("failed launchpad migration did not roll back private token pulls");
  }

  stage = "atomic launchpad migration";
  const preMigrationBlock = await hardhatEthers.provider.getBlock("latest");
  if (
    !preMigrationBlock ||
    BigInt(preMigrationBlock.timestamp) + MINIMUM_MIGRATION_SUBMISSION_WINDOW_SECONDS > deadline
  ) {
    throw new Error("launchpad migration deadline window exhausted before submission");
  }
  const migration = await submit(
    stage,
    () => disposition === undefined
      ? migrator.migrate(
          migrationRequest,
          { gasLimit: COTI_TESTNET_TX_GAS_LIMIT },
        )
      : migrator.migrateWithDisposition(
          migrationRequest,
          disposition,
          unlockTime,
          { gasLimit: COTI_TESTNET_TX_GAS_LIMIT },
        ),
  );

  let poolAddress: string | null = null;
  let migrationEventCount = 0;
  let migrationCommitmentMismatch = false;
  let lockDisposition: {
    disposition: number;
    lockId: string;
    unlockTime: bigint;
  } | null = null;
  let dispositionEventCount = 0;
  for (const log of migration.receipt.logs) {
    if (String(log.address).toLowerCase() !== migratorAddress.toLowerCase()) continue;
    try {
      const parsed = migrator.interface.parseLog({ topics: log.topics, data: log.data });
      if (parsed?.name === "LaunchpadMigration") {
        migrationEventCount += 1;
        if (
          String(parsed.args.launchId).toLowerCase() !== launchId.toLowerCase() ||
          ethers.getAddress(String(parsed.args.creator)) !== walletAddress ||
          ethers.getAddress(String(parsed.args.initializationStrategy)) !==
            initializationStrategyAddress ||
          String(parsed.args.launchCommitmentHash).toLowerCase() !==
            String(launchCommitmentHash).toLowerCase()
        ) {
          migrationCommitmentMismatch = true;
        }
        poolAddress = parsed.args.pool as string;
      }
      if (parsed?.name === "LaunchpadLockDisposition") {
        dispositionEventCount += 1;
        lockDisposition = {
          disposition: Number(parsed.args.disposition),
          lockId: parsed.args.lockId as string,
          unlockTime: BigInt(parsed.args.unlockTime),
        };
      }
    } catch {
      // Ignore logs emitted by the factory and token contracts.
    }
  }
  if (
    migrationEventCount !== 1 ||
    migrationCommitmentMismatch ||
    !poolAddress ||
    !ethers.isAddress(poolAddress)
  ) {
    throw new Error("launchpad pool event is missing or ambiguous");
  }
  if (dispositionEventCount > 1) {
    throw new Error("launchpad lock disposition event is ambiguous");
  }
  if (poolAddress.toLowerCase() !== predictedPoolAddress.toLowerCase()) {
    throw new Error("launchpad did not deploy the predicted canonical pool");
  }
  if (disposition === undefined) {
    if (lockDisposition) throw new Error("unexpected launchpad lock disposition event");
  } else {
    if (!lockDisposition) throw new Error("launchpad lock disposition event missing");
    if (lockDisposition.disposition !== 0) throw new Error("launchpad lock disposition mismatch");
    if (lockDisposition.lockId !== ethers.ZeroHash) {
      throw new Error("unexpected creator-held launchpad lock id");
    }
    if (lockDisposition.unlockTime !== 0n) {
      throw new Error("unexpected launchpad unlock time");
    }
  }

  const pool = new Contract(poolAddress, CONFIDENTIAL_POOL_TESTNET_ABI, wallet);
  if (!(await pool.initialized())) throw new Error("launchpad pool was not initialized");
  if (Number(await pool.feeBps()) !== feeBps) {
    throw new Error("launchpad pool total fee does not match the signed tier");
  }
  if ((await pool.feeVault()).toLowerCase() !== feeVaultDeployment.address.toLowerCase()) {
    throw new Error("launchpad pool did not inherit the factory fee vault");
  }
  if (
    ethers.getAddress(await pool.initializationStrategy()) !==
      initializationStrategyAddress
  ) {
    throw new Error("launchpad pool did not preserve its initialization strategy identity");
  }
  if (
    BigInt(await pool.PROTOCOL_FEE_SHARE_NUMERATOR()) !== 1n ||
    BigInt(await pool.PROTOCOL_FEE_SHARE_DENOMINATOR()) !== 6n
  ) {
    throw new Error("launchpad pool did not inherit the v1 protocol fee split");
  }
  const shares = await pool.myShares.staticCall();
  const decryptedShares = await decryptPrivateValue256(wallet, shares);
  if (decryptedShares <= 0n) throw new Error("creator-held launchpad shares were not minted");

  const beforeReplay0 = await readPrivateBalance(token0, walletAddress, wallet);
  const beforeReplay1 = await readPrivateBalance(token1, walletAddress, wallet);
  await expectMinedFailure("launchpad replay probe", () =>
    disposition === undefined
      ? migrator.migrate(migrationRequest, { gasLimit: COTI_TESTNET_TX_GAS_LIMIT })
      : migrator.migrateWithDisposition(migrationRequest, disposition, unlockTime, {
          gasLimit: COTI_TESTNET_TX_GAS_LIMIT,
        }),
    INVALID_LAUNCH_COMMITMENT_SELECTOR,
  );
  if (
    (await readPrivateBalance(token0, walletAddress, wallet)) !== beforeReplay0 ||
    (await readPrivateBalance(token1, walletAddress, wallet)) !== beforeReplay1
  ) {
    throw new Error("rejected launchpad replay changed private token balances");
  }
  if ((await factory.getPool(canonicalPoolKey)).toLowerCase() !== poolAddress.toLowerCase()) {
    throw new Error("launchpad replay changed canonical pool discovery");
  }

  const directSwapAmount = amount0 / 10n;
  if (directSwapAmount < minimumInputWithProtocolFee(feeBps)) {
    throw new Error("balance-derived launchpad seed is too small for a direct swap proof");
  }
  const directNetInput = directSwapAmount * BigInt(10_000 - feeBps) / 10_000n;
  const directProtocolFee = (directSwapAmount - directNetInput) / 6n;
  if (directProtocolFee <= 0n) {
    throw new Error("launchpad direct swap did not produce a protocol fee");
  }
  const quoteSelector = pool.interface.getFunction("requestQuoteExactInput")?.selector;
  const swapSelector = pool.interface.getFunction("swapExactInput")?.selector;
  if (!quoteSelector || !swapSelector) {
    throw new Error("launchpad pool quote or swap selector is unavailable");
  }
  const requestId = ethers.keccak256(ethers.randomBytes(32));
  const quoteInput = await wallet.encryptValue256(
    directSwapAmount,
    poolAddress,
    quoteSelector,
  );
  stage = "launchpad pool direct paid quote";
  const quoteEvidence = await submit(
    stage,
    () => pool.requestQuoteExactInput(
      quoteInput,
      true,
      requestId,
      { gasLimit: COTI_TESTNET_TX_GAS_LIMIT },
    ),
  );
  const quotedOutput = await decryptPrivateValue256(
    wallet,
    encryptedQuoteFromReceipt(
      pool,
      quoteEvidence.receipt,
      walletAddress,
      requestId,
    ) as never,
  );
  if (quotedOutput <= 0n) throw new Error("launchpad pool direct quote returned zero");
  const [directBalanceInBefore, directBalanceOutBefore] = await Promise.all([
    readPrivateBalance(token0, walletAddress, wallet),
    readPrivateBalance(token1, walletAddress, wallet),
  ]);
  await setRecoverablePrivateAllowance({
    journal: journal(),
    wallet,
    token: token0,
    tokenAddress: canonicalToken0,
    spender: poolAddress,
    amount: directSwapAmount,
    label: "launchpad pool direct-swap allowance",
    overrides: { gasLimit: COTI_TESTNET_TX_GAS_LIMIT },
    submit,
  });
  const [swapInput, swapMinimum] = await Promise.all([
    wallet.encryptValue256(directSwapAmount, poolAddress, swapSelector),
    wallet.encryptValue256(
      minimumWithSlippage(quotedOutput),
      poolAddress,
      swapSelector,
    ),
  ]);
  stage = "launchpad pool direct private swap";
  await submit(
    stage,
    () => pool.swapExactInput(
      swapInput,
      swapMinimum,
      true,
      BigInt(Math.floor(Date.now() / 1000) + 600),
      { gasLimit: COTI_TESTNET_TX_GAS_LIMIT },
    ),
  );
  const [directBalanceInAfter, directBalanceOutAfter, directAllowanceAfter] =
    await Promise.all([
      readPrivateBalance(token0, walletAddress, wallet),
      readPrivateBalance(token1, walletAddress, wallet),
      readPrivateAllowance(token0, walletAddress, poolAddress, wallet),
    ]);
  if (
    directBalanceInBefore - directBalanceInAfter !== directSwapAmount ||
    directBalanceOutAfter - directBalanceOutBefore !== quotedOutput ||
    directAllowanceAfter !== 0n
  ) {
    throw new Error("launchpad pool direct swap violated exact balance or allowance deltas");
  }
  await clearPrivateAllowance(
    token0,
    canonicalToken0,
    poolAddress,
    wallet,
    "launchpad pool direct-swap allowance cleanup",
  );

  const partialShares = decryptedShares / 2n;
  if (partialShares <= 0n) throw new Error("launchpad shares are too small for partial removal");
  stage = "protected launchpad pool partial exit";
  await removeLaunchpadShares(pool, wallet, partialShares, stage);
  const remainingShares = await decryptPrivateValue256(
    wallet,
    await pool.myShares.staticCall(),
  );
  if (remainingShares <= 0n || remainingShares >= decryptedShares) {
    throw new Error("protected launchpad partial exit did not reduce private shares");
  }

  stage = "protected launchpad pool first full exit";
  if (!(await exitAllLaunchpadShares(pool, wallet, stage))) {
    throw new Error("protected launchpad pool has no shares for the full-exit proof");
  }
  if (
    Boolean(await pool.initialized()) ||
    !Boolean(await pool.protectedInitializationCompleted())
  ) {
    throw new Error("protected launchpad pool lost its completed initialization history");
  }

  await clearPrivateAllowance(
    token0,
    canonicalToken0,
    poolAddress,
    wallet,
    "token0 protected-pool allowance reset",
  );
  await clearPrivateAllowance(
    token1,
    canonicalToken1,
    poolAddress,
    wallet,
    "token1 protected-pool allowance reset",
  );
  await setRecoverablePrivateAllowance({
    journal: journal(), wallet, token: token0, tokenAddress: canonicalToken0,
    spender: poolAddress, amount: amount0, label: "token0 protected-pool re-seed approval",
    overrides: { gasLimit: COTI_TESTNET_TX_GAS_LIMIT }, submit,
  });
  await setRecoverablePrivateAllowance({
    journal: journal(), wallet, token: token1, tokenAddress: canonicalToken1,
    spender: poolAddress, amount: amount1, label: "token1 protected-pool re-seed approval",
    overrides: { gasLimit: COTI_TESTNET_TX_GAS_LIMIT }, submit,
  });

  const addLiquiditySelector = pool.interface.getFunction("addLiquidity")?.selector;
  if (!addLiquiditySelector) throw new Error("protected-pool add-liquidity selector unavailable");
  stage = "protected pool ordinary re-seed input encryption";
  const [reseedAmount0, reseedAmount1, reseedMinimumShares, reseedMinimumPrice, reseedMaximumPrice] =
    await Promise.all([
      wallet.encryptValue256(amount0, poolAddress, addLiquiditySelector),
      wallet.encryptValue256(amount1, poolAddress, addLiquiditySelector),
      wallet.encryptValue256(minShares, poolAddress, addLiquiditySelector),
      wallet.encryptValue256(minPrice, poolAddress, addLiquiditySelector),
      wallet.encryptValue256(maxPrice, poolAddress, addLiquiditySelector),
    ]);
  stage = "protected pool ordinary re-seed";
  await submit(
    stage,
    () => pool.addLiquidity(
      reseedAmount0,
      reseedAmount1,
      reseedMinimumShares,
      reseedMinimumPrice,
      reseedMaximumPrice,
      false,
      BigInt(Math.floor(Date.now() / 1000) + 600),
      { gasLimit: COTI_TESTNET_TX_GAS_LIMIT },
    ),
  );
  const reseededShares = await decryptPrivateValue256(
    wallet,
    await pool.myShares.staticCall(),
  );
  if (
    !Boolean(await pool.initialized()) ||
    !Boolean(await pool.protectedInitializationCompleted()) ||
    reseededShares <= 0n ||
    (await readPrivateAllowance(token0, walletAddress, poolAddress, wallet)) !== 0n ||
    (await readPrivateAllowance(token1, walletAddress, poolAddress, wallet)) !== 0n
  ) {
    throw new Error("protected pool ordinary re-seed did not preserve lifecycle and allowance invariants");
  }
  await clearPrivateAllowance(
    token0, canonicalToken0, poolAddress, wallet, "token0 protected-pool post-seed cleanup",
  );
  await clearPrivateAllowance(
    token1, canonicalToken1, poolAddress, wallet, "token1 protected-pool post-seed cleanup",
  );

  const lpTokenAddress = ethers.getAddress(await pool.lpToken());
  stage = "launchpad private-asset and allowance recovery";
  await recoverLaunchpadResources();
  if (
    (await readPrivateBalance(token0, walletAddress, wallet)) !==
      beforeRejected0 - directProtocolFee ||
    (await readPrivateBalance(token1, walletAddress, wallet)) !== beforeRejected1 ||
    (await readPrivateAllowance(token0, walletAddress, migratorAddress, wallet)) !== 0n ||
    (await readPrivateAllowance(token1, walletAddress, migratorAddress, wallet)) !== 0n
  ) throw new Error("completed launchpad proof did not restore private balances and allowances");

  const recordedFeeBeneficiary = ethers.getAddress(String(await feeVault.beneficiary()));
  let launchEvidenceConfiguration: Readonly<Record<string, string | number | boolean>>;
  if (configuredProof) {
    launchEvidenceConfiguration = {
      chainId: Number(network.chainId),
      confidentialPoolVersion: 3,
      launchpadMigratorVersion: 4,
      initializationStrategyVersion: 1,
      privacyMode: 1,
      tokenA,
      tokenB,
      tokenACodehash,
      tokenBCodehash,
      feeBps,
      disposition: disposition ?? 0,
      feeBeneficiary: recordedFeeBeneficiary,
      factory: factoryAddress,
      initializationStrategy: initializationStrategyAddress,
      launchpadMigrator: migratorAddress,
      maximumBalanceBps: 10,
    };
  } else {
    launchEvidenceConfiguration = {
      chainId: Number(network.chainId),
      confidentialPoolVersion: 3,
      launchpadMigratorVersion: 4,
      initializationStrategyVersion: 1,
      privacyMode: 1,
      tokenA,
      tokenB,
      feeBps,
      disposition: disposition ?? 0,
      feeBeneficiary: recordedFeeBeneficiary,
    };
  }
  const launchAssertions = [
    "empty protected pool slot verified",
    "dual-authorized launch commitment created one uninitialized protected pool",
    "failed signed alternate-bound launch request rolled back atomically",
    "launchpad migration used canonical pool",
    "LP disposition and lock state verified",
    "replay protection rolled back atomically",
    "direct private quote and swap preserved exact balance and allowance deltas",
    "partial and full LP removal succeeded",
    "completed protected pool remained permissionless after a full exit and ordinary re-seed",
    "private balances and allowances recovered",
    configuredProof
      ? "configured launchpad pool recovered with zero residue"
      : "disposable launchpad pool recovered with zero residue",
  ];
  const launchArtifacts = configuredProof ? [
    {
      label: "configured launchpad fee vault",
      contractName: "CipherDEXFeeVault",
      address: feeVaultDeployment.address,
      creationTransactionHash: feeVaultDeployment.transactionHash,
      constructorArguments: feeVaultDeployment.constructorArguments,
    },
    {
      label: "configured launchpad confidential factory",
      contractName: "ConfidentialCPMMFactory",
      address: factoryAddress,
      creationTransactionHash: factoryDeployment.transactionHash,
      constructorArguments: factoryDeployment.constructorArguments,
    },
    {
      label: "configured launch initialization strategy",
      contractName: "ConfidentialLaunchInitializationStrategy",
      address: initializationStrategyAddress,
      creationTransactionHash: strategyDeployment.transactionHash,
      constructorArguments: strategyDeployment.constructorArguments,
    },
    {
      label: "configured launchpad migrator",
      contractName: "ConfidentialLaunchpadMigrator",
      address: migratorAddress,
    },
    {
      label: "configured launchpad pool",
      contractName: "ConfidentialCPMM",
      address: poolAddress,
    },
    {
      label: "configured launchpad private LP token",
      contractName: "PrivateLPToken",
      address: lpTokenAddress,
    },
  ] : [
    {
      label: "disposable launchpad fee vault",
      contractName: "CipherDEXFeeVault",
      address: feeVaultDeployment.address,
      creationTransactionHash: feeVaultDeployment.transactionHash,
      constructorArguments: [walletAddress],
    },
    {
      label: "disposable launchpad LP factory",
      contractName: "PrivateLPTokenFactory",
      address: lpTokenFactoryDeployment.address,
      creationTransactionHash: lpTokenFactoryDeployment.transactionHash,
      constructorArguments: [],
    },
    {
      label: "disposable launchpad confidential factory",
      contractName: "ConfidentialCPMMFactory",
      address: factoryAddress,
      creationTransactionHash: factoryDeployment.transactionHash,
      constructorArguments: [
        feeVaultDeployment.address,
        lpTokenFactoryDeployment.address,
        poolDeployerDeployment.address,
        poolDeployerRuntimeCodehash,
        strategyRegistryDeployment.address,
        strategyRegistryRuntimeCodehash,
      ],
    },
    {
      label: "disposable launchpad pool deployer",
      contractName: "ConfidentialCPMMDeployer",
      address: poolDeployerDeployment.address,
      creationTransactionHash: poolDeployerDeployment.transactionHash,
      constructorArguments: [],
    },
    {
      label: "disposable launch strategy registry",
      contractName: "ConfidentialInitializationStrategyRegistry",
      address: strategyRegistryDeployment.address,
      creationTransactionHash: strategyRegistryDeployment.transactionHash,
      constructorArguments: [[reviewedStrategyRuntimeCodehash]],
    },
    {
      label: "disposable launch initialization strategy",
      contractName: "ConfidentialLaunchInitializationStrategy",
      address: initializationStrategyAddress,
      creationTransactionHash: strategyDeployment.transactionHash,
      constructorArguments: [
        factoryAddress,
        strategyRegistryDeployment.address,
        launchAuthorityAddress,
      ],
    },
    {
      label: "disposable launchpad migrator",
      contractName: "ConfidentialLaunchpadMigrator",
      address: migratorAddress,
    },
    {
      label: "disposable launchpad pool",
      contractName: "ConfidentialCPMM",
      address: poolAddress,
    },
    {
      label: "disposable launchpad private LP token",
      contractName: "PrivateLPToken",
      address: lpTokenAddress,
    },
  ];
  recoveryJournal.prepareEvidence({
    participants: [walletAddress, launchAuthorityAddress],
    configuration: launchEvidenceConfiguration,
    artifacts: launchArtifacts as any,
    assertions: launchAssertions,
  });
  const finalEvidence = await writePreparedFundedRunEvidence({
    journal: recoveryJournal,
    provider: hardhatEthers.provider,
    attestationSigner: wallet,
  });
  console.log(`launchpad pool: ${poolAddress}`);
  console.log(`fundedEvidence=${finalEvidence.path}`);
  console.log("COTI launchpad migration completed without printing private values.");
}

void main().catch(async (error: unknown) => {
  if (recoveryJournal?.runStatus === "evidence-failed") {
    console.error(
      `COTI launchpad evidence generation failed: ` +
        `${safeTestnetErrorSummary(error)}; paid execution will not be repeated.`,
    );
    process.exitCode = 1;
    return;
  }
  if (error instanceof UnknownBroadcastOutcomeError) {
    recoveryJournal?.markRun("failed");
    console.error(
      `COTI launchpad migration paused with an uncertain broadcast during ${stage}; ` +
        `${safeTestnetErrorSummary(error)}; cleanup is deferred until receipt reconciliation.`,
    );
    process.exitCode = 1;
    return;
  }
  let reportedError = error;
  try {
    await recoverLaunchpadResources();
    recoveryJournal?.markRun("failed");
  } catch (recoveryError) {
    recoveryJournal?.markRun("recovery-failed");
    reportedError = new AggregateError(
      [error, recoveryError],
      "launchpad validation and funded recovery both failed",
    );
  }
  console.error(
    `COTI launchpad migration failed during ${stage}; ` +
      `${safeTestnetErrorSummary(reportedError)}; private payloads were suppressed.`,
  );
  process.exitCode = 1;
});
