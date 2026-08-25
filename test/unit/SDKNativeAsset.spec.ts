import { expect } from "chai";
import { Interface } from "ethers";
import {
  EVM_NATIVE_ASSET_ADDRESS,
  PUBLIC_CPMM_NATIVE_ROUTER_ABI,
  PUBLIC_LP_TOKEN_ABI,
  PUBLIC_LP_TOKEN_FACTORY_ABI,
  WRAPPED_NATIVE_TOKEN_ABI,
  buildPublicExactInputSwapExecution,
  buildPublicCreateOrAddLiquidityCall,
  buildPublicLiquidityRemovalExecution,
  buildPublicLpPermitTypedData,
  buildPublicNativeLiquidityAddExecution,
  buildPublicTokenApprovalPlan,
  buildUnwrapNativeCall,
  buildWrapNativeCall,
  isEvmNativeAssetAddress,
  resolvePublicAmmTokenAddress,
} from "../../sdk/src/index";

describe("SDK native asset handling", function () {
  const pool = "0x0000000000000000000000000000000000000010";
  const wrapped = "0x0000000000000000000000000000000000000020";
  const token = "0x0000000000000000000000000000000000000030";
  const publicRouter = "0x0000000000000000000000000000000000000040";
  const nativeRouter = "0x0000000000000000000000000000000000000050";
  const recipient = "0x0000000000000000000000000000000000000060";
  const liquidityRouter = "0x0000000000000000000000000000000000000080";
  const lpToken = "0x0000000000000000000000000000000000000090";

  const base = {
    pool,
    poolToken0: wrapped,
    poolToken1: token,
    wrappedNative: wrapped,
    publicRouter,
    nativeRouter,
    amountIn: 100n,
    minAmountOut: 90n,
    deadline: 1_000n,
    recipient,
  } as const;

  it("publishes parsable wrapped-native and native-router ABIs", function () {
    const wrappedInterface = new Interface(WRAPPED_NATIVE_TOKEN_ABI);
    const routerInterface = new Interface(PUBLIC_CPMM_NATIVE_ROUTER_ABI);
    const lpInterface = new Interface(PUBLIC_LP_TOKEN_ABI);
    const lpFactoryInterface = new Interface(PUBLIC_LP_TOKEN_FACTORY_ABI);
    expect(wrappedInterface.getFunction("deposit")).to.not.equal(null);
    expect(wrappedInterface.getFunction("withdraw")).to.not.equal(null);
    expect(routerInterface.getFunction("swapExactNativeForToken")).to.not.equal(null);
    expect(routerInterface.getFunction("swapExactTokenForNative")).to.not.equal(null);
    expect(routerInterface.getFunction("createOrAddLiquidityNative")).to.not.equal(null);
    expect(routerInterface.getFunction("removeLiquidityNativeWithPermit")).to.not.equal(null);
    expect(lpInterface.getFunction("permit")).to.not.equal(null);
    expect(lpFactoryInterface.getFunction("isIssuedToken")).to.not.equal(null);
  });

  it("resolves the standard sentinel only at the pool boundary", function () {
    expect(isEvmNativeAssetAddress(EVM_NATIVE_ASSET_ADDRESS.toLowerCase())).to.equal(true);
    expect(resolvePublicAmmTokenAddress(EVM_NATIVE_ASSET_ADDRESS, wrapped)).to.equal(wrapped);
    expect(resolvePublicAmmTokenAddress(token, wrapped)).to.equal(token);
  });

  it("builds native-input execution without an ERC-20 approval", function () {
    const execution = buildPublicExactInputSwapExecution({
      ...base,
      tokenIn: EVM_NATIVE_ASSET_ADDRESS,
      tokenOut: token,
    });
    expect(execution.kind).to.equal("native-to-token");
    expect(execution.to).to.equal(nativeRouter);
    expect(execution.value).to.equal(100n);
    expect(execution.approvalSpender).to.equal(null);
    expect(execution.args).to.deep.equal([pool, 90n, 1_000n, recipient]);
    expect(execution.resolvedTokenIn).to.equal(wrapped);
  });

  it("builds native-output execution with approval delegated to the adapter", function () {
    const execution = buildPublicExactInputSwapExecution({
      ...base,
      tokenIn: token,
      tokenOut: EVM_NATIVE_ASSET_ADDRESS,
    });
    expect(execution.kind).to.equal("token-to-native");
    expect(execution.to).to.equal(nativeRouter);
    expect(execution.value).to.equal(0n);
    expect(execution.approvalSpender).to.equal(nativeRouter);
    expect(execution.zeroForOne).to.equal(false);
    expect(execution.args).to.deep.equal([pool, 100n, 90n, 1_000n, recipient]);
  });

  it("keeps token-to-token execution on the existing router", function () {
    const second = "0x0000000000000000000000000000000000000070";
    const execution = buildPublicExactInputSwapExecution({
      ...base,
      poolToken0: token,
      poolToken1: second,
      tokenIn: token,
      tokenOut: second,
    });
    expect(execution.kind).to.equal("token-to-token");
    expect(execution.to).to.equal(publicRouter);
    expect(execution.approvalSpender).to.equal(publicRouter);
    expect(execution.args).to.deep.equal([pool, 100n, 90n, true, 1_000n]);
  });

  it("provides explicit wrap and unwrap calls for liquidity workflows", function () {
    expect(buildWrapNativeCall({ wrappedNative: wrapped, amount: 5n })).to.deep.equal({
      to: wrapped,
      functionName: "deposit",
      args: [],
      value: 5n,
    });
    expect(buildUnwrapNativeCall({ wrappedNative: wrapped, amount: 5n })).to.deep.equal({
      to: wrapped,
      functionName: "withdraw",
      args: [5n],
      value: 0n,
    });
  });

  it("builds atomic native add-liquidity execution with one paired-token approval", function () {
    const execution = buildPublicNativeLiquidityAddExecution({
      nativeRouter,
      pairedToken: token,
      pairedTokenDecimals: 6,
      feeBps: 30n,
      nativeAmountDesired: 100n,
      tokenAmountDesired: 200n,
      minShares: 1n,
      minPriceX18: 2n,
      maxPriceX18: 3n,
      deadline: 1_000n,
      recipient,
    });
    expect(execution.to).to.equal(nativeRouter);
    expect(execution.value).to.equal(100n);
    expect(execution.tokenApprovalSpender).to.equal(nativeRouter);
    expect(execution.args).to.deep.equal([
      token,
      6,
      30n,
      200n,
      1n,
      2n,
      3n,
      1_000n,
      recipient,
    ]);
  });

  it("builds native LP removal with permit and maps canonical minimums", function () {
    const execution = buildPublicLiquidityRemovalExecution({
      pool,
      liquidityRouter,
      nativeRouter,
      shareAmount: 10n,
      minAmount0: 4n,
      minAmount1: 5n,
      deadline: 1_000n,
      recipient,
      unwrapNative: true,
      wrappedNativeIsToken0: true,
      permit: {
        deadline: 2_000n,
        v: 27,
        r: `0x${"11".repeat(32)}`,
        s: `0x${"22".repeat(32)}`,
      },
    });
    expect(execution.functionName).to.equal("removeLiquidityNativeWithPermit");
    expect(execution.lpApprovalSpender).to.equal(null);
    expect(execution.args).to.deep.equal([
      pool,
      10n,
      5n,
      4n,
      1_000n,
      recipient,
      2_000n,
      27,
      `0x${"11".repeat(32)}`,
      `0x${"22".repeat(32)}`,
    ]);
  });

  it("builds canonical EIP-2612 LP permit typed data", function () {
    const typedData = buildPublicLpPermitTypedData({
      chainId: 2_632_500,
      lpToken,
      owner: recipient,
      spender: nativeRouter,
      value: 10n,
      nonce: 2n,
      deadline: 2_000n,
    });
    expect(typedData.domain).to.deep.equal({
      name: "CipherDEX Public LP Share",
      version: "1",
      chainId: 2_632_500n,
      verifyingContract: lpToken,
    });
    expect(typedData.primaryType).to.equal("Permit");
    expect(typedData.message.nonce).to.equal(2n);
  });

  it("fails closed instead of treating the native sentinel as an ERC-20", function () {
    expect(() => buildPublicTokenApprovalPlan({
      token: EVM_NATIVE_ASSET_ADDRESS,
      spender: publicRouter,
      requiredAmount: 1n,
      currentAllowance: 0n,
    })).to.throw("Invalid token address");
    expect(() => buildPublicCreateOrAddLiquidityCall({
      tokenA: EVM_NATIVE_ASSET_ADDRESS,
      tokenB: token,
      decimalsA: 18,
      decimalsB: 18,
      feeBps: 30n,
      amountADesired: 1n,
      amountBDesired: 1n,
      minShares: 1n,
      minPriceX18: 0n,
      maxPriceX18: 1n,
      deadline: 1n,
    })).to.throw("Invalid public liquidity token configuration");
  });

  it("rejects native-to-native and mismatched-pool execution", function () {
    expect(() => buildPublicExactInputSwapExecution({
      ...base,
      tokenIn: EVM_NATIVE_ASSET_ADDRESS,
      tokenOut: EVM_NATIVE_ASSET_ADDRESS,
    })).to.throw("Native-to-native public swaps are not supported");
    expect(() => buildPublicExactInputSwapExecution({
      ...base,
      poolToken1: "0x0000000000000000000000000000000000000070",
      tokenIn: EVM_NATIVE_ASSET_ADDRESS,
      tokenOut: token,
    })).to.throw("do not match the selected pool");
  });
});
