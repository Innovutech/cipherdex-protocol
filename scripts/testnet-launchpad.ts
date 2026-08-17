import { Wallet as CotiWallet } from "@coti-io/coti-ethers";
import { Contract, TransactionReceipt, ethers } from "ethers";
import { ethers as hardhatEthers } from "hardhat";
import {
  LAUNCHPAD_MIGRATION_EIP712_TYPES,
  LAUNCHPAD_MIGRATOR_EIP712_DOMAIN,
} from "../sdk/src/index";
import {
  CONFIDENTIAL_POOL_TESTNET_ABI,
  CT_UINT256,
  IT_UINT256,
  PRIVATE_ERC20_TESTNET_ABI,
} from "./coti-testnet-abi";
import { decryptPrivateValue256 } from "./coti-testnet-values";
import { resolvePrivateTokenCodehashes } from "./private-token-codehashes";
import {
  requireMinedFailure,
  requireMinedSuccess,
  safeTestnetErrorSummary,
} from "./testnet-transaction-evidence";

const MIGRATOR_ABI = [
  `function migrate((address tokenA,address tokenB,uint8 decimalsA,uint8 decimalsB,uint256 feeBps,${IT_UINT256} amountA,${IT_UINT256} amountB,${IT_UINT256} minShares,${IT_UINT256} minPriceX18,${IT_UINT256} maxPriceX18,uint64 deadline,bytes authorization) request) returns (address pool,${CT_UINT256} shares)`,
  `function migrateWithDisposition((address tokenA,address tokenB,uint8 decimalsA,uint8 decimalsB,uint256 feeBps,${IT_UINT256} amountA,${IT_UINT256} amountB,${IT_UINT256} minShares,${IT_UINT256} minPriceX18,${IT_UINT256} maxPriceX18,uint64 deadline,bytes authorization) request,uint8 disposition,uint64 unlockTime) returns (address pool,${CT_UINT256} shares,bytes32 lockId)`,
  "event LaunchpadMigration(address indexed creator,address indexed pool)",
  "event LaunchpadLockDisposition(address indexed creator,address indexed pool,uint8 disposition,bytes32 lockId,uint64 unlockTime)",
];

const FEE_VAULT_DEPLOY_GAS_LIMIT = 1_000_000n;
const PRIVATE_LP_FACTORY_DEPLOY_GAS_LIMIT = 8_000_000n;
const CONFIDENTIAL_FACTORY_DEPLOY_GAS_LIMIT = 8_000_000n;
const LAUNCHPAD_MIGRATOR_DEPLOY_GAS_LIMIT = 2_500_000n;
const LAUNCHPAD_ADAPTER_BIND_GAS_LIMIT = 250_000n;
const gasLimitText = process.env.COTI_TESTNET_GAS_LIMIT?.trim() ?? "30000000";
if (!/^\d+$/.test(gasLimitText) || BigInt(gasLimitText) === 0n) {
  throw new Error("COTI_TESTNET_GAS_LIMIT must be a positive integer");
}
const COTI_TESTNET_TX_GAS_LIMIT = BigInt(gasLimitText);

let stage = "configuration";

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

const requiredBigInt = (name: string): bigint => {
  const value = process.env[name]?.trim();
  if (!value || !/^\d+$/.test(value)) throw new Error(`missing ${name}`);
  return BigInt(value);
};

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
  transaction: Promise<{ hash: string; wait(): Promise<any> }>,
): Promise<any> => {
  const started = Date.now();
  const evidence = await requireMinedSuccess(
    label,
    () => transaction,
    (hash) => hardhatEthers.provider.getTransactionReceipt(hash),
  );
  const receipt = evidence.receipt;
  console.log(
    `${label}: tx=${evidence.transactionHash} gas=${receipt.gasUsed.toString()} ` +
      `latencyMs=${Date.now() - started}`,
  );
  return receipt;
};

const deployFunded = async (
  label: string,
  operation: () => Promise<any>,
): Promise<any> => {
  let contract: any;
  await submit(
    label,
    (async () => {
      contract = await operation();
      const transaction = contract.deploymentTransaction();
      if (!transaction) throw new Error(`${label} transaction unavailable`);
      return transaction;
    })(),
  );
  if (!contract) {
    throw new Error(`${label} mined without a contract handle; do not retry automatically`);
  }
  return contract;
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

async function main(): Promise<void> {
  const privateKey = requiredPrivateKey();
  const aesKey = process.env.COTI_AES_KEY?.trim();
  if (!aesKey) throw new Error("missing COTI_AES_KEY");

  const tokenA = requiredAddress("COTI_TOKEN0");
  const tokenB = requiredAddress("COTI_TOKEN1");
  const privateTokenCodehashes = await resolvePrivateTokenCodehashes(
    hardhatEthers.provider,
    [tokenA, tokenB],
  );
  const decimalsA = requiredUInt("COTI_TOKEN0_DECIMALS");
  const decimalsB = requiredUInt("COTI_TOKEN1_DECIMALS");
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
  const unlockTime = disposition === 1
    ? requiredBigInt("COTI_LAUNCHPAD_UNLOCK_TIME")
    : 0n;
  if (disposition === 1 && unlockTime <= BigInt(Math.floor(Date.now() / 1000))) {
    throw new Error("COTI_LAUNCHPAD_UNLOCK_TIME must be in the future");
  }
  if (disposition !== undefined && disposition !== 1 && process.env.COTI_LAUNCHPAD_UNLOCK_TIME) {
    throw new Error("COTI_LAUNCHPAD_UNLOCK_TIME is only valid for a timed lock");
  }

  const [deployer] = await hardhatEthers.getSigners();
  const wallet = new CotiWallet(privateKey, hardhatEthers.provider, { aesKey });
  const walletAddress = await wallet.getAddress();
  if ((await deployer.getAddress()).toLowerCase() !== walletAddress.toLowerCase()) {
    throw new Error("configured deployer and COTI wallet do not match");
  }

  const feeVaultFactory = await hardhatEthers.getContractFactory("CipherDEXFeeVault", deployer);
  const feeVault = await deployFunded(
    "fee vault deployment",
    () => feeVaultFactory.deploy(walletAddress, { gasLimit: FEE_VAULT_DEPLOY_GAS_LIMIT }),
  );
  const privateLpFactory = await hardhatEthers.getContractFactory("PrivateLPTokenFactory", deployer);
  const lpTokenFactory = await deployFunded(
    "private LP token factory deployment",
    () => privateLpFactory.deploy({ gasLimit: PRIVATE_LP_FACTORY_DEPLOY_GAS_LIMIT }),
  );
  const factoryFactory = await hardhatEthers.getContractFactory("ConfidentialCPMMFactory", deployer);
  const factory = await deployFunded(
    "confidential factory deployment",
    async () => factoryFactory.deploy(
      await feeVault.getAddress(),
      await lpTokenFactory.getAddress(),
      privateTokenCodehashes,
      { gasLimit: CONFIDENTIAL_FACTORY_DEPLOY_GAS_LIMIT },
    ),
  );
  const factoryAddress = await factory.getAddress();

  const migratorFactory = await hardhatEthers.getContractFactory("ConfidentialLaunchpadMigrator", deployer);
  const migratorDeployment = await deployFunded(
    "launchpad migrator deployment",
    () => migratorFactory.deploy(factoryAddress, {
      gasLimit: LAUNCHPAD_MIGRATOR_DEPLOY_GAS_LIMIT,
    }),
  );
  const migratorAddress = await migratorDeployment.getAddress();
  await submit(
    "launchpad adapter binding",
    factory.setBootstrapAdapter(migratorAddress, {
      gasLimit: LAUNCHPAD_ADAPTER_BIND_GAS_LIMIT,
    }),
  );

  if ((await factory.bootstrapAdapter()).toLowerCase() !== migratorAddress.toLowerCase()) {
    throw new Error("factory did not bind the launchpad adapter");
  }
  console.log(`factory deployed: ${factoryAddress}`);
  console.log(`launchpad migrator deployed: ${migratorAddress}`);

  const token0 = new Contract(canonicalToken0, PRIVATE_ERC20_TESTNET_ABI, wallet);
  const token1 = new Contract(canonicalToken1, PRIVATE_ERC20_TESTNET_ABI, wallet);
  const approveSelector0 = token0.interface.getFunction("approve")?.selector;
  const approveSelector1 = token1.interface.getFunction("approve")?.selector;
  const transferSelector0 = token0.interface.getFunction("transfer")?.selector;
  const migrator = new Contract(migratorAddress, MIGRATOR_ABI, wallet);
  const migrateSelector = migrator.interface
    .getFunction(disposition === undefined ? "migrate" : "migrateWithDisposition")?.selector;
  if (!approveSelector0 || !approveSelector1 || !transferSelector0 || !migrateSelector) {
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

  const prefundAmount = 1n;
  const beforePrefund = await readPrivateBalance(token0, walletAddress, wallet);
  if (beforePrefund < amount0 + prefundAmount) {
    throw new Error("token0 balance cannot cover launchpad amount and pre-fund proof");
  }
  const prefundInput = await wallet.encryptValue256(
    prefundAmount,
    canonicalToken0,
    transferSelector0,
  );
  stage = "deterministic pool pre-fund proof";
  await submit(stage, token0.transfer(predictedPoolAddress, prefundInput, {
    gasLimit: COTI_TESTNET_TX_GAS_LIMIT,
  }));
  if ((await readPrivateBalance(token0, walletAddress, wallet)) !== beforePrefund - prefundAmount) {
    throw new Error("deterministic pool pre-fund did not move the exact private amount");
  }
  if (
    await factory.getPool(canonicalPoolKey) !== ethers.ZeroAddress ||
    await hardhatEthers.provider.getCode(predictedPoolAddress) !== "0x"
  ) {
    throw new Error("pre-fund unexpectedly changed canonical pool discovery or deployment");
  }

  const zeroApproval0 = await wallet.encryptValue256(0n, canonicalToken0, approveSelector0);
  const zeroApproval1 = await wallet.encryptValue256(0n, canonicalToken1, approveSelector1);
  const approval0 = await wallet.encryptValue256(amount0, canonicalToken0, approveSelector0);
  const approval1 = await wallet.encryptValue256(amount1, canonicalToken1, approveSelector1);
  stage = "token0 launchpad approval reset";
  await submit(stage, token0.approve(migratorAddress, zeroApproval0, {
    gasLimit: COTI_TESTNET_TX_GAS_LIMIT,
  }));
  stage = "token1 launchpad approval reset";
  await submit(stage, token1.approve(migratorAddress, zeroApproval1, {
    gasLimit: COTI_TESTNET_TX_GAS_LIMIT,
  }));
  stage = "token0 launchpad approval";
  await submit(stage, token0.approve(migratorAddress, approval0, {
    gasLimit: COTI_TESTNET_TX_GAS_LIMIT,
  }));
  stage = "token1 launchpad approval";
  await submit(stage, token1.approve(migratorAddress, approval1, {
    gasLimit: COTI_TESTNET_TX_GAS_LIMIT,
  }));

  stage = "migration input encryption";
  const input0 = await wallet.encryptValue256(amount0, migratorAddress, migrateSelector);
  const input1 = await wallet.encryptValue256(amount1, migratorAddress, migrateSelector);
  const minSharesInput = await wallet.encryptValue256(minShares, migratorAddress, migrateSelector);
  const minPriceInput = await wallet.encryptValue256(minPrice, migratorAddress, migrateSelector);
  const maxPriceInput = await wallet.encryptValue256(maxPrice, migratorAddress, migrateSelector);
  const network = await hardhatEthers.provider.getNetwork();
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
  const receipt = await submit(
    stage,
    disposition === undefined
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
  for (const log of receipt?.logs ?? []) {
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
  if (disposition === undefined) {
    if (lockDisposition) throw new Error("unexpected launchpad lock disposition event");
  } else {
    if (!lockDisposition) throw new Error("launchpad lock disposition event missing");
    if (lockDisposition.disposition !== disposition) throw new Error("launchpad lock disposition mismatch");
    if (disposition === 0 && lockDisposition.lockId !== ethers.ZeroHash) {
      throw new Error("unexpected creator-held launchpad lock id");
    }
    if (disposition !== 0 && lockDisposition.lockId === ethers.ZeroHash) {
      throw new Error("launchpad lock id missing");
    }
    if (disposition === 1 && lockDisposition.unlockTime !== unlockTime) {
      throw new Error("launchpad unlock time mismatch");
    }
    if (disposition !== 1 && lockDisposition.unlockTime !== 0n) {
      throw new Error("unexpected launchpad unlock time");
    }
  }

  const pool = new Contract(poolAddress, CONFIDENTIAL_POOL_TESTNET_ABI, wallet);
  if (!(await pool.initialized())) throw new Error("launchpad pool was not initialized");
  if (Number(await pool.feeBps()) !== feeBps) {
    throw new Error("launchpad pool total fee does not match the signed tier");
  }
  if ((await pool.feeVault()).toLowerCase() !== (await feeVault.getAddress()).toLowerCase()) {
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
  if (disposition === undefined || disposition === 0) {
    if (decryptedShares <= 0n) throw new Error("creator-held launchpad shares were not minted");
  } else {
    if (decryptedShares !== 0n) throw new Error("locked launchpad shares were exposed to creator");
    if (!lockDisposition || lockDisposition.lockId === ethers.ZeroHash) {
      throw new Error("locked launchpad disposition state missing");
    }
    const lockInfo = await pool.lockInfo(lockDisposition.lockId);
    if ((lockInfo.owner as string).toLowerCase() !== walletAddress.toLowerCase()) {
      throw new Error("launchpad lock owner mismatch");
    }
    if (Boolean(lockInfo.permanent) !== (disposition === 2)) {
      throw new Error("launchpad lock permanence mismatch");
    }
    if (Boolean(lockInfo.released)) throw new Error("launchpad lock was released unexpectedly");
    if (disposition === 1 && BigInt(lockInfo.unlockTime) !== unlockTime) {
      throw new Error("launchpad pool lock time mismatch");
    }
  }

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
  console.log(`launchpad pool: ${poolAddress}`);
  console.log("COTI launchpad migration completed without printing private values.");
}

void main().catch((error: unknown) => {
  console.error(
    `COTI launchpad migration failed during ${stage}; ` +
      `${safeTestnetErrorSummary(error)}; private payloads were suppressed.`,
  );
  process.exitCode = 1;
});
