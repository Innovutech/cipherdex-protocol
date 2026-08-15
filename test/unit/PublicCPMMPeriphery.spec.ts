import { expect } from "chai";
import { ethers } from "hardhat";

describe("PublicCPMM periphery", function () {
  async function deployFixture() {
    const [owner, trader] = await ethers.getSigners();
    const tokenFactory = await ethers.getContractFactory("MockERC20");
    const tokenA = await tokenFactory.deploy("Token A", "TKA", 18);
    const tokenB = await tokenFactory.deploy("Token B", "TKB", 6);
    await tokenA.waitForDeployment();
    await tokenB.waitForDeployment();

    const factory = await (await ethers.getContractFactory("PublicCPMMFactory")).deploy();
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
    const token0IsA = (await pool.token0()).toLowerCase() === (await tokenA.getAddress()).toLowerCase();
    const token0 = token0IsA ? tokenA : tokenB;
    const token1 = token0IsA ? tokenB : tokenA;
    const amount0 = token0IsA ? ethers.parseEther("100") : 100_000_000n;
    const amount1 = token0IsA ? 100_000_000n : ethers.parseEther("100");
    const input = token0IsA ? ethers.parseEther("1") : 1_000_000n;

    await tokenA.mint(owner.address, ethers.parseEther("10000"));
    await tokenB.mint(owner.address, 10_000_000_000n);
    await token0.approve(poolAddress, amount0);
    await token1.approve(poolAddress, amount1);
    await pool.addLiquidity(amount0, amount1, 1n, 0xffffffff);
    await (token0IsA ? tokenA : tokenB).mint(trader.address, input);

    const quoter = await (await ethers.getContractFactory("PublicCPMMQuoter")).deploy(
      await factory.getAddress(),
    );
    const router = await (await ethers.getContractFactory("PublicCPMMRouter")).deploy(
      await factory.getAddress(),
    );
    await quoter.waitForDeployment();
    await router.waitForDeployment();

    return { trader, token0, token1, pool, quoter, router, input };
  }

  it("quotes and routes a factory pool without retaining user tokens", async function () {
    const { trader, token0, token1, pool, quoter, router, input } = await deployFixture();
    const routerAddress = await router.getAddress();
    const outputBefore = await token1.balanceOf(trader.address);
    const quoted = await quoter.quoteExactInput(await pool.getAddress(), input, true);

    await token0.connect(trader).approve(routerAddress, input);
    await router.connect(trader).swapExactInput(
      await pool.getAddress(),
      input,
      quoted,
      true,
      0xffffffff,
    );

    expect(await token1.balanceOf(trader.address)).to.equal(outputBefore + quoted);
    expect(await token0.balanceOf(routerAddress)).to.equal(0n);
    expect(await token1.balanceOf(routerAddress)).to.equal(0n);
  });

  it("rejects pools outside its immutable factory", async function () {
    const { token0, quoter, router } = await deployFixture();
    const tokenAddress = await token0.getAddress();
    await expect(quoter.quoteExactInput(tokenAddress, 1n, true))
      .to.be.revertedWithCustomError(quoter, "InvalidPool");
    await expect(router.swapExactInput(tokenAddress, 1n, 0n, true, 0xffffffff))
      .to.be.revertedWithCustomError(router, "InvalidPool");
  });
});
