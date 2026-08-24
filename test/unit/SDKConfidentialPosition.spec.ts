import { expect } from "chai";
import { Interface, ZeroAddress, ZeroHash, id, keccak256 } from "ethers";
import {
  CIPHERDEX_PROTOCOL_VERSION,
  CONFIDENTIAL_CPMM_ABI,
  CONFIDENTIAL_QUOTE_TRANSPORT,
  DISCLOSURE_SCHEMA_VERSION,
  PRIVACY_MODE,
  buildConfidentialLockedPositionCall,
  buildConfidentialPositionCall,
  buildConfidentialRemoveLiquidityQuoteCall,
  decryptConfidentialPositionResult,
  getCipherDEXV1FeePolicy,
  readConfidentialActiveShares,
  readConfidentialTokenAllowance,
  verifyConfidentialPoolDiscovery,
} from "../../sdk/src/index";

const chainId = 31_337;
const factory = "0x0000000000000000000000000000000000000099";
const feeVault = "0x0000000000000000000000000000000000000055";
const lpTokenFactory = "0x0000000000000000000000000000000000000066";
const lpToken = "0x0000000000000000000000000000000000000044";
const poolAddress = "0x0000000000000000000000000000000000000033";
const caller = "0x0000000000000000000000000000000000000077";
const spender = "0x0000000000000000000000000000000000000088";
const token0 = "0x0000000000000000000000000000000000000011";
const token1 = "0x0000000000000000000000000000000000000022";
const deployedCode = "0x60006000";
const poolInterface = new Interface(CONFIDENTIAL_CPMM_ABI);

async function verifiedPool() {
  const lpTokenFactoryRuntimeCodehash = keccak256(deployedCode);
  const discovery = {
    disclosureSchemaVersion: DISCLOSURE_SCHEMA_VERSION,
    protocolVersion: CIPHERDEX_PROTOCOL_VERSION,
    pool: poolAddress,
    token0,
    token1,
    token0Decimals: 18,
    token1Decimals: 6,
    feeBps: 30,
    feeVault,
    feePolicy: getCipherDEXV1FeePolicy(30),
    privacyMode: PRIVACY_MODE.AMOUNT_CONFIDENTIAL_PRIVATE_LP,
    initializationStrategy: ZeroAddress,
    strategyClass: 0,
    poolClass: "standard" as const,
    initialized: true,
    poolKind: "private-erc20-cpmm-v1" as const,
    quoteTransport: CONFIDENTIAL_QUOTE_TRANSPORT.TRANSACTION_EVENT,
  };
  return verifyConfidentialPoolDiscovery(
    discovery,
    {
      expectedChainId: chainId,
      expectedFactory: factory,
      expectedFeeVault: feeVault,
      expectedProtocolVersion: CIPHERDEX_PROTOCOL_VERSION,
      expectedLPTokenFactory: lpTokenFactory,
      expectedLPTokenFactoryRuntimeCodehash: lpTokenFactoryRuntimeCodehash,
    },
    {
      readChainId: async () => BigInt(chainId),
      getCode: async () => deployedCode,
      hashRuntimeCode: (code: string) => keccak256(code),
      readFactoryProtocolVersion: async () => BigInt(CIPHERDEX_PROTOCOL_VERSION),
      readFactoryLPTokenFactory: async () => lpTokenFactory,
      readFactoryLPTokenFactoryRuntimeCodehash: async () => lpTokenFactoryRuntimeCodehash,
      isLPTokenIssued: async () => true,
      isFactoryPrivateTokenCompatible: async () => true,
      isFactoryPool: async () => true,
      readFactoryInitializationStrategyClass: async () => 0,
      readFactoryInitializationStrategyRuntimeCodehash: async () => ZeroHash,
      getCanonicalPool: async () => poolAddress,
      readPoolState: async () => ({
        protocolVersion: BigInt(CIPHERDEX_PROTOCOL_VERSION),
        privacyMode: 1n,
        token0,
        token1,
        token0Decimals: 18n,
        token1Decimals: 6n,
        feeBps: 30n,
        feeVault,
        lpToken,
        initializationStrategy: ZeroAddress,
        initialized: true,
      }),
    },
  );
}

async function expectTypeError(promise: Promise<unknown>) {
  let error: unknown;
  try {
    await promise;
  } catch (candidate) {
    error = candidate;
  }
  expect(error).to.be.instanceOf(TypeError);
}

describe("confidential SDK position model", function () {
  it("builds function-bound active, removal and locked-position calls", function () {
    const requestId = id("position-request");
    const lockId = id("position-lock");
    const deadline = 1_900_000_000n;
    const shares = {
      ciphertext: { ciphertextHigh: 1n, ciphertextLow: 2n },
      signature: "0x1234",
    };

    expect(buildConfidentialPositionCall(requestId, deadline)).to.deep.equal({
      functionName: "requestMyPosition",
      args: [requestId, deadline],
    });
    expect(buildConfidentialRemoveLiquidityQuoteCall(shares, requestId, deadline)).to.deep.equal({
      functionName: "requestRemoveLiquidityQuote",
      args: [shares, requestId, deadline],
    });
    expect(buildConfidentialLockedPositionCall(lockId, requestId, deadline)).to.deep.equal({
      functionName: "requestLockedPosition",
      args: [lockId, requestId, deadline],
    });
    expect(() => buildConfidentialPositionCall(ZeroHash, deadline)).to.throw(TypeError);
    expect(() => buildConfidentialLockedPositionCall(ZeroHash, requestId, deadline))
      .to.throw(TypeError);
  });

  it("authenticates and decrypts every position result kind", async function () {
    const pool = await verifiedPool();
    const deadline = 1_900_000_000n;
    const cases = [
      {
        operation: "active-position" as const,
        functionName: "requestMyPosition",
        eventName: "ConfidentialPositionResult",
        requestId: id("active-position"),
        lockId: ZeroHash,
        args: (requestId: string) => [requestId, deadline],
      },
      {
        operation: "remove-liquidity-quote" as const,
        functionName: "requestRemoveLiquidityQuote",
        eventName: "ConfidentialRemoveLiquidityQuoteResult",
        requestId: id("remove-position"),
        lockId: ZeroHash,
        args: (requestId: string) => [
          [[1n, 2n], "0x1234"],
          requestId,
          deadline,
        ],
      },
      {
        operation: "locked-position" as const,
        functionName: "requestLockedPosition",
        eventName: "ConfidentialLockedPositionResult",
        requestId: id("locked-position"),
        lockId: id("position-lock"),
        args: (requestId: string, lockId: string) => [lockId, requestId, deadline],
      },
    ];

    for (const [index, candidate] of cases.entries()) {
      const transactionHash = id(`position-transaction-${index}`);
      const transactionData = poolInterface.encodeFunctionData(
        candidate.functionName,
        candidate.args(candidate.requestId, candidate.lockId),
      );
      const eventArgs = candidate.operation === "locked-position"
        ? [caller, candidate.requestId, candidate.lockId, [11n, 12n], [21n, 22n], [31n, 32n], [41n, 42n]]
        : [caller, candidate.requestId, [11n, 12n], [21n, 22n], [31n, 32n], [41n, 42n]];
      const encoded = poolInterface.encodeEventLog(
        poolInterface.getEvent(candidate.eventName)!,
        eventArgs,
      );
      const transaction = {
        chainId,
        hash: transactionHash,
        from: caller,
        to: poolAddress,
        data: transactionData,
      };
      const receipt = {
        transactionHash,
        status: 1,
        logs: [{ address: poolAddress, topics: encoded.topics, data: encoded.data }],
      };
      const adapter = {
        readChainId: async () => chainId,
        getTransaction: async () => transaction,
        getTransactionReceipt: async () => receipt,
        decryptValue256: async (value: { ciphertextHigh: bigint }) => value.ciphertextHigh,
      };

      const result = await decryptConfidentialPositionResult(
        pool,
        {
          operation: candidate.operation,
          caller,
          requestId: candidate.requestId,
          lockId: candidate.lockId,
          transactionHash,
          transactionData,
        },
        adapter,
      );
      expect(result).to.deep.include({
        operation: candidate.operation,
        shares: 11n,
        amount0: 21n,
        amount1: 31n,
        priceX18: 41n,
      });

      await expectTypeError(decryptConfidentialPositionResult(
        pool,
        {
          operation: candidate.operation,
          caller,
          requestId: candidate.requestId,
          lockId: candidate.lockId,
          transactionHash,
          transactionData,
        },
        {
          ...adapter,
          getTransactionReceipt: async () => ({
            ...receipt,
            logs: [...receipt.logs, ...receipt.logs],
          }),
        },
      ));
    }
  });

  it("reads active shares and owner-encrypted allowances only for verified pool assets", async function () {
    const pool = await verifiedPool();
    expect(await readConfidentialActiveShares(pool, caller, {
      readChainId: async () => chainId,
      readMyShares: async () => ({ ciphertextHigh: 55n, ciphertextLow: 56n }),
      decryptValue256: async (value) => value.ciphertextHigh,
    })).to.equal(55n);

    expect(await readConfidentialTokenAllowance(pool, token0, caller, spender, {
      readChainId: async () => chainId,
      readAllowance: async () => ({
        ciphertext: { ciphertextHigh: 1n, ciphertextLow: 2n },
        ownerCiphertext: { ciphertextHigh: 66n, ciphertextLow: 67n },
        spenderCiphertext: { ciphertextHigh: 68n, ciphertextLow: 69n },
      }),
      decryptValue256: async (value) => value.ciphertextHigh,
    })).to.equal(66n);

    await expectTypeError(readConfidentialTokenAllowance(
      pool,
      "0x00000000000000000000000000000000000000aa",
      caller,
      spender,
      {
        readChainId: async () => chainId,
        readAllowance: async () => ({
          ciphertext: { ciphertextHigh: 0n, ciphertextLow: 0n },
          ownerCiphertext: { ciphertextHigh: 0n, ciphertextLow: 0n },
          spenderCiphertext: { ciphertextHigh: 0n, ciphertextLow: 0n },
        }),
        decryptValue256: async () => 0n,
      },
    ));
  });
});
