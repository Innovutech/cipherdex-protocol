import { expect } from "chai";
import { Interface, ZeroAddress } from "ethers";
import {
  EVM_NATIVE_ASSET_ADDRESS,
  PUBLIC_BEST_EXECUTION_NATIVE_ROUTER_ABI,
  PUBLIC_BEST_EXECUTION_ROUTER_ABI,
  PUBLIC_BEST_SWAP_ROUTED_TOPIC,
  PUBLIC_NATIVE_BEST_SWAP_ROUTED_TOPIC,
  buildPublicBestExactInputSwapExecution,
  buildPublicBestExecutionQuoteCall,
  parsePublicBestExecutionQuoteResult,
  parsePublicBestExecutionSwapResult,
} from "../../sdk/src/index";

describe("SDK public best execution", function () {
  const bestRouter = "0x0000000000000000000000000000000000000010";
  const nativeBestRouter = "0x0000000000000000000000000000000000000020";
  const wrapped = "0x0000000000000000000000000000000000000030";
  const tokenA = "0x0000000000000000000000000000000000000040";
  const tokenB = "0x0000000000000000000000000000000000000050";
  const pool = "0x0000000000000000000000000000000000000060";
  const trader = "0x0000000000000000000000000000000000000070";
  const recipient = "0x0000000000000000000000000000000000000080";
  const transactionHash = `0x${"11".repeat(32)}`;

  const base = {
    bestExecutionRouter: bestRouter,
    nativeBestExecutionRouter: nativeBestRouter,
    wrappedNative: wrapped,
    amountIn: 100n,
    minAmountOut: 90n,
    candidateBitmap: 7,
    recipient,
    deadline: 1_000n,
  } as const;

  it("publishes parsable public and native best-execution ABIs", function () {
    const best = new Interface(PUBLIC_BEST_EXECUTION_ROUTER_ABI);
    const native = new Interface(PUBLIC_BEST_EXECUTION_NATIVE_ROUTER_ABI);
    expect(best.getFunction("quoteBestExactInput")).to.not.equal(null);
    expect(best.getFunction("swapBestExactInput")).to.not.equal(null);
    expect(native.getFunction("swapExactNativeForToken")).to.not.equal(null);
    expect(native.getFunction("swapExactTokenForNative")).to.not.equal(null);
    expect(best.getEvent("BestSwapRouted")?.topicHash).to.equal(PUBLIC_BEST_SWAP_ROUTED_TOPIC);
    expect(native.getEvent("NativeBestSwapRouted")?.topicHash)
      .to.equal(PUBLIC_NATIVE_BEST_SWAP_ROUTED_TOPIC);
  });

  it("builds a gasless preview and validates its selected fee tier", function () {
    const call = buildPublicBestExecutionQuoteCall({
      bestExecutionRouter: bestRouter,
      wrappedNative: wrapped,
      tokenIn: EVM_NATIVE_ASSET_ADDRESS,
      tokenOut: tokenA,
      amountIn: 100n,
      candidateBitmap: 3,
    });
    expect(call).to.deep.equal({
      to: bestRouter,
      functionName: "quoteBestExactInput",
      args: [wrapped, tokenA, 100n, 3],
      value: 0n,
      resolvedTokenIn: wrapped,
      resolvedTokenOut: tokenA,
    });
    expect(parsePublicBestExecutionQuoteResult({
      selectedPool: pool,
      selectedFeeBps: 30n,
      zeroForOne: true,
      amountOut: 95n,
    }, 3)).to.deep.equal({
      selectedPool: pool,
      selectedFeeBps: 30n,
      zeroForOne: true,
      amountOut: 95n,
    });
    expect(() => parsePublicBestExecutionQuoteResult(
      [pool, 100n, true, 95n],
      3,
    )).to.throw("unauthorized fee tier");
  });

  it("builds token, native-input, and native-output atomic execution", function () {
    const tokenSwap = buildPublicBestExactInputSwapExecution({
      ...base,
      nativeBestExecutionRouter: undefined,
      tokenIn: tokenA,
      tokenOut: tokenB,
    });
    expect(tokenSwap.kind).to.equal("token-to-token");
    expect(tokenSwap.to).to.equal(bestRouter);
    expect(tokenSwap.approvalSpender).to.equal(bestRouter);
    expect(tokenSwap.args).to.deep.equal([
      tokenA,
      tokenB,
      100n,
      90n,
      7,
      recipient,
      1_000n,
    ]);

    const nativeInput = buildPublicBestExactInputSwapExecution({
      ...base,
      tokenIn: EVM_NATIVE_ASSET_ADDRESS,
      tokenOut: tokenA,
    });
    expect(nativeInput.kind).to.equal("native-to-token");
    expect(nativeInput.to).to.equal(nativeBestRouter);
    expect(nativeInput.value).to.equal(100n);
    expect(nativeInput.approvalSpender).to.equal(null);
    expect(nativeInput.args).to.deep.equal([tokenA, 90n, 7, recipient, 1_000n]);

    const nativeOutput = buildPublicBestExactInputSwapExecution({
      ...base,
      tokenIn: tokenA,
      tokenOut: EVM_NATIVE_ASSET_ADDRESS,
    });
    expect(nativeOutput.kind).to.equal("token-to-native");
    expect(nativeOutput.to).to.equal(nativeBestRouter);
    expect(nativeOutput.value).to.equal(0n);
    expect(nativeOutput.approvalSpender).to.equal(nativeBestRouter);
    expect(nativeOutput.args).to.deep.equal([
      tokenA,
      100n,
      90n,
      7,
      recipient,
      1_000n,
    ]);
  });

  it("authenticates token and nested native route evidence", function () {
    const best = new Interface(PUBLIC_BEST_EXECUTION_ROUTER_ABI);
    const native = new Interface(PUBLIC_BEST_EXECUTION_NATIVE_ROUTER_ABI);
    const tokenEvent = best.encodeEventLog(best.getEvent("BestSwapRouted")!, [
      trader,
      pool,
      recipient,
      tokenA,
      tokenB,
      30n,
      7,
      100n,
      95n,
    ]);
    expect(parsePublicBestExecutionSwapResult({
      transactionHash,
      bestExecutionRouter: bestRouter,
      nativeBestExecutionRouter: nativeBestRouter,
      wrappedNative: wrapped,
      trader,
      recipient,
      tokenIn: tokenA,
      tokenOut: tokenB,
      amountIn: 100n,
      minAmountOut: 90n,
      candidateBitmap: 7,
    }, {
      transactionHash,
      status: 1,
      logs: [{ address: bestRouter, ...tokenEvent }],
    })).to.include({
      kind: "token-to-token",
      selectedPool: pool,
      selectedFeeBps: 30n,
      amountOut: 95n,
    });

    const nestedBestEvent = best.encodeEventLog(best.getEvent("BestSwapRouted")!, [
      nativeBestRouter,
      pool,
      recipient,
      wrapped,
      tokenA,
      30n,
      7,
      100n,
      95n,
    ]);
    const nativeEvent = native.encodeEventLog(native.getEvent("NativeBestSwapRouted")!, [
      trader,
      pool,
      recipient,
      ZeroAddress,
      tokenA,
      30n,
      7,
      100n,
      95n,
    ]);
    expect(parsePublicBestExecutionSwapResult({
      transactionHash,
      bestExecutionRouter: bestRouter,
      nativeBestExecutionRouter: nativeBestRouter,
      wrappedNative: wrapped,
      trader,
      recipient,
      tokenIn: EVM_NATIVE_ASSET_ADDRESS,
      tokenOut: tokenA,
      amountIn: 100n,
      minAmountOut: 90n,
      candidateBitmap: 7,
    }, {
      transactionHash,
      status: "0x1",
      logs: [
        { address: bestRouter, ...nestedBestEvent },
        { address: nativeBestRouter, ...nativeEvent },
      ],
    })).to.include({
      kind: "native-to-token",
      selectedPool: pool,
      selectedFeeBps: 30n,
      tokenIn: EVM_NATIVE_ASSET_ADDRESS,
      tokenOut: tokenA,
      amountOut: 95n,
    });

    const nativeOutputBestEvent = best.encodeEventLog(best.getEvent("BestSwapRouted")!, [
      nativeBestRouter,
      pool,
      nativeBestRouter,
      tokenA,
      wrapped,
      30n,
      7,
      100n,
      95n,
    ]);
    const nativeOutputEvent = native.encodeEventLog(
      native.getEvent("NativeBestSwapRouted")!,
      [
        trader,
        pool,
        recipient,
        tokenA,
        ZeroAddress,
        30n,
        7,
        100n,
        95n,
      ],
    );
    expect(parsePublicBestExecutionSwapResult({
      transactionHash,
      bestExecutionRouter: bestRouter,
      nativeBestExecutionRouter: nativeBestRouter,
      wrappedNative: wrapped,
      trader,
      recipient,
      tokenIn: tokenA,
      tokenOut: EVM_NATIVE_ASSET_ADDRESS,
      amountIn: 100n,
      minAmountOut: 90n,
      candidateBitmap: 7,
    }, {
      transactionHash,
      status: 1n,
      logs: [
        { address: bestRouter, ...nativeOutputBestEvent },
        { address: nativeBestRouter, ...nativeOutputEvent },
      ],
    })).to.include({
      kind: "token-to-native",
      selectedPool: pool,
      selectedFeeBps: 30n,
      tokenIn: tokenA,
      tokenOut: EVM_NATIVE_ASSET_ADDRESS,
      amountOut: 95n,
    });
  });

  it("rejects malformed policies and forged route evidence", function () {
    expect(() => buildPublicBestExecutionQuoteCall({
      bestExecutionRouter: bestRouter,
      wrappedNative: wrapped,
      tokenIn: tokenA,
      tokenOut: tokenB,
      amountIn: 1n,
      candidateBitmap: 8,
    })).to.throw("candidate bitmap");
    expect(() => buildPublicBestExactInputSwapExecution({
      ...base,
      tokenIn: wrapped,
      tokenOut: tokenA,
    })).to.throw("internal to public best execution");
    expect(() => buildPublicBestExactInputSwapExecution({
      ...base,
      tokenIn: EVM_NATIVE_ASSET_ADDRESS,
      tokenOut: EVM_NATIVE_ASSET_ADDRESS,
    })).to.throw("Native-to-native");

    const best = new Interface(PUBLIC_BEST_EXECUTION_ROUTER_ABI);
    const event = best.encodeEventLog(best.getEvent("BestSwapRouted")!, [
      trader,
      pool,
      recipient,
      tokenA,
      tokenB,
      30n,
      7,
      100n,
      89n,
    ]);
    expect(() => parsePublicBestExecutionSwapResult({
      transactionHash,
      bestExecutionRouter: bestRouter,
      nativeBestExecutionRouter: nativeBestRouter,
      wrappedNative: wrapped,
      trader,
      recipient,
      tokenIn: tokenA,
      tokenOut: tokenB,
      amountIn: 100n,
      minAmountOut: 90n,
      candidateBitmap: 7,
    }, {
      transactionHash,
      status: 1,
      logs: [{ address: bestRouter, ...event }],
    })).to.throw("violates the reviewed swap request");
  });
});
