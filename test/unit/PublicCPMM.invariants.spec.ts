import { expect } from "chai";
import { ethers } from "../../hardhat/runtime.js";
import { deployFeeVault } from "../helpers/deployFeeVault";
import { deployPublicLpTokenFactory } from "../helpers/deployPublicLpTokenFactory";
import {
  createPublicPool,
  deployPublicFactory,
} from "../helpers/deployPublicFactory";

const MAX_DEADLINE = 0xffffffff;
const MAX_UINT256 = ethers.MaxUint256;

function nextSeed(seed: bigint): bigint {
  return (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
}

describe("PublicCPMM stateful invariants", function () {
  it("preserves balances and the constant-product invariant across both swap directions", async function () {
    const [owner, trader] = await ethers.getSigners();
    const tokenFactory = await ethers.getContractFactory("MockERC20");
    const tokenA = await tokenFactory.deploy("Token A", "TKA", 18);
    const tokenB = await tokenFactory.deploy("Token B", "TKB", 6);
    await tokenA.waitForDeployment();
    await tokenB.waitForDeployment();

    const vault = await deployFeeVault();
    const lpTokenFactory = await deployPublicLpTokenFactory();
    const pool = await (
      await ethers.getContractFactory("PublicCPMM")
    ).deploy(
      await tokenA.getAddress(),
      await tokenB.getAddress(),
      18,
      6,
      30,
      await vault.getAddress(),
      await lpTokenFactory.getAddress(),
    );
    await pool.waitForDeployment();

    const token0IsA = (await pool.token0()).toLowerCase() ===
      (await tokenA.getAddress()).toLowerCase();
    const token0 = token0IsA ? tokenA : tokenB;
    const token1 = token0IsA ? tokenB : tokenA;

    // Keep the normalized reserves equal while leaving enough headroom for a
    // deterministic sequence of trades in either direction.
    const normalizedLiquidity = 1_000_000n;
    const amount0 = token0IsA
      ? normalizedLiquidity * 10n ** 18n
      : normalizedLiquidity * 10n ** 6n;
    const amount1 = token0IsA
      ? normalizedLiquidity * 10n ** 6n
      : normalizedLiquidity * 10n ** 18n;

    await token0.mint(owner.address, amount0);
    await token1.mint(owner.address, amount1);
    await token0.mint(trader.address, amount0);
    await token1.mint(trader.address, amount1);
    await token0.approve(await pool.getAddress(), amount0);
    await token1.approve(await pool.getAddress(), amount1);
    await token0.connect(trader).approve(await pool.getAddress(), MAX_UINT256);
    await token1.connect(trader).approve(await pool.getAddress(), MAX_UINT256);
    await pool.addLiquidity(amount0, amount1, 1n, 0n, MAX_UINT256, MAX_DEADLINE);

    let seed = 0xdecafbadn;
    for (let index = 0; index < 64; index += 1) {
      seed = nextSeed(seed);
      const zeroForOne = (seed & 1n) === 0n;
      const inputToken = zeroForOne ? token0 : token1;
      const outputToken = zeroForOne ? token1 : token0;
      const [reserve0Before, reserve1Before] = await pool.effectiveReserves();
      const reserveIn = zeroForOne ? reserve0Before : reserve1Before;
      const protocolFeeBefore = zeroForOne
        ? await pool.protocolFees0()
        : await pool.protocolFees1();
      const inputUpperBound = reserveIn / 1_000n;
      seed = nextSeed(seed);
      const amountIn = (seed % inputUpperBound) + 1n;
      const quoted = await pool.quoteExactInput(amountIn, zeroForOne);
      const traderInputBefore = await inputToken.balanceOf(trader.address);
      const traderOutputBefore = await outputToken.balanceOf(trader.address);

      await pool.connect(trader).swapExactInput(
        amountIn,
        quoted,
        zeroForOne,
        MAX_DEADLINE,
      );

      const [reserve0After, reserve1After] = await pool.effectiveReserves();
      const protocolFeeAfter = zeroForOne
        ? await pool.protocolFees0()
        : await pool.protocolFees1();
      const traderInputAfter = await inputToken.balanceOf(trader.address);
      const traderOutputAfter = await outputToken.balanceOf(trader.address);

      expect(traderInputAfter).to.equal(traderInputBefore - amountIn);
      expect(traderOutputAfter).to.equal(traderOutputBefore + quoted);
      expect(zeroForOne ? reserve0After : reserve1After).to.equal(
        reserveIn + amountIn - (protocolFeeAfter - protocolFeeBefore),
      );
      expect(zeroForOne ? reserve1After : reserve0After).to.equal(
        (zeroForOne ? reserve1Before : reserve0Before) - quoted,
      );
      expect(reserve0After * reserve1After).to.be.gte(
        reserve0Before * reserve1Before,
        `constant-product invariant failed at swap ${index}`,
      );
    }
  });

  it("keeps reserves, fees, and donated surplus disjoint across state transitions", async function () {
    const [owner, trader] = await ethers.getSigners();
    const tokenFactory = await ethers.getContractFactory("MockERC20");
    const tokenA = await tokenFactory.deploy("Token A", "TKA", 18);
    const tokenB = await tokenFactory.deploy("Token B", "TKB", 6);
    await Promise.all([tokenA.waitForDeployment(), tokenB.waitForDeployment()]);
    const { vault, factory } = await deployPublicFactory();
    const pool = await createPublicPool(
      factory,
      await tokenA.getAddress(),
      await tokenB.getAddress(),
      18,
      6,
      30,
    );
    const token0IsA = (await pool.token0()).toLowerCase() ===
      (await tokenA.getAddress()).toLowerCase();
    const token0 = token0IsA ? tokenA : tokenB;
    const token1 = token0IsA ? tokenB : tokenA;
    const initial0 = token0IsA ? ethers.parseEther("1000") : 1_000_000_000n;
    const initial1 = token0IsA ? 1_000_000_000n : ethers.parseEther("1000");

    for (const [token, amount] of [[token0, initial0], [token1, initial1]] as const) {
      await token.mint(owner.address, amount);
      await token.mint(trader.address, amount);
      await token.connect(owner).approve(await pool.getAddress(), amount);
      await token.connect(trader).approve(await pool.getAddress(), MAX_UINT256);
    }
    await pool.addLiquidity(initial0, initial1, 1n, 0n, MAX_UINT256, MAX_DEADLINE);

    const probe0 = initial0 / 1_000_000n;
    const probe1 = initial1 / 1_000_000n;
    let donated0 = 0n;
    let donated1 = 0n;
    for (let index = 0; index < 12; index += 1) {
      const zeroForOne = index % 2 === 0;
      const donatedToken = zeroForOne ? token0 : token1;
      const donation = BigInt(index + 1);
      const quotesBefore = [
        await pool.quoteExactInput(probe0, true),
        await pool.quoteExactInput(probe1, false),
      ];
      await donatedToken.connect(trader).transfer(await pool.getAddress(), donation);
      if (zeroForOne) donated0 += donation;
      else donated1 += donation;

      expect(await pool.surplusBalances()).to.deep.equal([donated0, donated1]);
      expect(await pool.quoteExactInput(probe0, true)).to.equal(quotesBefore[0]);
      expect(await pool.quoteExactInput(probe1, false)).to.equal(quotesBefore[1]);

      const input = (zeroForOne ? probe0 : probe1) + BigInt(index);
      await pool.connect(trader).swapExactInput(
        input,
        await pool.quoteExactInput(input, zeroForOne),
        zeroForOne,
        MAX_DEADLINE,
      );
      const [reserve0, reserve1] = await pool.effectiveReserves();
      expect(await token0.balanceOf(await pool.getAddress())).to.equal(
        reserve0 + await pool.protocolFees0() + donated0,
      );
      expect(await token1.balanceOf(await pool.getAddress())).to.equal(
        reserve1 + await pool.protocolFees1() + donated1,
      );
    }

    await pool.connect(trader).sweepSurplus(true, true);
    expect(await pool.surplusBalances()).to.deep.equal([0n, 0n]);
    expect(await token0.balanceOf(await vault.getAddress())).to.equal(donated0);
    expect(await token1.balanceOf(await vault.getAddress())).to.equal(donated1);
  });
});
