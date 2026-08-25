import { expect } from "chai";
import { ethers } from "../../hardhat/runtime.js";
import { deployFeeVault } from "../helpers/deployFeeVault";
import { deployPublicLpTokenFactory } from "../helpers/deployPublicLpTokenFactory";

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
});
