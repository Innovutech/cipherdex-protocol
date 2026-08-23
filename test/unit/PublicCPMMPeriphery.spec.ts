import { expect } from "chai";
import { ethers } from "../../hardhat/runtime.js";
import { deployFeeVault } from "../helpers/deployFeeVault";

describe("PublicCPMM periphery", function () {
  async function deployFixture() {
    const [owner, trader] = await ethers.getSigners();
    const tokenFactory = await ethers.getContractFactory("MockERC20");
    const tokenA = await tokenFactory.deploy("Token A", "TKA", 18);
    const tokenB = await tokenFactory.deploy("Token B", "TKB", 6);
    await tokenA.waitForDeployment();
    await tokenB.waitForDeployment();

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
    await pool.addLiquidity(amount0, amount1, 1n, 0n, ethers.MaxUint256, 0xffffffff);
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
    expect(await quoter.PROTOCOL_VERSION()).to.equal(2n);
    expect(await router.PROTOCOL_VERSION()).to.equal(2n);
  });

  it("rejects pools outside its immutable factory", async function () {
    const { token0, quoter, router } = await deployFixture();
    const tokenAddress = await token0.getAddress();
    await expect(quoter.quoteExactInput(tokenAddress, 1n, true))
      .to.be.revertedWithCustomError(quoter, "InvalidPool");
    await expect(router.swapExactInput(tokenAddress, 1n, 0n, true, 0xffffffff))
      .to.be.revertedWithCustomError(router, "InvalidPool");
  });

  it("cannot quote or route donated balances in an uninitialized canonical pool", async function () {
    const [owner, trader] = await ethers.getSigners();
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
    const pool = await ethers.getContractAt("PublicCPMM", await factory.getPool(key));
    const poolAddress = await pool.getAddress();
    const token0IsA = (await pool.token0()).toLowerCase() ===
      (await tokenA.getAddress()).toLowerCase();
    const token0 = token0IsA ? tokenA : tokenB;
    const token1 = token0IsA ? tokenB : tokenA;
    const input = token0IsA ? ethers.parseEther("1") : 1_000_000n;
    const donated0 = input * 2n;
    const donated1 = token0IsA ? 2_000_000n : ethers.parseEther("2");
    await token0.mint(owner.address, donated0);
    await token1.mint(owner.address, donated1);
    await token0.mint(trader.address, input);
    await token0.transfer(poolAddress, donated0);
    await token1.transfer(poolAddress, donated1);

    const quoter = await (await ethers.getContractFactory("PublicCPMMQuoter")).deploy(
      await factory.getAddress(),
    );
    const router = await (await ethers.getContractFactory("PublicCPMMRouter")).deploy(
      await factory.getAddress(),
    );
    await Promise.all([quoter.waitForDeployment(), router.waitForDeployment()]);
    const routerAddress = await router.getAddress();
    await token0.connect(trader).approve(routerAddress, input);
    const traderBalanceBefore = await token0.balanceOf(trader.address);

    await expect(quoter.quoteExactInput(poolAddress, input, true))
      .to.be.revertedWithCustomError(pool, "PoolNotInitialized");
    await expect(
      router.connect(trader).swapExactInput(poolAddress, input, 0n, true, 0xffffffff),
    ).to.be.revertedWithCustomError(pool, "PoolNotInitialized");

    expect(await token0.balanceOf(trader.address)).to.equal(traderBalanceBefore);
    expect(await token0.balanceOf(routerAddress)).to.equal(0n);
    expect(await token1.balanceOf(routerAddress)).to.equal(0n);
    expect(await token0.allowance(routerAddress, poolAddress)).to.equal(0n);
    expect(await token0.balanceOf(poolAddress)).to.equal(donated0);
    expect(await token1.balanceOf(poolAddress)).to.equal(donated1);
  });

  it("enforces the final trader receipt for taxed routed output", async function () {
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
    const factory = await (await ethers.getContractFactory("PublicCPMMFactory")).deploy(
      await vault.getAddress(),
    );
    await factory.waitForDeployment();
    await factory.createPool(await normal.getAddress(), await taxed.getAddress(), 18, 18, 30);
    const key = await factory.poolKey(await normal.getAddress(), await taxed.getAddress(), 18, 18, 30);
    const pool = await ethers.getContractAt("PublicCPMM", await factory.getPool(key));
    const token0IsNormal = (await pool.token0()).toLowerCase() ===
      (await normal.getAddress()).toLowerCase();
    const token0 = token0IsNormal ? normal : taxed;
    const token1 = token0IsNormal ? taxed : normal;
    const amount0 = token0IsNormal ? 1_000n : 1_010n;
    const amount1 = token0IsNormal ? 1_010n : 1_000n;
    await normal.mint(owner.address, 1_000n);
    await taxed.mint(owner.address, 1_010n);
    await normal.mint(trader.address, 500n);
    await token0.approve(await pool.getAddress(), amount0);
    await token1.approve(await pool.getAddress(), amount1);
    await pool.addLiquidity(amount0, amount1, 1n, 0n, ethers.MaxUint256, 0xffffffff);

    const router = await (await ethers.getContractFactory("PublicCPMMRouter")).deploy(
      await factory.getAddress(),
    );
    await router.waitForDeployment();
    const zeroForOne = token0IsNormal;
    const quote = await pool.quoteExactInput(500n, zeroForOne);
    await normal.connect(trader).approve(await router.getAddress(), 500n);
    await expect(
      router.connect(trader).swapExactInput(
        await pool.getAddress(),
        500n,
        quote,
        zeroForOne,
        0xffffffff,
      ),
    ).to.be.revertedWithCustomError(pool, "SlippageExceeded");

    const outputBefore = await taxed.balanceOf(trader.address);
    await router.connect(trader).swapExactInput(
      await pool.getAddress(),
      500n,
      0n,
      zeroForOne,
      0xffffffff,
    );
    expect(await taxed.balanceOf(trader.address)).to.be.greaterThan(outputBefore);
  });

  it("rejects a short-credited routed input without consuming prefunded router tokens", async function () {
    const [owner, trader] = await ethers.getSigners();
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
    const key = await factory.poolKey(await taxed.getAddress(), await paired.getAddress(), 18, 18, 30);
    const pool = await ethers.getContractAt("PublicCPMM", await factory.getPool(key));
    const poolAddress = await pool.getAddress();
    const token0IsTaxed = (await pool.token0()).toLowerCase() ===
      (await taxed.getAddress()).toLowerCase();

    await taxed.mint(owner.address, 20_000n);
    await paired.mint(owner.address, 20_000n);
    await taxed.approve(poolAddress, 10_000n);
    await paired.approve(poolAddress, 10_000n);
    await pool.addLiquidity(10_000n, 10_000n, 1n, 0n, ethers.MaxUint256, 0xffffffff);

    const router = await (await ethers.getContractFactory("PublicCPMMRouter")).deploy(
      await factory.getAddress(),
    );
    await router.waitForDeployment();
    const routerAddress = await router.getAddress();
    await taxed.transfer(routerAddress, 10n);
    await taxed.setTaxedSender(trader.address);
    await taxed.mint(trader.address, 100n);
    await taxed.connect(trader).approve(routerAddress, 100n);

    await expect(
      router.connect(trader).swapExactInput(
        poolAddress,
        100n,
        0n,
        token0IsTaxed,
        0xffffffff,
      ),
    ).to.be.revertedWithCustomError(router, "TransferAmountMismatch");

    expect(await taxed.balanceOf(routerAddress)).to.equal(10n);
    expect(await taxed.balanceOf(trader.address)).to.equal(100n);
    expect(await taxed.allowance(routerAddress, poolAddress)).to.equal(0n);
  });

  it("atomically creates and seeds a pool while minting shares to the provider", async function () {
    const [provider] = await ethers.getSigners();
    const tokenFactory = await ethers.getContractFactory("MockERC20");
    const tokenA = await tokenFactory.deploy("Token A", "TKA", 18);
    const tokenB = await tokenFactory.deploy("Token B", "TKB", 6);
    await Promise.all([tokenA.waitForDeployment(), tokenB.waitForDeployment()]);
    const vault = await deployFeeVault();
    const factory = await (await ethers.getContractFactory("PublicCPMMFactory")).deploy(
      await vault.getAddress(),
    );
    await factory.waitForDeployment();
    const liquidityRouter = await (
      await ethers.getContractFactory("PublicCPMMLiquidityRouter")
    ).deploy(await factory.getAddress());
    await liquidityRouter.waitForDeployment();

    const amountA = ethers.parseEther("100");
    const amountB = 100_000_000n;
    await tokenA.mint(provider.address, amountA);
    await tokenB.mint(provider.address, amountB);
    await tokenA.approve(await liquidityRouter.getAddress(), amountA);
    await tokenB.approve(await liquidityRouter.getAddress(), amountB);

    const key = await factory.poolKey(
      await tokenA.getAddress(),
      await tokenB.getAddress(),
      18,
      6,
      30,
    );
    await liquidityRouter.createOrAddLiquidity(
      await tokenA.getAddress(),
      await tokenB.getAddress(),
      18,
      6,
      30,
      amountA,
      amountB,
      1n,
      0n,
      ethers.MaxUint256,
      0xffffffff,
    );

    const poolAddress = await factory.getPool(key);
    const pool = await ethers.getContractAt("PublicCPMM", poolAddress);
    expect(poolAddress).to.not.equal(ethers.ZeroAddress);
    expect(await pool.initialized()).to.equal(true);
    expect(await pool.shares(provider.address)).to.be.greaterThan(0n);
    expect(await tokenA.balanceOf(await liquidityRouter.getAddress())).to.equal(0n);
    expect(await tokenB.balanceOf(await liquidityRouter.getAddress())).to.equal(0n);
    expect(await tokenA.allowance(await liquidityRouter.getAddress(), poolAddress)).to.equal(0n);
    expect(await tokenB.allowance(await liquidityRouter.getAddress(), poolAddress)).to.equal(0n);
    expect(await liquidityRouter.PROTOCOL_VERSION()).to.equal(1n);
  });

  it("rolls pool creation back when atomic initial seeding fails", async function () {
    const [provider] = await ethers.getSigners();
    const tokenFactory = await ethers.getContractFactory("MockERC20");
    const tokenA = await tokenFactory.deploy("Token A", "TKA", 18);
    const tokenB = await tokenFactory.deploy("Token B", "TKB", 6);
    await Promise.all([tokenA.waitForDeployment(), tokenB.waitForDeployment()]);
    const vault = await deployFeeVault();
    const factory = await (await ethers.getContractFactory("PublicCPMMFactory")).deploy(
      await vault.getAddress(),
    );
    const liquidityRouter = await (
      await ethers.getContractFactory("PublicCPMMLiquidityRouter")
    ).deploy(await factory.getAddress());
    await Promise.all([factory.waitForDeployment(), liquidityRouter.waitForDeployment()]);
    const amountA = ethers.parseEther("10");
    const amountB = 10_000_000n;
    await tokenA.mint(provider.address, amountA);
    await tokenB.mint(provider.address, amountB);
    await tokenA.approve(await liquidityRouter.getAddress(), amountA);
    await tokenB.approve(await liquidityRouter.getAddress(), amountB);
    const key = await factory.poolKey(
      await tokenA.getAddress(),
      await tokenB.getAddress(),
      18,
      6,
      30,
    );

    await expect(liquidityRouter.createOrAddLiquidity(
      await tokenA.getAddress(),
      await tokenB.getAddress(),
      18,
      6,
      30,
      amountA,
      amountB,
      ethers.MaxUint256,
      0n,
      ethers.MaxUint256,
      0xffffffff,
    )).to.be.revert(ethers);

    expect(await factory.getPool(key)).to.equal(ethers.ZeroAddress);
    expect(await factory.allPoolsLength()).to.equal(0n);
    expect(await tokenA.balanceOf(provider.address)).to.equal(amountA);
    expect(await tokenB.balanceOf(provider.address)).to.equal(amountB);
  });

  it("uses only the proportional amounts and refunds excess for an existing pool", async function () {
    const [provider, secondProvider] = await ethers.getSigners();
    const tokenFactory = await ethers.getContractFactory("MockERC20");
    const tokenA = await tokenFactory.deploy("Token A", "TKA", 18);
    const tokenB = await tokenFactory.deploy("Token B", "TKB", 6);
    await Promise.all([tokenA.waitForDeployment(), tokenB.waitForDeployment()]);
    const vault = await deployFeeVault();
    const factory = await (await ethers.getContractFactory("PublicCPMMFactory")).deploy(
      await vault.getAddress(),
    );
    const liquidityRouter = await (
      await ethers.getContractFactory("PublicCPMMLiquidityRouter")
    ).deploy(await factory.getAddress());
    await Promise.all([factory.waitForDeployment(), liquidityRouter.waitForDeployment()]);
    const routerAddress = await liquidityRouter.getAddress();

    await tokenA.mint(provider.address, ethers.parseEther("100"));
    await tokenB.mint(provider.address, 100_000_000n);
    await tokenA.approve(routerAddress, ethers.MaxUint256);
    await tokenB.approve(routerAddress, ethers.MaxUint256);
    await liquidityRouter.createOrAddLiquidity(
      await tokenA.getAddress(), await tokenB.getAddress(), 18, 6, 30,
      ethers.parseEther("100"), 100_000_000n, 1n, 0n, ethers.MaxUint256, 0xffffffff,
    );

    const desiredA = ethers.parseEther("10");
    const desiredB = 20_000_000n;
    await tokenA.mint(secondProvider.address, desiredA);
    await tokenB.mint(secondProvider.address, desiredB);
    await tokenA.connect(secondProvider).approve(routerAddress, desiredA);
    await tokenB.connect(secondProvider).approve(routerAddress, desiredB);
    const result = await liquidityRouter.connect(secondProvider)
      .createOrAddLiquidity.staticCall(
        await tokenA.getAddress(), await tokenB.getAddress(), 18, 6, 30,
        desiredA, desiredB, 1n, 0n, ethers.MaxUint256, 0xffffffff,
      );
    await liquidityRouter.connect(secondProvider).createOrAddLiquidity(
      await tokenA.getAddress(), await tokenB.getAddress(), 18, 6, 30,
      desiredA, desiredB, 1n, 0n, ethers.MaxUint256, 0xffffffff,
    );

    const pool = await ethers.getContractAt("PublicCPMM", result[0]);
    expect(result[2]).to.equal(desiredA);
    expect(result[3]).to.equal(10_000_000n);
    expect(await tokenA.balanceOf(secondProvider.address)).to.equal(0n);
    expect(await tokenB.balanceOf(secondProvider.address)).to.equal(10_000_000n);
    expect(await pool.shares(secondProvider.address)).to.equal(result[1]);
    expect(await tokenA.balanceOf(routerAddress)).to.equal(0n);
    expect(await tokenB.balanceOf(routerAddress)).to.equal(0n);
  });

  it("preserves caller token ordering when tokenA is canonical token1", async function () {
    const [provider, secondProvider] = await ethers.getSigners();
    const tokenFactory = await ethers.getContractFactory("MockERC20");
    const first = await tokenFactory.deploy("First Token", "FIRST", 18);
    const second = await tokenFactory.deploy("Second Token", "SECOND", 18);
    await Promise.all([first.waitForDeployment(), second.waitForDeployment()]);
    const vault = await deployFeeVault();
    const factory = await (await ethers.getContractFactory("PublicCPMMFactory")).deploy(
      await vault.getAddress(),
    );
    const liquidityRouter = await (
      await ethers.getContractFactory("PublicCPMMLiquidityRouter")
    ).deploy(await factory.getAddress());
    await Promise.all([factory.waitForDeployment(), liquidityRouter.waitForDeployment()]);
    const routerAddress = await liquidityRouter.getAddress();
    const firstAddress = await first.getAddress();
    const secondAddress = await second.getAddress();
    const tokenA = firstAddress.toLowerCase() > secondAddress.toLowerCase() ? first : second;
    const tokenB = tokenA === first ? second : first;
    const tokenAAddress = await tokenA.getAddress();
    const tokenBAddress = await tokenB.getAddress();

    await tokenA.mint(provider.address, 1_000n);
    await tokenB.mint(provider.address, 1_000n);
    await tokenA.approve(routerAddress, 1_000n);
    await tokenB.approve(routerAddress, 1_000n);
    await liquidityRouter.createOrAddLiquidity(
      tokenAAddress, tokenBAddress, 18, 18, 30,
      1_000n, 1_000n, 1n, 0n, ethers.MaxUint256, 0xffffffff,
    );

    await tokenA.mint(secondProvider.address, 200n);
    await tokenB.mint(secondProvider.address, 100n);
    await tokenA.connect(secondProvider).approve(routerAddress, 200n);
    await tokenB.connect(secondProvider).approve(routerAddress, 100n);
    const result = await liquidityRouter.connect(secondProvider)
      .createOrAddLiquidity.staticCall(
        tokenAAddress, tokenBAddress, 18, 18, 30,
        200n, 100n, 1n, 0n, ethers.MaxUint256, 0xffffffff,
      );
    await liquidityRouter.connect(secondProvider).createOrAddLiquidity(
      tokenAAddress, tokenBAddress, 18, 18, 30,
      200n, 100n, 1n, 0n, ethers.MaxUint256, 0xffffffff,
    );

    expect(result[2]).to.equal(100n);
    expect(result[3]).to.equal(100n);
    expect(await tokenA.balanceOf(secondProvider.address)).to.equal(100n);
    expect(await tokenB.balanceOf(secondProvider.address)).to.equal(0n);
    expect(await tokenA.balanceOf(routerAddress)).to.equal(0n);
    expect(await tokenB.balanceOf(routerAddress)).to.equal(0n);
  });
});
