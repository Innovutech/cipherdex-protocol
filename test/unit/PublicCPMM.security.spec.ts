import { expect } from "chai";
import { ethers } from "hardhat";
import { deployFeeVault } from "../helpers/deployFeeVault";

const MAX_DEADLINE = 0xffffffff;

type ReentrantToken = {
  getAddress(): Promise<string>;
  waitForDeployment(): Promise<unknown>;
  mint(to: string, amount: bigint): Promise<unknown>;
  approve(spender: string, amount: bigint): Promise<unknown>;
  configureCallback(target: string, data: string): Promise<unknown>;
  balanceOf(account: string): Promise<bigint>;
};

function referenceQuote(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeBps: bigint,
): bigint {
  if (amountIn === 0n || reserveIn === 0n || reserveOut === 0n) {
    throw new Error("insufficient liquidity");
  }
  const netIn = (amountIn * (10_000n - feeBps)) / 10_000n;
  if (netIn === 0n) throw new Error("invalid amount");
  const newReserveIn = reserveIn + netIn;
  const retained = (reserveIn * reserveOut + newReserveIn - 1n) / newReserveIn;
  if (retained >= reserveOut) throw new Error("insufficient liquidity");
  return reserveOut - retained;
}

async function deployPublicPool() {
  const [owner, trader] = await ethers.getSigners();
  const tokenFactory = await ethers.getContractFactory("MockERC20");
  const token0 = await tokenFactory.deploy("Token 0", "TK0", 18);
  const token1 = await tokenFactory.deploy("Token 1", "TK1", 18);
  await token0.waitForDeployment();
  await token1.waitForDeployment();

  const vault = await deployFeeVault();
  const poolFactory = await ethers.getContractFactory("PublicCPMM");
  const pool = await poolFactory.deploy(
    await token0.getAddress(),
    await token1.getAddress(),
    18,
    18,
    30,
    await vault.getAddress(),
  );
  await pool.waitForDeployment();

  const amount0 = 1_000_000_000n;
  const amount1 = 1_000_000_000n;
  await token0.mint(owner.address, amount0 * 2n);
  await token1.mint(owner.address, amount1 * 2n);
  await token0.mint(trader.address, amount0);
  await token1.mint(trader.address, amount1);
  await token0.approve(await pool.getAddress(), amount0);
  await token1.approve(await pool.getAddress(), amount1);
  await pool.addLiquidity(amount0, amount1, 1n, 0n, ethers.MaxUint256, MAX_DEADLINE);
  return { owner, trader, token0, token1, pool, amount0, amount1 };
}

describe("PublicCPMM adversarial and differential coverage", function () {
  it("matches the reference quote across both directions and varied inputs", async function () {
    const { pool, amount0, amount1 } = await deployPublicPool();
    let seed = 19n;
    for (let index = 0; index < 64; index += 1) {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
      const input0 = (seed % (amount0 / 2n)) + 1n;
      expect(await pool.quoteExactInput(input0, true)).to.equal(
        referenceQuote(input0, amount0, amount1, 30n),
      );

      seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
      const input1 = (seed % (amount1 / 2n)) + 1n;
      expect(await pool.quoteExactInput(input1, false)).to.equal(
        referenceQuote(input1, amount1, amount0, 30n),
      );
    }
  });

  it("rejects expired swaps before token callbacks or state changes", async function () {
    const { trader, token0, pool } = await deployPublicPool();
    await token0.connect(trader).approve(await pool.getAddress(), 1n);
    await expect(
      pool.connect(trader).swapExactInput(1n, 0n, true, 0),
    ).to.be.revertedWithCustomError(pool, "DeadlineExpired");
  });

  it("reverts failed slippage without changing public balances", async function () {
    const { trader, token0, token1, pool } = await deployPublicPool();
    const token0IsPoolToken0 = (await pool.token0()).toLowerCase() ===
      (await token0.getAddress()).toLowerCase();
    const inputToken = token0IsPoolToken0 ? token0 : token1;
    const outputToken = token0IsPoolToken0 ? token1 : token0;
    const amountIn = 1_000n;
    const quoted = await pool.quoteExactInput(amountIn, true);
    await inputToken.connect(trader).approve(await pool.getAddress(), amountIn);

    const beforeInput = await inputToken.balanceOf(trader.address);
    const beforeOutput = await outputToken.balanceOf(trader.address);
    await expect(
      pool.connect(trader).swapExactInput(amountIn, quoted + 1n, true, MAX_DEADLINE),
    ).to.be.revertedWithCustomError(pool, "SlippageExceeded");
    expect(await inputToken.balanceOf(trader.address)).to.equal(beforeInput);
    expect(await outputToken.balanceOf(trader.address)).to.equal(beforeOutput);
  });

  it("rejects zero and effectively zero-input quotes", async function () {
    const { pool } = await deployPublicPool();
    await expect(pool.quoteExactInput(0n, true))
      .to.be.revertedWithCustomError(pool, "InsufficientLiquidity");
    await expect(pool.quoteExactInput(100n, true))
      .to.not.be.reverted;
  });

  it("rejects maximum-width inputs instead of wrapping reserve arithmetic", async function () {
    const [owner] = await ethers.getSigners();
    const tokenFactory = await ethers.getContractFactory("MockERC20");
    const token0 = await tokenFactory.deploy("Wide Token 0", "W0", 18);
    const token1 = await tokenFactory.deploy("Wide Token 1", "W1", 18);
    await token0.waitForDeployment();
    await token1.waitForDeployment();
    const vault = await deployFeeVault();
    const pool = await (await ethers.getContractFactory("PublicCPMM")).deploy(
      await token0.getAddress(),
      await token1.getAddress(),
      18,
      18,
      30,
      await vault.getAddress(),
    );
    await pool.waitForDeployment();
    await token0.mint(owner.address, ethers.MaxUint256);
    await token1.mint(owner.address, ethers.MaxUint256);
    await token0.approve(await pool.getAddress(), ethers.MaxUint256);
    await token1.approve(await pool.getAddress(), ethers.MaxUint256);
    await pool.addLiquidity(
      ethers.MaxUint256,
      ethers.MaxUint256,
      1n,
      0n,
      ethers.MaxUint256,
      MAX_DEADLINE,
    );
    await expect(pool.quoteExactInput(10_000n, true)).to.be.reverted;
  });

  it("rejects a public fee above the protocol cap", async function () {
    const tokenFactory = await ethers.getContractFactory("MockERC20");
    const token0 = await tokenFactory.deploy("Fee Token 0", "F0", 18);
    const token1 = await tokenFactory.deploy("Fee Token 1", "F1", 18);
    await token0.waitForDeployment();
    await token1.waitForDeployment();
    const vault = await deployFeeVault();
    const poolFactory = await ethers.getContractFactory("PublicCPMM");
    await expect(
      poolFactory.deploy(
        await token0.getAddress(),
        await token1.getAddress(),
        18,
        18,
        1_001,
        await vault.getAddress(),
      ),
    ).to.be.revertedWithCustomError(poolFactory, "InvalidFee");
  });

  it("rejects a reentrant token callback during swap", async function () {
    const [owner] = await ethers.getSigners();
    const tokenFactory = await ethers.getContractFactory("ReentrantERC20");
    const reentrant = await tokenFactory.deploy(18) as unknown as ReentrantToken;
    const normal = await (await ethers.getContractFactory("MockERC20")).deploy(
      "Normal Token",
      "NORM",
      18,
    );
    await reentrant.waitForDeployment();
    await normal.waitForDeployment();
    const vault = await deployFeeVault();
    const pool = await (await ethers.getContractFactory("PublicCPMM")).deploy(
      await reentrant.getAddress(),
      await normal.getAddress(),
      18,
      18,
      30,
      await vault.getAddress(),
    );
    await pool.waitForDeployment();

    await reentrant.mint(owner.address, 2_000n);
    await normal.mint(owner.address, 2_000n);
    await reentrant.approve(await pool.getAddress(), 1_000n);
    await normal.approve(await pool.getAddress(), 1_000n);
    await pool.addLiquidity(1_000n, 1_000n, 1n, 0n, ethers.MaxUint256, MAX_DEADLINE);

    const reentrantIsToken0 = (await pool.token0()).toLowerCase() ===
      (await reentrant.getAddress()).toLowerCase();
    const nestedCall = pool.interface.encodeFunctionData("swapExactInput", [
      1n,
      0n,
      reentrantIsToken0,
      MAX_DEADLINE,
    ]);
    await reentrant.configureCallback(await pool.getAddress(), nestedCall);
    await reentrant.approve(await pool.getAddress(), 1n);

    await expect(
      pool.swapExactInput(1n, 0n, reentrantIsToken0, MAX_DEADLINE),
    ).to.be.revertedWithCustomError(pool, "Reentrancy");
    expect(await reentrant.balanceOf(await pool.getAddress())).to.equal(1_000n);
    expect(await normal.balanceOf(await pool.getAddress())).to.equal(1_000n);
  });

  it("enforces swap minimums against the recipient's actual token increase", async function () {
    const [owner, trader] = await ethers.getSigners();
    const normal = await (await ethers.getContractFactory("MockERC20")).deploy(
      "Normal Token",
      "NORM",
      18,
    );
    const taxed = await (await ethers.getContractFactory("FeeOnTransferERC20")).deploy(
      "Taxed Token",
      "TAX",
      100,
    );
    await normal.waitForDeployment();
    await taxed.waitForDeployment();
    const vault = await deployFeeVault();
    const pool = await (await ethers.getContractFactory("PublicCPMM")).deploy(
      await normal.getAddress(),
      await taxed.getAddress(),
      18,
      18,
      30,
      await vault.getAddress(),
    );
    await pool.waitForDeployment();

    const token0IsNormal = (await pool.token0()).toLowerCase() ===
      (await normal.getAddress()).toLowerCase();
    const token0 = token0IsNormal ? normal : taxed;
    const token1 = token0IsNormal ? taxed : normal;
    const amount0 = token0IsNormal ? 1_000n : 1_010n;
    const amount1 = token0IsNormal ? 1_010n : 1_000n;
    await normal.mint(owner.address, 2_000n);
    await taxed.mint(owner.address, 2_020n);
    await normal.mint(trader.address, 500n);
    await token0.approve(await pool.getAddress(), amount0);
    await token1.approve(await pool.getAddress(), amount1);
    await pool.addLiquidity(amount0, amount1, 1n, 0n, ethers.MaxUint256, MAX_DEADLINE);

    const zeroForOne = token0IsNormal;
    const quoted = await pool.quoteExactInput(500n, zeroForOne);
    const expectedReceived = quoted - ((quoted * 100n) / 10_000n);
    await normal.connect(trader).approve(await pool.getAddress(), 500n);
    await expect(
      pool.connect(trader).swapExactInput(500n, quoted, zeroForOne, MAX_DEADLINE),
    ).to.be.revertedWithCustomError(pool, "SlippageExceeded");

    const outputBefore = await taxed.balanceOf(trader.address);
    await pool.connect(trader).swapExactInput(500n, expectedReceived, zeroForOne, MAX_DEADLINE);
    expect(await taxed.balanceOf(trader.address)).to.equal(outputBefore + expectedReceived);
  });

  it("enforces liquidity withdrawal minimums against actual receipts", async function () {
    const [owner] = await ethers.getSigners();
    const normal = await (await ethers.getContractFactory("MockERC20")).deploy(
      "Normal Token",
      "NORM",
      18,
    );
    const taxed = await (await ethers.getContractFactory("FeeOnTransferERC20")).deploy(
      "Taxed Token",
      "TAX",
      100,
    );
    await normal.waitForDeployment();
    await taxed.waitForDeployment();
    const vault = await deployFeeVault();
    const pool = await (await ethers.getContractFactory("PublicCPMM")).deploy(
      await normal.getAddress(),
      await taxed.getAddress(),
      18,
      18,
      30,
      await vault.getAddress(),
    );
    await pool.waitForDeployment();

    const token0IsNormal = (await pool.token0()).toLowerCase() ===
      (await normal.getAddress()).toLowerCase();
    const token0 = token0IsNormal ? normal : taxed;
    const token1 = token0IsNormal ? taxed : normal;
    const amount0 = token0IsNormal ? 1_000n : 1_010n;
    const amount1 = token0IsNormal ? 1_010n : 1_000n;
    await normal.mint(owner.address, 1_000n);
    await taxed.mint(owner.address, 1_010n);
    await token0.approve(await pool.getAddress(), amount0);
    await token1.approve(await pool.getAddress(), amount1);
    await pool.addLiquidity(amount0, amount1, 1n, 0n, ethers.MaxUint256, MAX_DEADLINE);

    const shares = await pool.totalShares();
    const nominal0 = await token0.balanceOf(await pool.getAddress());
    const nominal1 = await token1.balanceOf(await pool.getAddress());
    await expect(
      pool.removeLiquidity(shares, nominal0, nominal1, MAX_DEADLINE),
    ).to.be.revertedWithCustomError(pool, "SlippageExceeded");

    const min0 = token0IsNormal ? nominal0 : nominal0 - ((nominal0 * 100n) / 10_000n);
    const min1 = token0IsNormal ? nominal1 - ((nominal1 * 100n) / 10_000n) : nominal1;
    await pool.removeLiquidity(shares, min0, min1, MAX_DEADLINE);
    expect(await pool.totalShares()).to.equal(0n);
    expect(await pool.initialized()).to.equal(false);
  });

  it("sweeps only unmanaged donations when reinitializing after a full exit", async function () {
    const [owner, trader] = await ethers.getSigners();
    const tokenFactory = await ethers.getContractFactory("MockERC20");
    const token0 = await tokenFactory.deploy("Token 0", "TK0", 18);
    const token1 = await tokenFactory.deploy("Token 1", "TK1", 18);
    await Promise.all([token0.waitForDeployment(), token1.waitForDeployment()]);
    const vault = await deployFeeVault();
    const pool = await (await ethers.getContractFactory("PublicCPMM")).deploy(
      await token0.getAddress(),
      await token1.getAddress(),
      18,
      18,
      30,
      await vault.getAddress(),
    );
    await pool.waitForDeployment();

    await token0.mint(owner.address, 30_000n);
    await token1.mint(owner.address, 20_000n);
    await token0.mint(trader.address, 10_000n);
    await token0.approve(await pool.getAddress(), ethers.MaxUint256);
    await token1.approve(await pool.getAddress(), ethers.MaxUint256);
    await pool.addLiquidity(10_000n, 10_000n, 1n, 0n, ethers.MaxUint256, MAX_DEADLINE);

    await token0.connect(trader).approve(await pool.getAddress(), 10_000n);
    await pool.connect(trader).swapExactInput(10_000n, 0n, true, MAX_DEADLINE);
    const accruedProtocolFee = await pool.protocolFees0();
    expect(accruedProtocolFee).to.be.greaterThan(0n);

    await pool.removeLiquidity(await pool.totalShares(), 0n, 0n, MAX_DEADLINE);
    expect(await pool.initialized()).to.equal(false);
    expect(await token0.balanceOf(await pool.getAddress())).to.equal(accruedProtocolFee);

    await token0.transfer(await pool.getAddress(), 1n);
    await pool.addLiquidity(10_000n, 10_000n, 1n, 0n, ethers.MaxUint256, MAX_DEADLINE);

    expect(await token0.balanceOf(await vault.getAddress())).to.equal(1n);
    expect(await pool.protocolFees0()).to.equal(accruedProtocolFee);
    const [reserve0, reserve1] = await pool.effectiveReserves();
    expect(reserve0).to.equal(10_000n);
    expect(reserve1).to.equal(10_000n);
  });
});
