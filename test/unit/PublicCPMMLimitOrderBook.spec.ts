import { expect } from "chai";
import { ethers } from "../../hardhat/runtime.js";
import { deployFeeVault } from "../helpers/deployFeeVault";

describe("PublicCPMMLimitOrderBook", function () {
  async function deployFixture() {
    const [liquidityProvider, maker, filler, recipient, outsider, beneficiary] =
      await ethers.getSigners();
    const tokenFactory = await ethers.getContractFactory("MockERC20");
    const tokenA = await tokenFactory.deploy("Token A", "TKA", 18);
    const tokenB = await tokenFactory.deploy("Token B", "TKB", 6);
    const wrappedNative = await (
      await ethers.getContractFactory("WrappedNativeToken")
    ).deploy("Wrapped COTI", "WCOTI");
    await Promise.all([
      tokenA.waitForDeployment(),
      tokenB.waitForDeployment(),
      wrappedNative.waitForDeployment(),
    ]);

    const vault = await deployFeeVault();
    const factory = await (await ethers.getContractFactory("PublicCPMMFactory")).deploy(
      await vault.getAddress(),
    );
    await factory.waitForDeployment();

    async function createPool(feeBps: number, reserveA: bigint, reserveB: bigint) {
      const tokenAAddress = await tokenA.getAddress();
      const tokenBAddress = await tokenB.getAddress();
      await factory.createPool(tokenAAddress, tokenBAddress, 18, 6, feeBps);
      const key = await factory.poolKey(tokenAAddress, tokenBAddress, 18, 6, feeBps);
      const poolAddress = await factory.getPool(key);
      const pool = await ethers.getContractAt("PublicCPMM", poolAddress);
      const amountA = ethers.parseUnits(reserveA.toString(), 18);
      const amountB = ethers.parseUnits(reserveB.toString(), 6);
      await tokenA.mint(liquidityProvider.address, amountA);
      await tokenB.mint(liquidityProvider.address, amountB);
      await tokenA.approve(poolAddress, amountA);
      await tokenB.approve(poolAddress, amountB);
      const token0IsA = (await pool.token0()).toLowerCase() === tokenAAddress.toLowerCase();
      await pool.addLiquidity(
        token0IsA ? amountA : amountB,
        token0IsA ? amountB : amountA,
        1n,
        0n,
        ethers.MaxUint256,
        0xffffffff,
      );
      return pool;
    }

    const lowPool = await createPool(5, 1_000n, 900n);
    const standardPool = await createPool(30, 1_000n, 1_000n);
    const highPool = await createPool(100, 1_000n, 1_200n);
    const wrappedNativeAddress = await wrappedNative.getAddress();
    const tokenBAddress = await tokenB.getAddress();
    await factory.createPool(wrappedNativeAddress, tokenBAddress, 18, 6, 30);
    const nativePoolKey = await factory.poolKey(
      wrappedNativeAddress,
      tokenBAddress,
      18,
      6,
      30,
    );
    const nativePool = await ethers.getContractAt(
      "PublicCPMM",
      await factory.getPool(nativePoolKey),
    );
    const nativeLiquidity = ethers.parseEther("100");
    const pairedLiquidity = ethers.parseUnits("100", 6);
    await wrappedNative.connect(liquidityProvider).deposit({ value: nativeLiquidity });
    await tokenB.mint(liquidityProvider.address, pairedLiquidity);
    await wrappedNative.connect(liquidityProvider).approve(
      await nativePool.getAddress(),
      nativeLiquidity,
    );
    await tokenB.connect(liquidityProvider).approve(
      await nativePool.getAddress(),
      pairedLiquidity,
    );
    const nativeToken0 = (await nativePool.token0()).toLowerCase() ===
      wrappedNativeAddress.toLowerCase();
    await nativePool.connect(liquidityProvider).addLiquidity(
      nativeToken0 ? nativeLiquidity : pairedLiquidity,
      nativeToken0 ? pairedLiquidity : nativeLiquidity,
      1n,
      0n,
      ethers.MaxUint256,
      0xffffffff,
    );
    const router = await (
      await ethers.getContractFactory("PublicBestExecutionRouter")
    ).deploy(await factory.getAddress());
    await router.waitForDeployment();
    const orderBook = await (
      await ethers.getContractFactory("PublicCPMMLimitOrderBook")
    ).deploy(
      await factory.getAddress(),
      await router.getAddress(),
      await wrappedNative.getAddress(),
      beneficiary.address,
    );
    await orderBook.waitForDeployment();

    const amountIn = ethers.parseUnits("10", 18);
    await tokenA.mint(maker.address, ethers.parseUnits("100", 18));
    await tokenB.mint(maker.address, ethers.parseUnits("100", 6));
    await tokenA.connect(maker).approve(await orderBook.getAddress(), ethers.MaxUint256);
    await tokenB.connect(maker).approve(await orderBook.getAddress(), ethers.MaxUint256);
    const latest = await ethers.provider.getBlock("latest");
    if (!latest) throw new Error("latest block unavailable");
    const expiry = BigInt(latest.timestamp + 3_600);

    return {
      amountIn,
      beneficiary,
      expiry,
      factory,
      filler,
      highPool,
      lowPool,
      maker,
      nativePool,
      orderBook,
      outsider,
      recipient,
      router,
      standardPool,
      tokenA,
      tokenAAddress: await tokenA.getAddress(),
      tokenB,
      tokenBAddress: await tokenB.getAddress(),
      wrappedNative,
      wrappedNativeAddress: await wrappedNative.getAddress(),
    };
  }

  type Fixture = Awaited<ReturnType<typeof deployFixture>>;

  function orderParams(fixture: Fixture, overrides: Record<string, unknown> = {}) {
    return {
      tokenIn: fixture.tokenAAddress,
      tokenOut: fixture.tokenBAddress,
      amountIn: fixture.amountIn,
      minAmountOut: 1n,
      recipient: fixture.recipient.address,
      expiry: fixture.expiry,
      candidateBitmap: 7,
      allowPartialFills: false,
      minimumFillAmount: 0n,
      settlementMode: 0,
      ...overrides,
    };
  }

  async function placeOrder(
    fixture: Fixture,
    overrides: Record<string, unknown> = {},
    bounty = 0n,
  ): Promise<bigint> {
    const id = await fixture.orderBook.nextOrderId();
    await fixture.orderBook.connect(fixture.maker).createOrder(
      orderParams(fixture, overrides),
      { value: bounty },
    );
    return id;
  }

  it("binds to one reviewed factory, router, and immutable surplus beneficiary", async function () {
    const fixture = await deployFixture();
    expect(await fixture.orderBook.factory()).to.equal(await fixture.factory.getAddress());
    expect(await fixture.orderBook.bestExecutionRouter()).to.equal(
      await fixture.router.getAddress(),
    );
    expect(await fixture.orderBook.surplusBeneficiary()).to.equal(
      fixture.beneficiary.address,
    );

    const orderBookFactory = await ethers.getContractFactory("PublicCPMMLimitOrderBook");
    await expect(orderBookFactory.deploy(
      ethers.ZeroAddress,
      await fixture.router.getAddress(),
      await fixture.wrappedNative.getAddress(),
      fixture.beneficiary.address,
    )).to.be.revertedWithCustomError(orderBookFactory, "InvalidFactory");
    await expect(orderBookFactory.deploy(
      await fixture.factory.getAddress(),
      await fixture.tokenA.getAddress(),
      await fixture.wrappedNative.getAddress(),
      fixture.beneficiary.address,
    )).to.be.revertedWithCustomError(orderBookFactory, "InvalidRouter");
    await expect(orderBookFactory.deploy(
      await fixture.factory.getAddress(),
      await fixture.router.getAddress(),
      await fixture.wrappedNative.getAddress(),
      ethers.ZeroAddress,
    )).to.be.revertedWithCustomError(orderBookFactory, "InvalidSurplusBeneficiary");
    await expect(orderBookFactory.deploy(
      await fixture.factory.getAddress(),
      await fixture.router.getAddress(),
      ethers.ZeroAddress,
      fixture.beneficiary.address,
    )).to.be.revertedWithCustomError(orderBookFactory, "InvalidWrappedNative");
    await expect(orderBookFactory.deploy(
      await fixture.factory.getAddress(),
      await fixture.router.getAddress(),
      await fixture.wrappedNative.getAddress(),
      await fixture.wrappedNative.getAddress(),
    )).to.be.revertedWithCustomError(orderBookFactory, "InvalidSurplusBeneficiary");
  });

  it("escrows a pair-level order instead of binding it to one pool", async function () {
    const fixture = await deployFixture();
    const bounty = 11n;
    const orderId = await placeOrder(fixture, {}, bounty);
    const order = await fixture.orderBook.getOrder(orderId);
    expect(order.id).to.equal(orderId);
    expect(order.maker).to.equal(fixture.maker.address);
    expect(order.tokenIn).to.equal(await fixture.tokenA.getAddress());
    expect(order.tokenOut).to.equal(await fixture.tokenB.getAddress());
    expect(order.remainingAmountIn).to.equal(fixture.amountIn);
    expect(order.priceNumerator).to.equal(1n);
    expect(order.priceDenominator).to.equal(fixture.amountIn);
    expect(order.candidateBitmap).to.equal(7n);
    expect(order.remainingExecutionBounty).to.equal(bounty);
    expect(await fixture.orderBook.orderStatus(orderId)).to.equal(1n);
    expect(await fixture.orderBook.totalEscrowed(await fixture.tokenA.getAddress()))
      .to.equal(fixture.amountIn);
  });

  it("wraps native input internally, supports partial fills, and unwraps cancellation", async function () {
    const fixture = await deployFixture();
    const amountIn = ethers.parseEther("10");
    const partial = ethers.parseEther("3");
    const bounty = 17n;
    const supplyBefore = await fixture.wrappedNative.totalSupply();
    const orderId = await fixture.orderBook.nextOrderId();

    await fixture.orderBook.connect(fixture.maker).createOrder(
      orderParams(fixture, {
        tokenIn: fixture.wrappedNativeAddress,
        tokenOut: fixture.tokenBAddress,
        amountIn,
        candidateBitmap: 2,
        allowPartialFills: true,
        minimumFillAmount: ethers.parseEther("1"),
        settlementMode: 1,
      }),
      { value: amountIn + bounty },
    );

    expect(await fixture.wrappedNative.balanceOf(fixture.maker.address)).to.equal(0n);
    expect(await fixture.wrappedNative.balanceOf(await fixture.orderBook.getAddress()))
      .to.equal(amountIn);
    expect((await fixture.orderBook.getOrder(orderId)).settlementMode).to.equal(1n);
    expect(await ethers.provider.getBalance(await fixture.orderBook.getAddress()))
      .to.equal(bounty);

    const quote = await fixture.router.quoteBestExactInput(
      fixture.wrappedNativeAddress,
      fixture.tokenBAddress,
      partial,
      2,
    );
    await fixture.orderBook.connect(fixture.filler).fillOrder(orderId, partial);
    expect(await fixture.tokenB.balanceOf(fixture.recipient.address)).to.equal(quote.amountOut);

    await fixture.orderBook.connect(fixture.maker).cancelOrder(orderId);
    expect(await fixture.orderBook.orderStatus(orderId)).to.equal(3n);
    expect(await fixture.orderBook.totalEscrowed(fixture.wrappedNativeAddress)).to.equal(0n);
    expect(await fixture.wrappedNative.balanceOf(await fixture.orderBook.getAddress()))
      .to.equal(0n);
    expect(await fixture.wrappedNative.balanceOf(fixture.maker.address)).to.equal(0n);
    expect(await fixture.wrappedNative.totalSupply()).to.equal(supplyBefore + partial);
    expect(await fixture.orderBook.totalOpenExecutionBounties()).to.equal(0n);
    expect(await ethers.provider.getBalance(await fixture.orderBook.getAddress()))
      .to.equal(0n);
  });

  it("unwraps partial native output and credits a rejecting recipient", async function () {
    const fixture = await deployFixture();
    const amountIn = ethers.parseUnits("10", 6);
    const firstFill = ethers.parseUnits("3", 6);
    const actor = await (
      await ethers.getContractFactory("RejectingNativeLimitOrderActor")
    ).deploy();
    await actor.waitForDeployment();
    const actorAddress = await actor.getAddress();
    const orderId = await fixture.orderBook.nextOrderId();

    await fixture.orderBook.connect(fixture.maker).createOrder(
      orderParams(fixture, {
        tokenIn: fixture.tokenBAddress,
        tokenOut: fixture.wrappedNativeAddress,
        amountIn,
        recipient: actorAddress,
        candidateBitmap: 2,
        allowPartialFills: true,
        minimumFillAmount: ethers.parseUnits("1", 6),
        settlementMode: 2,
      }),
    );

    const firstQuote = await fixture.router.quoteBestExactInput(
      fixture.tokenBAddress,
      fixture.wrappedNativeAddress,
      firstFill,
      2,
    );
    await expect(fixture.orderBook.connect(fixture.filler).fillOrder(orderId, firstFill))
      .to.emit(fixture.orderBook, "NativeProceedsCredited")
      .withArgs(orderId, actorAddress, firstQuote.amountOut);
    expect(await fixture.orderBook.claimableNativeProceeds(actorAddress))
      .to.equal(firstQuote.amountOut);

    const remaining = amountIn - firstFill;
    const secondQuote = await fixture.router.quoteBestExactInput(
      fixture.tokenBAddress,
      fixture.wrappedNativeAddress,
      remaining,
      2,
    );
    await fixture.orderBook.connect(fixture.outsider).fillOrder(orderId, remaining);
    const totalProceeds = firstQuote.amountOut + secondQuote.amountOut;
    expect(await fixture.orderBook.claimableNativeProceeds(actorAddress))
      .to.equal(totalProceeds);
    expect(await fixture.orderBook.totalClaimableNativeProceeds()).to.equal(totalProceeds);
    expect(await fixture.wrappedNative.balanceOf(await fixture.orderBook.getAddress()))
      .to.equal(0n);

    await ethers.provider.send("hardhat_setBalance", [
      await fixture.orderBook.getAddress(),
      ethers.toQuantity(totalProceeds + 5n),
    ]);
    await fixture.orderBook.connect(fixture.outsider).sweepNativeSurplus();
    expect(await ethers.provider.getBalance(await fixture.orderBook.getAddress()))
      .to.equal(totalProceeds);

    const recipientBefore = await ethers.provider.getBalance(fixture.recipient.address);
    await actor.claimNativeProceeds(
      await fixture.orderBook.getAddress(),
      fixture.recipient.address,
    );
    expect(await ethers.provider.getBalance(fixture.recipient.address))
      .to.equal(recipientBefore + totalProceeds);
    expect(await fixture.orderBook.totalClaimableNativeProceeds()).to.equal(0n);
    expect(await ethers.provider.getBalance(await fixture.orderBook.getAddress()))
      .to.equal(0n);
  });

  it("delivers native output directly to an ordinary recipient", async function () {
    const fixture = await deployFixture();
    const amountIn = ethers.parseUnits("1", 6);
    const orderId = await fixture.orderBook.nextOrderId();
    const quote = await fixture.router.quoteBestExactInput(
      fixture.tokenBAddress,
      fixture.wrappedNativeAddress,
      amountIn,
      2,
    );
    await fixture.orderBook.connect(fixture.maker).createOrder(
      orderParams(fixture, {
        tokenIn: fixture.tokenBAddress,
        tokenOut: fixture.wrappedNativeAddress,
        amountIn,
        candidateBitmap: 2,
        settlementMode: 2,
      }),
    );

    const before = await ethers.provider.getBalance(fixture.recipient.address);
    await fixture.orderBook.connect(fixture.filler).fillOrder(orderId, amountIn);
    expect(await ethers.provider.getBalance(fixture.recipient.address))
      .to.equal(before + quote.amountOut);
    expect(await fixture.orderBook.orderStatus(orderId)).to.equal(2n);
    expect(await fixture.orderBook.totalClaimableNativeProceeds()).to.equal(0n);
    expect(await ethers.provider.getBalance(await fixture.orderBook.getAddress()))
      .to.equal(0n);
  });

  it("fills through the best eligible canonical pool and compacts terminal state", async function () {
    const fixture = await deployFixture();
    const orderId = await placeOrder(fixture);
    const quote = await fixture.router.quoteBestExactInput(
      await fixture.tokenA.getAddress(),
      await fixture.tokenB.getAddress(),
      fixture.amountIn,
      7,
    );
    expect(quote.selectedPool).to.equal(await fixture.highPool.getAddress());

    await expect(fixture.orderBook.connect(fixture.filler).fillOrder(
      orderId,
      fixture.amountIn,
    )).to.emit(fixture.orderBook, "OrderFilled");
    expect(await fixture.tokenB.balanceOf(fixture.recipient.address)).to.equal(quote.amountOut);
    expect(await fixture.orderBook.orderStatus(orderId)).to.equal(2n);
    expect((await fixture.orderBook.getOrder(orderId)).maker).to.equal(ethers.ZeroAddress);
    expect(await fixture.orderBook.totalEscrowed(await fixture.tokenA.getAddress()))
      .to.equal(0n);
    expect(await fixture.tokenA.allowance(
      await fixture.orderBook.getAddress(),
      await fixture.router.getAddress(),
    )).to.equal(0n);
  });

  it("restricts routing to the maker-selected fee tiers", async function () {
    const fixture = await deployFixture();
    const orderId = await placeOrder(fixture, { candidateBitmap: 2 });
    const readiness = await fixture.orderBook.canFillOrder(orderId, fixture.amountIn);
    expect(readiness.canFill).to.equal(true);
    expect(readiness.selectedPool).to.equal(await fixture.standardPool.getAddress());
    expect(readiness.selectedFeeBps).to.equal(30n);
  });

  it("supports bounded partial fills with ceiling price rounding and conserved bounties", async function () {
    const fixture = await deployFixture();
    const unit = ethers.parseUnits("1", 18);
    const bounty = 10n;
    const orderId = await placeOrder(fixture, {
      amountIn: 10n * unit,
      minAmountOut: 7n,
      allowPartialFills: true,
      minimumFillAmount: unit,
    }, bounty);

    expect(await fixture.orderBook.minimumOutputFor(orderId, 3n * unit)).to.equal(3n);
    await fixture.orderBook.connect(fixture.filler).fillOrder(orderId, 3n * unit);
    let order = await fixture.orderBook.getOrder(orderId);
    expect(order.remainingAmountIn).to.equal(7n * unit);
    expect(order.remainingExecutionBounty).to.equal(7n);
    expect(await fixture.orderBook.totalOpenExecutionBounties()).to.equal(7n);

    await fixture.orderBook.connect(fixture.outsider).fillOrder(orderId, 2n * unit);
    order = await fixture.orderBook.getOrder(orderId);
    expect(order.remainingAmountIn).to.equal(5n * unit);
    expect(order.remainingExecutionBounty).to.equal(5n);

    await fixture.orderBook.connect(fixture.filler).fillOrder(orderId, 5n * unit);
    expect(await fixture.orderBook.orderStatus(orderId)).to.equal(2n);
    expect(await fixture.orderBook.totalOpenExecutionBounties()).to.equal(0n);
    expect(await ethers.provider.getBalance(await fixture.orderBook.getAddress())).to.equal(0n);
  });

  it("preserves aggregate escrow and bounty invariants across interleaved orders", async function () {
    const fixture = await deployFixture();
    const unit = ethers.parseUnits("1", 18);
    const first = await placeOrder(fixture, {
      amountIn: 10n * unit,
      allowPartialFills: true,
      minimumFillAmount: unit,
    }, 11n);
    const second = await placeOrder(fixture, {
      amountIn: 20n * unit,
      allowPartialFills: true,
      minimumFillAmount: unit,
    }, 17n);
    const third = await placeOrder(fixture, {
      amountIn: 30n * unit,
      allowPartialFills: true,
      minimumFillAmount: unit,
    }, 23n);
    const token = await fixture.tokenA.getAddress();
    const orderBookAddress = await fixture.orderBook.getAddress();

    expect(await fixture.orderBook.totalEscrowed(token)).to.equal(60n * unit);
    expect(await fixture.orderBook.totalOpenExecutionBounties()).to.equal(51n);
    expect(await ethers.provider.getBalance(orderBookAddress)).to.equal(51n);

    await fixture.orderBook.connect(fixture.filler).fillOrder(first, 3n * unit);
    await fixture.orderBook.connect(fixture.outsider).fillOrder(second, 7n * unit);
    await fixture.orderBook.connect(fixture.maker).cancelOrder(third);
    expect(await fixture.orderBook.totalEscrowed(token)).to.equal(20n * unit);
    expect(await fixture.tokenA.balanceOf(orderBookAddress)).to.equal(20n * unit);
    expect(await fixture.orderBook.totalOpenExecutionBounties()).to.equal(20n);
    expect(await ethers.provider.getBalance(orderBookAddress)).to.equal(20n);

    await fixture.orderBook.connect(fixture.filler).fillOrder(first, 7n * unit);
    await fixture.orderBook.connect(fixture.filler).fillOrder(second, 3n * unit);
    expect(await fixture.orderBook.totalEscrowed(token)).to.equal(10n * unit);
    expect(await fixture.orderBook.totalOpenExecutionBounties()).to.equal(10n);
    await fixture.orderBook.connect(fixture.maker).cancelOrder(second);
    expect(await fixture.orderBook.totalEscrowed(token)).to.equal(0n);
    expect(await fixture.orderBook.totalOpenExecutionBounties()).to.equal(0n);
    expect(await fixture.tokenA.balanceOf(orderBookAddress)).to.equal(0n);
    expect(await ethers.provider.getBalance(orderBookAddress)).to.equal(0n);
  });

  it("enforces full-fill orders and the configured minimum partial size", async function () {
    const fixture = await deployFixture();
    const unit = ethers.parseUnits("1", 18);
    const fullOnly = await placeOrder(fixture);
    await expect(fixture.orderBook.connect(fixture.filler).fillOrder(fullOnly, unit))
      .to.be.revertedWithCustomError(fixture.orderBook, "InvalidFillAmount");

    const partial = await placeOrder(fixture, {
      allowPartialFills: true,
      minimumFillAmount: 2n * unit,
    });
    await expect(fixture.orderBook.connect(fixture.filler).fillOrder(partial, unit))
      .to.be.revertedWithCustomError(fixture.orderBook, "InvalidFillAmount");
    expect(await fixture.orderBook.canFillOrder(partial, unit)).to.deep.equal([
      false,
      ethers.ZeroAddress,
      0n,
      0n,
      0n,
    ]);
  });

  it("lets only the maker amend price, expiry, recipient, routing, and partial-fill policy", async function () {
    const fixture = await deployFixture();
    const latest = await ethers.provider.getBlock("latest");
    if (!latest) throw new Error("latest block unavailable");
    const shortExpiry = BigInt(latest.timestamp + 10);
    const orderId = await placeOrder(fixture, { expiry: shortExpiry });
    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(shortExpiry + 1n)]);
    await ethers.provider.send("evm_mine", []);
    expect((await fixture.orderBook.canFillOrder(orderId, fixture.amountIn)).canFill)
      .to.equal(false);

    const current = await ethers.provider.getBlock("latest");
    if (!current) throw new Error("latest block unavailable");
    const amendment = {
      recipient: fixture.outsider.address,
      minAmountOutForRemaining: 2n,
      expiry: BigInt(current.timestamp + 600),
      candidateBitmap: 2,
      allowPartialFills: true,
      minimumFillAmount: ethers.parseUnits("1", 18),
    };
    await expect(fixture.orderBook.connect(fixture.outsider).amendOrder(orderId, amendment))
      .to.be.revertedWithCustomError(fixture.orderBook, "NotOrderMaker");
    await fixture.orderBook.connect(fixture.maker).amendOrder(orderId, amendment);

    const order = await fixture.orderBook.getOrder(orderId);
    expect(order.revision).to.equal(1n);
    expect(order.recipient).to.equal(fixture.outsider.address);
    expect(order.priceNumerator).to.equal(2n);
    expect(order.priceDenominator).to.equal(fixture.amountIn);
    expect(order.candidateBitmap).to.equal(2n);
    expect(order.allowPartialFills).to.equal(true);
    const readiness = await fixture.orderBook.canFillOrder(orderId, fixture.amountIn);
    expect(readiness.canFill).to.equal(true);
    expect(readiness.selectedPool).to.equal(await fixture.standardPool.getAddress());
  });

  it("allows only bounty increases while an order remains open", async function () {
    const fixture = await deployFixture();
    const orderId = await placeOrder(fixture, {}, 3n);
    await expect(fixture.orderBook.connect(fixture.outsider).increaseExecutionBounty(
      orderId,
      { value: 2n },
    )).to.be.revertedWithCustomError(fixture.orderBook, "NotOrderMaker");
    await fixture.orderBook.connect(fixture.maker).increaseExecutionBounty(
      orderId,
      { value: 2n },
    );
    expect((await fixture.orderBook.getOrder(orderId)).remainingExecutionBounty)
      .to.equal(5n);
    expect(await fixture.orderBook.totalOpenExecutionBounties()).to.equal(5n);
  });

  it("cancels after a partial fill and returns only remaining escrow and bounty", async function () {
    const fixture = await deployFixture();
    const unit = ethers.parseUnits("1", 18);
    const makerBefore = await fixture.tokenA.balanceOf(fixture.maker.address);
    const orderId = await placeOrder(fixture, {
      allowPartialFills: true,
      minimumFillAmount: unit,
    }, 10n);
    await fixture.orderBook.connect(fixture.filler).fillOrder(orderId, 3n * unit);
    await fixture.orderBook.connect(fixture.maker).cancelOrder(orderId);

    expect(await fixture.tokenA.balanceOf(fixture.maker.address))
      .to.equal(makerBefore - 3n * unit);
    expect(await fixture.orderBook.orderStatus(orderId)).to.equal(3n);
    expect((await fixture.orderBook.getOrder(orderId)).maker).to.equal(ethers.ZeroAddress);
    expect(await fixture.orderBook.totalOpenExecutionBounties()).to.equal(0n);
  });

  it("keeps impossible fills atomic and leaves the order open", async function () {
    const fixture = await deployFixture();
    const quote = await fixture.router.quoteBestExactInput(
      await fixture.tokenA.getAddress(),
      await fixture.tokenB.getAddress(),
      fixture.amountIn,
      7,
    );
    const orderId = await placeOrder(fixture, { minAmountOut: quote.amountOut + 1n }, 10n);
    const readiness = await fixture.orderBook.canFillOrder(orderId, fixture.amountIn);
    expect(readiness.canFill).to.equal(false);
    await expect(fixture.orderBook.connect(fixture.filler).fillOrder(
      orderId,
      fixture.amountIn,
    )).to.be.revertedWithCustomError(fixture.router, "SlippageExceeded");
    expect(await fixture.orderBook.orderStatus(orderId)).to.equal(1n);
    expect((await fixture.orderBook.getOrder(orderId)).remainingAmountIn)
      .to.equal(fixture.amountIn);
    expect(await fixture.orderBook.totalOpenExecutionBounties()).to.equal(10n);
  });

  it("credits a rejecting filler without rolling back settlement", async function () {
    const fixture = await deployFixture();
    const bounty = ethers.parseEther("0.01");
    const orderId = await placeOrder(fixture, {}, bounty);
    const actor = await (
      await ethers.getContractFactory("RejectingNativeLimitOrderActor")
    ).deploy();
    await actor.waitForDeployment();
    const actorAddress = await actor.getAddress();

    await expect(actor.fillOrder(
      await fixture.orderBook.getAddress(),
      orderId,
      fixture.amountIn,
    )).to.emit(fixture.orderBook, "NativeBountyCredited")
      .withArgs(orderId, actorAddress, bounty);
    expect(await fixture.orderBook.orderStatus(orderId)).to.equal(2n);
    expect(await fixture.orderBook.claimableNativeBounties(actorAddress)).to.equal(bounty);
    expect(await fixture.orderBook.totalClaimableNativeBounties()).to.equal(bounty);

    await actor.claimNativeBounty(
      await fixture.orderBook.getAddress(),
      fixture.outsider.address,
    );
    expect(await fixture.orderBook.claimableNativeBounties(actorAddress)).to.equal(0n);
  });

  it("sweeps only token and native surplus to the immutable beneficiary", async function () {
    const fixture = await deployFixture();
    const bounty = 10n;
    await placeOrder(fixture, {}, bounty);
    const orderBookAddress = await fixture.orderBook.getAddress();
    const surplus = ethers.parseUnits("5", 18);
    await fixture.tokenA.mint(orderBookAddress, surplus);
    const beneficiaryBefore = await fixture.tokenA.balanceOf(fixture.beneficiary.address);

    await fixture.orderBook.connect(fixture.outsider).sweepTokenSurplus(
      await fixture.tokenA.getAddress(),
    );
    expect(await fixture.tokenA.balanceOf(fixture.beneficiary.address))
      .to.equal(beneficiaryBefore + surplus);
    expect(await fixture.tokenA.balanceOf(orderBookAddress)).to.equal(fixture.amountIn);
    await expect(fixture.orderBook.sweepTokenSurplus(await fixture.tokenA.getAddress()))
      .to.be.revertedWithCustomError(fixture.orderBook, "NoSurplus");

    await ethers.provider.send("hardhat_setBalance", [orderBookAddress, ethers.toQuantity(15n)]);
    const nativeBefore = await ethers.provider.getBalance(fixture.beneficiary.address);
    await fixture.orderBook.connect(fixture.outsider).sweepNativeSurplus();
    expect(await ethers.provider.getBalance(fixture.beneficiary.address))
      .to.equal(nativeBefore + 5n);
    expect(await ethers.provider.getBalance(orderBookAddress)).to.equal(bounty);
  });

  it("supports EIP-2612 creation and allowance-backed fallback for non-permit tokens", async function () {
    const fixture = await deployFixture();
    const permitToken = await (
      await ethers.getContractFactory("MockPermitERC20")
    ).deploy("Permit Token", "PRM", 18);
    await permitToken.waitForDeployment();
    const amount = ethers.parseUnits("1", 18);
    await permitToken.mint(fixture.maker.address, amount);
    const network = await ethers.provider.getNetwork();
    const nonce = await permitToken.nonces(fixture.maker.address);
    const permitDeadline = fixture.expiry;
    const signature = ethers.Signature.from(await fixture.maker.signTypedData(
      {
        name: "Permit Token",
        version: "1",
        chainId: network.chainId,
        verifyingContract: await permitToken.getAddress(),
      },
      {
        Permit: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      {
        owner: fixture.maker.address,
        spender: await fixture.orderBook.getAddress(),
        value: amount,
        nonce,
        deadline: permitDeadline,
      },
    ));
    await fixture.orderBook.connect(fixture.maker).createOrderWithPermit(
      orderParams(fixture, { tokenIn: await permitToken.getAddress(), amountIn: amount }),
      permitDeadline,
      signature.v,
      signature.r,
      signature.s,
    );
    expect(await fixture.orderBook.totalEscrowed(await permitToken.getAddress()))
      .to.equal(amount);

    const fallbackId = await fixture.orderBook.nextOrderId();
    await fixture.orderBook.connect(fixture.maker).createOrderWithPermit(
      orderParams(fixture),
      permitDeadline,
      27,
      ethers.ZeroHash,
      ethers.ZeroHash,
    );
    expect(await fixture.orderBook.orderStatus(fallbackId)).to.equal(1n);

    await expect(fixture.orderBook.connect(fixture.outsider).createOrderWithPermit(
      orderParams(fixture),
      permitDeadline,
      27,
      ethers.ZeroHash,
      ethers.ZeroHash,
    )).to.be.revertedWithCustomError(fixture.orderBook, "PermitFailed");
  });

  it("rolls back creation when an input token attempts callback reentry", async function () {
    const fixture = await deployFixture();
    const reentrant = await (
      await ethers.getContractFactory("ReentrantERC20")
    ).deploy(18);
    await reentrant.waitForDeployment();
    const amount = ethers.parseUnits("1", 18);
    await reentrant.mint(fixture.maker.address, amount);
    await reentrant.connect(fixture.maker).approve(await fixture.orderBook.getAddress(), amount);
    await reentrant.configureCallback(
      await fixture.orderBook.getAddress(),
      fixture.orderBook.interface.encodeFunctionData("cancelOrder", [1n]),
    );

    await expect(fixture.orderBook.connect(fixture.maker).createOrder(
      orderParams(fixture, { tokenIn: await reentrant.getAddress(), amountIn: amount }),
    )).to.be.revertedWithCustomError(
      fixture.orderBook,
      "ReentrancyGuardReentrantCall",
    );
    expect(await fixture.orderBook.nextOrderId()).to.equal(1n);
    expect(await fixture.orderBook.totalEscrowed(await reentrant.getAddress())).to.equal(0n);
  });

  it("rejects malformed orders and short-credit fee-on-transfer escrow", async function () {
    const fixture = await deployFixture();
    await expect(fixture.maker.sendTransaction({
      to: await fixture.orderBook.getAddress(),
      value: 1n,
    })).to.be.revertedWithCustomError(fixture.orderBook, "UnexpectedNativeSender");
    await expect(fixture.orderBook.connect(fixture.maker).createOrder(
      orderParams(fixture, { tokenIn: fixture.wrappedNativeAddress }),
    )).to.be.revertedWithCustomError(fixture.orderBook, "InvalidSettlementMode");
    await expect(fixture.orderBook.connect(fixture.maker).createOrder(
      orderParams(fixture, {
        tokenIn: fixture.wrappedNativeAddress,
        settlementMode: 1,
      }),
      { value: fixture.amountIn - 1n },
    )).to.be.revertedWithCustomError(fixture.orderBook, "InvalidNativeValue");
    await expect(fixture.orderBook.connect(fixture.maker).createOrder(
      orderParams(fixture, { settlementMode: 2 }),
    )).to.be.revertedWithCustomError(fixture.orderBook, "InvalidSettlementMode");
    await expect(fixture.orderBook.connect(fixture.maker).createOrder(
      orderParams(fixture, { recipient: fixture.wrappedNativeAddress }),
    )).to.be.revertedWithCustomError(fixture.orderBook, "InvalidRecipient");
    await expect(fixture.orderBook.connect(fixture.maker).createOrderWithPermit(
      orderParams(fixture, {
        tokenIn: fixture.wrappedNativeAddress,
        settlementMode: 1,
      }),
      fixture.expiry,
      27,
      ethers.ZeroHash,
      ethers.ZeroHash,
      { value: fixture.amountIn },
    )).to.be.revertedWithCustomError(fixture.orderBook, "InvalidSettlementMode");
    await expect(fixture.orderBook.connect(fixture.maker).createOrder(
      orderParams(fixture, { candidateBitmap: 0 }),
    )).to.be.revertedWithCustomError(fixture.orderBook, "InvalidCandidateBitmap");
    await expect(fixture.orderBook.connect(fixture.maker).createOrder(
      orderParams(fixture, { allowPartialFills: true, minimumFillAmount: 0n }),
    )).to.be.revertedWithCustomError(
      fixture.orderBook,
      "InvalidPartialFillConfiguration",
    );
    await expect(fixture.orderBook.connect(fixture.maker).createOrder(
      orderParams(fixture, { minAmountOut: 0n }),
    )).to.be.revertedWithCustomError(fixture.orderBook, "InvalidMinimumOutput");

    const taxed = await (
      await ethers.getContractFactory("FeeOnTransferERC20")
    ).deploy("Taxed", "TAX", 100);
    await taxed.waitForDeployment();
    const amount = 1_000n;
    await taxed.mint(fixture.maker.address, amount);
    await taxed.setTaxedSender(fixture.maker.address);
    await taxed.connect(fixture.maker).approve(await fixture.orderBook.getAddress(), amount);
    await expect(fixture.orderBook.connect(fixture.maker).createOrder(
      orderParams(fixture, { tokenIn: await taxed.getAddress(), amountIn: amount }),
    )).to.be.revertedWithCustomError(fixture.orderBook, "TransferAmountMismatch");
  });
});
