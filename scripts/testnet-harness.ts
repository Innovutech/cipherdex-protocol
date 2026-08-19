import { CotiNetwork } from "@coti-io/coti-ethers";
import {
  Contract,
  JsonRpcProvider,
  TransactionReceipt,
  ZeroAddress,
  getAddress,
  isAddress,
  keccak256,
  randomBytes,
} from "ethers";
import {
  CONFIDENTIAL_FACTORY_TESTNET_ABI,
  CONFIDENTIAL_POOL_TESTNET_ABI,
  PRIVATE_ERC20_TESTNET_ABI,
} from "./coti-testnet-abi";
import { resolvePrivateTokenCodehashes } from "./private-token-codehashes";
import { verifyDeployedRuntimeArtifact } from "./runtime-artifact";
import {
  requiredTestnetDeploymentRecordPath,
  verifyConfiguredTestnetDeployment,
} from "./testnet-deployment-provenance";
import { createFundedDeploymentBinding } from "./funded-deployment-binding";
import type { FundedRecoveryJournal } from "./funded-recovery-journal";
import {
  FundedCotiWallet as CotiWallet,
  openFundedRecoveryJournal,
  withFundedTransactionEvidence,
} from "./funded-transaction-wallet";
import { requiredFundedRecoveryDirectory } from "./funded-runtime-state";
import {
  recoverPrivateAllowanceObligations,
  setRecoverablePrivateAllowance,
} from "./funded-private-allowance";
import { minimumWithSlippage } from "./testnet-slippage";
import {
  MinedTransactionStatusError,
  UnknownBroadcastOutcomeError,
  requireMinedSuccess,
  safeTestnetErrorSummary,
  transactionHashFromError,
} from "./testnet-transaction-evidence";

const EXPECTED_CHAIN_ID = 7_082_400n;
const APPROVED_FEE_TIERS = new Set([5, 30, 100]);
const gasLimitText = process.env.COTI_TESTNET_GAS_LIMIT?.trim() ?? "30000000";
if (!/^\d+$/.test(gasLimitText) || BigInt(gasLimitText) === 0n) {
  throw new Error("COTI_TESTNET_GAS_LIMIT must be a positive integer");
}
const COTI_TESTNET_TX_OVERRIDES = { gasLimit: BigInt(gasLimitText) } as const;
let stage = "configuration";
let recoveryJournal: FundedRecoveryJournal | undefined;

class UnresolvedDirectAllowanceError extends Error {
  constructor(cause: unknown) {
    super(
      "direct confidential swap failed and its exact private-token allowance could not be proven cleared; funded recovery remains active",
      { cause },
    );
    this.name = "UnresolvedDirectAllowanceError";
  }
}

function journal(): FundedRecoveryJournal {
  if (!recoveryJournal) throw new Error("funded recovery journal is unavailable");
  return recoveryJournal;
}

async function submit(
  provider: JsonRpcProvider,
  label: string,
  operation: () => Promise<{
    hash: string;
    wait(): Promise<TransactionReceipt | null>;
  }>,
): Promise<Readonly<{ transactionHash: string; receipt: TransactionReceipt }>> {
  stage = label;
  try {
    const evidence = await withFundedTransactionEvidence(
      label,
      journal(),
      () => requireMinedSuccess(
        label,
        operation,
        (hash) => provider.getTransactionReceipt(hash),
      ),
    );
    journal().recordTransaction(
      evidence.transactionHash,
      "mined-success",
      evidence.receipt.blockNumber,
    );
    return evidence;
  } catch (error) {
    const hash = transactionHashFromError(error);
    if (hash) {
      if (!journal().transactions.some((transaction) =>
        transaction.hash.toLowerCase() === hash.toLowerCase()
      )) throw new Error("funded transaction was not locally signed and journaled", { cause: error });
      journal().recordTransaction(
        hash,
        error instanceof MinedTransactionStatusError ? "mined-failure" : "outcome-unknown",
      );
    }
    throw error;
  }
}

function requiredAddress(name: string): string {
  const value = process.env[name]?.trim();
  if (!value || !isAddress(value)) throw new Error(`${name} must be a valid address`);
  return getAddress(value);
}

function requiredDecimals(name: string): number {
  const value = process.env[name]?.trim();
  if (!value || !/^\d+$/.test(value)) throw new Error(`${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 18) {
    throw new Error(`${name} must be between 0 and 18`);
  }
  return parsed;
}

function encryptedQuoteFromReceipt(
  pool: Contract,
  receipt: any,
  caller: string,
  requestId: string,
): unknown {
  const poolAddress = String(pool.target).toLowerCase();
  const matches: unknown[] = [];
  for (const log of receipt?.logs ?? []) {
    if (String(log.address).toLowerCase() !== poolAddress) continue;
    try {
      const parsed = pool.interface.parseLog({ topics: log.topics, data: log.data });
      if (
        parsed?.name === "ConfidentialQuoteResult" &&
        String(parsed.args.caller).toLowerCase() === caller.toLowerCase() &&
        String(parsed.args.requestId).toLowerCase() === requestId.toLowerCase() &&
        parsed.args.zeroForOne === true
      ) {
        matches.push(parsed.args.result);
      }
    } catch {
      // Ignore token and unrelated contract logs.
    }
  }
  if (matches.length !== 1) {
    throw new Error("encrypted quote result event is missing or ambiguous");
  }
  return matches[0];
}

async function main(): Promise<void> {
  stage = "configuration";
  const poolAddress = requiredAddress("COTI_POOL");
  const factoryAddress = requiredAddress("COTI_FACTORY");
  const expectedFeeVault = requiredAddress("COTI_FEE_VAULT");
  const tokenA = requiredAddress("COTI_TOKEN0");
  const tokenB = requiredAddress("COTI_TOKEN1");
  const decimalsA = requiredDecimals("COTI_TOKEN0_DECIMALS");
  const decimalsB = requiredDecimals("COTI_TOKEN1_DECIMALS");
  const privateKey = process.env.COTI_TESTNET_PRIVATE_KEY?.trim();
  const aesKey = process.env.COTI_AES_KEY?.trim();
  const amountInText = process.env.COTI_TEST_AMOUNT_IN?.trim();

  if (!privateKey || !aesKey || !amountInText) {
    throw new Error(
      "Set COTI_POOL, COTI_TESTNET_PRIVATE_KEY, COTI_AES_KEY and COTI_TEST_AMOUNT_IN explicitly.",
    );
  }
  if (!/^\d+$/.test(amountInText) || BigInt(amountInText) === 0n) {
    throw new Error("COTI_TEST_AMOUNT_IN must be a positive uint256");
  }
  const amountIn = BigInt(amountInText);

  const provider = new JsonRpcProvider(
    process.env.COTI_TESTNET_RPC_URL ?? CotiNetwork.Testnet,
    7082400,
  );
  const network = await provider.getNetwork();
  if (network.chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(`expected COTI testnet ${EXPECTED_CHAIN_ID}, received ${network.chainId}`);
  }
  stage = "reviewed deployment provenance";
  const deploymentRecord = await verifyConfiguredTestnetDeployment(
    requiredTestnetDeploymentRecordPath(),
    provider,
    [
      {
        recordKey: "confidentialFactory",
        contractName: "ConfidentialCPMMFactory",
        address: factoryAddress,
      },
      {
        recordKey: "feeVault",
        contractName: "CipherDEXFeeVault",
        address: expectedFeeVault,
      },
    ],
  );
  await verifyDeployedRuntimeArtifact("ConfidentialCPMM", poolAddress, provider);
  const reviewedTokens = deploymentRecord.contracts.confidentialFactory.reviewedPrivateTokens;
  if (
    !Array.isArray(reviewedTokens) ||
    ![tokenA, tokenB].every((token) => reviewedTokens.some(
      (candidate) => typeof candidate === "string" &&
        candidate.toLowerCase() === token.toLowerCase(),
    ))
  ) {
    throw new Error("configured private tokens are absent from the reviewed deployment record");
  }
  const factory = new Contract(
    factoryAddress,
    CONFIDENTIAL_FACTORY_TESTNET_ABI,
    provider,
  );
  const validationPool = new Contract(poolAddress, CONFIDENTIAL_POOL_TESTNET_ABI, provider);
  stage = "canonical deployment validation";
  const [expectedToken0, expectedToken1, expectedDecimals0, expectedDecimals1] =
    tokenA.toLowerCase() < tokenB.toLowerCase()
      ? [tokenA, tokenB, decimalsA, decimalsB] as const
      : [tokenB, tokenA, decimalsB, decimalsA] as const;
  const [
    factoryCode,
    poolCode,
    token0Code,
    token1Code,
    vaultCode,
    factoryVersion,
    factoryPrivacyMode,
    factoryFeeVault,
    isPool,
    poolVersion,
    poolPrivacyMode,
    poolInitialized,
    bootstrapper,
    poolToken0,
    poolToken1,
    poolDecimals0,
    poolDecimals1,
    scale0,
    scale1,
    feeBps,
    poolFeeVault,
  ] = await Promise.all([
    provider.getCode(factoryAddress),
    provider.getCode(poolAddress),
    provider.getCode(expectedToken0),
    provider.getCode(expectedToken1),
    provider.getCode(expectedFeeVault),
    factory.PROTOCOL_VERSION(),
    factory.PRIVACY_MODE(),
    factory.feeVault(),
    factory.isPool(poolAddress),
    validationPool.PROTOCOL_VERSION(),
    validationPool.PRIVACY_MODE(),
    validationPool.initialized(),
    validationPool.bootstrapper(),
    validationPool.token0(),
    validationPool.token1(),
    validationPool.token0Decimals(),
    validationPool.token1Decimals(),
    validationPool.scale0(),
    validationPool.scale1(),
    validationPool.feeBps(),
    validationPool.feeVault(),
  ]);
  const normalizedFeeBps = Number(feeBps);
  if (
    [factoryCode, poolCode, token0Code, token1Code, vaultCode].some((code) => code === "0x") ||
    BigInt(factoryVersion) !== 3n ||
    Number(factoryPrivacyMode) !== 1 ||
    BigInt(poolVersion) !== 3n ||
    Number(poolPrivacyMode) !== 1 ||
    !poolInitialized ||
    !isPool ||
    getAddress(String(bootstrapper)) !== factoryAddress ||
    getAddress(String(factoryFeeVault)) !== expectedFeeVault ||
    getAddress(String(poolFeeVault)) !== expectedFeeVault ||
    getAddress(String(poolToken0)) !== expectedToken0 ||
    getAddress(String(poolToken1)) !== expectedToken1 ||
    Number(poolDecimals0) !== expectedDecimals0 ||
    Number(poolDecimals1) !== expectedDecimals1 ||
    BigInt(scale0) !== 10n ** BigInt(18 - expectedDecimals0) ||
    BigInt(scale1) !== 10n ** BigInt(18 - expectedDecimals1) ||
    !APPROVED_FEE_TIERS.has(normalizedFeeBps)
  ) throw new Error("COTI_POOL failed canonical deployment validation");

  stage = "canonical pool provenance";
  const canonicalKey = await factory.poolKey(
    expectedToken0,
    expectedToken1,
    expectedDecimals0,
    expectedDecimals1,
    normalizedFeeBps,
    ZeroAddress,
  );
  const [canonicalPool, token0Approved, token1Approved, codehashes] = await Promise.all([
    factory.getPool(canonicalKey),
    factory.isApprovedPrivateToken(expectedToken0),
    factory.isApprovedPrivateToken(expectedToken1),
    resolvePrivateTokenCodehashes(provider, [expectedToken0, expectedToken1]),
  ]);
  const codehashApprovals = await Promise.all(
    codehashes.map((codehash) => factory.isApprovedPrivateTokenCodehash(codehash)),
  );
  if (
    getAddress(String(canonicalPool)) !== poolAddress ||
    !token0Approved ||
    !token1Approved ||
    codehashApprovals.some((approved) => !approved)
  ) throw new Error("COTI_POOL is not the factory's canonical approved private-token pool");

  const wallet = new CotiWallet(privateKey, provider, { aesKey });
  wallet.setAesKey(aesKey);
  const caller = await wallet.getAddress();
  recoveryJournal = openFundedRecoveryJournal(privateKey, {
    runner: "direct-harness",
    sourceCommit: deploymentRecord.sourceCommit,
    chainId: Number(network.chainId),
    owner: caller,
    directory: requiredFundedRecoveryDirectory(),
    deployment: await createFundedDeploymentBinding(deploymentRecord),
  });
  const unresolved = await recoveryJournal.reconcileTransactions(provider);
  if (unresolved.length > 0) {
    throw new Error(
      `funded recovery has ${unresolved.length} transaction(s) with unknown outcome; do not retry`,
    );
  }
  const submitAllowance = (label: string, operation: () => Promise<any>) =>
    submit(provider, label, operation);
  await recoverPrivateAllowanceObligations({
    journal: recoveryJournal,
    wallets: [wallet],
    overrides: COTI_TESTNET_TX_OVERRIDES,
    submit: submitAllowance,
  });

  const pool = new Contract(poolAddress, CONFIDENTIAL_POOL_TESTNET_ABI, wallet);
  const inputToken = new Contract(expectedToken0, PRIVATE_ERC20_TESTNET_ABI, wallet);
  const quoteSelector = pool.interface.getFunction("requestQuoteExactInput")?.selector;
  const swapSelector = pool.interface.getFunction("swapExactInput")?.selector;
  const approveSelector = inputToken.interface.getFunction("approve")?.selector;
  if (!quoteSelector || !swapSelector || !approveSelector) {
    throw new Error("COTI pool or private-token selectors are unavailable");
  }

  stage = "paid quote input encryption";
  const encryptedAmountForQuote = await wallet.encryptValue256(
    amountIn,
    poolAddress,
    quoteSelector,
  );
  const requestId = keccak256(randomBytes(32));
  const started = Date.now();
  stage = "paid quote submission";
  const quoteEvidence = await submit(
    provider,
    "paid quote submission",
    () => pool.requestQuoteExactInput(
      encryptedAmountForQuote,
      true,
      requestId,
      COTI_TESTNET_TX_OVERRIDES,
    ),
  );
  const quoteReceipt = quoteEvidence.receipt;
  const quoteElapsedMs = Date.now() - started;
  stage = "paid quote result decryption";
  const decryptedQuote = await wallet.decryptValue256(
    encryptedQuoteFromReceipt(pool, quoteReceipt, caller, requestId) as never,
  );
  if (decryptedQuote <= 0n) throw new Error("paid encrypted quote returned zero");
  const boundedMinimumOut = minimumWithSlippage(decryptedQuote);
  stage = "swap input encryption";
  const encryptedAmountForSwap = await wallet.encryptValue256(
    amountIn,
    poolAddress,
    swapSelector,
  );
  const encryptedMinimumForSwap = await wallet.encryptValue256(
    boundedMinimumOut,
    poolAddress,
    swapSelector,
  );

  // Do not print the encrypted or decrypted amount. The harness only reports timing
  // and transaction identity; values stay in the user's local process.
  console.log(`COTI testnet paid quote completed in ${quoteElapsedMs}ms`);

  stage = "exact private-token allowance";
  await setRecoverablePrivateAllowance({
    journal: journal(),
    wallet,
    token: inputToken,
    tokenAddress: expectedToken0,
    spender: poolAddress,
    amount: amountIn,
    label: "exact private-token allowance",
    overrides: COTI_TESTNET_TX_OVERRIDES,
    submit: submitAllowance,
  });
  let exactAllowanceGranted = false;
  try {
    exactAllowanceGranted = true;

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
    stage = "swap submission";
    const swapEvidence = await submit(
      provider,
      "swap submission",
      () => pool.swapExactInput(
        encryptedAmountForSwap,
        encryptedMinimumForSwap,
        true,
        deadline,
        COTI_TESTNET_TX_OVERRIDES,
      ),
    );
    stage = "post-swap allowance cleanup";
    const finalAllowance = await inputToken.allowance.staticCall(caller, poolAddress);
    const finalAllowanceAmount = await wallet.decryptValue256(
      finalAllowance.ownerCiphertext,
    );
    if (finalAllowanceAmount !== 0n) {
      throw new Error("direct confidential swap left residual input-token allowance");
    }
    await setRecoverablePrivateAllowance({
      journal: journal(),
      wallet,
      token: inputToken,
      tokenAddress: expectedToken0,
      spender: poolAddress,
      amount: 0n,
      label: "post-swap allowance cleanup",
      overrides: COTI_TESTNET_TX_OVERRIDES,
      submit: submitAllowance,
    });
    exactAllowanceGranted = false;
    console.log(`COTI testnet swap submitted: ${swapEvidence.transactionHash}`);
  } catch (error) {
    if (exactAllowanceGranted && !(error instanceof UnknownBroadcastOutcomeError)) {
      try {
        stage = "failed-swap allowance recovery";
        await setRecoverablePrivateAllowance({
          journal: journal(),
          wallet,
          token: inputToken,
          tokenAddress: expectedToken0,
          spender: poolAddress,
          amount: 0n,
          label: "failed-swap allowance recovery",
          overrides: COTI_TESTNET_TX_OVERRIDES,
          submit: submitAllowance,
        });
        const recoveredAllowance = await inputToken.allowance.staticCall(caller, poolAddress);
        const recoveredAllowanceAmount = await wallet.decryptValue256(
          recoveredAllowance.ownerCiphertext,
        );
        if (recoveredAllowanceAmount !== 0n) {
          throw new Error("failed-swap allowance recovery did not clear the private allowance");
        }
      } catch (recoveryError) {
        throw new UnresolvedDirectAllowanceError(
          new AggregateError([error, recoveryError], "swap and allowance recovery both failed"),
        );
      }
    }
    throw error;
  }
  journal().markRun("passed");
}

void main().catch((error: unknown) => {
  if (error instanceof UnknownBroadcastOutcomeError) {
    console.error(
      `COTI testnet harness paused with an uncertain broadcast during ${stage}; ` +
        `${safeTestnetErrorSummary(error)}; do not retry until journal reconciliation succeeds.`,
    );
    process.exitCode = 1;
    return;
  }
  if (error instanceof UnresolvedDirectAllowanceError) {
    console.error(
      `COTI testnet harness requires allowance recovery during ${stage}; ` +
        `${safeTestnetErrorSummary(error)}; do not mark this run terminal or retry automatically.`,
    );
    process.exitCode = 1;
    return;
  }
  recoveryJournal?.markRun("failed");
  console.error(
    `COTI testnet harness failed during ${stage}; ${safeTestnetErrorSummary(error)}; ` +
      "private RPC payloads were suppressed.",
  );
  process.exitCode = 1;
});
