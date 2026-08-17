import { Wallet as CotiWallet } from "@coti-io/coti-ethers";
import { Contract } from "ethers";
import hre, { ethers } from "hardhat";
import {
  CONFIDENTIAL_FACTORY_TESTNET_ABI,
  CONFIDENTIAL_POOL_TESTNET_ABI,
  PRIVATE_ERC20_TESTNET_ABI,
} from "./coti-testnet-abi";
import { decryptPrivateValue256 } from "./coti-testnet-values";
import { requireFeeCollectionMature } from "./testnet-fee-collection-readiness";
import { verifyDeployedRuntimeArtifact } from "./runtime-artifact";
import {
  requiredTestnetDeploymentRecordPath,
  verifyConfiguredTestnetDeployment,
} from "./testnet-deployment-provenance";
import {
  confidentialLiquidityBounds,
  minimumWithSlippage,
} from "./testnet-slippage";
import {
  requireMinedSuccess,
  safeTestnetErrorSummary,
} from "./testnet-transaction-evidence";

const TARGET_SWAP_COUNT = 8n;
const COLLECTION_DELAY_SECONDS = 3_600n;
const gasLimitText = process.env.COTI_TESTNET_GAS_LIMIT?.trim() ?? "30000000";
if (!/^\d+$/.test(gasLimitText) || BigInt(gasLimitText) === 0n) {
  throw new Error("COTI_TESTNET_GAS_LIMIT must be a positive integer");
}
const TX_GAS_LIMIT = BigInt(gasLimitText);
const TX_OVERRIDES = { gasLimit: TX_GAS_LIMIT } as const;

let stage = "configuration";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function requiredAddress(name: string): string {
  const value = required(name);
  if (!ethers.isAddress(value)) throw new Error(`invalid ${name}`);
  return value;
}

function defaultRawAmount(decimals: number, decimalPlaces: number): bigint {
  return decimals >= decimalPlaces ? 10n ** BigInt(decimals - decimalPlaces) : 1n;
}

function optionalRawAmount(name: string, fallback: bigint): bigint {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`invalid ${name}`);
  const parsed = BigInt(value);
  if (parsed === 0n) throw new Error(`${name} must be positive`);
  return parsed;
}

function requiredPositiveRawAmount(name: string): bigint {
  const value = required(name);
  if (!/^\d+$/.test(value)) throw new Error(`invalid ${name}`);
  const parsed = BigInt(value);
  if (parsed === 0n) throw new Error(`${name} must be positive`);
  return parsed;
}

function minimumFromQuote(quote: bigint): bigint {
  if (quote <= 0n) throw new Error("paid encrypted quote returned zero");
  return minimumWithSlippage(quote);
}

async function submit(
  label: string,
  transaction: Promise<{ hash: string; wait(): Promise<any> }>,
): Promise<any> {
  stage = label;
  const started = Date.now();
  const evidence = await requireMinedSuccess(
    label,
    () => transaction,
    (hash) => ethers.provider.getTransactionReceipt(hash),
  );
  const receipt = evidence.receipt;
  console.log(
    `${label}: tx=${evidence.transactionHash} gas=${receipt.gasUsed.toString()} ` +
      `latencyMs=${Date.now() - started}`,
  );
  return receipt;
}

async function privateBalance(token: Contract, owner: string, wallet: CotiWallet): Promise<bigint> {
  const encrypted = await token.balanceOf.staticCall(owner);
  return decryptPrivateValue256(wallet, encrypted);
}

async function setPrivateAllowance(
  token: Contract,
  tokenAddress: string,
  poolAddress: string,
  amount: bigint,
  wallet: CotiWallet,
  label: string,
): Promise<void> {
  const selector = token.interface.getFunction("approve")?.selector;
  if (!selector) throw new Error("private approval selector unavailable");
  const zero = await wallet.encryptValue256(0n, tokenAddress, selector);
  const value = await wallet.encryptValue256(amount, tokenAddress, selector);
  await submit(`${label} approval reset`, token.approve(poolAddress, zero, TX_OVERRIDES));
  await submit(`${label} approval`, token.approve(poolAddress, value, TX_OVERRIDES));
}

async function requestPrivateQuote(
  pool: Contract,
  poolAddress: string,
  wallet: CotiWallet,
  amountIn: bigint,
  zeroForOne: boolean,
  label: string,
): Promise<bigint> {
  const selector = pool.interface.getFunction("requestQuoteExactInput")?.selector;
  if (!selector) throw new Error("transactional quote selector unavailable");
  const encryptedInput = await wallet.encryptValue256(amountIn, poolAddress, selector);
  const requestId = ethers.keccak256(ethers.randomBytes(32));
  const caller = await wallet.getAddress();
  const receipt = await submit(
    label,
    pool.requestQuoteExactInput(
      encryptedInput,
      zeroForOne,
      requestId,
      TX_OVERRIDES,
    ),
  );
  const matches: Array<{
    ciphertextHigh: bigint | number | string;
    ciphertextLow: bigint | number | string;
  }> = [];
  for (const log of receipt?.logs ?? []) {
    if (log.address.toLowerCase() !== poolAddress.toLowerCase()) continue;
    try {
      const parsed = pool.interface.parseLog({ topics: log.topics, data: log.data });
      if (
        parsed?.name === "ConfidentialQuoteResult" &&
        String(parsed.args.caller).toLowerCase() === caller.toLowerCase() &&
        String(parsed.args.requestId).toLowerCase() === requestId.toLowerCase() &&
        parsed.args.zeroForOne === zeroForOne
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
  return decryptPrivateValue256(wallet, matches[0]);
}

async function main(): Promise<void> {
  await hre.run("clean");
  await hre.run("compile");
  const poolAddress = requiredAddress("COTI_FEE_COLLECTION_POOL");
  const factoryAddress = requiredAddress("COTI_FACTORY");
  const expectedFeeVault = requiredAddress("COTI_FEE_VAULT");
  const privateKey = required("COTI_TESTNET_PRIVATE_KEY");
  const aesKey = required("COTI_AES_KEY");
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("invalid COTI_TESTNET_PRIVATE_KEY");
  }

  stage = "network and reviewed deployment provenance";
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== 7_082_400n) {
    throw new Error(`expected COTI testnet 7082400, received ${network.chainId}`);
  }
  const deploymentRecord = await verifyConfiguredTestnetDeployment(
    requiredTestnetDeploymentRecordPath(),
    ethers.provider,
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
  await verifyDeployedRuntimeArtifact("ConfidentialCPMM", poolAddress);

  const wallet = new CotiWallet(privateKey, ethers.provider, { aesKey });
  wallet.setAesKey(aesKey);
  const walletAddress = await wallet.getAddress();
  const pool = new Contract(poolAddress, CONFIDENTIAL_POOL_TESTNET_ABI, wallet);
  stage = "pool metadata validation";
  const factory = new Contract(
    factoryAddress,
    CONFIDENTIAL_FACTORY_TESTNET_ABI,
    ethers.provider,
  );
  const [factoryCode, poolCode, vaultCode] = await Promise.all([
    ethers.provider.getCode(factoryAddress),
    ethers.provider.getCode(poolAddress),
    ethers.provider.getCode(expectedFeeVault),
  ]);
  if (factoryCode === "0x" || poolCode === "0x" || vaultCode === "0x") {
    throw new Error("factory, pool and fee vault must be deployed contracts");
  }
  const token0Address = String(await pool.token0());
  const token1Address = String(await pool.token1());
  const reviewedTokens = deploymentRecord.contracts.confidentialFactory.reviewedPrivateTokens;
  if (
    !Array.isArray(reviewedTokens) ||
    ![token0Address, token1Address].every((token) => reviewedTokens.some(
      (candidate) => typeof candidate === "string" &&
        candidate.toLowerCase() === token.toLowerCase(),
    ))
  ) {
    throw new Error("fee-collection tokens are absent from the reviewed deployment record");
  }
  const [token0Code, token1Code] = await Promise.all([
    ethers.provider.getCode(token0Address),
    ethers.provider.getCode(token1Address),
  ]);
  if (
    token0Code === "0x" ||
    token1Code === "0x" ||
    !(await factory.isApprovedPrivateTokenCodehash(ethers.keccak256(token0Code))) ||
    !(await factory.isApprovedPrivateTokenCodehash(ethers.keccak256(token1Code)))
  ) {
    throw new Error("pool token implementation is outside the factory policy");
  }
  const decimals0FromPool = Number(await pool.token0Decimals());
  const decimals1FromPool = Number(await pool.token1Decimals());
  const feeBps = BigInt(await pool.feeBps());
  const feeVault = String(await pool.feeVault());
  const canonicalKey = await factory.poolKey(
    token0Address,
    token1Address,
    decimals0FromPool,
    decimals1FromPool,
    feeBps,
  );
  const canonicalPool = String(await factory.getPool(canonicalKey));
  if (
    BigInt(await factory.PROTOCOL_VERSION()) !== 2n ||
    BigInt(await factory.PRIVACY_MODE()) !== 1n ||
    BigInt(await pool.PROTOCOL_VERSION()) !== 2n ||
    BigInt(await pool.PRIVACY_MODE()) !== 1n ||
    !(await factory.isPool(poolAddress)) ||
    canonicalPool.toLowerCase() !== poolAddress.toLowerCase() ||
    String(await factory.feeVault()).toLowerCase() !== expectedFeeVault.toLowerCase() ||
    feeVault.toLowerCase() !== expectedFeeVault.toLowerCase() ||
    String(await pool.bootstrapper()).toLowerCase() !== factoryAddress.toLowerCase()
  ) {
    throw new Error("fee-collection pool failed canonical provenance validation");
  }
  if (
    BigInt(await pool.PROTOCOL_FEE_SHARE_NUMERATOR()) !== 1n ||
    BigInt(await pool.PROTOCOL_FEE_SHARE_DENOMINATOR()) !== 6n
  ) {
    throw new Error("pool does not use the v1 protocol fee split");
  }

  const token0 = new Contract(token0Address, PRIVATE_ERC20_TESTNET_ABI, wallet);
  const token1 = new Contract(token1Address, PRIVATE_ERC20_TESTNET_ABI, wallet);
  const decimals0 = Number(await token0.decimals());
  const decimals1 = Number(await token1.decimals());
  if (decimals0 !== decimals0FromPool || decimals1 !== decimals1FromPool) {
    throw new Error("pool token decimals are inconsistent");
  }
  // COTI's deployed PrivateERC20 implementations may expose public overloads
  // while still using encrypted balances and encrypted transfer methods. The
  // publicAmountsEnabled compatibility flag is therefore informational, not a
  // privacy or provenance boundary. The immutable factory codehash policy and
  // the encrypted balance reads below are the authoritative checks.
  const liquidity0 = optionalRawAmount(
    "COTI_FEE_TEST_LIQUIDITY0",
    defaultRawAmount(decimals0, 1),
  );
  const liquidity1 = optionalRawAmount(
    "COTI_FEE_TEST_LIQUIDITY1",
    defaultRawAmount(decimals1, 1),
  );
  const swap0 = optionalRawAmount("COTI_FEE_TEST_SWAP0", defaultRawAmount(decimals0, 2));
  const swap1 = optionalRawAmount("COTI_FEE_TEST_SWAP1", defaultRawAmount(decimals1, 2));

  let count0 = BigInt(await pool.protocolFeeSwapCount0());
  let count1 = BigInt(await pool.protocolFeeSwapCount1());
  const needed0 = count0 >= TARGET_SWAP_COUNT ? 0n : TARGET_SWAP_COUNT - count0;
  const needed1 = count1 >= TARGET_SWAP_COUNT ? 0n : TARGET_SWAP_COUNT - count1;

  if (needed0 > 0n || needed1 > 0n) {
    const liquidityRequired = !(await pool.initialized());
    const allowance0 = (liquidityRequired ? liquidity0 : 0n) + needed0 * swap0;
    const allowance1 = (liquidityRequired ? liquidity1 : 0n) + needed1 * swap1;
    stage = "private balance sufficiency validation";
    if (
      (allowance0 > 0n && await privateBalance(token0, walletAddress, wallet) < allowance0) ||
      (allowance1 > 0n && await privateBalance(token1, walletAddress, wallet) < allowance1)
    ) {
      throw new Error("fee-collection test amounts exceed the available private balance");
    }

    if (allowance0 > 0n) {
      await setPrivateAllowance(token0, token0Address, poolAddress, allowance0, wallet, "token0");
    }
    if (allowance1 > 0n) {
      await setPrivateAllowance(token1, token1Address, poolAddress, allowance1, wallet, "token1");
    }

    if (liquidityRequired) {
      const selector = pool.interface.getFunction("addLiquidity")?.selector;
      if (!selector) throw new Error("add-liquidity selector unavailable");
      const bounds = confidentialLiquidityBounds(
        liquidity0,
        decimals0,
        liquidity1,
        decimals1,
        false,
      );
      const input0 = await wallet.encryptValue256(liquidity0, poolAddress, selector);
      const input1 = await wallet.encryptValue256(liquidity1, poolAddress, selector);
      const minimum = await wallet.encryptValue256(bounds.minShares, poolAddress, selector);
      const minimumPrice = await wallet.encryptValue256(
        bounds.minPriceX18,
        poolAddress,
        selector,
      );
      const maximumPrice = await wallet.encryptValue256(
        bounds.maxPriceX18,
        poolAddress,
        selector,
      );
      await submit(
        "fee test liquidity initialization",
        pool.addLiquidity(
          input0,
          input1,
          minimum,
          minimumPrice,
          maximumPrice,
          false,
          BigInt(Math.floor(Date.now() / 1000) + 600),
          TX_OVERRIDES,
        ),
      );
    }

    const swapSelector = pool.interface.getFunction("swapExactInput")?.selector;
    if (!swapSelector) throw new Error("swap selector unavailable");
    const rounds = Number(needed0 > needed1 ? needed0 : needed1);
    for (let index = 0; index < rounds; index += 1) {
      if (BigInt(index) < needed0) {
        const quote = await requestPrivateQuote(
          pool,
          poolAddress,
          wallet,
          swap0,
          true,
          `fee test token0 quote ${index + 1}/${needed0}`,
        );
        const input = await wallet.encryptValue256(swap0, poolAddress, swapSelector);
        const minimum = await wallet.encryptValue256(
          minimumFromQuote(quote),
          poolAddress,
          swapSelector,
        );
        await submit(
          `fee test token0 swap ${index + 1}/${needed0}`,
          pool.swapExactInput(
            input,
            minimum,
            true,
            BigInt(Math.floor(Date.now() / 1000) + 600),
            TX_OVERRIDES,
          ),
        );
      }
      if (BigInt(index) < needed1) {
        const quote = await requestPrivateQuote(
          pool,
          poolAddress,
          wallet,
          swap1,
          false,
          `fee test token1 quote ${index + 1}/${needed1}`,
        );
        const input = await wallet.encryptValue256(swap1, poolAddress, swapSelector);
        const minimum = await wallet.encryptValue256(
          minimumFromQuote(quote),
          poolAddress,
          swapSelector,
        );
        await submit(
          `fee test token1 swap ${index + 1}/${needed1}`,
          pool.swapExactInput(
            input,
            minimum,
            false,
            BigInt(Math.floor(Date.now() / 1000) + 600),
            TX_OVERRIDES,
          ),
        );
      }
    }
  }

  count0 = BigInt(await pool.protocolFeeSwapCount0());
  count1 = BigInt(await pool.protocolFeeSwapCount1());
  if (count0 < TARGET_SWAP_COUNT || count1 < TARGET_SWAP_COUNT) {
    throw new Error("confidential fee batch did not reach the required swap count");
  }

  const window0 = BigInt(await pool.protocolFeeWindowStart0());
  const window1 = BigInt(await pool.protocolFeeWindowStart1());
  const readyAt = (window0 > window1 ? window0 : window1) + COLLECTION_DELAY_SECONDS;
  const latestBlock = await ethers.provider.getBlock("latest");
  if (!latestBlock) throw new Error("latest block unavailable");
  console.log(`confidential fee batch readyAt=${readyAt} count0=${count0} count1=${count1}`);
  stage = "fee collection maturity gate";
  requireFeeCollectionMature(BigInt(latestBlock.timestamp), readyAt);

  if (await pool.initialized()) {
    const encryptedShares = await pool.myShares.staticCall();
    const shares = await decryptPrivateValue256(wallet, encryptedShares);
    if (shares > 0n) {
      const selector = pool.interface.getFunction("removeLiquidity")?.selector;
      if (!selector) throw new Error("remove-liquidity selector unavailable");
      const shareInput = await wallet.encryptValue256(shares, poolAddress, selector);
      const minimum0 = await wallet.encryptValue256(
        requiredPositiveRawAmount("COTI_FEE_TEST_REMOVE_MIN0"),
        poolAddress,
        selector,
      );
      const minimum1 = await wallet.encryptValue256(
        requiredPositiveRawAmount("COTI_FEE_TEST_REMOVE_MIN1"),
        poolAddress,
        selector,
      );
      await submit(
        "full LP exit before protocol fee collection",
        pool.removeLiquidity(
          shareInput,
          minimum0,
          minimum1,
          BigInt(Math.floor(Date.now() / 1000) + 600),
          TX_OVERRIDES,
        ),
      );
      if (await pool.initialized()) throw new Error("full LP exit left the pool initialized");
    }
  }

  await submit(
    "mature confidential protocol fee collection",
    pool.collectProtocolFees(true, true, TX_OVERRIDES),
  );
  if (
    BigInt(await pool.protocolFeeSwapCount0()) !== 0n ||
    BigInt(await pool.protocolFeeSwapCount1()) !== 0n
  ) {
    throw new Error("confidential fee collection did not clear both public batch counters");
  }
  console.log(`confidential protocol fees collected to fixed vault ${feeVault}`);
}

void main().catch((error: unknown) => {
  console.error(
    `COTI fee-collection test failed during ${stage}; ${safeTestnetErrorSummary(error)}; ` +
      "private payloads were suppressed.",
  );
  process.exitCode = 1;
});
