import { expect } from "chai";
import { Interface } from "ethers";
import {
  CONFIDENTIAL_CPMM_ABI,
  CONFIDENTIAL_CPMM_FACTORY_ABI,
  CONFIDENTIAL_LAUNCHPAD_MIGRATOR_ABI,
  CONFIDENTIAL_QUOTE_TRANSPORT,
  CIPHERDEX_FEE_VAULT_ABI,
  CIPHERDEX_V1_FEE_POLICY,
  DISCLOSURE_SCHEMA_VERSION,
  LAUNCHPAD_MIGRATION_EIP712_TYPES,
  LP_DISPOSITION,
  PRIVACY_MODE,
  PRIVATE_LP_TOKEN_ABI,
  PUBLIC_CPMM_ABI,
  PUBLIC_CPMM_FACTORY_ABI,
  PUBLIC_CPMM_QUOTER_ABI,
  PUBLIC_CPMM_ROUTER_ABI,
  calculateCipherDEXV1FeeBreakdown,
  getCipherDEXV1FeePolicy,
  isConfidentialLockDiscovery,
  isConfidentialPoolDiscovery,
  isLaunchpadMigrationMetadata,
  isPublicPoolDiscovery,
  selectBestConfidentialPoolQuote,
} from "../../sdk/src/index";

describe("stable SDK surface", function () {
  it("parses the published pool and factory ABI fragments", function () {
    expect(DISCLOSURE_SCHEMA_VERSION).to.equal(5);
    const pool = new Interface(CONFIDENTIAL_CPMM_ABI);
    const factory = new Interface(CONFIDENTIAL_CPMM_FACTORY_ABI);
    const launchpad = new Interface(CONFIDENTIAL_LAUNCHPAD_MIGRATOR_ABI);
    const privateLpToken = new Interface(PRIVATE_LP_TOKEN_ABI);
    const publicPool = new Interface(PUBLIC_CPMM_ABI);
    const publicFactory = new Interface(PUBLIC_CPMM_FACTORY_ABI);
    const publicQuoter = new Interface(PUBLIC_CPMM_QUOTER_ABI);
    const publicRouter = new Interface(PUBLIC_CPMM_ROUTER_ABI);
    const feeVault = new Interface(CIPHERDEX_FEE_VAULT_ABI);
    expect(pool.getFunction("swapExactInput")).to.not.equal(null);
    expect(pool.getFunction("PRIVACY_MODE")).to.not.equal(null);
    expect(pool.getFunction("LP_DISPOSITION_PERMANENT_LOCK")).to.not.equal(null);
    expect(pool.getFunction("removeLiquidity")).to.not.equal(null);
    expect(pool.getFunction("requestQuoteExactInput")).to.not.equal(null);
    expect(pool.getEvent("ConfidentialQuoteResult")).to.not.equal(null);
    expect(pool.getFunction("collectProtocolFees")).to.not.equal(null);
    expect(pool.getFunction("protocolFees0")).to.equal(null);
    expect(pool.getFunction("protocolFees1")).to.equal(null);
    expect(pool.getFunction("publishSpotPrice")).to.equal(null);
    expect(pool.getFunction("publicSpotPriceX18")).to.equal(null);
    expect(pool.getFunction("publicPriceCumulativeX18SecondsNow")).to.equal(null);
    expect(pool.getFunction("bootstrapLiquidity")).to.not.equal(null);
    expect(pool.getFunction("bootstrapLiquidityWithDisposition")).to.not.equal(null);
    expect(factory.getFunction("createPool")).to.not.equal(null);
    expect(factory.getFunction("createPoolWithPublisher")).to.equal(null);
    expect(factory.getFunction("PRIVACY_MODE")).to.not.equal(null);
    expect(factory.getFunction("setBootstrapAdapter")).to.not.equal(null);
    expect(factory.getFunction("bootstrapAdapter")).to.not.equal(null);
    expect(factory.getFunction("bootstrapPool")).to.not.equal(null);
    expect(factory.getFunction("bootstrapPoolWithDisposition")).to.not.equal(null);
    expect(factory.getEvent("PoolCreated")).to.not.equal(null);
    expect(factory.getEvent("PrivateLPTokenCreated")).to.not.equal(null);
    expect(privateLpToken.getFunction("pool")).to.not.equal(null);
    expect(privateLpToken.getFunction("balanceOf")).to.not.equal(null);
    expect(launchpad.getFunction("migrate")).to.not.equal(null);
    expect(launchpad.getFunction("migrateWithDisposition")).to.not.equal(null);
    expect(launchpad.getEvent("LaunchpadMigration")).to.not.equal(null);
    expect(launchpad.getEvent("LaunchpadLockDisposition")).to.not.equal(null);
    expect(LP_DISPOSITION.PERMANENT_LOCK).to.equal(2);
    expect(publicPool.getFunction("swapExactInput")).to.not.equal(null);
    expect(publicPool.getFunction("PRIVACY_MODE")).to.not.equal(null);
    expect(publicPool.getFunction("effectiveReserves")).to.not.equal(null);
    expect(publicPool.getFunction("collectProtocolFees")).to.not.equal(null);
    expect(publicFactory.getFunction("createPool")).to.not.equal(null);
    expect(publicFactory.getFunction("PRIVACY_MODE")).to.not.equal(null);
    expect(publicQuoter.getFunction("quoteExactInput")).to.not.equal(null);
    expect(publicRouter.getFunction("swapExactInput")).to.not.equal(null);
    expect(feeVault.getFunction("sweepPublicToken")).to.not.equal(null);
    expect(feeVault.getFunction("sweepConfidentialToken")).to.not.equal(null);
    expect(feeVault.getFunction("MIN_CONFIDENTIAL_SWEEP_DELAY")).to.not.equal(null);
    expect(feeVault.getFunction("nextConfidentialSweepAt")).to.not.equal(null);
    expect(PRIVACY_MODE.TRANSPARENT).to.equal(0);
    expect(PRIVACY_MODE.AMOUNT_CONFIDENTIAL_PRIVATE_LP).to.equal(1);
    expect(PRIVACY_MODE.UNSUPPORTED_FULLY_CONFIDENTIAL).to.equal(2);
    expect(LAUNCHPAD_MIGRATION_EIP712_TYPES).to.have.length(11);
  });

  it("accepts only the public privacy-minimal discovery shape", function () {
    const feeVault = "0x0000000000000000000000000000000000000004";
    const feePolicy = getCipherDEXV1FeePolicy(30);
    expect(
      isConfidentialPoolDiscovery({
        disclosureSchemaVersion: DISCLOSURE_SCHEMA_VERSION,
        protocolVersion: 1,
        pool: "0x0000000000000000000000000000000000000001",
        token0: "0x0000000000000000000000000000000000000002",
        token1: "0x0000000000000000000000000000000000000003",
        token0Decimals: 18,
        token1Decimals: 6,
        feeBps: 30,
        feeVault,
        feePolicy,
        privacyMode: PRIVACY_MODE.AMOUNT_CONFIDENTIAL_PRIVATE_LP,
        poolKind: "private-erc20-cpmm-v1",
        quoteTransport: CONFIDENTIAL_QUOTE_TRANSPORT.TRANSACTION_EVENT,
      }),
    ).to.equal(true);
    expect(
      isConfidentialPoolDiscovery({
        disclosureSchemaVersion: DISCLOSURE_SCHEMA_VERSION,
        poolKind: "private-erc20-cpmm-v1",
      }),
    ).to.equal(false);
    expect(
      isPublicPoolDiscovery({
        disclosureSchemaVersion: DISCLOSURE_SCHEMA_VERSION,
        protocolVersion: 1,
        pool: "0x0000000000000000000000000000000000000001",
        token0: "0x0000000000000000000000000000000000000002",
        token1: "0x0000000000000000000000000000000000000003",
        token0Decimals: 18,
        token1Decimals: 6,
        feeBps: 30,
        feeVault,
        feePolicy,
        privacyMode: PRIVACY_MODE.TRANSPARENT,
        poolKind: "public-erc20-cpmm-v1",
      }),
    ).to.equal(true);

    const pool = "0x0000000000000000000000000000000000000001";
    const owner = "0x0000000000000000000000000000000000000002";
    const lockId = "0x" + "11".repeat(32);
    expect(
      isConfidentialLockDiscovery({
        disclosureSchemaVersion: DISCLOSURE_SCHEMA_VERSION,
        pool,
        lockId,
        owner,
        unlockTime: "100",
        permanent: false,
        released: false,
      }),
    ).to.equal(true);
    expect(
      isLaunchpadMigrationMetadata({
        disclosureSchemaVersion: DISCLOSURE_SCHEMA_VERSION,
        creator: owner,
        pool,
        disposition: LP_DISPOSITION.PERMANENT_LOCK,
        lockId,
        unlockTime: 0n,
      }),
    ).to.equal(true);
    expect(
      isConfidentialLockDiscovery({
        disclosureSchemaVersion: DISCLOSURE_SCHEMA_VERSION,
        pool,
        lockId,
        owner,
        unlockTime: "not-a-number",
        permanent: false,
        released: false,
      }),
    ).to.equal(false);
    expect(
      isConfidentialPoolDiscovery({
        disclosureSchemaVersion: DISCLOSURE_SCHEMA_VERSION,
        protocolVersion: 1,
        pool,
        token0: owner,
        token1: lockId.slice(0, 42),
        token0Decimals: 18,
        token1Decimals: 18,
        feeBps: 30,
        feeVault,
        feePolicy,
        privacyMode: PRIVACY_MODE.AMOUNT_CONFIDENTIAL_PRIVATE_LP,
        poolKind: "private-erc20-cpmm-v1",
        quoteTransport: CONFIDENTIAL_QUOTE_TRANSPORT.TRANSACTION_EVENT,
        totalShares: "private",
      }),
    ).to.equal(false);
  });

  it("selects the best same-request confidential quote without publishing it", function () {
    const discovery = (pool: string, feeBps: number) => ({
      disclosureSchemaVersion: DISCLOSURE_SCHEMA_VERSION,
      protocolVersion: 1,
      pool,
      token0: "0x0000000000000000000000000000000000000011",
      token1: "0x0000000000000000000000000000000000000022",
      token0Decimals: 18,
      token1Decimals: 6,
      feeBps,
      feeVault: "0x0000000000000000000000000000000000000055",
      feePolicy: getCipherDEXV1FeePolicy(feeBps),
      privacyMode: PRIVACY_MODE.AMOUNT_CONFIDENTIAL_PRIVATE_LP,
      poolKind: "private-erc20-cpmm-v1" as const,
      quoteTransport: CONFIDENTIAL_QUOTE_TRANSPORT.TRANSACTION_EVENT,
    });
    const slow = {
      discovery: discovery("0x0000000000000000000000000000000000000033", 30),
      requestId: "request-1",
      zeroForOne: true,
      decryptedAmountOut: 100n,
    };
    const best = {
      discovery: discovery("0x0000000000000000000000000000000000000044", 100),
      requestId: "request-1",
      zeroForOne: true,
      decryptedAmountOut: 110n,
    };
    expect(selectBestConfidentialPoolQuote([slow, best])).to.equal(best);
    expect(selectBestConfidentialPoolQuote([])).to.equal(undefined);
    expect(() => selectBestConfidentialPoolQuote([
      slow,
      { ...best, requestId: "different-request" },
    ])).to.throw("Incomparable confidential quote evaluations");
    expect(() => selectBestConfidentialPoolQuote([slow, slow])).to.throw(
      "Incomparable confidential quote evaluations",
    );
  });

  it("publishes the complete v1 fee policy and mirrors contract rounding", function () {
    expect(CIPHERDEX_V1_FEE_POLICY.approvedTotalFeeBps).to.deep.equal([5, 30, 100]);
    expect(getCipherDEXV1FeePolicy(30)).to.deep.include({
      totalFeeBps: 30,
      protocolFeeShareNumerator: 1,
      protocolFeeShareDenominator: 6,
      lpFeeShareNumerator: 5,
      lpFeeShareDenominator: 6,
      chargedOn: "input",
      extraNativeSwapFee: false,
      confidentialCollection: {
        minimumPoolSwapCount: 8,
        minimumPoolDelaySeconds: 3_600,
        minimumVaultSweepDelaySeconds: 86_400,
      },
    });
    expect(calculateCipherDEXV1FeeBreakdown(10_000n, 30)).to.deep.equal({
      amountIn: 10_000n,
      netAmountIn: 9_970n,
      totalFee: 30n,
      lpFee: 25n,
      protocolFee: 5n,
    });
    expect(() => getCipherDEXV1FeePolicy(25)).to.throw("Unsupported CipherDEX v1 fee tier");
  });
});
