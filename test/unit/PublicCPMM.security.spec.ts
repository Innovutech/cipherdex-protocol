import { expect } from "chai";
import { ethers } from "../../hardhat/runtime.js";
import { deployFeeVault } from "../helpers/deployFeeVault";
import { deployPublicLpTokenFactory } from "../helpers/deployPublicLpTokenFactory";
import {
  createPublicPool,
  deployPublicFactory,
} from "../helpers/deployPublicFactory";

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

  const { factory } = await deployPublicFactory();
  const pool = await createPublicPool(
    factory,
    await token0.getAddress(),
    await token1.getAddress(),
    18,
    18,
    30,
  );

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
      .to.not.revert(ethers);
  });

  it("rejects maximum-width inputs instead of wrapping reserve arithmetic", async function () {
    const [owner] = await ethers.getSigners();
    const tokenFactory = await ethers.getContractFactory("MockERC20");
    const token0 = await tokenFactory.deploy("Wide Token 0", "W0", 18);
    const token1 = await tokenFactory.deploy("Wide Token 1", "W1", 18);
    await token0.waitForDeployment();
    await token1.waitForDeployment();
    const { factory } = await deployPublicFactory();
    const pool = await createPublicPool(
      factory,
      await token0.getAddress(),
      await token1.getAddress(),
      18,
      18,
      30,
    );
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
    await expect(pool.quoteExactInput(10_000n, true)).to.revert(ethers);
  });

  it("rejects a public fee above the protocol cap", async function () {
    const tokenFactory = await ethers.getContractFactory("MockERC20");
    const token0 = await tokenFactory.deploy("Fee Token 0", "F0", 18);
    const token1 = await tokenFactory.deploy("Fee Token 1", "F1", 18);
    await token0.waitForDeployment();
    await token1.waitForDeployment();
    const vault = await deployFeeVault();
    const lpTokenFactory = await deployPublicLpTokenFactory();
    const poolFactory = await ethers.getContractFactory("PublicCPMM");
    await expect(
      poolFactory.deploy(
        await token0.getAddress(),
        await token1.getAddress(),
        18,
        18,
        1_001,
        await vault.getAddress(),
        await lpTokenFactory.getAddress(),
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
    const lpTokenFactory = await deployPublicLpTokenFactory();
    const pool = await (await ethers.getContractFactory("PublicCPMM")).deploy(
      await reentrant.getAddress(),
      await normal.getAddress(),
      18,
      18,
      30,
      await vault.getAddress(),
      await lpTokenFactory.getAddress(),
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
    const lpTokenFactory = await deployPublicLpTokenFactory();
    const pool = await (await ethers.getContractFactory("PublicCPMM")).deploy(
      await normal.getAddress(),
      await taxed.getAddress(),
      18,
      18,
      30,
      await vault.getAddress(),
      await lpTokenFactory.getAddress(),
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
    const lpTokenFactory = await deployPublicLpTokenFactory();
    const pool = await (await ethers.getContractFactory("PublicCPMM")).deploy(
      await normal.getAddress(),
      await taxed.getAddress(),
      18,
      18,
      30,
      await vault.getAddress(),
      await lpTokenFactory.getAddress(),
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
    const { vault, factory } = await deployPublicFactory();
    const pool = await createPublicPool(
      factory,
      await token0.getAddress(),
      await token1.getAddress(),
      18,
      18,
      30,
    );

    await token0.mint(owner.address, 30_000n);
    await token1.mint(owner.address, 20_000n);
    await token0.mint(trader.address, 10_000n);
    await token0.approve(await pool.getAddress(), ethers.MaxUint256);
    await token1.approve(await pool.getAddress(), ethers.MaxUint256);
    await pool.addLiquidity(10_000n, 10_000n, 1n, 0n, ethers.MaxUint256, MAX_DEADLINE);

    const token0IsPoolToken0 = (await pool.token0()).toLowerCase() ===
      (await token0.getAddress()).toLowerCase();
    await token0.connect(trader).approve(await pool.getAddress(), 10_000n);
    await pool.connect(trader).swapExactInput(
      10_000n,
      0n,
      token0IsPoolToken0,
      MAX_DEADLINE,
    );
    const accruedProtocolFee = token0IsPoolToken0
      ? await pool.protocolFees0()
      : await pool.protocolFees1();
    expect(accruedProtocolFee).to.be.greaterThan(0n);

    await pool.removeLiquidity(await pool.totalShares(), 0n, 0n, MAX_DEADLINE);
    expect(await pool.initialized()).to.equal(false);
    expect(await token0.balanceOf(await pool.getAddress())).to.equal(accruedProtocolFee);

    await token0.transfer(await pool.getAddress(), 1n);
    await pool.addLiquidity(10_000n, 10_000n, 1n, 0n, ethers.MaxUint256, MAX_DEADLINE);

    expect(await token0.balanceOf(await vault.getAddress())).to.equal(1n);
    expect(
      token0IsPoolToken0 ? await pool.protocolFees0() : await pool.protocolFees1(),
    ).to.equal(accruedProtocolFee);
    const [reserve0, reserve1] = await pool.effectiveReserves();
    expect(reserve0).to.equal(10_000n);
    expect(reserve1).to.equal(10_000n);
  });

  it("keeps initialized donations out of reserves and sweeps them only to the fixed vault", async function () {
    const [owner, outsider] = await ethers.getSigners();
    const tokenFactory = await ethers.getContractFactory("MockERC20");
    const tokenA = await tokenFactory.deploy("Token A", "TKA", 18);
    const tokenB = await tokenFactory.deploy("Token B", "TKB", 18);
    await Promise.all([tokenA.waitForDeployment(), tokenB.waitForDeployment()]);
    const { vault, factory } = await deployPublicFactory();
    const pool = await createPublicPool(
      factory,
      await tokenA.getAddress(),
      await tokenB.getAddress(),
      18,
      18,
      30,
    );
    const token0IsA = (await pool.token0()).toLowerCase() ===
      (await tokenA.getAddress()).toLowerCase();
    const token0 = token0IsA ? tokenA : tokenB;
    const token1 = token0IsA ? tokenB : tokenA;
    const initial = 10_000n;
    const surplus0 = 123n;
    const surplus1 = 456n;

    await token0.mint(owner.address, initial);
    await token1.mint(owner.address, initial);
    await token0.approve(await pool.getAddress(), initial);
    await token1.approve(await pool.getAddress(), initial);
    await pool.addLiquidity(initial, initial, 1n, 0n, ethers.MaxUint256, MAX_DEADLINE);
    const quote0 = await pool.quoteExactInput(1_000n, true);
    const quote1 = await pool.quoteExactInput(1_000n, false);
    const shares = await pool.totalShares();

    await token0.mint(outsider.address, surplus0);
    await token1.mint(outsider.address, surplus1);
    await token0.connect(outsider).transfer(await pool.getAddress(), surplus0);
    await token1.connect(outsider).transfer(await pool.getAddress(), surplus1);

    expect(await pool.effectiveReserves()).to.deep.equal([initial, initial]);
    expect(await pool.surplusBalances()).to.deep.equal([surplus0, surplus1]);
    expect(await pool.quoteExactInput(1_000n, true)).to.equal(quote0);
    expect(await pool.quoteExactInput(1_000n, false)).to.equal(quote1);
    expect(await pool.totalShares()).to.equal(shares);
    await expect(pool.sweepSurplus(false, false))
      .to.be.revertedWithCustomError(pool, "NoSurplus");

    const partialShares = shares / 2n;
    await pool.removeLiquidity(partialShares, 0n, 0n, MAX_DEADLINE);
    expect(await pool.surplusBalances()).to.deep.equal([surplus0, surplus1]);
    await pool.removeLiquidity(
      await pool.shares(owner.address),
      0n,
      0n,
      MAX_DEADLINE,
    );
    expect(await pool.initialized()).to.equal(false);
    expect(await pool.effectiveReserves()).to.deep.equal([0n, 0n]);
    expect(await pool.surplusBalances()).to.deep.equal([surplus0, surplus1]);

    const sweep = await pool.connect(outsider).sweepSurplus(true, true);
    await expect(sweep).to.emit(pool, "UnmanagedBalanceSwept").withArgs(
      await token0.getAddress(),
      await vault.getAddress(),
      surplus0,
      surplus0,
    );
    await expect(sweep).to.emit(pool, "UnmanagedBalanceSwept").withArgs(
      await token1.getAddress(),
      await vault.getAddress(),
      surplus1,
      surplus1,
    );

    expect(await pool.effectiveReserves()).to.deep.equal([0n, 0n]);
    expect(await pool.surplusBalances()).to.deep.equal([0n, 0n]);
    expect(await token0.balanceOf(await vault.getAddress())).to.equal(surplus0);
    expect(await token1.balanceOf(await vault.getAddress())).to.equal(surplus1);
    await expect(pool.sweepSurplus(true, true))
      .to.be.revertedWithCustomError(pool, "NoSurplus");
  });

  it("initializes after sweeping sender-taxed unmanaged dust at measured vault credit", async function () {
    const [owner] = await ethers.getSigners();
    const taxed = await (
      await ethers.getContractFactory("FeeOnTransferERC20")
    ).deploy("Taxed Token", "TAX", 5_000);
    const paired = await (
      await ethers.getContractFactory("MockERC20")
    ).deploy("Paired Token", "PAIR", 18);
    await Promise.all([taxed.waitForDeployment(), paired.waitForDeployment()]);
    const { vault, factory } = await deployPublicFactory();
    const pool = await createPublicPool(
      factory,
      await taxed.getAddress(),
      await paired.getAddress(),
      18,
      18,
      30,
    );
    const poolAddress = await pool.getAddress();
    await taxed.setTaxedSender(poolAddress);

    await taxed.mint(owner.address, 10_100n);
    await paired.mint(owner.address, 10_000n);
    await taxed.transfer(poolAddress, 100n);
    await taxed.approve(poolAddress, 10_000n);
    await paired.approve(poolAddress, 10_000n);

    await expect(
      pool.addLiquidity(10_000n, 10_000n, 1n, 0n, ethers.MaxUint256, MAX_DEADLINE),
    ).to.emit(pool, "UnmanagedBalanceSwept")
      .withArgs(await taxed.getAddress(), await vault.getAddress(), 100n, 50n);

    expect(await pool.initialized()).to.equal(true);
    expect(await pool.effectiveReserves()).to.deep.equal([10_000n, 10_000n]);
    expect(await taxed.balanceOf(poolAddress)).to.equal(10_000n);
    expect(await taxed.balanceOf(await vault.getAddress())).to.equal(50n);
    expect(await vault.publicFees(await taxed.getAddress())).to.equal(50n);
  });

  it("absorbs a small external balance loss entirely from the protocol claim", async function () {
    const [owner, trader] = await ethers.getSigners();
    const burnable = await (
      await ethers.getContractFactory("ExternallyBurnableERC20")
    ).deploy("Burnable Token", "BURN", 18);
    const paired = await (
      await ethers.getContractFactory("MockERC20")
    ).deploy("Paired Token", "PAIR", 18);
    await Promise.all([burnable.waitForDeployment(), paired.waitForDeployment()]);
    const { vault, factory } = await deployPublicFactory();
    const pool = await createPublicPool(
      factory,
      await burnable.getAddress(),
      await paired.getAddress(),
      18,
      18,
      30,
    );
    const poolAddress = await pool.getAddress();
    const burnableIsToken0 = (await pool.token0()).toLowerCase() ===
      (await burnable.getAddress()).toLowerCase();
    const token0 = burnableIsToken0 ? burnable : paired;
    const token1 = burnableIsToken0 ? paired : burnable;

    await token0.mint(owner.address, 10_000n);
    await token1.mint(owner.address, 10_000n);
    await burnable.mint(trader.address, 10_000n);
    await token0.approve(poolAddress, 10_000n);
    await token1.approve(poolAddress, 10_000n);
    await burnable.connect(trader).approve(poolAddress, 10_000n);
    await pool.addLiquidity(10_000n, 10_000n, 1n, 0n, ethers.MaxUint256, MAX_DEADLINE);
    await pool.connect(trader).swapExactInput(
      10_000n,
      0n,
      burnableIsToken0,
      MAX_DEADLINE,
    );

    const claim = burnableIsToken0
      ? await pool.protocolFees0()
      : await pool.protocolFees1();
    const reservesBefore = await pool.effectiveReserves();
    expect(claim).to.be.greaterThan(1n);
    await burnable.burnFrom(poolAddress, 1n);

    const collection = await pool.collectProtocolFees(
      burnableIsToken0,
      !burnableIsToken0,
    );
    await expect(collection).to.emit(pool, "ProtocolFeeLossReconciled").withArgs(
      await burnable.getAddress(),
      claim,
      claim - 1n,
      1n,
    );
    await expect(collection).not.to.emit(pool, "ReserveLossReconciled");
    expect(await pool.effectiveReserves()).to.deep.equal(reservesBefore);
    expect(await vault.publicFees(await burnable.getAddress())).to.equal(claim - 1n);
  });

  it("charges external balance loss to protocol fees before LP reserves", async function () {
    const [owner, trader] = await ethers.getSigners();
    const burnable = await (
      await ethers.getContractFactory("ExternallyBurnableERC20")
    ).deploy("Burnable Token", "BURN", 18);
    const paired = await (
      await ethers.getContractFactory("MockERC20")
    ).deploy("Paired Token", "PAIR", 18);
    await Promise.all([burnable.waitForDeployment(), paired.waitForDeployment()]);
    const vault = await deployFeeVault();
    const lpTokenFactory = await deployPublicLpTokenFactory();
    const pool = await (await ethers.getContractFactory("PublicCPMM")).deploy(
      await burnable.getAddress(),
      await paired.getAddress(),
      18,
      18,
      30,
      await vault.getAddress(),
      await lpTokenFactory.getAddress(),
    );
    await pool.waitForDeployment();

    await burnable.mint(owner.address, 10_000n);
    await paired.mint(owner.address, 10_000n);
    await burnable.mint(trader.address, 10_000n);
    await burnable.approve(await pool.getAddress(), 10_000n);
    await paired.approve(await pool.getAddress(), 10_000n);
    await pool.addLiquidity(10_000n, 10_000n, 1n, 0n, ethers.MaxUint256, MAX_DEADLINE);
    await burnable.connect(trader).approve(await pool.getAddress(), 10_000n);
    await pool.connect(trader).swapExactInput(10_000n, 0n, true, MAX_DEADLINE);

    const previousClaim = await pool.protocolFees0();
    expect(previousClaim).to.be.greaterThan(1n);
    const previousReserve = (await pool.effectiveReserves())[0];
    const poolAddress = await pool.getAddress();
    const rawBalance = await burnable.balanceOf(poolAddress);
    const remainingClaim = previousClaim - 1n;
    await burnable.burnFrom(poolAddress, rawBalance - remainingClaim);

    const burnableBefore = await burnable.balanceOf(owner.address);
    const pairedBefore = await paired.balanceOf(owner.address);
    const pairedReserve = (await pool.effectiveReserves())[1];
    const removal = await pool.removeLiquidity(
      await pool.totalShares(),
      0n,
      0n,
      MAX_DEADLINE,
    );
    await expect(removal).to.emit(pool, "ProtocolFeeLossReconciled").withArgs(
      await burnable.getAddress(), previousClaim, 0n, previousClaim,
    );
    await expect(removal).to.emit(pool, "ReserveLossReconciled").withArgs(
      await burnable.getAddress(),
      previousReserve,
      remainingClaim,
      previousReserve - remainingClaim,
    );

    expect(await burnable.balanceOf(owner.address)).to.equal(burnableBefore + remainingClaim);
    expect(await paired.balanceOf(owner.address)).to.equal(pairedBefore + pairedReserve);
    expect(await pool.totalShares()).to.equal(0n);
    expect(await pool.initialized()).to.equal(false);
    expect(await pool.protocolFees0()).to.equal(0n);
    expect(await burnable.balanceOf(poolAddress)).to.equal(0n);
  });

  it("lets LPs burn stranded shares after hostile tokens destroy both reserves", async function () {
    const [owner, secondLp] = await ethers.getSigners();
    const tokenA = await (
      await ethers.getContractFactory("ExternallyBurnableERC20")
    ).deploy("Burnable A", "BURA", 18);
    const tokenB = await (
      await ethers.getContractFactory("ExternallyBurnableERC20")
    ).deploy("Burnable B", "BURB", 18);
    await Promise.all([tokenA.waitForDeployment(), tokenB.waitForDeployment()]);
    const vault = await deployFeeVault();
    const lpTokenFactory = await deployPublicLpTokenFactory();
    const pool = await (await ethers.getContractFactory("PublicCPMM")).deploy(
      await tokenA.getAddress(),
      await tokenB.getAddress(),
      18,
      18,
      30,
      await vault.getAddress(),
      await lpTokenFactory.getAddress(),
    );
    await pool.waitForDeployment();

    for (const signer of [owner, secondLp]) {
      await tokenA.mint(signer.address, 10_000n);
      await tokenB.mint(signer.address, 10_000n);
      await tokenA.connect(signer).approve(await pool.getAddress(), 10_000n);
      await tokenB.connect(signer).approve(await pool.getAddress(), 10_000n);
      await pool.connect(signer).addLiquidity(
        10_000n,
        10_000n,
        1n,
        0n,
        ethers.MaxUint256,
        MAX_DEADLINE,
      );
    }

    const poolAddress = await pool.getAddress();
    await tokenA.burnFrom(poolAddress, await tokenA.balanceOf(poolAddress));
    await tokenB.burnFrom(poolAddress, await tokenB.balanceOf(poolAddress));

    await expect(
      pool.removeLiquidity(await pool.shares(owner.address), 1n, 0n, MAX_DEADLINE),
    ).to.be.revertedWithCustomError(pool, "InsufficientLiquidity");

    const ownerShares = await pool.shares(owner.address);
    await expect(pool.removeLiquidity(ownerShares, 0n, 0n, MAX_DEADLINE))
      .to.emit(pool, "LiquidityRemoved")
      .withArgs(owner.address, 0n, 0n, ownerShares);
    expect(await pool.initialized()).to.equal(true);

    const finalShares = await pool.shares(secondLp.address);
    await expect(
      pool.connect(secondLp).removeLiquidity(finalShares, 0n, 0n, MAX_DEADLINE),
    ).to.emit(pool, "LiquidityRemoved")
      .withArgs(secondLp.address, 0n, 0n, finalShares);
    expect(await pool.totalShares()).to.equal(0n);
    expect(await pool.initialized()).to.equal(false);
  });

  it("accounts the measured vault credit when an outbound tax burns protocol-owned fees", async function () {
    const [owner, trader] = await ethers.getSigners();
    const taxed = await (
      await ethers.getContractFactory("FeeOnTransferERC20")
    ).deploy("Taxed Token", "TAX", 5_000);
    const paired = await (
      await ethers.getContractFactory("MockERC20")
    ).deploy("Paired Token", "PAIR", 18);
    await Promise.all([taxed.waitForDeployment(), paired.waitForDeployment()]);
    const { vault, factory } = await deployPublicFactory();
    const pool = await createPublicPool(
      factory,
      await taxed.getAddress(),
      await paired.getAddress(),
      18,
      18,
      30,
    );
    const poolAddress = await pool.getAddress();
    await taxed.setTaxedSender(poolAddress);

    await taxed.mint(owner.address, 10_000n);
    await paired.mint(owner.address, 10_000n);
    await taxed.mint(trader.address, 10_000n);
    await taxed.approve(poolAddress, 10_000n);
    await paired.approve(poolAddress, 10_000n);
    await pool.addLiquidity(10_000n, 10_000n, 1n, 0n, ethers.MaxUint256, MAX_DEADLINE);
    await taxed.connect(trader).approve(poolAddress, 10_000n);
    const taxedIsToken0 = (await pool.token0()).toLowerCase() ===
      (await taxed.getAddress()).toLowerCase();
    await pool.connect(trader).swapExactInput(
      10_000n,
      0n,
      taxedIsToken0,
      MAX_DEADLINE,
    );

    const claimBefore = taxedIsToken0
      ? await pool.protocolFees0()
      : await pool.protocolFees1();
    const poolBalanceBefore = await taxed.balanceOf(poolAddress);
    const vaultBalanceBefore = await taxed.balanceOf(await vault.getAddress());
    expect(claimBefore).to.be.greaterThan(0n);

    const expectedReceived = claimBefore - ((claimBefore * 5_000n) / 10_000n);
    await expect(pool.collectProtocolFees(taxedIsToken0, !taxedIsToken0))
      .to.emit(pool, "ProtocolFeeCollected")
      .withArgs(await taxed.getAddress(), await vault.getAddress(), claimBefore, expectedReceived);
    expect(taxedIsToken0 ? await pool.protocolFees0() : await pool.protocolFees1())
      .to.equal(0n);
    expect(await taxed.balanceOf(poolAddress)).to.equal(poolBalanceBefore - claimBefore);
    expect(await taxed.balanceOf(await vault.getAddress()))
      .to.equal(vaultBalanceBefore + expectedReceived);
    expect(await vault.publicFees(await taxed.getAddress())).to.equal(expectedReceived);
  });

  it("collects selected fee and surplus sides without reading the unselected token", async function () {
    const [owner, trader] = await ethers.getSigners();
    const healthy = await (await ethers.getContractFactory("MockERC20")).deploy(
      "Healthy Token",
      "GOOD",
      18,
    );
    const reverting = await (
      await ethers.getContractFactory("RevertingBalanceERC20")
    ).deploy("Reverting Token", "BAD");
    await Promise.all([healthy.waitForDeployment(), reverting.waitForDeployment()]);
    const { vault, factory } = await deployPublicFactory();
    const pool = await createPublicPool(
      factory,
      await healthy.getAddress(),
      await reverting.getAddress(),
      18,
      18,
      30,
    );

    const poolAddress = await pool.getAddress();
    const healthyIsToken0 = (await pool.token0()).toLowerCase() ===
      (await healthy.getAddress()).toLowerCase();
    const initial = 10_000_000n;
    await healthy.mint(owner.address, initial * 2n);
    await reverting.mint(owner.address, initial * 2n);
    await healthy.mint(trader.address, 1_000_000n);
    await healthy.approve(poolAddress, initial);
    await reverting.approve(poolAddress, initial);
    await healthy.connect(trader).approve(poolAddress, 1_000_000n);
    await pool.addLiquidity(initial, initial, 1n, 0n, ethers.MaxUint256, MAX_DEADLINE);
    await pool.connect(trader).swapExactInput(
      1_000_000n,
      0n,
      healthyIsToken0,
      MAX_DEADLINE,
    );

    const accrued = healthyIsToken0
      ? await pool.protocolFees0()
      : await pool.protocolFees1();
    expect(accrued).to.be.greaterThan(0n);
    await reverting.setRevertBalanceReads(true);

    await expect(pool.collectProtocolFees(healthyIsToken0, !healthyIsToken0))
      .to.emit(pool, "ProtocolFeeCollected")
      .withArgs(await healthy.getAddress(), await vault.getAddress(), accrued, accrued);

    const donation = 777n;
    await healthy.mint(trader.address, donation);
    await healthy.connect(trader).transfer(poolAddress, donation);
    await expect(pool.sweepSurplus(healthyIsToken0, !healthyIsToken0))
      .to.emit(pool, "UnmanagedBalanceSwept")
      .withArgs(
        await healthy.getAddress(),
        await vault.getAddress(),
        donation,
        donation,
      );
  });
});
