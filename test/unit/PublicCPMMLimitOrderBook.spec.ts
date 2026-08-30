import { expect } from "chai";
import { ethers } from "../../hardhat/runtime.js";
import { deployFeeVault } from "../helpers/deployFeeVault";

describe("PublicCPMMLimitOrderBook", function () {
  async function deployFixture() {
    const [owner, maker, filler, recipient, outsider] = await ethers.getSigners();
    const tokenFactory = await ethers.getContractFactory("MockERC20");
    const tokenA = await tokenFactory.deploy("Token A", "TKA", 18);
    const tokenB = await tokenFactory.deploy("Token B", "TKB", 6);
    await Promise.all([tokenA.waitForDeployment(), tokenB.waitForDeployment()]);

    const vault = await deployFeeVault();
    const factory = await (await ethers.getContractFactory("PublicCPMMFactory")).deploy(
      await vault.getAddress(),
    );
    await factory.waitForDeployment();
    await factory.createPool(
      await tokenA.getAddress(),
      await tokenB.getAddress(),
      18,
      6,
      30,
    );

    const key = await factory.poolKey(
      await tokenA.getAddress(),
      await tokenB.getAddress(),
      18,
      6,
      30,
    );
    const poolAddress = await factory.getPool(key);
    const pool = await ethers.getContractAt("PublicCPMM", poolAddress);
    const token0IsA = (await pool.token0()).toLowerCase() ===
      (await tokenA.getAddress()).toLowerCase();
    const token0 = token0IsA ? tokenA : tokenB;
    const token1 = token0IsA ? tokenB : tokenA;
    const unit0 = token0IsA ? ethers.parseEther("1") : 1_000_000n;
    const unit1 = token0IsA ? 1_000_000n : ethers.parseEther("1");
    const liquidity0 = unit0 * 1_000n;
    const liquidity1 = unit1 * 1_000n;

    await token0.mint(owner.address, liquidity0);
    await token1.mint(owner.address, liquidity1);
    await token0.approve(poolAddress, liquidity0);
    await token1.approve(poolAddress, liquidity1);
    await pool.addLiquidity(
      liquidity0,
      liquidity1,
      1n,
      0n,
      ethers.MaxUint256,
      0xffffffff,
    );

    const orderBook = await (
      await ethers.getContractFactory("PublicCPMMLimitOrderBook")
    ).deploy(await factory.getAddress());
    await orderBook.waitForDeployment();
    const orderBookAddress = await orderBook.getAddress();
    await token0.mint(maker.address, unit0 * 20n);
    await token1.mint(maker.address, unit1 * 20n);
    await token0.connect(maker).approve(orderBookAddress, ethers.MaxUint256);
    await token1.connect(maker).approve(orderBookAddress, ethers.MaxUint256);

    const latest = await ethers.provider.getBlock("latest");
    if (!latest) throw new Error("latest block unavailable");
    const expiry = BigInt(latest.timestamp + 3_600);
    const amountIn = unit0;
    const expectedAmountOut = await pool.quoteExactInput(amountIn, true);

    return {
      amountIn,
      expectedAmountOut,
      expiry,
      factory,
      filler,
      maker,
      orderBook,
      outsider,
      pool,
      poolAddress,
      recipient,
      token0,
      token1,
      unit0,
      unit1,
    };
  }

  type Fixture = Awaited<ReturnType<typeof deployFixture>>;

  async function placeOrder(
    fixture: Fixture,
    options: {
      amountIn?: bigint;
      bounty?: bigint;
      expiry?: bigint;
      minAmountOut?: bigint;
      recipient?: string;
      zeroForOne?: boolean;
    } = {},
  ): Promise<bigint> {
    const orderId = await fixture.orderBook.nextOrderId();
    await fixture.orderBook.connect(fixture.maker).createOrder(
      fixture.poolAddress,
      options.zeroForOne ?? true,
      options.amountIn ?? fixture.amountIn,
      options.minAmountOut ?? fixture.expectedAmountOut,
      options.recipient ?? fixture.recipient.address,
      options.expiry ?? fixture.expiry,
      { value: options.bounty ?? 0n },
    );
    return orderId;
  }

  it("binds only to a deployed factory", async function () {
    const [owner] = await ethers.getSigners();
    const orderBookFactory = await ethers.getContractFactory("PublicCPMMLimitOrderBook");
    await expect(orderBookFactory.deploy(ethers.ZeroAddress))
      .to.be.revertedWithCustomError(orderBookFactory, "InvalidFactory");
    await expect(orderBookFactory.deploy(owner.address))
      .to.be.revertedWithCustomError(orderBookFactory, "InvalidFactory");
  });

  it("escrows exact input and stores canonical token directions", async function () {
    const fixture = await deployFixture();
    const bounty = ethers.parseEther("0.01");
    const firstId = await placeOrder(fixture, { bounty });
    const first = await fixture.orderBook.getOrder(firstId);

    expect(first.id).to.equal(firstId);
    expect(first.maker).to.equal(fixture.maker.address);
    expect(first.recipient).to.equal(fixture.recipient.address);
    expect(first.pool).to.equal(fixture.poolAddress);
    expect(first.tokenIn).to.equal(await fixture.token0.getAddress());
    expect(first.tokenOut).to.equal(await fixture.token1.getAddress());
    expect(first.zeroForOne).to.equal(true);
    expect(first.amountIn).to.equal(fixture.amountIn);
    expect(first.minAmountOut).to.equal(fixture.expectedAmountOut);
    expect(first.executionBounty).to.equal(bounty);
    expect(first.status).to.equal(0n);
    expect(await fixture.token0.balanceOf(await fixture.orderBook.getAddress()))
      .to.equal(fixture.amountIn);
    expect(await fixture.orderBook.totalEscrowed(await fixture.token0.getAddress()))
      .to.equal(fixture.amountIn);
    expect(await ethers.provider.getBalance(await fixture.orderBook.getAddress()))
      .to.equal(bounty);

    const reverseAmount = fixture.unit1;
    const reverseMinimum = await fixture.pool.quoteExactInput(reverseAmount, false);
    const secondId = await placeOrder(fixture, {
      amountIn: reverseAmount,
      minAmountOut: reverseMinimum,
      zeroForOne: false,
    });
    const second = await fixture.orderBook.getOrder(secondId);
    expect(second.tokenIn).to.equal(await fixture.token1.getAddress());
    expect(second.tokenOut).to.equal(await fixture.token0.getAddress());
    expect(second.zeroForOne).to.equal(false);
  });

  it("preserves backing for concurrent orders after one is filled", async function () {
    const fixture = await deployFixture();
    const firstId = await placeOrder(fixture, { minAmountOut: 1n });
    const secondId = await placeOrder(fixture, { minAmountOut: 1n });
    const orderBookAddress = await fixture.orderBook.getAddress();
    const token0Address = await fixture.token0.getAddress();
    expect(await fixture.orderBook.totalEscrowed(token0Address))
      .to.equal(fixture.amountIn * 2n);

    await fixture.orderBook.connect(fixture.filler).fillOrder(firstId);

    expect(await fixture.orderBook.totalEscrowed(token0Address)).to.equal(fixture.amountIn);
    expect(await fixture.token0.balanceOf(orderBookAddress)).to.equal(fixture.amountIn);
    expect((await fixture.orderBook.getOrder(secondId)).status).to.equal(0n);
    expect((await fixture.orderBook.canFillOrder(secondId))[0]).to.equal(true);
  });

  it("rejects non-canonical pools", async function () {
    const fixture = await deployFixture();
    await expect(fixture.orderBook.connect(fixture.maker).createOrder(
      await fixture.token0.getAddress(),
      true,
      fixture.amountIn,
      fixture.expectedAmountOut,
      fixture.recipient.address,
      fixture.expiry,
    )).to.be.revertedWithCustomError(fixture.orderBook, "InvalidPool");
  });

  it("rejects invalid order parameters", async function () {
    const fixture = await deployFixture();
    await expect(fixture.orderBook.connect(fixture.maker).createOrder(
      fixture.poolAddress,
      true,
      0n,
      fixture.expectedAmountOut,
      fixture.recipient.address,
      fixture.expiry,
    )).to.be.revertedWithCustomError(fixture.orderBook, "InvalidAmount");
    await expect(fixture.orderBook.connect(fixture.maker).createOrder(
      fixture.poolAddress,
      true,
      fixture.amountIn,
      0n,
      fixture.recipient.address,
      fixture.expiry,
    )).to.be.revertedWithCustomError(fixture.orderBook, "InvalidMinimumOutput");
    await expect(fixture.orderBook.connect(fixture.maker).createOrder(
      fixture.poolAddress,
      true,
      fixture.amountIn,
      fixture.expectedAmountOut,
      ethers.ZeroAddress,
      fixture.expiry,
    )).to.be.revertedWithCustomError(fixture.orderBook, "InvalidRecipient");
    await expect(fixture.orderBook.connect(fixture.maker).createOrder(
      fixture.poolAddress,
      true,
      fixture.amountIn,
      fixture.expectedAmountOut,
      fixture.recipient.address,
      0n,
    )).to.be.revertedWithCustomError(fixture.orderBook, "InvalidExpiry");
  });

  it("rejects short-credit fee-on-transfer escrow atomically", async function () {
    const [maker, recipient] = await ethers.getSigners();
    const taxed = await (await ethers.getContractFactory("FeeOnTransferERC20")).deploy(
      "Taxed Token",
      "TAX",
      100,
    );
    const paired = await (await ethers.getContractFactory("MockERC20")).deploy(
      "Paired Token",
      "PAIR",
      18,
    );
    await Promise.all([taxed.waitForDeployment(), paired.waitForDeployment()]);
    const vault = await deployFeeVault();
    const factory = await (await ethers.getContractFactory("PublicCPMMFactory")).deploy(
      await vault.getAddress(),
    );
    await factory.waitForDeployment();
    await factory.createPool(await taxed.getAddress(), await paired.getAddress(), 18, 18, 30);
    const key = await factory.poolKey(
      await taxed.getAddress(),
      await paired.getAddress(),
      18,
      18,
      30,
    );
    const poolAddress = await factory.getPool(key);
    const pool = await ethers.getContractAt("PublicCPMM", poolAddress);
    const taxedIsToken0 = (await pool.token0()).toLowerCase() ===
      (await taxed.getAddress()).toLowerCase();
    const orderBook = await (
      await ethers.getContractFactory("PublicCPMMLimitOrderBook")
    ).deploy(await factory.getAddress());
    await orderBook.waitForDeployment();
    const orderBookAddress = await orderBook.getAddress();
    const amountIn = 1_000n;
    const bounty = ethers.parseEther("0.01");
    await taxed.mint(maker.address, amountIn);
    await taxed.setTaxedSender(maker.address);
    await taxed.connect(maker).approve(orderBookAddress, amountIn);
    const latest = await ethers.provider.getBlock("latest");
    if (!latest) throw new Error("latest block unavailable");

    await expect(orderBook.connect(maker).createOrder(
      poolAddress,
      taxedIsToken0,
      amountIn,
      1n,
      recipient.address,
      BigInt(latest.timestamp + 3_600),
      { value: bounty },
    )).to.be.revertedWithCustomError(orderBook, "TransferAmountMismatch");

    expect(await orderBook.nextOrderId()).to.equal(1n);
    expect(await orderBook.totalEscrowed(await taxed.getAddress())).to.equal(0n);
    expect(await taxed.balanceOf(orderBookAddress)).to.equal(0n);
    expect(await ethers.provider.getBalance(orderBookAddress)).to.equal(0n);
    expect(await taxed.balanceOf(maker.address)).to.equal(amountIn);
  });

  it("reports keeper readiness without reverting for unavailable orders", async function () {
    const fixture = await deployFixture();
    expect(await fixture.orderBook.canFillOrder(999n)).to.deep.equal([false, 0n]);

    const orderId = await placeOrder(fixture);
    const readiness = await fixture.orderBook.canFillOrder(orderId);
    expect(readiness[0]).to.equal(true);
    expect(readiness[1]).to.equal(fixture.expectedAmountOut);
  });

  it("allows a permissionless third party to fill a satisfiable order", async function () {
    const fixture = await deployFixture();
    const orderId = await placeOrder(fixture);
    const recipientBefore = await fixture.token1.balanceOf(fixture.recipient.address);

    await expect(fixture.orderBook.connect(fixture.filler).fillOrder(orderId))
      .to.emit(fixture.orderBook, "OrderFilled")
      .withArgs(
        orderId,
        fixture.maker.address,
        fixture.filler.address,
        fixture.recipient.address,
        fixture.amountIn,
        fixture.expectedAmountOut,
        0n,
      );

    expect(await fixture.token1.balanceOf(fixture.recipient.address))
      .to.equal(recipientBefore + fixture.expectedAmountOut);
    expect((await fixture.orderBook.getOrder(orderId)).status).to.equal(1n);
    expect(await fixture.orderBook.totalEscrowed(await fixture.token0.getAddress()))
      .to.equal(0n);
    expect(await fixture.token0.balanceOf(await fixture.orderBook.getAddress())).to.equal(0n);
    expect(await fixture.token1.balanceOf(await fixture.orderBook.getAddress())).to.equal(0n);
  });

  it("keeps an order open when the pool cannot satisfy its minimum", async function () {
    const fixture = await deployFixture();
    const bounty = ethers.parseEther("0.01");
    const impossibleMinimum = fixture.expectedAmountOut + 1n;
    const orderId = await placeOrder(fixture, {
      bounty,
      minAmountOut: impossibleMinimum,
    });
    const readiness = await fixture.orderBook.canFillOrder(orderId);
    expect(readiness[0]).to.equal(false);
    expect(readiness[1]).to.equal(fixture.expectedAmountOut);

    await expect(fixture.orderBook.connect(fixture.filler).fillOrder(orderId))
      .to.be.revertedWithCustomError(fixture.pool, "SlippageExceeded");
    expect((await fixture.orderBook.getOrder(orderId)).status).to.equal(0n);
    expect(await fixture.token0.balanceOf(await fixture.orderBook.getAddress()))
      .to.equal(fixture.amountIn);
    expect((await fixture.orderBook.getOrder(orderId)).executionBounty).to.equal(bounty);
    expect(await ethers.provider.getBalance(await fixture.orderBook.getAddress()))
      .to.equal(bounty);
    expect(await fixture.token0.allowance(
      await fixture.orderBook.getAddress(),
      fixture.poolAddress,
    )).to.equal(0n);
  });

  it("cannot fill or cancel an already filled order", async function () {
    const fixture = await deployFixture();
    const orderId = await placeOrder(fixture);
    await fixture.orderBook.connect(fixture.filler).fillOrder(orderId);

    await expect(fixture.orderBook.connect(fixture.outsider).fillOrder(orderId))
      .to.be.revertedWithCustomError(fixture.orderBook, "OrderNotOpen");
    await expect(fixture.orderBook.connect(fixture.maker).cancelOrder(orderId))
      .to.be.revertedWithCustomError(fixture.orderBook, "OrderNotOpen");
  });

  it("allows only the maker to cancel and returns token escrow", async function () {
    const fixture = await deployFixture();
    const makerBalanceBefore = await fixture.token0.balanceOf(fixture.maker.address);
    const orderId = await placeOrder(fixture);
    expect(await fixture.token0.balanceOf(fixture.maker.address))
      .to.equal(makerBalanceBefore - fixture.amountIn);

    await expect(fixture.orderBook.connect(fixture.outsider).cancelOrder(orderId))
      .to.be.revertedWithCustomError(fixture.orderBook, "NotOrderMaker");
    await fixture.orderBook.connect(fixture.maker).cancelOrder(orderId);

    expect(await fixture.token0.balanceOf(fixture.maker.address)).to.equal(makerBalanceBefore);
    expect((await fixture.orderBook.getOrder(orderId)).status).to.equal(2n);
    expect(await fixture.orderBook.totalEscrowed(await fixture.token0.getAddress()))
      .to.equal(0n);
  });

  it("returns the native execution bounty when the maker cancels", async function () {
    const fixture = await deployFixture();
    const bounty = ethers.parseEther("0.01");
    const orderId = await placeOrder(fixture, { bounty });

    await expect(() => fixture.orderBook.connect(fixture.maker).cancelOrder(orderId))
      .to.changeEtherBalances(
        ethers,
        [await fixture.orderBook.getAddress(), fixture.maker.address],
        [-bounty, bounty],
      );
    expect((await fixture.orderBook.getOrder(orderId)).executionBounty).to.equal(0n);
  });

  it("blocks expired fills while preserving maker cancellation", async function () {
    const fixture = await deployFixture();
    const latest = await ethers.provider.getBlock("latest");
    if (!latest) throw new Error("latest block unavailable");
    const expiry = BigInt(latest.timestamp + 10);
    const orderId = await placeOrder(fixture, { expiry });
    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(expiry + 1n)]);
    await ethers.provider.send("evm_mine", []);

    expect(await fixture.orderBook.canFillOrder(orderId)).to.deep.equal([false, 0n]);
    await expect(fixture.orderBook.connect(fixture.filler).fillOrder(orderId))
      .to.be.revertedWithCustomError(fixture.orderBook, "OrderExpired");
    await fixture.orderBook.connect(fixture.maker).cancelOrder(orderId);
    expect((await fixture.orderBook.getOrder(orderId)).status).to.equal(2n);
  });

  it("pays the native execution bounty to the successful filler", async function () {
    const fixture = await deployFixture();
    const bounty = ethers.parseEther("0.01");
    const orderId = await placeOrder(fixture, { bounty });

    await expect(() => fixture.orderBook.connect(fixture.filler).fillOrder(orderId))
      .to.changeEtherBalances(
        ethers,
        [await fixture.orderBook.getAddress(), fixture.filler.address],
        [-bounty, bounty],
      );
    expect((await fixture.orderBook.getOrder(orderId)).executionBounty).to.equal(0n);
  });

  it("clears the exact pool allowance after a successful fill", async function () {
    const fixture = await deployFixture();
    const orderId = await placeOrder(fixture);
    await fixture.orderBook.connect(fixture.filler).fillOrder(orderId);

    expect(await fixture.token0.allowance(
      await fixture.orderBook.getAddress(),
      fixture.poolAddress,
    )).to.equal(0n);
  });
});
