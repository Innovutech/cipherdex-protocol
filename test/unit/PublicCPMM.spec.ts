import { expect } from "chai";
import { ethers } from "hardhat";

describe("PublicCPMM", function () {
  async function deployPool() {
    const [owner, trader] = await ethers.getSigners();
    const tokenFactory = await ethers.getContractFactory("MockERC20");
    const tokenA = await tokenFactory.deploy("Token A", "TKA", 18);
    const tokenB = await tokenFactory.deploy("Token B", "TKB", 6);
    await tokenA.waitForDeployment();
    await tokenB.waitForDeployment();

    const factoryFactory = await ethers.getContractFactory("PublicCPMMFactory");
    const factory = await factoryFactory.deploy();
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
    const poolAddress = await factory.getPool(key);
    const pool = await ethers.getContractAt("PublicCPMM", poolAddress);

    await tokenA.mint(owner.address, ethers.parseEther("10000"));
    await tokenB.mint(owner.address, 10_000_000_000n);
    await tokenA.mint(trader.address, ethers.parseEther("100"));
    await tokenB.mint(trader.address, 100_000_000n);
    return { owner, trader, tokenA, tokenB, pool };
  }

  it("creates canonical pools and preserves the public invariant through a swap", async function () {
    const { owner, trader, tokenA, tokenB, pool } = await deployPool();
    const token0IsA = (await pool.token0()).toLowerCase() === (await tokenA.getAddress()).toLowerCase();
    const amount0 = token0IsA ? ethers.parseEther("100") : 100_000_000n;
    const amount1 = token0IsA ? 100_000_000n : ethers.parseEther("100");
    await (token0IsA ? tokenA : tokenB).approve(await pool.getAddress(), amount0);
    await (token0IsA ? tokenB : tokenA).approve(await pool.getAddress(), amount1);
    await pool.addLiquidity(amount0, amount1, 1n, 0xffffffff);

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
    expect(await pool.shares(owner.address)).to.equal(ethers.parseEther("100"));
    expect(afterProduct).to.be.gte(beforeProduct);
  });

  it("requires exact proportional public deposits and enforces permanent locks", async function () {
    const { owner, tokenA, tokenB, pool } = await deployPool();
    const token0IsA = (await pool.token0()).toLowerCase() === (await tokenA.getAddress()).toLowerCase();
    const token0 = token0IsA ? tokenA : tokenB;
    const token1 = token0IsA ? tokenB : tokenA;
    const amount0 = token0IsA ? ethers.parseEther("100") : 100_000_000n;
    const amount1 = token0IsA ? 100_000_000n : ethers.parseEther("100");
    await token0.approve(await pool.getAddress(), amount0);
    await token1.approve(await pool.getAddress(), amount1);
    await pool.addLiquidity(amount0, amount1, 1n, 0xffffffff);

    await token0.approve(await pool.getAddress(), token0IsA ? ethers.parseEther("1") : 1_000_001n);
    await token1.approve(await pool.getAddress(), token0IsA ? 1_000_001n : ethers.parseEther("1"));
    await expect(
      pool.addLiquidity(token0IsA ? ethers.parseEther("1") : 1_000_001n, token0IsA ? 1_000_001n : ethers.parseEther("1"), 1n, 0xffffffff),
    ).to.be.revertedWithCustomError(pool, "InvalidLiquidityRatio");

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
    expect(await pool.shares(owner.address)).to.equal(ethers.parseEther("90"));
  });
});
