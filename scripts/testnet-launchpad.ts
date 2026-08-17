import { Wallet as CotiWallet } from "@coti-io/coti-ethers";
import { Contract, TransactionReceipt, ethers } from "ethers";
import { ethers as hardhatEthers } from "hardhat";
import {
  LAUNCHPAD_MIGRATION_EIP712_TYPES,
  LAUNCHPAD_MIGRATOR_EIP712_DOMAIN,
} from "../sdk/src/index";
import {
  CONFIDENTIAL_POOL_TESTNET_ABI,
  PRIVATE_ERC20_TESTNET_ABI,
} from "./coti-testnet-abi";
import { decryptPrivateValue256 } from "./coti-testnet-values";
import { resolvePrivateTokenCodehashes } from "./private-token-codehashes";
import { verifyDeployedRuntimeArtifact } from "./runtime-artifact";
import {
  FundedRecoveryJournal,
  type RecoveryResource,
  verifyRecoveryResourceCreation,
} from "./funded-recovery-journal";
import { writeFundedRunEvidence } from "./funded-run-evidence";
import { createFundedDeploymentBinding } from "./funded-deployment-binding";
import {
  assertReviewedPrivateTokens,
  requiredTestnetDeploymentRecordPath,
  verifyConfiguredTestnetDeployment,
} from "./testnet-deployment-provenance";
import {
  requireMinedFailure,
  requireMinedSuccess,
  safeTestnetErrorSummary,
  UnknownBroadcastOutcomeError,
} from "./testnet-transaction-evidence";

const FEE_VAULT_DEPLOY_GAS_LIMIT = 2_500_000n;
const PRIVATE_LP_FACTORY_DEPLOY_GAS_LIMIT = 8_000_000n;
const CONFIDENTIAL_FACTORY_DEPLOY_GAS_LIMIT = 8_000_000n;
const FEE_VAULT_BIND_GAS_LIMIT = 250_000n;
const LAUNCHPAD_MIGRATOR_DEPLOY_GAS_LIMIT = 2_500_000n;
const LAUNCHPAD_ADAPTER_BIND_GAS_LIMIT = 250_000n;
const gasLimitText = process.env.COTI_TESTNET_GAS_LIMIT?.trim() ?? "30000000";
if (!/^\d+$/.test(gasLimitText) || BigInt(gasLimitText) === 0n) {
  throw new Error("COTI_TESTNET_GAS_LIMIT must be a positive integer");
}
const COTI_TESTNET_TX_GAS_LIMIT = BigInt(gasLimitText);
const EXPECTED_CHAIN_ID = 7_082_400n;
const STACK_RESOURCE_ID = "launchpad-stack";
const POOL_RESOURCE_ID = "launchpad-pool";

let stage = "configuration";
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

const requiredPrivateKey = (): string => {
  const value = process.env.COTI_TESTNET_PRIVATE_KEY?.trim();
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error("missing COTI_TESTNET_PRIVATE_KEY");
  }
  return value;
};

function journal(): FundedRecoveryJournal {
  if (!recoveryJournal) throw new Error("funded recovery journal is not initialized");
  return recoveryJournal;
}

const optionalBigInt = (name: string, fallback: bigint): bigint => {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`invalid ${name}`);
  return BigInt(value);
};

const defaultTestAmount = (decimals: number): bigint =>
  decimals >= 3 ? 10n ** BigInt(decimals - 3) : 1n;

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
  const evidence = await requireMinedSuccess(
    label,
    operation,
    (hash) => hardhatEthers.provider.getTransactionReceipt(hash),
    (hash) => journal().recordBroadcast(label, hash),
    () => journal().recordSubmission(label),
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
): Promise<void> => {
  stage = label;
  const evidence = await requireMinedFailure(
    label,
    operation,
    (hash) => hardhatEthers.provider.getTransactionReceipt(hash),
    (hash) => journal().recordBroadcast(label, hash),
    () => journal().recordSubmission(label),
  );
  journal().recordTransaction(
    evidence.transactionHash,
    "mined-failure",
    evidence.receipt.blockNumber,
  );
  console.log(`${label}: rejected onchain tx=${evidence.transactionHash}`);
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
): Promise<void> {
  if (await readPrivateAllowance(token, await wallet.getAddress(), spender, wallet) === 0n) return;
  const selector = token.interface.getFunction("approve")?.selector;
  if (!selector) throw new Error("launchpad recovery approval selector unavailable");
  const zeroApproval = await wallet.encryptValue256(0n, tokenAddress, selector);
  await submit(
    label,
    () => token.approve(
      spender,
      zeroApproval,
      { gasLimit: COTI_TESTNET_TX_GAS_LIMIT },
    ),
  );
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
    );
    const poolAddress = ethers.getAddress(await factory.getPool(key));
    const successfulMigrations = recoveryJournal.transactions.filter((transaction) =>
      transaction.label === "atomic launchpad migration" &&
      transaction.status === "mined-success"
    );
    if (successfulMigrations.length > 1) {
      throw new Error("launchpad recovery found multiple successful migrations");
    }
    if (poolAddress === ethers.ZeroAddress) {
      if (successfulMigrations.length !== 0) {
        throw new Error("successful launchpad migration has no canonical pool to recover");
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
        ethers.getAddress(String(event.args.pool)) === poolAddress
      );
      if (matchingCreatedEvents.length !== 1) {
        throw new Error("launchpad recovery cannot uniquely prove canonical pool creation");
      }
      const creationTransactionHash = matchingCreatedEvents[0].transactionHash;
      if (
        successfulMigrations.length === 1 &&
        successfulMigrations[0].hash.toLowerCase() !== creationTransactionHash.toLowerCase()
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
    );
    if (
      ethers.getAddress(await factory.getPool(key)) !== ethers.getAddress(poolResource.address) ||
      !(await factory.isPool(poolResource.address)) ||
      ethers.getAddress(await pool.token0()) !== token0Address ||
      ethers.getAddress(await pool.token1()) !== token1Address ||
      Number(await pool.feeBps()) !== feeBps ||
      ethers.getAddress(await pool.bootstrapper()) !== factoryAddress
    ) throw new Error("launchpad pool recovery canonical provenance changed");
    const shares = await decryptPrivateValue256(
      recoveryWallet,
      await pool.myShares.staticCall(),
    );
    if (shares > 0n) {
      const selector = pool.interface.getFunction("removeLiquidity")?.selector;
      if (!selector) throw new Error("launchpad recovery remove-liquidity selector unavailable");
      const encryptedShares = await recoveryWallet.encryptValue256(
        shares,
        poolResource.address,
        selector,
      );
      const encryptedMinimum0 = await recoveryWallet.encryptValue256(
        1n,
        poolResource.address,
        selector,
      );
      const encryptedMinimum1 = await recoveryWallet.encryptValue256(
        1n,
        poolResource.address,
        selector,
      );
      await submit(
        "full disposable launchpad-pool exit",
        () => pool.removeLiquidity(
          encryptedShares,
          encryptedMinimum0,
          encryptedMinimum1,
          BigInt(Math.floor(Date.now() / 1000) + 600),
          { gasLimit: COTI_TESTNET_TX_GAS_LIMIT },
        ),
      );
    }
    const token0 = new Contract(token0Address, PRIVATE_ERC20_TESTNET_ABI, recoveryWallet);
    const token1 = new Contract(token1Address, PRIVATE_ERC20_TESTNET_ABI, recoveryWallet);
    if (
      await readPrivateBalance(token0, poolResource.address, recoveryWallet) !== 0n ||
      await readPrivateBalance(token1, poolResource.address, recoveryWallet) !== 0n ||
      Boolean(await pool.initialized())
    ) throw new Error("disposable launchpad pool recovery left private-token residue");
    recoveryJournal.markRecovered(POOL_RESOURCE_ID);
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
    await clearPrivateAllowance(
      token0,
      token0Address,
      migratorAddress,
      recoveryWallet,
      "launchpad token0 allowance recovery",
    );
    await clearPrivateAllowance(
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
    recoveryJournal.markRecovered(STACK_RESOURCE_ID);
  }
}

async function main(): Promise<void> {
  const privateKey = requiredPrivateKey();
  const aesKey = process.env.COTI_AES_KEY?.trim();
  if (!aesKey) throw new Error("missing COTI_AES_KEY");

  const tokenA = requiredAddress("COTI_TOKEN0");
  const tokenB = requiredAddress("COTI_TOKEN1");
  const configuredFactory = requiredAddress("COTI_FACTORY");
  const configuredFeeVault = requiredAddress("COTI_FEE_VAULT");
  const network = await hardhatEthers.provider.getNetwork();
  if (network.chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(`expected COTI testnet ${EXPECTED_CHAIN_ID}, received ${network.chainId}`);
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
  assertReviewedPrivateTokens(deploymentRecord, [tokenA, tokenB]);
  const privateTokenCodehashes = await resolvePrivateTokenCodehashes(
    hardhatEthers.provider,
    [tokenA, tokenB],
  );
  const decimalsA = requiredUInt("COTI_TOKEN0_DECIMALS");
  const decimalsB = requiredUInt("COTI_TOKEN1_DECIMALS");
  stage = "onchain private-token decimal validation";
  const tokenARead = new Contract(tokenA, PRIVATE_ERC20_TESTNET_ABI, hardhatEthers.provider);
  const tokenBRead = new Contract(tokenB, PRIVATE_ERC20_TESTNET_ABI, hardhatEthers.provider);
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
  const suppliedAmountA = optionalBigInt(
    "COTI_LAUNCHPAD_AMOUNT0",
    defaultTestAmount(decimalsA),
  );
  const suppliedAmountB = optionalBigInt(
    "COTI_LAUNCHPAD_AMOUNT1",
    defaultTestAmount(decimalsB),
  );
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

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

  const [deployer] = await hardhatEthers.getSigners();
  const wallet = new CotiWallet(privateKey, hardhatEthers.provider, { aesKey });
  wallet.setAesKey(aesKey);
  const walletAddress = await wallet.getAddress();
  if ((await deployer.getAddress()).toLowerCase() !== walletAddress.toLowerCase()) {
    throw new Error("configured deployer and COTI wallet do not match");
  }
  const sourceCommit = deploymentRecord.sourceCommit;
  recoveryJournal = FundedRecoveryJournal.open({
    runner: "launchpad",
    sourceCommit,
    chainId: Number(network.chainId),
    owner: walletAddress,
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
  if (recoveryJournal.activeResources.length > 0) {
    await recoverLaunchpadResources();
    recoveryJournal.markRun("failed");
    throw new Error("interrupted launchpad proof was recovered; rerun from a fresh journal");
  }

  const feeVaultFactory = await hardhatEthers.getContractFactory("CipherDEXFeeVault", deployer);
  const feeVaultDeployment = await deployFunded(
    "fee vault deployment",
    () => feeVaultFactory.deploy(walletAddress, { gasLimit: FEE_VAULT_DEPLOY_GAS_LIMIT }),
  );
  const feeVault = feeVaultDeployment.contract;
  await verifyDeployedRuntimeArtifact("CipherDEXFeeVault", feeVaultDeployment.address);
  const privateLpFactory = await hardhatEthers.getContractFactory("PrivateLPTokenFactory", deployer);
  const lpTokenFactoryDeployment = await deployFunded(
    "private LP token factory deployment",
    () => privateLpFactory.deploy({ gasLimit: PRIVATE_LP_FACTORY_DEPLOY_GAS_LIMIT }),
  );
  const lpTokenFactory = lpTokenFactoryDeployment.contract;
  await verifyDeployedRuntimeArtifact(
    "PrivateLPTokenFactory",
    lpTokenFactoryDeployment.address,
  );
  const factoryFactory = await hardhatEthers.getContractFactory("ConfidentialCPMMFactory", deployer);
  const factoryDeployment = await deployFunded(
    "confidential factory deployment",
    async () => factoryFactory.deploy(
      feeVaultDeployment.address,
      lpTokenFactoryDeployment.address,
      privateTokenCodehashes,
      { gasLimit: CONFIDENTIAL_FACTORY_DEPLOY_GAS_LIMIT },
    ),
  );
  const factory = factoryDeployment.contract;
  const factoryAddress = factoryDeployment.address;
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

  const migratorFactory = await hardhatEthers.getContractFactory("ConfidentialLaunchpadMigrator", deployer);
  const migratorDeployment = await deployFunded(
    "launchpad migrator deployment",
    () => migratorFactory.deploy(factoryAddress, {
      gasLimit: LAUNCHPAD_MIGRATOR_DEPLOY_GAS_LIMIT,
    }),
  );
  const migrator = migratorDeployment.contract;
  const migratorAddress = migratorDeployment.address;
  await verifyDeployedRuntimeArtifact("ConfidentialLaunchpadMigrator", migratorAddress);
  await submit(
    "launchpad adapter binding",
    () => factory.setBootstrapAdapter(migratorAddress, {
      gasLimit: LAUNCHPAD_ADAPTER_BIND_GAS_LIMIT,
    }),
  );

  if ((await factory.bootstrapAdapter()).toLowerCase() !== migratorAddress.toLowerCase()) {
    throw new Error("factory did not bind the launchpad adapter");
  }
  console.log(`disposable launchpad factory deployed: ${factoryAddress}`);
  console.log(`disposable launchpad migrator deployed: ${migratorAddress}`);

  recoveryJournal.recordResource({
    id: STACK_RESOURCE_ID,
    kind: "launchpad-stack",
    address: factoryAddress,
    creationTransactionHash: factoryDeployment.transactionHash,
    metadata: {
      factoryAddress,
      migratorAddress,
      token0Address: canonicalToken0,
      token1Address: canonicalToken1,
      decimals0: canonicalDecimals0,
      decimals1: canonicalDecimals1,
      feeBps,
      feeVaultAddress: feeVaultDeployment.address,
      lpFactoryAddress: lpTokenFactoryDeployment.address,
      feeVaultTx: feeVaultDeployment.transactionHash,
      lpFactoryTx: lpTokenFactoryDeployment.transactionHash,
      factoryTx: factoryDeployment.transactionHash,
      migratorTx: migratorDeployment.transactionHash,
    },
  });

  const token0 = new Contract(canonicalToken0, PRIVATE_ERC20_TESTNET_ABI, wallet);
  const token1 = new Contract(canonicalToken1, PRIVATE_ERC20_TESTNET_ABI, wallet);
  const approveSelector0 = token0.interface.getFunction("approve")?.selector;
  const approveSelector1 = token1.interface.getFunction("approve")?.selector;
  const migrateSelector = migrator.interface
    .getFunction(disposition === undefined ? "migrate" : "migrateWithDisposition")?.selector;
  if (!approveSelector0 || !approveSelector1 || !migrateSelector) {
    throw new Error("required selector unavailable");
  }

  const canonicalPoolKey = await factory.poolKey(
    canonicalToken0,
    canonicalToken1,
    canonicalDecimals0,
    canonicalDecimals1,
    feeBps,
  );
  if (await factory.getPool(canonicalPoolKey) !== ethers.ZeroAddress) {
    throw new Error("launchpad proof requires an empty canonical pool slot");
  }
  const poolFactory = await hardhatEthers.getContractFactory("ConfidentialCPMM", deployer);
  const poolDeployment = await poolFactory.getDeployTransaction(
    canonicalToken0,
    canonicalToken1,
    canonicalDecimals0,
    canonicalDecimals1,
    feeBps,
    await feeVault.getAddress(),
  );
  if (!poolDeployment.data) throw new Error("canonical pool init code unavailable");
  const predictedPoolAddress = ethers.getCreate2Address(
    factoryAddress,
    canonicalPoolKey,
    ethers.keccak256(poolDeployment.data),
  );
  if (await hardhatEthers.provider.getCode(predictedPoolAddress) !== "0x") {
    throw new Error("predicted canonical pool address is already deployed");
  }

  const zeroApproval0 = await wallet.encryptValue256(0n, canonicalToken0, approveSelector0);
  const zeroApproval1 = await wallet.encryptValue256(0n, canonicalToken1, approveSelector1);
  const approval0 = await wallet.encryptValue256(amount0, canonicalToken0, approveSelector0);
  const approval1 = await wallet.encryptValue256(amount1, canonicalToken1, approveSelector1);
  stage = "token0 launchpad approval reset";
  await submit(stage, () => token0.approve(migratorAddress, zeroApproval0, {
    gasLimit: COTI_TESTNET_TX_GAS_LIMIT,
  }));
  stage = "token1 launchpad approval reset";
  await submit(stage, () => token1.approve(migratorAddress, zeroApproval1, {
    gasLimit: COTI_TESTNET_TX_GAS_LIMIT,
  }));
  stage = "token0 launchpad approval";
  await submit(stage, () => token0.approve(migratorAddress, approval0, {
    gasLimit: COTI_TESTNET_TX_GAS_LIMIT,
  }));
  stage = "token1 launchpad approval";
  await submit(stage, () => token1.approve(migratorAddress, approval1, {
    gasLimit: COTI_TESTNET_TX_GAS_LIMIT,
  }));

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
  if (await factory.getPool(canonicalPoolKey) !== ethers.ZeroAddress) {
    throw new Error("launchpad rollback probe requires an empty canonical pool slot");
  }
  stage = "rollback probe balance snapshot";
  const beforeRejected0 = await readPrivateBalance(token0, walletAddress, wallet);
  const beforeRejected1 = await readPrivateBalance(token1, walletAddress, wallet);
  if (beforeRejected0 < amount0 || beforeRejected1 < amount1) {
    throw new Error("configured launchpad amounts exceed the available private balance");
  }
  await expectMinedFailure("rejected launchpad price-bound probe", () =>
    disposition === undefined
      ? migrator.migrate(rejectedRequest, { gasLimit: COTI_TESTNET_TX_GAS_LIMIT })
      : migrator.migrateWithDisposition(rejectedRequest, disposition, unlockTime, {
          gasLimit: COTI_TESTNET_TX_GAS_LIMIT,
        }),
  );
  if (await factory.getPool(canonicalPoolKey) !== ethers.ZeroAddress) {
    throw new Error("failed launchpad migration left a canonical pool behind");
  }
  if (
    (await readPrivateBalance(token0, walletAddress, wallet)) !== beforeRejected0 ||
    (await readPrivateBalance(token1, walletAddress, wallet)) !== beforeRejected1
  ) {
    throw new Error("failed launchpad migration did not roll back private token pulls");
  }

  stage = "atomic launchpad migration";
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
  if (migrationEventCount !== 1 || !poolAddress || !ethers.isAddress(poolAddress)) {
    throw new Error("launchpad pool event is missing or ambiguous");
  }
  if (dispositionEventCount > 1) {
    throw new Error("launchpad lock disposition event is ambiguous");
  }
  if (poolAddress.toLowerCase() !== predictedPoolAddress.toLowerCase()) {
    throw new Error("launchpad did not deploy the predicted canonical pool");
  }
  recoveryJournal.recordResource({
    id: POOL_RESOURCE_ID,
    kind: "launchpad-pool",
    address: ethers.getAddress(poolAddress),
    creationTransactionHash: migration.transactionHash,
    metadata: {
      factoryAddress,
      migratorAddress,
      token0Address: canonicalToken0,
      token1Address: canonicalToken1,
      decimals0: canonicalDecimals0,
      decimals1: canonicalDecimals1,
      feeBps,
    },
  });
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
  const lpTokenAddress = ethers.getAddress(await pool.lpToken());
  stage = "launchpad private-asset and allowance recovery";
  await recoverLaunchpadResources();
  if (
    (await readPrivateBalance(token0, walletAddress, wallet)) !== beforeRejected0 ||
    (await readPrivateBalance(token1, walletAddress, wallet)) !== beforeRejected1 ||
    (await readPrivateAllowance(token0, walletAddress, migratorAddress, wallet)) !== 0n ||
    (await readPrivateAllowance(token1, walletAddress, migratorAddress, wallet)) !== 0n
  ) throw new Error("completed launchpad proof did not restore private balances and allowances");

  recoveryJournal.markRun("passed");
  const finalEvidence = await writeFundedRunEvidence({
    journal: recoveryJournal,
    provider: hardhatEthers.provider,
    participants: [walletAddress],
    configuration: {
      chainId: Number(network.chainId),
      confidentialPoolVersion: 2,
      launchpadMigratorVersion: 3,
      privacyMode: 1,
      tokenA,
      tokenB,
      feeBps,
      disposition: disposition ?? 0,
      feeBeneficiary: walletAddress,
    },
    artifacts: [
      {
        label: "disposable launchpad fee vault",
        contractName: "CipherDEXFeeVault",
        address: feeVaultDeployment.address,
      },
      {
        label: "disposable launchpad LP factory",
        contractName: "PrivateLPTokenFactory",
        address: lpTokenFactoryDeployment.address,
      },
      {
        label: "disposable launchpad confidential factory",
        contractName: "ConfidentialCPMMFactory",
        address: factoryAddress,
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
    ],
    assertions: [
      "empty canonical pool slot verified",
      "price-bound failure rolled back atomically",
      "launchpad migration used canonical pool",
      "LP disposition and lock state verified",
      "replay protection rolled back atomically",
      "private balances and allowances recovered",
      "disposable launchpad pool recovered with zero residue",
    ],
  });
  console.log(`launchpad pool: ${poolAddress}`);
  console.log(`fundedEvidence=${finalEvidence.path}`);
  console.log("COTI launchpad migration completed without printing private values.");
}

void main().catch(async (error: unknown) => {
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
