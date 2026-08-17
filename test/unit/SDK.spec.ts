import { expect } from "chai";
import { AbiCoder, Interface, ZeroHash, keccak256, zeroPadValue } from "ethers";
import {
  CONFIDENTIAL_CPMM_ABI,
  CONFIDENTIAL_CPMM_FACTORY_ABI,
  CONFIDENTIAL_BEST_EXECUTION_POOL_ABI,
  CONFIDENTIAL_BEST_EXECUTION_ROUTER_ABI,
  CONFIDENTIAL_BEST_EXECUTION_ROUTER_VERSION,
  CONFIDENTIAL_BEST_QUOTE_SELECTOR,
  CONFIDENTIAL_BEST_SWAP_SELECTOR,
  CONFIDENTIAL_LIQUIDITY_LOCKED_TOPIC,
  CONFIDENTIAL_LAUNCHPAD_MIGRATOR_ABI,
  CONFIDENTIAL_LAUNCHPAD_MIGRATOR_VERSION,
  CONFIDENTIAL_QUOTE_TRANSPORT,
  CIPHERDEX_FEE_VAULT_ABI,
  CIPHERDEX_PROTOCOL_VERSION,
  CIPHERDEX_V1_FEE_POLICY,
  DISCLOSURE_SCHEMA_VERSION,
  LAUNCHPAD_MIGRATION_EIP712_TYPES,
  LAUNCHPAD_LOCK_DISPOSITION_TOPIC,
  LAUNCHPAD_MIGRATE_SELECTOR,
  LAUNCHPAD_MIGRATE_WITH_DISPOSITION_SELECTOR,
  LAUNCHPAD_MIGRATION_TOPIC,
  LP_DISPOSITION,
  PRIVACY_MODE,
  PRIVATE_LP_TOKEN_ABI,
  PUBLIC_CPMM_ABI,
  PUBLIC_CPMM_FACTORY_ABI,
  PUBLIC_CPMM_QUOTER_ABI,
  PUBLIC_CPMM_ROUTER_ABI,
  calculateCipherDEXV1FeeBreakdown,
  buildConfidentialBestQuoteCall,
  buildConfidentialBestSwapCall,
  buildVerifiedConfidentialBestQuoteTransaction,
  buildVerifiedConfidentialBestSwapTransaction,
  decryptConfidentialBestExecutionResult,
  getCipherDEXV1FeePolicy,
  getConfidentialBestExecutionEncryptionBinding,
  isConfidentialLockDiscovery,
  isConfidentialLockDiscoveryShape,
  isConfidentialPoolDiscovery,
  isLaunchpadMigrationMetadata,
  isLaunchpadMigrationMetadataShape,
  isPublicPoolDiscovery,
  minimumCipherDEXV1ConfidentialInput,
  verifyConfidentialPoolDiscovery,
  verifyConfidentialBestExecutionRouter,
  verifyLaunchpadMigrationMetadata,
  verifyPublicPoolDiscovery,
} from "../../sdk/src/index";

describe("stable SDK surface", function () {
  it("parses the published pool and factory ABI fragments", function () {
    expect(DISCLOSURE_SCHEMA_VERSION).to.equal(5);
    const pool = new Interface(CONFIDENTIAL_CPMM_ABI);
    const factory = new Interface(CONFIDENTIAL_CPMM_FACTORY_ABI);
    const bestExecutionPool = new Interface(CONFIDENTIAL_BEST_EXECUTION_POOL_ABI);
    const bestExecutionRouter = new Interface(CONFIDENTIAL_BEST_EXECUTION_ROUTER_ABI);
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
    expect(pool.getFunction("quoteExactInput")).to.not.equal(null);
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
    expect(factory.getFunction("getOrCreatePoolForBootstrap")).to.not.equal(null);
    expect(factory.getFunction("createPoolWithPublisher")).to.equal(null);
    expect(factory.getFunction("PRIVACY_MODE")).to.not.equal(null);
    expect(factory.getFunction("setBootstrapAdapter")).to.not.equal(null);
    expect(factory.getFunction("bootstrapAdapter")).to.not.equal(null);
    expect(factory.getFunction("setBestExecutionRouter")).to.not.equal(null);
    expect(factory.getFunction("bestExecutionRouter")).to.not.equal(null);
    expect(factory.getFunction("bootstrapPool")).to.not.equal(null);
    expect(factory.getFunction("bootstrapPoolWithDisposition")).to.not.equal(null);
    expect(factory.getFunction("isApprovedPrivateToken")).to.not.equal(null);
    expect(factory.getEvent("PoolCreated")).to.not.equal(null);
    expect(factory.getEvent("PrivateLPTokenCreated")).to.not.equal(null);
    expect(factory.getEvent("BestExecutionRouterConfigured")).to.not.equal(null);
    expect(bestExecutionPool.getFunction("quoteExactInputForRouter")).to.not.equal(null);
    expect(bestExecutionPool.getFunction("settleExactInputForRouter")).to.not.equal(null);
    expect(bestExecutionRouter.getFunction("requestBestQuoteExactInput")).to.not.equal(null);
    expect(bestExecutionRouter.getFunction("swapBestExactInput")).to.not.equal(null);
    expect(bestExecutionRouter.getEvent("ConfidentialBestQuoteResult")).to.not.equal(null);
    expect(bestExecutionRouter.getEvent("ConfidentialBestSwapResult")).to.not.equal(null);
    expect(CONFIDENTIAL_BEST_EXECUTION_ROUTER_VERSION).to.equal(1);
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
        protocolVersion: CIPHERDEX_PROTOCOL_VERSION,
        pool: "0x0000000000000000000000000000000000000001",
        token0: "0x0000000000000000000000000000000000000002",
        token1: "0x0000000000000000000000000000000000000003",
        token0Decimals: 18,
        token1Decimals: 6,
        feeBps: 30,
        feeVault,
        feePolicy,
        privacyMode: PRIVACY_MODE.AMOUNT_CONFIDENTIAL_PRIVATE_LP,
        poolKind: "private-erc20-cpmm-v2",
        quoteTransport: CONFIDENTIAL_QUOTE_TRANSPORT.TRANSACTION_EVENT,
      }),
    ).to.equal(true);
    expect(isConfidentialPoolDiscovery({
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
    })).to.equal(false);
    expect(
      isPublicPoolDiscovery({
        disclosureSchemaVersion: DISCLOSURE_SCHEMA_VERSION,
        protocolVersion: CIPHERDEX_PROTOCOL_VERSION,
        pool: "0x0000000000000000000000000000000000000001",
        token0: "0x0000000000000000000000000000000000000002",
        token1: "0x0000000000000000000000000000000000000003",
        token0Decimals: 18,
        token1Decimals: 6,
        feeBps: 30,
        feeVault,
        feePolicy,
        privacyMode: PRIVACY_MODE.TRANSPARENT,
        poolKind: "public-erc20-cpmm-v2",
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
        protocolVersion: CIPHERDEX_PROTOCOL_VERSION,
        pool,
        token0: owner,
        token1: lockId.slice(0, 42),
        token0Decimals: 18,
        token1Decimals: 18,
        feeBps: 30,
        feeVault,
        feePolicy,
        privacyMode: PRIVACY_MODE.AMOUNT_CONFIDENTIAL_PRIVATE_LP,
        poolKind: "private-erc20-cpmm-v2",
        quoteTransport: CONFIDENTIAL_QUOTE_TRANSPORT.TRANSACTION_EVENT,
        totalShares: "private",
      }),
    ).to.equal(false);
  });

  it("separates lock and migration shape parsing from semantic validation", function () {
    const pool = "0x0000000000000000000000000000000000000011";
    const creator = "0x0000000000000000000000000000000000000022";
    const lockId = `0x${"33".repeat(32)}`;
    const contradictoryLock = {
      disclosureSchemaVersion: DISCLOSURE_SCHEMA_VERSION,
      pool,
      lockId,
      owner: creator,
      unlockTime: "10",
      permanent: true,
      released: false,
    };
    expect(isConfidentialLockDiscoveryShape(contradictoryLock)).to.equal(true);
    expect(isConfidentialLockDiscovery(contradictoryLock)).to.equal(false);

    const contradictoryMigration = {
      disclosureSchemaVersion: DISCLOSURE_SCHEMA_VERSION,
      creator,
      pool,
      disposition: LP_DISPOSITION.CREATOR_HELD,
      lockId,
      unlockTime: 0n,
    };
    expect(isLaunchpadMigrationMetadataShape(contradictoryMigration)).to.equal(true);
    expect(isLaunchpadMigrationMetadata(contradictoryMigration)).to.equal(false);
    expect(isLaunchpadMigrationMetadata({
      ...contradictoryMigration,
      disposition: LP_DISPOSITION.TIMED_LOCK,
      unlockTime: 100n,
    })).to.equal(true);
    expect(isLaunchpadMigrationMetadata({
      ...contradictoryMigration,
      disposition: LP_DISPOSITION.PERMANENT_LOCK,
    })).to.equal(true);
  });

  it("authenticates launchpad metadata against receipt, factory, canonical pool, and lock state", async function () {
    const chainId = 7_082_400;
    const factory = "0x0000000000000000000000000000000000000011";
    const migrator = "0x0000000000000000000000000000000000000022";
    const creator = "0x0000000000000000000000000000000000000033";
    const pool = "0x0000000000000000000000000000000000000044";
    const token0 = "0x0000000000000000000000000000000000000055";
    const token1 = "0x0000000000000000000000000000000000000066";
    const feeVault = "0x0000000000000000000000000000000000000077";
    const lpToken = "0x0000000000000000000000000000000000000088";
    const transactionHash = `0x${"99".repeat(32)}`;
    const lockId = `0x${"aa".repeat(32)}`;
    const factoryCode = "0x6001600055";
    const migratorCode = "0x6002600055";
    const metadata = {
      disclosureSchemaVersion: DISCLOSURE_SCHEMA_VERSION,
      creator,
      pool,
      disposition: LP_DISPOSITION.TIMED_LOCK,
      lockId,
      unlockTime: 100n,
    } as const;
    const abi = AbiCoder.defaultAbiCoder();
    const topicAddress = (address: string) => zeroPadValue(address, 32);
    const receipt = {
      transactionHash,
      status: 1,
      logs: [
        {
          address: migrator,
          topics: [LAUNCHPAD_MIGRATION_TOPIC, topicAddress(creator), topicAddress(pool)],
          data: "0x",
        },
        {
          address: pool,
          topics: [CONFIDENTIAL_LIQUIDITY_LOCKED_TOPIC, lockId, topicAddress(creator)],
          data: abi.encode(["uint64", "bool"], [100n, false]),
        },
        {
          address: migrator,
          topics: [LAUNCHPAD_LOCK_DISPOSITION_TOPIC, topicAddress(creator), topicAddress(pool)],
          data: abi.encode(["uint8", "bytes32", "uint64"], [
            LP_DISPOSITION.TIMED_LOCK,
            lockId,
            100n,
          ]),
        },
      ],
    };
    const adapter = {
      readChainId: async () => chainId,
      getCode: async (address: string) => address.toLowerCase() === factory.toLowerCase()
        ? factoryCode
        : migratorCode,
      hashRuntimeCode: (code: string) => keccak256(code),
      getTransaction: async () => ({
        chainId,
        hash: transactionHash,
        from: creator,
        to: migrator,
        data: `${LAUNCHPAD_MIGRATE_WITH_DISPOSITION_SELECTOR}${"00".repeat(32)}`,
      }),
      getTransactionReceipt: async () => receipt,
      readFactoryProtocolVersion: async () => CIPHERDEX_PROTOCOL_VERSION,
      readFactoryBootstrapAdapter: async () => migrator,
      isFactoryPool: async () => true,
      readMigratorProtocolVersion: async () => CONFIDENTIAL_LAUNCHPAD_MIGRATOR_VERSION,
      readMigratorFactory: async () => factory,
      readPoolState: async () => ({
        protocolVersion: CIPHERDEX_PROTOCOL_VERSION,
        privacyMode: PRIVACY_MODE.AMOUNT_CONFIDENTIAL_PRIVATE_LP,
        token0,
        token1,
        token0Decimals: 18,
        token1Decimals: 6,
        feeBps: 30,
        feeVault,
        lpToken,
      }),
      getCanonicalPool: async () => pool,
      readLockInfo: async () => ({
        owner: creator,
        unlockTime: 100n,
        permanent: false,
        released: false,
      }),
    };
    const policy = {
      expectedChainId: chainId,
      expectedFactory: factory,
      expectedFactoryRuntimeCodehash: keccak256(factoryCode),
      expectedMigrator: migrator,
      expectedMigratorRuntimeCodehash: keccak256(migratorCode),
      expectedFeeVault: feeVault,
      expectedFactoryProtocolVersion: CIPHERDEX_PROTOCOL_VERSION,
      expectedPoolProtocolVersion: CIPHERDEX_PROTOCOL_VERSION,
      expectedMigratorProtocolVersion: CONFIDENTIAL_LAUNCHPAD_MIGRATOR_VERSION,
    };

    const verified = await verifyLaunchpadMigrationMetadata(
      { transactionHash, metadata },
      policy,
      adapter,
    );
    expect(verified.pool).to.equal(pool);
    expect(verified.factory).to.equal(factory);
    expect(Object.isFrozen(verified)).to.equal(true);

    for (const overrides of [
      { getTransaction: async () => ({ ...(await adapter.getTransaction()), from: token0 }) },
      { getTransactionReceipt: async () => ({ ...receipt, status: 0 }) },
      { readFactoryBootstrapAdapter: async () => token0 },
      { isFactoryPool: async () => false },
      { getCanonicalPool: async () => token0 },
      { readLockInfo: async () => ({ owner: creator, unlockTime: 100n, permanent: false, released: true }) },
    ]) {
      let rejected = false;
      try {
        await verifyLaunchpadMigrationMetadata(
          { transactionHash, metadata },
          policy,
          { ...adapter, ...overrides },
        );
      } catch {
        rejected = true;
      }
      expect(rejected).to.equal(true);
    }

    const creatorHeldMetadata = {
      ...metadata,
      disposition: LP_DISPOSITION.CREATOR_HELD,
      lockId: ZeroHash,
      unlockTime: 0n,
    } as const;
    const creatorHeldAdapter = {
      ...adapter,
      getTransaction: async () => ({
        chainId,
        hash: transactionHash,
        from: creator,
        to: migrator,
        data: `${LAUNCHPAD_MIGRATE_SELECTOR}${"00".repeat(32)}`,
      }),
      getTransactionReceipt: async () => ({
        transactionHash,
        status: 1,
        logs: [{
          address: migrator,
          topics: [LAUNCHPAD_MIGRATION_TOPIC, topicAddress(creator), topicAddress(pool)],
          data: "0x",
        }],
      }),
      readLockInfo: async () => {
        throw new Error("creator-held migration must not read lock state");
      },
    };
    const creatorHeld = await verifyLaunchpadMigrationMetadata(
      { transactionHash, metadata: creatorHeldMetadata },
      policy,
      creatorHeldAdapter,
    );
    expect(creatorHeld.disposition).to.equal(LP_DISPOSITION.CREATOR_HELD);
  });

  it("builds immutable caller-encrypted best quote and swap calls", function () {
    const tokenIn = "0x0000000000000000000000000000000000000011";
    const tokenOut = "0x0000000000000000000000000000000000000022";
    const requestId = "0x" + "12".repeat(32);
    const amountIn = {
      ciphertext: { ciphertextHigh: 1n, ciphertextLow: 2n },
      signature: "0x1234",
    };
    const minimumOut = {
      ciphertext: { ciphertextHigh: 3n, ciphertextLow: 4n },
      signature: new Uint8Array([1, 2]),
    };

    const quote = buildConfidentialBestQuoteCall(
      tokenIn,
      tokenOut,
      amountIn,
      requestId,
      1_000n,
    );
    expect(quote.functionName).to.equal("requestBestQuoteExactInput");
    expect(quote.args).to.deep.equal([
      tokenIn,
      tokenOut,
      amountIn,
      requestId,
      1_000n,
    ]);
    expect(Object.isFrozen(quote)).to.equal(true);
    expect(Object.isFrozen(quote.args)).to.equal(true);
    expect(Object.isFrozen(quote.args[2])).to.equal(true);
    expect(Object.isFrozen(quote.args[2].ciphertext)).to.equal(true);

    const swap = buildConfidentialBestSwapCall(
      tokenIn,
      tokenOut,
      amountIn,
      minimumOut,
      requestId,
      1_000n,
    );
    expect(swap.functionName).to.equal("swapBestExactInput");
    expect(swap.args).to.deep.equal([
      tokenIn,
      tokenOut,
      amountIn,
      {
        ciphertext: { ciphertextHigh: 3n, ciphertextLow: 4n },
        signature: "0x0102",
      },
      requestId,
      1_000n,
    ]);

    amountIn.ciphertext.ciphertextHigh = 99n;
    amountIn.signature = "0xabcd";
    minimumOut.ciphertext.ciphertextLow = 99n;
    minimumOut.signature[0] = 99;
    expect(quote.args[2]).to.deep.equal({
      ciphertext: { ciphertextHigh: 1n, ciphertextLow: 2n },
      signature: "0x1234",
    });
    expect(swap.args[2]).to.deep.equal(quote.args[2]);
    expect(swap.args[3]).to.deep.equal({
      ciphertext: { ciphertextHigh: 3n, ciphertextLow: 4n },
      signature: "0x0102",
    });

    const fullWidthCiphertext = {
      ciphertext: {
        ciphertextHigh: (1n << 256n) - 1n,
        ciphertextLow: 1n << 128n,
      },
      signature: "0x1234",
    };
    expect(() => buildConfidentialBestQuoteCall(
      tokenIn,
      tokenOut,
      fullWidthCiphertext,
      requestId,
      1n,
    )).to.not.throw();

    for (const operation of [
      () => buildConfidentialBestQuoteCall(tokenIn, tokenIn, amountIn, requestId, 1n),
      () => buildConfidentialBestQuoteCall(tokenIn, tokenOut, amountIn, ZeroHash, 1n),
      () => buildConfidentialBestQuoteCall(tokenIn, tokenOut, amountIn, requestId, 0n),
      () => buildConfidentialBestQuoteCall(
        tokenIn,
        tokenOut,
        { ...amountIn, signature: "0x" },
        requestId,
        1n,
      ),
      () => buildConfidentialBestQuoteCall(
        tokenIn,
        tokenOut,
        {
          ...amountIn,
          ciphertext: { ciphertextHigh: 1n << 256n, ciphertextLow: 0n },
        },
        requestId,
        1n,
      ),
      () => buildConfidentialBestQuoteCall(
        tokenIn,
        tokenOut,
        {
          ...amountIn,
          ciphertext: { ciphertextHigh: -1n, ciphertextLow: 0n },
        },
        requestId,
        1n,
      ),
    ]) {
      expect(operation).to.throw(TypeError);
    }
  });

  it("binds best-execution transactions and decryption to canonical chain evidence", async function () {
    const chainId = 31_337;
    const factory = "0x0000000000000000000000000000000000000099";
    const routerAddress = "0x0000000000000000000000000000000000000088";
    const caller = "0x0000000000000000000000000000000000000077";
    const requestId = "0x" + "ab".repeat(32);
    const deployedCode = "0x60006000";
    const deployedCodehash = keccak256(deployedCode);
    const adapter = {
      readChainId: async () => BigInt(chainId),
      getCode: async () => deployedCode,
      hashRuntimeCode: (code: string) => keccak256(code),
      readFactoryProtocolVersion: async () => BigInt(CIPHERDEX_PROTOCOL_VERSION),
      readFactoryBestExecutionRouter: async () => routerAddress,
      readRouterProtocolVersion: async () =>
        BigInt(CONFIDENTIAL_BEST_EXECUTION_ROUTER_VERSION),
      readRouterFactory: async () => factory,
    };
    const verified = await verifyConfidentialBestExecutionRouter(
      routerAddress,
      {
        expectedChainId: chainId,
        expectedFactory: factory,
        expectedFactoryRuntimeCodehash: deployedCodehash,
        expectedRouter: routerAddress,
        expectedRouterRuntimeCodehash: deployedCodehash,
        expectedFactoryProtocolVersion: CIPHERDEX_PROTOCOL_VERSION,
        expectedRouterProtocolVersion: CONFIDENTIAL_BEST_EXECUTION_ROUTER_VERSION,
      },
      adapter,
    );
    const tokenIn = "0x0000000000000000000000000000000000000011";
    const tokenOut = "0x0000000000000000000000000000000000000022";
    const amountIn = {
      ciphertext: { ciphertextHigh: 1n, ciphertextLow: 2n },
      signature: "0x1234",
    };
    const minimumOut = {
      ciphertext: { ciphertextHigh: 3n, ciphertextLow: 4n },
      signature: "0x5678",
    };

    expect(getConfidentialBestExecutionEncryptionBinding(verified, "quote")).to.deep.equal({
      chainId,
      contractAddress: routerAddress,
      functionName: "requestBestQuoteExactInput",
      functionSelector: CONFIDENTIAL_BEST_QUOTE_SELECTOR,
    });
    expect(getConfidentialBestExecutionEncryptionBinding(verified, "swap")).to.deep.equal({
      chainId,
      contractAddress: routerAddress,
      functionName: "swapBestExactInput",
      functionSelector: CONFIDENTIAL_BEST_SWAP_SELECTOR,
    });
    const quote = buildVerifiedConfidentialBestQuoteTransaction(
      verified,
      tokenIn,
      tokenOut,
      amountIn,
      requestId,
      1_000n,
    );
    expect(quote.to).to.equal(routerAddress);
    expect(quote.chainId).to.equal(chainId);
    expect(quote.functionName).to.equal("requestBestQuoteExactInput");
    const swap = buildVerifiedConfidentialBestSwapTransaction(
      verified,
      tokenIn,
      tokenOut,
      amountIn,
      minimumOut,
      requestId,
      1_000n,
    );
    expect(swap.to).to.equal(routerAddress);
    expect(swap.chainId).to.equal(chainId);
    expect(swap.functionName).to.equal("swapBestExactInput");

    const selectedPool = "0x0000000000000000000000000000000000000066";
    const transactionHash = "0x" + "cd".repeat(32);
    const routerInterface = new Interface(CONFIDENTIAL_BEST_EXECUTION_ROUTER_ABI);
    const transactionData = routerInterface.encodeFunctionData(
      "requestBestQuoteExactInput",
      [tokenIn, tokenOut, [[1n, 2n], "0x1234"], requestId, 1_000n],
    );
    const encodedEvent = routerInterface.encodeEventLog(
      "ConfidentialBestQuoteResult",
      [caller, requestId, selectedPool, 30n, true, [5n, 1n << 128n]],
    );
    const expectation = {
      operation: "quote" as const,
      caller,
      requestId,
      tokenIn,
      tokenOut,
      transactionHash,
      transactionData,
    };
    const evidence = {
      transaction: {
        chainId,
        hash: transactionHash,
        from: caller,
        to: routerAddress,
        data: transactionData,
      },
      receipt: {
        transactionHash,
        status: 1,
        logs: [{ address: routerAddress, ...encodedEvent }],
      },
    };
    const decryptionAdapter = {
      readChainId: async () => BigInt(chainId),
      getTransaction: async (hash: string) => {
        expect(hash).to.equal(transactionHash);
        return evidence.transaction;
      },
      getTransactionReceipt: async (hash: string) => {
        expect(hash).to.equal(transactionHash);
        return evidence.receipt;
      },
      getCanonicalPool: async () => selectedPool,
      decryptValue256: async (value: { ciphertextHigh: bigint; ciphertextLow: bigint }) => {
        expect(value).to.deep.equal({ ciphertextHigh: 5n, ciphertextLow: 1n << 128n });
        return 42n;
      },
    };
    expect(
      await decryptConfidentialBestExecutionResult(
        verified,
        expectation,
        decryptionAdapter,
      ),
    ).to.equal(42n);

    for (const overrides of [
      { readChainId: async () => BigInt(chainId + 1) },
      { readFactoryBestExecutionRouter: async () => caller },
      { readRouterFactory: async () => caller },
      { readRouterProtocolVersion: async () => 2n },
      { getCode: async () => "0x" },
    ]) {
      let rejected = false;
      try {
        await verifyConfidentialBestExecutionRouter(
          routerAddress,
          {
            expectedChainId: chainId,
            expectedFactory: factory,
            expectedFactoryRuntimeCodehash: deployedCodehash,
            expectedRouter: routerAddress,
            expectedRouterRuntimeCodehash: deployedCodehash,
            expectedFactoryProtocolVersion: CIPHERDEX_PROTOCOL_VERSION,
            expectedRouterProtocolVersion: CONFIDENTIAL_BEST_EXECUTION_ROUTER_VERSION,
          },
          { ...adapter, ...overrides },
        );
      } catch (error) {
        rejected = error instanceof TypeError;
      }
      expect(rejected).to.equal(true);
    }

    for (const policyOverrides of [
      { expectedRouter: caller },
      { expectedRouterRuntimeCodehash: "0x" + "11".repeat(32) },
      { expectedFactoryRuntimeCodehash: "0x" + "22".repeat(32) },
    ]) {
      let rejected = false;
      try {
        await verifyConfidentialBestExecutionRouter(
          routerAddress,
          {
            expectedChainId: chainId,
            expectedFactory: factory,
            expectedFactoryRuntimeCodehash: deployedCodehash,
            expectedRouter: routerAddress,
            expectedRouterRuntimeCodehash: deployedCodehash,
            expectedFactoryProtocolVersion: CIPHERDEX_PROTOCOL_VERSION,
            expectedRouterProtocolVersion: CONFIDENTIAL_BEST_EXECUTION_ROUTER_VERSION,
            ...policyOverrides,
          },
          adapter,
        );
      } catch (error) {
        rejected = error instanceof TypeError;
      }
      expect(rejected).to.equal(true);
    }

    const forgedCases = [
      {
        expectation: { ...expectation, operation: "swap" as const },
        adapter: decryptionAdapter,
      },
      {
        expectation,
        adapter: {
          ...decryptionAdapter,
          getTransaction: async () => ({
            ...evidence.transaction,
            data: routerInterface.encodeFunctionData(
              "requestBestQuoteExactInput",
              [tokenIn, tokenOut, [[1n, 2n], "0x1234"], requestId, 1_001n],
            ),
          }),
        },
      },
      {
        expectation,
        adapter: {
          ...decryptionAdapter,
          getTransaction: async () => ({
            ...evidence.transaction,
            data: routerInterface.encodeFunctionData(
              "requestBestQuoteExactInput",
              [tokenIn, tokenOut, [[9n, 2n], "0x1234"], requestId, 1_000n],
            ),
          }),
        },
      },
      {
        expectation,
        adapter: {
          ...decryptionAdapter,
          getTransaction: async () => ({
            ...evidence.transaction,
            chainId: chainId + 1,
          }),
        },
      },
      {
        expectation,
        adapter: {
          ...decryptionAdapter,
          getTransactionReceipt: async () => ({
            ...evidence.receipt,
            logs: [
              ...evidence.receipt.logs,
              { address: routerAddress, ...encodedEvent },
            ],
          }),
        },
      },
      {
        expectation,
        adapter: { ...decryptionAdapter, getCanonicalPool: async () => caller },
      },
      {
        expectation,
        adapter: { ...decryptionAdapter, readChainId: async () => BigInt(chainId + 1) },
      },
      {
        expectation,
        adapter: { ...decryptionAdapter, getTransaction: async () => null },
      },
      {
        expectation,
        adapter: { ...decryptionAdapter, getTransactionReceipt: async () => null },
      },
      {
        expectation,
        adapter: {
          ...decryptionAdapter,
          getTransaction: async () => {
            throw new Error("RPC unavailable");
          },
        },
      },
    ];
    for (const candidate of forgedCases) {
      let rejected = false;
      try {
        await decryptConfidentialBestExecutionResult(
          verified,
          candidate.expectation,
          candidate.adapter,
        );
      } catch (error) {
        rejected = error instanceof TypeError;
      }
      expect(rejected).to.equal(true);
    }
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
    expect(isConfidentialPoolDiscovery(cyclic)).to.equal(false);

    for (const extra of [
      { amount0: "1" },
      { protocolFeeAmount: "1" },
      { AmountIn: "1" },
      { arbitraryMetadata: "unexpected" },
    ]) {
      expect(isConfidentialPoolDiscovery({ ...valid, ...extra })).to.equal(false);
    }
    expect(isConfidentialPoolDiscovery({
      ...valid,
      feePolicy: {
        ...valid.feePolicy,
        confidentialCollection: {
          ...valid.feePolicy.confidentialCollection,
          amount: "1",
        },
      },
    })).to.equal(false);
    expect(isConfidentialPoolDiscovery({
      ...valid,
      [Symbol("hidden")]: "1",
    })).to.equal(false);

    let proxyGetCalls = 0;
    const dataPropertyProxy = new Proxy({ ...valid }, {
      get() {
        proxyGetCalls += 1;
        throw new Error("shape validation must not invoke proxy getters");
      },
    });
    expect(isConfidentialPoolDiscovery(dataPropertyProxy)).to.equal(true);
    expect(proxyGetCalls).to.equal(0);

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
    expect(isPublicPoolDiscovery({
      disclosureSchemaVersion: DISCLOSURE_SCHEMA_VERSION,
      protocolVersion: CIPHERDEX_PROTOCOL_VERSION,
      pool: valid.pool,
      token0: valid.token0,
      token1: valid.token1,
      token0Decimals: valid.token0Decimals,
      token1Decimals: valid.token1Decimals,
      feeBps: valid.feeBps,
      feeVault: valid.feeVault,
      feePolicy: valid.feePolicy,
      privacyMode: PRIVACY_MODE.TRANSPARENT,
      poolKind: "public-erc20-cpmm-v2",
      amount0: "1",
    })).to.equal(false);
    expect(isConfidentialLockDiscovery({
      disclosureSchemaVersion: DISCLOSURE_SCHEMA_VERSION,
      pool: valid.pool,
      lockId: "0x" + "11".repeat(32),
      owner: valid.token0,
      unlockTime: "0",
      permanent: false,
      released: false,
      amount0: "1",
    })).to.equal(false);
    expect(isLaunchpadMigrationMetadata({
      disclosureSchemaVersion: DISCLOSURE_SCHEMA_VERSION,
      creator: valid.token0,
      pool: valid.pool,
      disposition: LP_DISPOSITION.CREATOR_HELD,
      lockId: "0x" + "00".repeat(32),
      unlockTime: "0",
      amount0: "1",
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

  it("fails closed for revoked Proxy metadata across every exported predicate", function () {
    const guards = [
      isConfidentialPoolDiscovery,
      isPublicPoolDiscovery,
      isConfidentialLockDiscovery,
      isLaunchpadMigrationMetadata,
    ];

    for (const guard of guards) {
      const { proxy, revoke } = Proxy.revocable({}, {});
      revoke();
      expect(() => guard(proxy)).not.to.throw();
      expect(guard(proxy)).to.equal(false);
    }
  });

  it("requires factory-proven confidential pool discovery", async function () {
    const chainId = 31_337;
    const factory = "0x0000000000000000000000000000000000000099";
    const feeVault = "0x0000000000000000000000000000000000000055";
    const lpTokenFactory = "0x0000000000000000000000000000000000000066";
    const lpToken = "0x0000000000000000000000000000000000000044";
    const deployedCode = "0x60006000";
    const lpTokenFactoryRuntimeCodehash = keccak256(deployedCode);
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
      readChainId: async () => BigInt(chainId),
      getCode: async () => deployedCode,
      hashRuntimeCode: (code: string) => keccak256(code),
      readFactoryProtocolVersion: async () => BigInt(CIPHERDEX_PROTOCOL_VERSION),
      readFactoryLPTokenFactory: async () => lpTokenFactory,
      readFactoryLPTokenFactoryRuntimeCodehash: async () => lpTokenFactoryRuntimeCodehash,
      isLPTokenIssued: async () => true,
      isFactoryPrivateTokenApproved: async () => true,
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
        lpToken,
      }),
      ...overrides,
    });
    const verify = (candidate: ReturnType<typeof discovery>, overrides: Record<string, unknown> = {}) =>
      verifyConfidentialPoolDiscovery(
        candidate,
        {
          expectedChainId: chainId,
          expectedFactory: factory,
          expectedFeeVault: feeVault,
          expectedProtocolVersion: CIPHERDEX_PROTOCOL_VERSION,
          expectedLPTokenFactory: lpTokenFactory,
          expectedLPTokenFactoryRuntimeCodehash: lpTokenFactoryRuntimeCodehash,
        },
        adapter(candidate, overrides),
      );

    const slowDiscovery = discovery("0x0000000000000000000000000000000000000033", 30);
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
        expectedChainId: chainId,
        expectedFactory: factory,
        expectedFeeVault: feeVault,
        expectedProtocolVersion: CIPHERDEX_PROTOCOL_VERSION,
        expectedLPTokenFactory: lpTokenFactory,
        expectedLPTokenFactoryRuntimeCodehash: lpTokenFactoryRuntimeCodehash,
      },
      adapter(slowDiscovery),
    );
    expect(snapshottedDiscovery.pool).to.equal(slowDiscovery.pool);
    expect(dynamicPoolReads).to.equal(0);
    expect(await verify(slowDiscovery)).to.deep.include({
      pool: slowDiscovery.pool,
      feeBps: slowDiscovery.feeBps,
      factory,
      chainId,
    });

    for (const overrides of [
      { readChainId: async () => BigInt(chainId + 1) },
      { isFactoryPrivateTokenApproved: async () => false },
      { isFactoryPool: async () => false },
      { readFactoryLPTokenFactory: async () => "0x0000000000000000000000000000000000000077" },
      { readFactoryLPTokenFactoryRuntimeCodehash: async () => `0x${"77".repeat(32)}` },
      { isLPTokenIssued: async () => false },
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
          lpToken,
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

  it("requires canonical factory provenance for public pool discovery", async function () {
    const chainId = 31_337;
    const factory = "0x0000000000000000000000000000000000000099";
    const feeVault = "0x0000000000000000000000000000000000000055";
    const discovery = {
      disclosureSchemaVersion: DISCLOSURE_SCHEMA_VERSION,
      protocolVersion: CIPHERDEX_PROTOCOL_VERSION,
      pool: "0x0000000000000000000000000000000000000033",
      token0: "0x0000000000000000000000000000000000000011",
      token1: "0x0000000000000000000000000000000000000022",
      token0Decimals: 18,
      token1Decimals: 6,
      feeBps: 30,
      feeVault,
      feePolicy: getCipherDEXV1FeePolicy(30),
      privacyMode: PRIVACY_MODE.TRANSPARENT,
      poolKind: "public-erc20-cpmm-v2" as const,
    };
    const adapter = {
      readChainId: async () => BigInt(chainId),
      getCode: async () => "0x60006000",
      readFactoryProtocolVersion: async () => BigInt(CIPHERDEX_PROTOCOL_VERSION),
      isFactoryPool: async () => true,
      getCanonicalPool: async () => discovery.pool,
      readPoolState: async () => ({
        protocolVersion: BigInt(CIPHERDEX_PROTOCOL_VERSION),
        privacyMode: 0n,
        token0: discovery.token0,
        token1: discovery.token1,
        token0Decimals: 18n,
        token1Decimals: 6n,
        feeBps: 30n,
        feeVault,
      }),
    };
    const policy = {
      expectedChainId: chainId,
      expectedFactory: factory,
      expectedFeeVault: feeVault,
      expectedProtocolVersion: CIPHERDEX_PROTOCOL_VERSION,
    };

    const verified = await verifyPublicPoolDiscovery(discovery, policy, adapter);
    expect(verified.factory).to.equal(factory);
    expect(Object.isFrozen(verified)).to.equal(true);

    for (const overrides of [
      { readChainId: async () => BigInt(chainId + 1) },
      { isFactoryPool: async () => false },
      { getCanonicalPool: async () => "0x0000000000000000000000000000000000000077" },
      {
        readPoolState: async () => ({
          ...(await adapter.readPoolState()),
          privacyMode: 1n,
        }),
      },
    ]) {
      let rejected = false;
      try {
        await verifyPublicPoolDiscovery(discovery, policy, { ...adapter, ...overrides });
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
        vaultEpochSeconds: 86_400,
        minimumVaultAggregatedSwapCount: 8,
        minimumVaultResidenceEpochs: 2,
      },
    });
    expect(calculateCipherDEXV1FeeBreakdown(10_000n, 30)).to.deep.equal({
      amountIn: 10_000n,
      netAmountIn: 9_970n,
      totalFee: 30n,
      lpFee: 25n,
      protocolFee: 5n,
    });
    expect(minimumCipherDEXV1ConfidentialInput(5)).to.equal(10_001n);
    expect(minimumCipherDEXV1ConfidentialInput(30)).to.equal(1_667n);
    expect(minimumCipherDEXV1ConfidentialInput(100)).to.equal(501n);
    for (const feeBps of CIPHERDEX_V1_FEE_POLICY.approvedTotalFeeBps) {
      const minimum = minimumCipherDEXV1ConfidentialInput(feeBps);
      expect(calculateCipherDEXV1FeeBreakdown(minimum, feeBps).protocolFee).to.equal(1n);
      expect(calculateCipherDEXV1FeeBreakdown(minimum - 1n, feeBps).protocolFee).to.equal(0n);
    }
    expect(() => getCipherDEXV1FeePolicy(25)).to.throw("Unsupported CipherDEX v1 fee tier");
  });
});
