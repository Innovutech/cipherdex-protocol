import { expect } from "chai";
import { ethers } from "../../hardhat/runtime.js";
import { deployFeeVault } from "../helpers/deployFeeVault";

describe("PublicBestExecutionRouter", function () {
  async function deployFixture() {
    const [liquidityProvider, trader, recipient] = await ethers.getSigners();
    const tokenFactory = await ethers.getContractFactory("MockERC20");
    const tokenA = await tokenFactory.deploy("Token A", "TKA", 18);
    const tokenB = await tokenFactory.deploy("Token B", "TKB", 6);
    await Promise.all([tokenA.waitForDeployment(), tokenB.waitForDeployment()]);

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
    const router = await (
      await ethers.getContractFactory("PublicBestExecutionRouter")
    ).deploy(await factory.getAddress());
    await router.waitForDeployment();

    return {
      factory,
      highPool,
      lowPool,
      recipient,
      router,
      standardPool,
      tokenA,
      tokenB,
      trader,
    };
  }

  it("selects the best canonical fee tier in both token directions", async function () {
    const fixture = await deployFixture();
    const amountA = ethers.parseUnits("1", 18);
    const forward = await fixture.router.quoteBestExactInput(
      await fixture.tokenA.getAddress(),
      await fixture.tokenB.getAddress(),
      amountA,
      7,
    );
    expect(forward.selectedPool).to.equal(await fixture.highPool.getAddress());
    expect(forward.selectedFeeBps).to.equal(100n);

    const amountB = ethers.parseUnits("1", 6);
    const reverse = await fixture.router.quoteBestExactInput(
      await fixture.tokenB.getAddress(),
      await fixture.tokenA.getAddress(),
      amountB,
      7,
    );
    expect(reverse.selectedPool).to.equal(await fixture.lowPool.getAddress());
    expect(reverse.selectedFeeBps).to.equal(5n);
  });

  it("honors the allowed candidate bitmap", async function () {
    const fixture = await deployFixture();
    const quote = await fixture.router.quoteBestExactInput(
      await fixture.tokenA.getAddress(),
      await fixture.tokenB.getAddress(),
      ethers.parseUnits("1", 18),
      2,
    );
    expect(quote.selectedPool).to.equal(await fixture.standardPool.getAddress());
    expect(quote.selectedFeeBps).to.equal(30n);
  });

  it("routes a swap atomically and leaves no custody or allowance", async function () {
    const fixture = await deployFixture();
    const amountIn = ethers.parseUnits("1", 18);
    const quote = await fixture.router.quoteBestExactInput(
      await fixture.tokenA.getAddress(),
      await fixture.tokenB.getAddress(),
      amountIn,
      7,
    );
    const routerAddress = await fixture.router.getAddress();
    await fixture.tokenA.mint(fixture.trader.address, amountIn);
    await fixture.tokenA.connect(fixture.trader).approve(routerAddress, amountIn);

    await expect(fixture.router.connect(fixture.trader).swapBestExactInput(
      await fixture.tokenA.getAddress(),
      await fixture.tokenB.getAddress(),
      amountIn,
      quote.amountOut,
      7,
      fixture.recipient.address,
      0xffffffff,
    )).to.emit(fixture.router, "BestSwapRouted");

    expect(await fixture.tokenB.balanceOf(fixture.recipient.address)).to.equal(quote.amountOut);
    expect(await fixture.tokenA.balanceOf(routerAddress)).to.equal(0n);
    expect(await fixture.tokenB.balanceOf(routerAddress)).to.equal(0n);
    expect(await fixture.tokenA.allowance(routerAddress, quote.selectedPool)).to.equal(0n);
  });

  it("fails closed for invalid requests and unavailable routes", async function () {
    const fixture = await deployFixture();
    const tokenA = await fixture.tokenA.getAddress();
    const tokenB = await fixture.tokenB.getAddress();
    await expect(fixture.router.quoteBestExactInput(tokenA, tokenB, 1n, 0))
      .to.be.revertedWithCustomError(fixture.router, "InvalidCandidateBitmap");
    await expect(fixture.router.quoteBestExactInput(tokenA, tokenB, 1n, 8))
      .to.be.revertedWithCustomError(fixture.router, "InvalidCandidateBitmap");
    await expect(fixture.router.quoteBestExactInput(tokenA, tokenA, 1n, 7))
      .to.be.revertedWithCustomError(fixture.router, "InvalidTokenPair");
    await expect(fixture.router.quoteBestExactInput(tokenA, tokenB, 0n, 7))
      .to.be.revertedWithCustomError(fixture.router, "InvalidAmount");

    const unrelated = await (
      await ethers.getContractFactory("MockERC20")
    ).deploy("Unrelated", "NOPE", 18);
    await unrelated.waitForDeployment();
    await expect(fixture.router.quoteBestExactInput(
      tokenA,
      await unrelated.getAddress(),
      1n,
      7,
    )).to.be.revertedWithCustomError(fixture.router, "NoRoute");
  });

  it("does not execute below the caller minimum", async function () {
    const fixture = await deployFixture();
    const amountIn = ethers.parseUnits("1", 18);
    const quote = await fixture.router.quoteBestExactInput(
      await fixture.tokenA.getAddress(),
      await fixture.tokenB.getAddress(),
      amountIn,
      7,
    );
    await fixture.tokenA.mint(fixture.trader.address, amountIn);
    await fixture.tokenA.connect(fixture.trader).approve(
      await fixture.router.getAddress(),
      amountIn,
    );
    await expect(fixture.router.connect(fixture.trader).swapBestExactInput(
      await fixture.tokenA.getAddress(),
      await fixture.tokenB.getAddress(),
      amountIn,
      quote.amountOut + 1n,
      7,
      fixture.recipient.address,
      0xffffffff,
    )).to.be.revertedWithCustomError(fixture.router, "SlippageExceeded");
    expect(await fixture.tokenA.balanceOf(fixture.trader.address)).to.equal(amountIn);
  });
});
