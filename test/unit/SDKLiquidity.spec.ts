import { expect } from "chai";
import { Interface, id } from "ethers";
import {
  CONFIDENTIAL_LIQUIDITY_QUOTE_RESULT_TOPIC,
  NATIVE_LIQUIDITY_ADDED_TOPIC,
  PUBLIC_LIQUIDITY_ROUTED_TOPIC,
  liquiditySideToContractBoolean,
  parseConfidentialAddLiquidityQuoteResult,
  parseNativeLiquidityAddedResult,
  parsePublicLiquidityRoutedResult,
  previewPublicProportionalLiquidity,
} from "../../sdk/src/index";

describe("SDK proportional liquidity previews and results", function () {
  const UINT256_MAX = (1n << 256n) - 1n;
  const transactionHash = id("liquidity-transaction");
  const requestId = id("liquidity-preview");
  const provider = "0x0000000000000000000000000000000000000011";
  const recipient = "0x0000000000000000000000000000000000000012";
  const pool = "0x0000000000000000000000000000000000000020";
  const liquidityRouter = "0x0000000000000000000000000000000000000030";
  const nativeRouter = "0x0000000000000000000000000000000000000040";
  const wrappedNative = "0x0000000000000000000000000000000000000050";
  const pairedToken = "0x0000000000000000000000000000000000000060";

  const publicInterface = new Interface([
    "event PublicLiquidityRouted(address indexed provider,address indexed pool,bool indexed poolCreated,uint256 amount0,uint256 amount1,uint256 shares)",
  ]);
  const nativeInterface = new Interface([
    "event NativeLiquidityAdded(address indexed provider,address indexed recipient,address indexed pool,address pairedToken,uint256 nativeAmount,uint256 tokenAmount,uint256 shares)",
  ]);
  const confidentialInterface = new Interface([
    "event ConfidentialLiquidityQuoteResult(address indexed caller,bytes32 indexed requestId,bool indexed token0Specified,(uint256,uint256) acceptedCiphertext,(uint256,uint256) counterpartCiphertext,(uint256,uint256) lpCiphertext)",
  ]);

  function eventLog(
    emitter: string,
    iface: Interface,
    eventName: string,
    values: readonly unknown[],
  ) {
    const encoded = iface.encodeEventLog(iface.getEvent(eventName)!, values);
    return { address: emitter, topics: encoded.topics, data: encoded.data };
  }

  it("previews either specified side with contract-exact down/up rounding", function () {
    expect(previewPublicProportionalLiquidity({
      reserve0: 3n,
      reserve1: 7n,
      totalLpShares: 10n,
      specifiedSide: "token0",
      specifiedAmount: 2n,
    })).to.deep.equal({
      acceptedAmount0: 2n,
      acceptedAmount1: 5n,
      expectedLpShares: 6n,
    });
    expect(previewPublicProportionalLiquidity({
      reserve0: 3n,
      reserve1: 7n,
      totalLpShares: 10n,
      specifiedSide: "token1",
      specifiedAmount: 5n,
    })).to.deep.equal({
      acceptedAmount0: 3n,
      acceptedAmount1: 5n,
      expectedLpShares: 7n,
    });
    expect(liquiditySideToContractBoolean("token0")).to.equal(true);
    expect(liquiditySideToContractBoolean("token1")).to.equal(false);
  });

  it("uses raw token units for mixed decimals and full-precision mulDiv inputs", function () {
    expect(previewPublicProportionalLiquidity({
      reserve0: 1_000_000_000_000_000_000n,
      reserve1: 2_000_000n,
      totalLpShares: 1_000_000_000_000_000_000n,
      specifiedSide: "token0",
      specifiedAmount: 250_000_000_000_000_000n,
    })).to.deep.equal({
      acceptedAmount0: 250_000_000_000_000_000n,
      acceptedAmount1: 500_000n,
      expectedLpShares: 250_000_000_000_000_000n,
    });
    expect(previewPublicProportionalLiquidity({
      reserve0: UINT256_MAX,
      reserve1: UINT256_MAX,
      totalLpShares: UINT256_MAX,
      specifiedSide: "token1",
      specifiedAmount: UINT256_MAX,
    })).to.deep.equal({
      acceptedAmount0: UINT256_MAX,
      acceptedAmount1: UINT256_MAX,
      expectedLpShares: UINT256_MAX,
    });
  });

  it("fails closed for tiny, invalid, and out-of-range inputs", function () {
    expect(() => previewPublicProportionalLiquidity({
      reserve0: 2n,
      reserve1: 2n,
      totalLpShares: 1n,
      specifiedSide: "token0",
      specifiedAmount: 1n,
    })).to.throw("too small");
    expect(() => previewPublicProportionalLiquidity({
      reserve0: 0n,
      reserve1: 1n,
      totalLpShares: 1n,
      specifiedSide: "token0",
      specifiedAmount: 1n,
    })).to.throw("reserve0");
    expect(() => previewPublicProportionalLiquidity({
      reserve0: 1n,
      reserve1: 1n,
      totalLpShares: 1n,
      specifiedSide: "token2" as "token0",
      specifiedAmount: 1n,
    })).to.throw("Invalid liquidity side");
    expect(() => previewPublicProportionalLiquidity({
      reserve0: 1n,
      reserve1: 1n,
      totalLpShares: 1n,
      specifiedSide: "token0",
      specifiedAmount: UINT256_MAX + 1n,
    })).to.throw("specified amount");
  });

  it("authenticates public router results and derives refunds", function () {
    const routed = eventLog(liquidityRouter, publicInterface, "PublicLiquidityRouted", [
      provider,
      pool,
      false,
      90n,
      180n,
      45n,
    ]);
    expect(routed.topics[0]).to.equal(PUBLIC_LIQUIDITY_ROUTED_TOPIC);
    expect(parsePublicLiquidityRoutedResult({
      transactionHash,
      liquidityRouter,
      provider,
      maximumAmount0: 100n,
      maximumAmount1: 200n,
    }, { transactionHash, status: 1, logs: [routed] })).to.deep.equal({
      transactionHash,
      provider,
      pool,
      poolCreated: false,
      amount0Used: 90n,
      amount1Used: 180n,
      mintedLpShares: 45n,
      amount0Refunded: 10n,
      amount1Refunded: 20n,
    });
    expect(() => parsePublicLiquidityRoutedResult({
      transactionHash,
      liquidityRouter,
      provider,
      maximumAmount0: 80n,
      maximumAmount1: 200n,
    }, { transactionHash, status: 1, logs: [routed] })).to.throw("reviewed liquidity request");
  });

  it("authenticates native and nested public events in canonical token order", function () {
    const native = eventLog(nativeRouter, nativeInterface, "NativeLiquidityAdded", [
      provider,
      recipient,
      pool,
      pairedToken,
      90n,
      180n,
      45n,
    ]);
    const routed = eventLog(liquidityRouter, publicInterface, "PublicLiquidityRouted", [
      recipient,
      pool,
      true,
      90n,
      180n,
      45n,
    ]);
    expect(native.topics[0]).to.equal(NATIVE_LIQUIDITY_ADDED_TOPIC);
    expect(parseNativeLiquidityAddedResult({
      transactionHash,
      nativeRouter,
      liquidityRouter,
      wrappedNative,
      provider,
      recipient,
      pairedToken,
      maximumNativeAmount: 100n,
      maximumTokenAmount: 200n,
    }, { transactionHash, status: 1n, logs: [native, routed] })).to.deep.equal({
      transactionHash,
      provider,
      recipient,
      pool,
      poolCreated: true,
      pairedToken,
      nativeAmountUsed: 90n,
      tokenAmountUsed: 180n,
      mintedLpShares: 45n,
      nativeAmountRefunded: 10n,
      tokenAmountRefunded: 20n,
    });
  });

  it("maps native liquidity when the paired token sorts before WCOTI", function () {
    const lowerPairedToken = "0x0000000000000000000000000000000000000001";
    const native = eventLog(nativeRouter, nativeInterface, "NativeLiquidityAdded", [
      provider,
      recipient,
      pool,
      lowerPairedToken,
      90n,
      180n,
      45n,
    ]);
    const routed = eventLog(liquidityRouter, publicInterface, "PublicLiquidityRouted", [
      recipient,
      pool,
      false,
      180n,
      90n,
      45n,
    ]);
    const result = parseNativeLiquidityAddedResult({
      transactionHash,
      nativeRouter,
      liquidityRouter,
      wrappedNative,
      provider,
      recipient,
      pairedToken: lowerPairedToken,
      maximumNativeAmount: 90n,
      maximumTokenAmount: 180n,
    }, { transactionHash, status: 1, logs: [native, routed] });
    expect(result.poolCreated).to.equal(false);
    expect(result.nativeAmountUsed).to.equal(90n);
    expect(result.tokenAmountUsed).to.equal(180n);
  });

  it("parses confidential quote ciphertexts without crossing the wallet decryption boundary", function () {
    const quote = eventLog(pool, confidentialInterface, "ConfidentialLiquidityQuoteResult", [
      provider,
      requestId,
      false,
      [1n, 2n],
      [3n, 4n],
      [5n, 6n],
    ]);
    expect(quote.topics[0]).to.equal(CONFIDENTIAL_LIQUIDITY_QUOTE_RESULT_TOPIC);
    expect(parseConfidentialAddLiquidityQuoteResult({
      transactionHash,
      pool,
      caller: provider,
      requestId,
      specifiedSide: "token1",
    }, { transactionHash, status: 1, logs: [quote] })).to.deep.equal({
      transactionHash,
      pool,
      caller: provider,
      requestId,
      specifiedSide: "token1",
      acceptedAmount0: { ciphertextHigh: 3n, ciphertextLow: 4n },
      acceptedAmount1: { ciphertextHigh: 1n, ciphertextLow: 2n },
      expectedLpShares: { ciphertextHigh: 5n, ciphertextLow: 6n },
    });
    expect(() => parseConfidentialAddLiquidityQuoteResult({
      transactionHash,
      pool,
      caller: provider,
      requestId,
      specifiedSide: "token0",
    }, { transactionHash, status: 1, logs: [quote] })).to.throw("does not match expectation");
    expect(() => parseConfidentialAddLiquidityQuoteResult({
      transactionHash,
      pool,
      caller: provider,
      requestId,
      specifiedSide: "token1",
    }, { transactionHash, status: 1, logs: [quote, quote] })).to.throw("missing or ambiguous");
  });
});
