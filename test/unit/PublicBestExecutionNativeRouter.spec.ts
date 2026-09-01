import { expect } from "chai";
import { ethers } from "../../hardhat/runtime.js";
import { deployFeeVault } from "../helpers/deployFeeVault";

describe("PublicBestExecutionNativeRouter", function () {
  const DEADLINE = 0xffffffff;

  async function deployFixture() {
    const [liquidityProvider, trader, recipient] = await ethers.getSigners();
    const wrapped = await (await ethers.getContractFactory("WrappedNativeToken")).deploy(
      "Wrapped COTI",
      "WCOTI",
    );
    const token = await (await ethers.getContractFactory("MockERC20")).deploy(
      "Paired Token",
      "PAIR",
      18,
    );
    await Promise.all([wrapped.waitForDeployment(), token.waitForDeployment()]);

    const vault = await deployFeeVault();
    const factory = await (await ethers.getContractFactory("PublicCPMMFactory")).deploy(
      await vault.getAddress(),
    );
    await factory.waitForDeployment();

    async function createPool(feeBps: number, wrappedReserve: bigint, tokenReserve: bigint) {
      const wrappedAddress = await wrapped.getAddress();
      const tokenAddress = await token.getAddress();
      await factory.createPool(wrappedAddress, tokenAddress, 18, 18, feeBps);
      const key = await factory.poolKey(wrappedAddress, tokenAddress, 18, 18, feeBps);
      const poolAddress = await factory.getPool(key);
      const pool = await ethers.getContractAt("PublicCPMM", poolAddress);
      const wrappedAmount = ethers.parseEther(wrappedReserve.toString());
      const tokenAmount = ethers.parseEther(tokenReserve.toString());
      await wrapped.connect(liquidityProvider).deposit({ value: wrappedAmount });
      await token.mint(liquidityProvider.address, tokenAmount);
      await wrapped.connect(liquidityProvider).approve(poolAddress, wrappedAmount);
      await token.connect(liquidityProvider).approve(poolAddress, tokenAmount);
      const wrappedIsToken0 = (await pool.token0()).toLowerCase() ===
        wrappedAddress.toLowerCase();
      await pool.connect(liquidityProvider).addLiquidity(
        wrappedIsToken0 ? wrappedAmount : tokenAmount,
        wrappedIsToken0 ? tokenAmount : wrappedAmount,
        1n,
        0n,
        ethers.MaxUint256,
        DEADLINE,
      );
      return pool;
    }

    const lowPool = await createPool(5, 100n, 90n);
    const standardPool = await createPool(30, 100n, 100n);
    const highPool = await createPool(100, 100n, 120n);
    const bestRouter = await (
      await ethers.getContractFactory("PublicBestExecutionRouter")
    ).deploy(await factory.getAddress());
    await bestRouter.waitForDeployment();
    const nativeBestRouter = await (
      await ethers.getContractFactory("PublicBestExecutionNativeRouter")
    ).deploy(
      await factory.getAddress(),
      await bestRouter.getAddress(),
      await wrapped.getAddress(),
    );
    await nativeBestRouter.waitForDeployment();

    return {
      bestRouter,
      factory,
      highPool,
      lowPool,
      nativeBestRouter,
      recipient,
      standardPool,
      token,
      trader,
      wrapped,
    };
  }

  it("binds immutably to the reviewed factory, best router, and WCOTI", async function () {
    const fixture = await deployFixture();
    expect(await fixture.nativeBestRouter.factory()).to.equal(await fixture.factory.getAddress());
    expect(await fixture.nativeBestRouter.bestExecutionRouter()).to.equal(
      await fixture.bestRouter.getAddress(),
    );
    expect(await fixture.nativeBestRouter.wrappedNative()).to.equal(
      await fixture.wrapped.getAddress(),
    );
    expect(await fixture.nativeBestRouter.ALL_CANDIDATE_BITMAP()).to.equal(7n);
  });

  it("wraps native input and atomically executes through the best allowed pool", async function () {
    const fixture = await deployFixture();
    const amountIn = ethers.parseEther("1");
    const quote = await fixture.bestRouter.quoteBestExactInput(
      await fixture.wrapped.getAddress(),
      await fixture.token.getAddress(),
      amountIn,
      7,
    );
    expect(quote.selectedPool).to.equal(await fixture.highPool.getAddress());
    const adapterAddress = await fixture.nativeBestRouter.getAddress();
    const recipientBefore = await fixture.token.balanceOf(fixture.recipient.address);

    await expect(fixture.nativeBestRouter.connect(fixture.trader).swapExactNativeForToken(
      await fixture.token.getAddress(),
      quote.amountOut,
      7,
      fixture.recipient.address,
      DEADLINE,
      { value: amountIn },
    )).to.emit(fixture.nativeBestRouter, "NativeBestSwapRouted")
      .and.to.emit(fixture.bestRouter, "BestSwapRouted");

    expect(await fixture.token.balanceOf(fixture.recipient.address)).to.equal(
      recipientBefore + quote.amountOut,
    );
    expect(await fixture.wrapped.balanceOf(adapterAddress)).to.equal(0n);
    expect(await fixture.token.balanceOf(adapterAddress)).to.equal(0n);
    expect(await ethers.provider.getBalance(adapterAddress)).to.equal(0n);
    expect(await fixture.wrapped.allowance(adapterAddress, await fixture.bestRouter.getAddress()))
      .to.equal(0n);
  });

  it("routes token input to WCOTI, unwraps it, and leaves no custody", async function () {
    const fixture = await deployFixture();
    const amountIn = ethers.parseEther("1");
    const quote = await fixture.bestRouter.quoteBestExactInput(
      await fixture.token.getAddress(),
      await fixture.wrapped.getAddress(),
      amountIn,
      7,
    );
    expect(quote.selectedPool).to.equal(await fixture.lowPool.getAddress());
    const adapterAddress = await fixture.nativeBestRouter.getAddress();
    await fixture.token.mint(fixture.trader.address, amountIn);
    await fixture.token.connect(fixture.trader).approve(adapterAddress, amountIn);
    const recipientBefore = await ethers.provider.getBalance(fixture.recipient.address);

    await expect(fixture.nativeBestRouter.connect(fixture.trader).swapExactTokenForNative(
      await fixture.token.getAddress(),
      amountIn,
      quote.amountOut,
      7,
      fixture.recipient.address,
      DEADLINE,
    )).to.emit(fixture.nativeBestRouter, "NativeBestSwapRouted")
      .and.to.emit(fixture.bestRouter, "BestSwapRouted");

    expect(await ethers.provider.getBalance(fixture.recipient.address)).to.equal(
      recipientBefore + quote.amountOut,
    );
    expect(await fixture.token.balanceOf(adapterAddress)).to.equal(0n);
    expect(await fixture.wrapped.balanceOf(adapterAddress)).to.equal(0n);
    expect(await ethers.provider.getBalance(adapterAddress)).to.equal(0n);
    expect(await fixture.token.allowance(adapterAddress, await fixture.bestRouter.getAddress()))
      .to.equal(0n);
  });

  it("honors the caller candidate bitmap during native execution", async function () {
    const fixture = await deployFixture();
    const amountIn = ethers.parseEther("1");
    const quote = await fixture.bestRouter.quoteBestExactInput(
      await fixture.wrapped.getAddress(),
      await fixture.token.getAddress(),
      amountIn,
      2,
    );
    expect(quote.selectedPool).to.equal(await fixture.standardPool.getAddress());

    await expect(fixture.nativeBestRouter.connect(fixture.trader).swapExactNativeForToken(
      await fixture.token.getAddress(),
      quote.amountOut,
      2,
      fixture.recipient.address,
      DEADLINE,
      { value: amountIn },
    )).to.emit(fixture.nativeBestRouter, "NativeBestSwapRouted")
      .withArgs(
        fixture.trader.address,
        await fixture.standardPool.getAddress(),
        fixture.recipient.address,
        ethers.ZeroAddress,
        await fixture.token.getAddress(),
        30n,
        2,
        amountIn,
        quote.amountOut,
      );
  });

  it("rolls back native and token settlement when slippage or delivery fails", async function () {
    const fixture = await deployFixture();
    const amountIn = ethers.parseEther("1");
    const nativeQuote = await fixture.bestRouter.quoteBestExactInput(
      await fixture.wrapped.getAddress(),
      await fixture.token.getAddress(),
      amountIn,
      7,
    );
    await expect(fixture.nativeBestRouter.connect(fixture.trader).swapExactNativeForToken(
      await fixture.token.getAddress(),
      nativeQuote.amountOut + 1n,
      7,
      fixture.recipient.address,
      DEADLINE,
      { value: amountIn },
    )).to.be.revertedWithCustomError(fixture.bestRouter, "SlippageExceeded");

    const rejecting = await (
      await ethers.getContractFactory("RejectingNativeLimitOrderActor")
    ).deploy();
    await rejecting.waitForDeployment();
    await fixture.token.mint(fixture.trader.address, amountIn);
    await fixture.token.connect(fixture.trader).approve(
      await fixture.nativeBestRouter.getAddress(),
      amountIn,
    );
    await expect(fixture.nativeBestRouter.connect(fixture.trader).swapExactTokenForNative(
      await fixture.token.getAddress(),
      amountIn,
      0n,
      7,
      await rejecting.getAddress(),
      DEADLINE,
    )).to.be.revertedWithCustomError(fixture.nativeBestRouter, "NativeTransferFailed");
    expect(await fixture.token.balanceOf(fixture.trader.address)).to.equal(amountIn);
  });

  it("rejects invalid configuration, assets, recipients, and direct native transfers", async function () {
    const fixture = await deployFixture();
    const otherVault = await deployFeeVault();
    const otherFactory = await (
      await ethers.getContractFactory("PublicCPMMFactory")
    ).deploy(await otherVault.getAddress());
    await otherFactory.waitForDeployment();
    const otherBestRouter = await (
      await ethers.getContractFactory("PublicBestExecutionRouter")
    ).deploy(await otherFactory.getAddress());
    await otherBestRouter.waitForDeployment();
    const adapterFactory = await ethers.getContractFactory("PublicBestExecutionNativeRouter");
    await expect(adapterFactory.deploy(
      await fixture.factory.getAddress(),
      await otherBestRouter.getAddress(),
      await fixture.wrapped.getAddress(),
    )).to.be.revertedWithCustomError(adapterFactory, "InvalidConfiguration");

    await expect(fixture.nativeBestRouter.connect(fixture.trader).swapExactNativeForToken(
      await fixture.wrapped.getAddress(),
      0n,
      7,
      fixture.recipient.address,
      DEADLINE,
      { value: 1n },
    )).to.be.revertedWithCustomError(fixture.nativeBestRouter, "InvalidToken");
    await expect(fixture.nativeBestRouter.connect(fixture.trader).swapExactNativeForToken(
      await fixture.token.getAddress(),
      0n,
      7,
      await fixture.nativeBestRouter.getAddress(),
      DEADLINE,
      { value: 1n },
    )).to.be.revertedWithCustomError(fixture.nativeBestRouter, "InvalidRecipient");
    await expect(fixture.trader.sendTransaction({
      to: await fixture.nativeBestRouter.getAddress(),
      value: 1n,
    })).to.be.revertedWithCustomError(fixture.nativeBestRouter, "UnexpectedNativeSender");
  });
});
