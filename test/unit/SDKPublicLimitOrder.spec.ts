import { expect } from "chai";
import { Interface, id } from "ethers";
import {
  EVM_NATIVE_ASSET_ADDRESS,
  PUBLIC_CPMM_LIMIT_ORDER_BOOK_ABI,
  PUBLIC_LIMIT_ORDER_CREATED_TOPIC,
  PUBLIC_LIMIT_ORDER_FILLED_TOPIC,
  PUBLIC_ROUTE_CANDIDATE,
  PUBLIC_LIMIT_ORDER_SETTLEMENT,
  buildPublicLimitOrderAmendCall,
  buildPublicLimitOrderCreateCall,
  buildPublicLimitOrderFillCall,
  buildPublicLimitOrderPermitCall,
  parsePublicLimitOrderAmendedResult,
  parsePublicLimitOrderCancelledResult,
  parsePublicLimitOrderCreatedResult,
  parsePublicLimitOrderFilledResult,
  publicLimitOrderBountyForFill,
  publicLimitOrderMinimumOutput,
} from "../../sdk/src/index";

describe("SDK public routed limit orders", function () {
  const transactionHash = id("public-limit-order");
  const orderBook = "0x0000000000000000000000000000000000000010";
  const maker = "0x0000000000000000000000000000000000000020";
  const filler = "0x0000000000000000000000000000000000000030";
  const tokenIn = "0x0000000000000000000000000000000000000040";
  const tokenOut = "0x0000000000000000000000000000000000000050";
  const recipient = "0x0000000000000000000000000000000000000060";
  const selectedPool = "0x0000000000000000000000000000000000000070";
  const wrappedNative = "0x0000000000000000000000000000000000000080";
  const iface = new Interface(PUBLIC_CPMM_LIMIT_ORDER_BOOK_ABI);
  const params = {
    tokenIn,
    tokenOut,
    amountIn: 10n,
    minAmountOut: 7n,
    recipient,
    expiry: 1_000n,
    candidateBitmap: PUBLIC_ROUTE_CANDIDATE.ALL,
    allowPartialFills: true,
    minimumFillAmount: 2n,
  } as const;

  function eventLog(eventName: string, values: readonly unknown[]) {
    const encoded = iface.encodeEventLog(iface.getEvent(eventName)!, values);
    return { address: orderBook, topics: encoded.topics, data: encoded.data };
  }

  it("builds immutable typed calls and mirrors fill rounding", function () {
    expect(buildPublicLimitOrderCreateCall(params, {
      wrappedNative,
      executionBounty: 5n,
    })).to.deep.equal({
      functionName: "createOrder",
      args: [{ ...params, settlementMode: PUBLIC_LIMIT_ORDER_SETTLEMENT.TOKEN }],
      value: 5n,
    });
    expect(buildPublicLimitOrderAmendCall(1n, {
      recipient,
      minAmountOutForRemaining: 5n,
      expiry: 2_000n,
      candidateBitmap: PUBLIC_ROUTE_CANDIDATE.STANDARD_30_BPS,
      allowPartialFills: false,
      minimumFillAmount: 0n,
    }, 10n, wrappedNative).functionName).to.equal("amendOrder");
    expect(buildPublicLimitOrderFillCall(1n, 3n).args).to.deep.equal([1n, 3n]);
    expect(buildPublicLimitOrderPermitCall(params, {
      deadline: 2_000n,
      v: 27,
      r: `0x${"11".repeat(32)}`,
      s: `0x${"22".repeat(32)}`,
    }, { wrappedNative, executionBounty: 9n }).value).to.equal(9n);
    expect(publicLimitOrderMinimumOutput({
      amountInToFill: 3n,
      priceNumerator: 7n,
      priceDenominator: 10n,
    })).to.equal(3n);
    expect(publicLimitOrderBountyForFill({
      remainingBounty: 10n,
      amountInToFill: 3n,
      remainingAmountIn: 10n,
    })).to.equal(3n);
    expect(publicLimitOrderBountyForFill({
      remainingBounty: 7n,
      amountInToFill: 7n,
      remainingAmountIn: 7n,
    })).to.equal(7n);
  });

  it("maps native COTI to internal WCOTI without requiring a wallet balance", function () {
    const nativeInput = buildPublicLimitOrderCreateCall({
      ...params,
      tokenIn: EVM_NATIVE_ASSET_ADDRESS,
    }, { wrappedNative, executionBounty: 5n });
    expect(nativeInput.args[0]).to.deep.equal({
      ...params,
      tokenIn: wrappedNative,
      settlementMode: PUBLIC_LIMIT_ORDER_SETTLEMENT.NATIVE_INPUT,
    });
    expect(nativeInput.value).to.equal(params.amountIn + 5n);

    const nativeOutput = buildPublicLimitOrderCreateCall({
      ...params,
      tokenOut: EVM_NATIVE_ASSET_ADDRESS,
    }, { wrappedNative, executionBounty: 5n });
    expect(nativeOutput.args[0]).to.deep.equal({
      ...params,
      tokenOut: wrappedNative,
      settlementMode: PUBLIC_LIMIT_ORDER_SETTLEMENT.NATIVE_OUTPUT,
    });
    expect(nativeOutput.value).to.equal(5n);
    expect(buildPublicLimitOrderPermitCall({
      ...params,
      tokenOut: EVM_NATIVE_ASSET_ADDRESS,
    }, {
      deadline: 2_000n,
      v: 27,
      r: `0x${"11".repeat(32)}`,
      s: `0x${"22".repeat(32)}`,
    }, { wrappedNative }).args[0].settlementMode)
      .to.equal(PUBLIC_LIMIT_ORDER_SETTLEMENT.NATIVE_OUTPUT);
  });

  it("rejects unsafe call plans before wallet submission", function () {
    expect(() => buildPublicLimitOrderCreateCall({
      ...params,
      tokenOut: tokenIn,
    }, { wrappedNative })).to.throw("token pair");
    expect(() => buildPublicLimitOrderCreateCall({
      ...params,
      candidateBitmap: 8,
    }, { wrappedNative })).to.throw("candidate bitmap");
    for (const candidateBitmap of [4_294_967_297, Number.MAX_SAFE_INTEGER, 1.5]) {
      expect(() => buildPublicLimitOrderCreateCall({
        ...params,
        candidateBitmap,
      }, { wrappedNative })).to.throw("candidate bitmap");
    }
    expect(() => buildPublicLimitOrderCreateCall({
      ...params,
      minimumFillAmount: 11n,
    }, { wrappedNative })).to.throw("partial-fill configuration");
    expect(() => buildPublicLimitOrderPermitCall(params, {
      deadline: 2_000n,
      v: 1,
      r: `0x${"11".repeat(32)}`,
      s: `0x${"22".repeat(32)}`,
    }, { wrappedNative })).to.throw("permit signature");
    expect(() => buildPublicLimitOrderCreateCall({
      ...params,
      tokenIn: wrappedNative,
    }, { wrappedNative })).to.throw("internal");
    expect(() => buildPublicLimitOrderCreateCall({
      ...params,
      recipient: wrappedNative,
    }, { wrappedNative })).to.throw("recipient");
    expect(() => buildPublicLimitOrderCreateCall({
      ...params,
      tokenIn: EVM_NATIVE_ASSET_ADDRESS,
      tokenOut: EVM_NATIVE_ASSET_ADDRESS,
    }, { wrappedNative })).to.throw("token pair");
    expect(() => buildPublicLimitOrderPermitCall({
      ...params,
      tokenIn: EVM_NATIVE_ASSET_ADDRESS,
    }, {
      deadline: 2_000n,
      v: 27,
      r: `0x${"11".repeat(32)}`,
      s: `0x${"22".repeat(32)}`,
    }, { wrappedNative })).to.throw("do not use permits");
    expect(() => buildPublicLimitOrderAmendCall(1n, {
      recipient,
      minAmountOutForRemaining: 5n,
      expiry: 2_000n,
      candidateBitmap: 7,
      allowPartialFills: true,
      minimumFillAmount: 11n,
    }, 10n, wrappedNative)).to.throw("partial-fill configuration");
    expect(() => buildPublicLimitOrderAmendCall(1n, {
      recipient: wrappedNative,
      minAmountOutForRemaining: 5n,
      expiry: 2_000n,
      candidateBitmap: 7,
      allowPartialFills: false,
      minimumFillAmount: 0n,
    }, 10n, wrappedNative)).to.throw("recipient");
    expect(() => publicLimitOrderBountyForFill({
      remainingBounty: 1n,
      amountInToFill: 2n,
      remainingAmountIn: 1n,
    })).to.throw("exceeds remaining input");
  });

  it("validates trusted creation, amendment, fill, and cancellation evidence", function () {
    const createdLog = eventLog("OrderCreated", [
      1n,
      maker,
      tokenIn,
      tokenOut,
      recipient,
      10n,
      7n,
      1_000n,
      7,
      true,
      2n,
      5n,
      0,
    ]);
    expect(createdLog.topics[0]).to.equal(PUBLIC_LIMIT_ORDER_CREATED_TOPIC);
    const created = parsePublicLimitOrderCreatedResult(
      { transactionHash, orderBook, maker, tokenIn },
      { transactionHash, status: 1, logs: [createdLog] },
    );
    expect(created).to.deep.include({
      orderId: 1n,
      maker,
      tokenIn,
      tokenOut,
      amountIn: 10n,
      candidateBitmap: 7,
      executionBounty: 5n,
      settlement: "token",
    });

    const filledLog = eventLog("OrderFilled", [
      1n,
      maker,
      filler,
      recipient,
      selectedPool,
      100n,
      3n,
      4n,
      3n,
      7n,
      1n,
      2,
    ]);
    expect(filledLog.topics[0]).to.equal(PUBLIC_LIMIT_ORDER_FILLED_TOPIC);
    expect(parsePublicLimitOrderFilledResult(
      { transactionHash, orderBook, orderId: 1n, maker },
      { transactionHash, status: 1n, logs: [filledLog] },
    )).to.deep.include({
      orderId: 1n,
      filler,
      selectedPool,
      selectedFeeBps: 100n,
      amountIn: 3n,
      amountOut: 4n,
      remainingAmountIn: 7n,
      settlement: "native-output",
    });

    const amendedLog = eventLog("OrderAmended", [
      1n,
      maker,
      2n,
      recipient,
      5n,
      2_000n,
      2,
      false,
      7n,
    ]);
    expect(parsePublicLimitOrderAmendedResult(
      { transactionHash, orderBook, orderId: 1n, maker },
      { transactionHash, status: 1, logs: [amendedLog] },
    )).to.deep.include({ revision: 2n, candidateBitmap: 2 });

    const cancelledLog = eventLog("OrderCancelled", [1n, maker, 7n, 4n, 1]);
    expect(parsePublicLimitOrderCancelledResult(
      { transactionHash, orderBook, orderId: 1n, maker },
      { transactionHash, status: 1, logs: [cancelledLog] },
    )).to.deep.include({
      returnedAmountIn: 7n,
      returnedExecutionBounty: 4n,
      settlement: "native-input",
    });
  });

  it("fails closed for forged, failed, and ambiguous event evidence", function () {
    const createdLog = eventLog("OrderCreated", [
      1n,
      maker,
      tokenIn,
      tokenOut,
      recipient,
      10n,
      7n,
      1_000n,
      7,
      true,
      2n,
      5n,
      0,
    ]);
    const parse = (logs: readonly typeof createdLog[], status: number | bigint = 1) =>
      parsePublicLimitOrderCreatedResult(
        { transactionHash, orderBook, maker, tokenIn },
        { transactionHash, status, logs },
      );
    expect(() => parse([createdLog], 0)).to.throw("receipt");
    expect(() => parse([createdLog, createdLog])).to.throw("ambiguous");
    expect(() => parse([{ ...createdLog, address: tokenOut }])).to.throw("missing");
    expect(() => parsePublicLimitOrderCreatedResult(
      { transactionHash, orderBook, maker: filler, tokenIn },
      { transactionHash, status: 1, logs: [createdLog] },
    )).to.throw("encoding");
  });
});
