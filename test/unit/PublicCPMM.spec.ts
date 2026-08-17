import { expect } from "chai";
import { ethers } from "hardhat";
import { deployFeeVault } from "../helpers/deployFeeVault";

describe("PublicCPMM", function () {
  async function deployPool() {
    const [owner, trader] = await ethers.getSigners();
    const tokenFactory = await ethers.getContractFactory("MockERC20");
    const tokenA = await tokenFactory.deploy("Token A", "TKA", 18);
    const tokenB = await tokenFactory.deploy("Token B", "TKB", 6);
    await tokenA.waitForDeployment();
    await tokenB.waitForDeployment();

    const vault = await deployFeeVault();
    const factoryFactory = await ethers.getContractFactory("PublicCPMMFactory");
    const factory = await factoryFactory.deploy(await vault.getAddress());
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
    const reverseKey = await factory.poolKey(
      await tokenB.getAddress(),
      await tokenA.getAddress(),
      6,
      18,
      30,
    );
    expect(reverseKey).to.equal(key);
    expect(await factory.poolKey(await tokenA.getAddress(), await tokenB.getAddress(), 0, 0, 30)).to.equal(key);
    expect(await factory.PRIVACY_MODE()).to.equal(0n);
    const poolAddress = await factory.getPool(key);
    const pool = await ethers.getContractAt("PublicCPMM", poolAddress);

    await tokenA.mint(owner.address, ethers.parseEther("10000"));
    await tokenB.mint(owner.address, 10_000_000_000n);
    await tokenA.mint(trader.address, ethers.parseEther("100"));
    await tokenB.mint(trader.address, 100_000_000n);
    return { owner, trader, tokenA, tokenB, pool, vault, factory };
  }

  it("creates canonical pools and preserves the public invariant through a swap", async function () {
    const { owner, trader, tokenA, tokenB, pool, factory } = await deployPool();
    const token0IsA = (await pool.token0()).toLowerCase() === (await tokenA.getAddress()).toLowerCase();
    const amount0 = token0IsA ? ethers.parseEther("100") : 100_000_000n;
    const amount1 = token0IsA ? 100_000_000n : ethers.parseEther("100");
    await (token0IsA ? tokenA : tokenB).approve(await pool.getAddress(), amount0);
    await (token0IsA ? tokenB : tokenA).approve(await pool.getAddress(), amount1);
    await pool.addLiquidity(amount0, amount1, 1n, 0n, ethers.MaxUint256, 0xffffffff);

    const beforeProduct =
      (await tokenA.balanceOf(await pool.getAddress())) *
      (await tokenB.balanceOf(await pool.getAddress()));
    const input = token0IsA ? ethers.parseEther("1") : 1_000_000n;
    const quoted = await pool.quoteExactInput(input, true);
    await (token0IsA ? tokenA : tokenB).connect(trader).approve(await pool.getAddress(), input);
    await pool.connect(trader).swapExactInput(input, quoted, true, 0xffffffff);
    const afterProduct =
      (await tokenA.balanceOf(await pool.getAddress())) *
      (await tokenB.balanceOf(await pool.getAddress()));

    expect(await pool.initialized()).to.equal(true);
    expect(await pool.PRIVACY_MODE()).to.equal(0n);
    expect(await pool.PROTOCOL_VERSION()).to.equal(2n);
    expect(await factory.PROTOCOL_VERSION()).to.equal(2n);
    expect(await pool.shares(owner.address)).to.equal(ethers.parseEther("100"));
    expect(afterProduct).to.be.gte(beforeProduct);
  });

  it("lets the first LP establish an arbitrary normalized price", async function () {
    const { tokenA, tokenB, pool } = await deployPool();
    const token0IsA = (await pool.token0()).toLowerCase() === (await tokenA.getAddress()).toLowerCase();
    const token0 = token0IsA ? tokenA : tokenB;
    const token1 = token0IsA ? tokenB : tokenA;
    const amount0 = token0IsA ? ethers.parseEther("1") : 3_000_000_000n;
    const amount1 = token0IsA ? 3_000_000_000n : ethers.parseEther("1");

    await token0.approve(await pool.getAddress(), amount0);
    await token1.approve(await pool.getAddress(), amount1);
    const expectedPriceX18 = token0IsA
      ? 3_000n * 10n ** 18n
      : 10n ** 18n / 3_000n;
    await pool.addLiquidity(
      amount0,
      amount1,
      1n,
      expectedPriceX18,
      expectedPriceX18,
      0xffffffff,
    );

    expect(await pool.initialized()).to.equal(true);
    expect(await pool.totalShares()).to.equal(ethers.parseEther("1"));
    expect(await token0.balanceOf(await pool.getAddress())).to.equal(amount0);
    expect(await token1.balanceOf(await pool.getAddress())).to.equal(amount1);
  });

  it("rejects liquidity when the resulting normalized price leaves caller bounds", async function () {
    const { tokenA, tokenB, pool } = await deployPool();
    const token0IsA = (await pool.token0()).toLowerCase() === (await tokenA.getAddress()).toLowerCase();
    const token0 = token0IsA ? tokenA : tokenB;
    const token1 = token0IsA ? tokenB : tokenA;
    const amount0 = token0IsA ? ethers.parseEther("10") : 10_000_000n;
    const amount1 = token0IsA ? 10_000_000n : ethers.parseEther("10");
    await token0.approve(await pool.getAddress(), amount0);
    await token1.approve(await pool.getAddress(), amount1);

    await expect(
      pool.addLiquidity(
        amount0,
        amount1,
        1n,
        2n * 10n ** 18n,
        3n * 10n ** 18n,
        0xffffffff,
      ),
    ).to.be.revertedWithCustomError(pool, "SlippageExceeded");
    expect(await pool.initialized()).to.equal(false);
    expect(await token0.balanceOf(await pool.getAddress())).to.equal(0n);
    expect(await token1.balanceOf(await pool.getAddress())).to.equal(0n);
  });

  it("sweeps pre-initialization donations to the immutable fee vault", async function () {
    const { tokenA, tokenB, pool, vault } = await deployPool();
    const token0IsA = (await pool.token0()).toLowerCase() === (await tokenA.getAddress()).toLowerCase();
    const token0 = token0IsA ? tokenA : tokenB;
    const token1 = token0IsA ? tokenB : tokenA;
    const amount0 = token0IsA ? ethers.parseEther("10") : 10_000_000n;
    const amount1 = token0IsA ? 10_000_000n : ethers.parseEther("10");

    await token0.transfer(await pool.getAddress(), 1n);
    await token0.approve(await pool.getAddress(), amount0);
    await token1.approve(await pool.getAddress(), amount1);
    await pool.addLiquidity(amount0, amount1, 1n, 0n, ethers.MaxUint256, 0xffffffff);

    expect(await token0.balanceOf(await vault.getAddress())).to.equal(1n);
    expect(await token0.balanceOf(await pool.getAddress())).to.equal(amount0);
    expect(await token1.balanceOf(await pool.getAddress())).to.equal(amount1);
  });

  it("never treats donated balances as tradable reserves before initialization", async function () {
    const { trader, tokenA, tokenB, pool } = await deployPool();
    const poolAddress = await pool.getAddress();
    const token0IsA = (await pool.token0()).toLowerCase() ===
      (await tokenA.getAddress()).toLowerCase();
    const token0 = token0IsA ? tokenA : tokenB;
    const token1 = token0IsA ? tokenB : tokenA;
    const donated0 = token0IsA ? ethers.parseEther("2") : 2_000_000n;
    const donated1 = token0IsA ? 2_000_000n : ethers.parseEther("2");
    const input = token0IsA ? ethers.parseEther("1") : 1_000_000n;

    await token0.transfer(poolAddress, donated0);
    await token1.transfer(poolAddress, donated1);
    await token0.connect(trader).approve(poolAddress, input);

    await expect(pool.quoteExactInput(input, true))
      .to.be.revertedWithCustomError(pool, "PoolNotInitialized");
    await expect(pool.connect(trader).swapExactInput(input, 0n, true, 0xffffffff))
      .to.be.revertedWithCustomError(pool, "PoolNotInitialized");

    expect(await pool.initialized()).to.equal(false);
    expect(await token0.balanceOf(poolAddress)).to.equal(donated0);
    expect(await token1.balanceOf(poolAddress)).to.equal(donated1);
  });

  it("keeps a fully exited pool non-tradable even after later donations", async function () {
    const { owner, trader, tokenA, tokenB, pool } = await deployPool();
    const poolAddress = await pool.getAddress();
    const token0IsA = (await pool.token0()).toLowerCase() ===
      (await tokenA.getAddress()).toLowerCase();
    const token0 = token0IsA ? tokenA : tokenB;
    const token1 = token0IsA ? tokenB : tokenA;
    const amount0 = token0IsA ? ethers.parseEther("100") : 100_000_000n;
    const amount1 = token0IsA ? 100_000_000n : ethers.parseEther("100");
    const input = token0IsA ? ethers.parseEther("1") : 1_000_000n;

    await token0.approve(poolAddress, amount0);
    await token1.approve(poolAddress, amount1);
    await pool.addLiquidity(amount0, amount1, 1n, 0n, ethers.MaxUint256, 0xffffffff);
    const allShares = await pool.shares(owner.address);
    await pool.removeLiquidity(allShares, amount0, amount1, 0xffffffff);

    expect(await pool.initialized()).to.equal(false);
    expect(await pool.totalShares()).to.equal(0n);
    await token0.transfer(poolAddress, 1n);
    await token1.transfer(poolAddress, 1n);
    await token0.connect(trader).approve(poolAddress, input);

    await expect(pool.quoteExactInput(input, true))
      .to.be.revertedWithCustomError(pool, "PoolNotInitialized");
    await expect(pool.connect(trader).swapExactInput(input, 0n, true, 0xffffffff))
      .to.be.revertedWithCustomError(pool, "PoolNotInitialized");
    expect(await token0.balanceOf(poolAddress)).to.equal(1n);
    expect(await token1.balanceOf(poolAddress)).to.equal(1n);
  });

  it("uses liquidity amounts as maxima and enforces permanent locks", async function () {
    const { owner, tokenA, tokenB, pool } = await deployPool();
    const token0IsA = (await pool.token0()).toLowerCase() === (await tokenA.getAddress()).toLowerCase();
    const token0 = token0IsA ? tokenA : tokenB;
    const token1 = token0IsA ? tokenB : tokenA;
    const amount0 = token0IsA ? ethers.parseEther("100") : 100_000_000n;
    const amount1 = token0IsA ? 100_000_000n : ethers.parseEther("100");
    await token0.approve(await pool.getAddress(), amount0);
    await token1.approve(await pool.getAddress(), amount1);
    await pool.addLiquidity(amount0, amount1, 1n, 0n, ethers.MaxUint256, 0xffffffff);

    await token0.approve(await pool.getAddress(), token0IsA ? ethers.parseEther("1") : 1_000_001n);
    await token1.approve(await pool.getAddress(), token0IsA ? 1_000_001n : ethers.parseEther("1"));
    const balance0Before = await token0.balanceOf(owner.address);
    const balance1Before = await token1.balanceOf(owner.address);
    await pool.addLiquidity(
      token0IsA ? ethers.parseEther("1") : 1_000_001n,
      token0IsA ? 1_000_001n : ethers.parseEther("1"),
      1n,
      0n,
      ethers.MaxUint256,
      0xffffffff,
    );
    expect(await token0.balanceOf(owner.address)).to.equal(
      balance0Before - (token0IsA ? ethers.parseEther("1") : 1_000_000n),
    );
    expect(await token1.balanceOf(owner.address)).to.equal(
      balance1Before - (token0IsA ? 1_000_000n : ethers.parseEther("1")),
    );

    await expect(
      pool.lockShares(ethers.parseEther("1"), 1, true, 0xffffffff),
    ).to.be.revertedWithCustomError(pool, "InvalidLock");

    const tx = await pool.lockShares(ethers.parseEther("10"), 0, true, 0xffffffff);
    const receipt = await tx.wait();
    const parsed = receipt?.logs
      .map((log) => {
        try {
          return pool.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((log) => log?.name === "LiquidityLocked");
    const lockId = parsed?.args.lockId as string;
    expect(lockId).to.be.a("string");
    await expect(pool.unlockShares(lockId)).to.be.revertedWithCustomError(pool, "InvalidLock");
    expect(await pool.shares(owner.address)).to.equal(ethers.parseEther("91"));
  });

  it("accepts bounded rounded deposits without requiring an exact reserve multiple", async function () {
    const [owner] = await ethers.getSigners();
    const tokenFactory = await ethers.getContractFactory("MockERC20");
    const token0 = await tokenFactory.deploy("Token 0", "TK0", 18);
    const token1 = await tokenFactory.deploy("Token 1", "TK1", 18);
    await token0.waitForDeployment();
    await token1.waitForDeployment();

    const poolFactory = await ethers.getContractFactory("PublicCPMM");
    const vault = await deployFeeVault();
    const pool = await poolFactory.deploy(
      await token0.getAddress(),
      await token1.getAddress(),
      18,
      18,
      30,
      await vault.getAddress(),
    );
    await pool.waitForDeployment();

    await token0.mint(owner.address, ethers.parseEther("20"));
    await token1.mint(owner.address, ethers.parseEther("20"));
    await token0.approve(await pool.getAddress(), ethers.MaxUint256);
    await token1.approve(await pool.getAddress(), ethers.MaxUint256);
    await pool.addLiquidity(
      ethers.parseEther("10"),
      ethers.parseEther("10"),
      1n,
      0n,
      ethers.MaxUint256,
      0xffffffff,
    );

    // The extra wei makes the raw reserve ratio 11:10. The 2:1 deposit would
    // produce the same floored share value under the old implementation, but
    // is not actually proportional and must not donate the excess token.
    await token0.transfer(await pool.getAddress(), 1n);
    const owner0Before = await token0.balanceOf(owner.address);
    const owner1Before = await token1.balanceOf(owner.address);
    await pool.addLiquidity(2n, 1n, 1n, 0n, ethers.MaxUint256, 0xffffffff);

    expect(await token0.balanceOf(owner.address)).to.equal(owner0Before - 2n);
    expect(await token1.balanceOf(owner.address)).to.equal(owner1Before - 1n);
    expect(await pool.shares(owner.address)).to.equal(ethers.parseEther("10") + 1n);
  });
});
