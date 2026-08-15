import { expect } from "chai";
import { Interface } from "ethers";
import {
  CONFIDENTIAL_CPMM_ABI,
  CONFIDENTIAL_CPMM_FACTORY_ABI,
  CONFIDENTIAL_LAUNCHPAD_MIGRATOR_ABI,
  CONFIDENTIAL_QUOTE_TRANSPORT,
  CIPHERDEX_FEE_VAULT_ABI,
  CIPHERDEX_PROTOCOL_VERSION,
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
  verifyConfidentialPoolDiscovery,
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
    expect(factory.getFunction("createLaunchpadPool")).to.not.equal(null);
    expect(factory.getFunction("launchPoolKey")).to.not.equal(null);
    expect(factory.getFunction("getLaunchPool")).to.not.equal(null);
    expect(factory.getFunction("createPoolWithPublisher")).to.equal(null);
    expect(factory.getFunction("PRIVACY_MODE")).to.not.equal(null);
    expect(factory.getFunction("setBootstrapAdapter")).to.not.equal(null);
    expect(factory.getFunction("bootstrapAdapter")).to.not.equal(null);
    expect(factory.getFunction("bootstrapPool")).to.not.equal(null);
    expect(factory.getFunction("bootstrapPoolWithDisposition")).to.not.equal(null);
    expect(factory.getEvent("PoolCreated")).to.not.equal(null);
    expect(factory.getEvent("PrivateLPTokenCreated")).to.not.equal(null);
    expect(factory.getEvent("LaunchpadPoolCreated")).to.not.equal(null);
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

  it("bounds disclosure traversal and never invokes metadata accessors", function () {
    const valid = {
      disclosureSchemaVersion: DISCLOSURE_SCHEMA_VERSION,
      protocolVersion: CIPHERDEX_PROTOCOL_VERSION,
      pool: "0x0000000000000000000000000000000000000001",
      token0: "0x0000000000000000000000000000000000000002",
      token1: "0x0000000000000000000000000000000000000003",
      token0Decimals: 18,
      token1Decimals: 6,
      feeBps: 30,
      feeVault: "0x0000000000000000000000000000000000000004",
      feePolicy: getCipherDEXV1FeePolicy(30),
      privacyMode: PRIVACY_MODE.AMOUNT_CONFIDENTIAL_PRIVATE_LP,
      poolKind: "private-erc20-cpmm-v2" as const,
      quoteTransport: CONFIDENTIAL_QUOTE_TRANSPORT.TRANSACTION_EVENT,
    };

    const cyclic = { ...valid } as typeof valid & { self?: unknown };
    cyclic.self = cyclic;
    expect(isConfidentialPoolDiscovery(cyclic)).to.equal(true);

    const deepRoot: Record<string, unknown> = {};
    let cursor = deepRoot;
    for (let index = 0; index < 40; index += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    expect(() => isConfidentialPoolDiscovery({ ...valid, metadata: deepRoot })).not.to.throw();
    expect(isConfidentialPoolDiscovery({ ...valid, metadata: deepRoot })).to.equal(false);
    expect(isPublicPoolDiscovery({
      ...valid,
      metadata: deepRoot,
      privacyMode: PRIVACY_MODE.TRANSPARENT,
      poolKind: "public-erc20-cpmm-v2",
    })).to.equal(false);
    expect(isConfidentialLockDiscovery({
      disclosureSchemaVersion: DISCLOSURE_SCHEMA_VERSION,
      pool: valid.pool,
      lockId: "0x" + "11".repeat(32),
      owner: valid.token0,
      unlockTime: "0",
      permanent: false,
      released: false,
      metadata: deepRoot,
    })).to.equal(false);
    expect(isLaunchpadMigrationMetadata({
      disclosureSchemaVersion: DISCLOSURE_SCHEMA_VERSION,
      creator: valid.token0,
      pool: valid.pool,
      disposition: LP_DISPOSITION.CREATOR_HELD,
      lockId: "0x" + "00".repeat(32),
      unlockTime: "0",
      metadata: deepRoot,
    })).to.equal(false);

    const wide = Object.fromEntries(
      Array.from({ length: 1_100 }, (_, index) => [`node${index}`, {}]),
    );
    expect(isConfidentialPoolDiscovery({ ...valid, metadata: wide })).to.equal(false);

    const widePrimitive = Object.fromEntries(
      Array.from({ length: 5_000 }, (_, index) => [`value${index}`, index]),
    );
    expect(isConfidentialPoolDiscovery({ ...valid, metadata: widePrimitive })).to.equal(false);

    let getterCalls = 0;
    const accessor = { ...valid } as typeof valid & { metadata?: unknown };
    Object.defineProperty(accessor, "metadata", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return {};
      },
    });
    expect(isConfidentialPoolDiscovery(accessor)).to.equal(false);
    expect(getterCalls).to.equal(0);

    const hostile = new Proxy({ ...valid }, {
      ownKeys() {
        throw new Error("hostile metadata");
      },
    });
    expect(() => isConfidentialPoolDiscovery(hostile)).not.to.throw();
    expect(isConfidentialPoolDiscovery(hostile)).to.equal(false);
  });

  it("requires factory-proven discovery before selecting a confidential quote", async function () {
    const factory = "0x0000000000000000000000000000000000000099";
    const feeVault = "0x0000000000000000000000000000000000000055";
    const discovery = (pool: string, feeBps: number) => ({
      disclosureSchemaVersion: DISCLOSURE_SCHEMA_VERSION,
      protocolVersion: CIPHERDEX_PROTOCOL_VERSION,
      pool,
      token0: "0x0000000000000000000000000000000000000011",
      token1: "0x0000000000000000000000000000000000000022",
      token0Decimals: 18,
      token1Decimals: 6,
      feeBps,
      feeVault,
      feePolicy: getCipherDEXV1FeePolicy(feeBps),
      privacyMode: PRIVACY_MODE.AMOUNT_CONFIDENTIAL_PRIVATE_LP,
      poolKind: "private-erc20-cpmm-v2" as const,
      quoteTransport: CONFIDENTIAL_QUOTE_TRANSPORT.TRANSACTION_EVENT,
    });
    const adapter = (candidate: ReturnType<typeof discovery>, overrides: Record<string, unknown> = {}) => ({
      getCode: async () => "0x60006000",
      readFactoryProtocolVersion: async () => BigInt(CIPHERDEX_PROTOCOL_VERSION),
      isFactoryPool: async () => true,
      getCanonicalPool: async () => candidate.pool,
      readPoolState: async () => ({
        protocolVersion: BigInt(CIPHERDEX_PROTOCOL_VERSION),
        privacyMode: 1n,
        token0: candidate.token0,
        token1: candidate.token1,
        token0Decimals: 18n,
        token1Decimals: 6n,
        feeBps: BigInt(candidate.feeBps),
        feeVault,
      }),
      ...overrides,
    });
    const verify = (candidate: ReturnType<typeof discovery>, overrides: Record<string, unknown> = {}) =>
      verifyConfidentialPoolDiscovery(
        candidate,
        {
          expectedFactory: factory,
          expectedFeeVault: feeVault,
          expectedProtocolVersion: CIPHERDEX_PROTOCOL_VERSION,
        },
        adapter(candidate, overrides),
      );

    const slowDiscovery = discovery("0x0000000000000000000000000000000000000033", 30);
    const bestDiscovery = discovery("0x0000000000000000000000000000000000000044", 100);
    let dynamicPoolReads = 0;
    const dynamicDiscovery = new Proxy(slowDiscovery, {
      get(target, property, receiver) {
        if (property === "pool") dynamicPoolReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const snapshottedDiscovery = await verifyConfidentialPoolDiscovery(
      dynamicDiscovery,
      {
        expectedFactory: factory,
        expectedFeeVault: feeVault,
        expectedProtocolVersion: CIPHERDEX_PROTOCOL_VERSION,
      },
      adapter(slowDiscovery),
    );
    expect(snapshottedDiscovery.pool).to.equal(slowDiscovery.pool);
    expect(dynamicPoolReads).to.equal(0);
    const slow = {
      discovery: await verify(slowDiscovery),
      requestId: "request-1",
      zeroForOne: true,
      decryptedAmountOut: 100n,
    };
    const best = {
      discovery: await verify(bestDiscovery),
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

    expect(() => selectBestConfidentialPoolQuote([{
      ...slow,
      discovery: slowDiscovery,
    }] as never)).to.throw("Invalid confidential quote evaluation");

    for (const overrides of [
      { isFactoryPool: async () => false },
      { getCanonicalPool: async () => "0x0000000000000000000000000000000000000077" },
      {
        readPoolState: async () => ({
          protocolVersion: BigInt(CIPHERDEX_PROTOCOL_VERSION),
          privacyMode: 1n,
          token0: slowDiscovery.token0,
          token1: slowDiscovery.token1,
          token0Decimals: 18n,
          token1Decimals: 6n,
          feeBps: 30n,
          feeVault: "0x0000000000000000000000000000000000000088",
        }),
      },
    ]) {
      let rejected = false;
      try {
        await verify(slowDiscovery, overrides);
      } catch (error) {
        rejected = error instanceof TypeError;
      }
      expect(rejected).to.equal(true);
    }
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
