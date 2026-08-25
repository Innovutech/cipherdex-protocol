import { expect } from "chai";
import { ethers } from "../../hardhat/runtime.js";
import { deployFeeVault } from "../helpers/deployFeeVault";

describe("PublicCPMM native periphery", function () {
  const DEADLINE = 0xffffffff;

  async function deployFixture() {
    const [owner, trader, recipient] = await ethers.getSigners();
    const wrapped = await (await ethers.getContractFactory("WrappedNativeToken")).deploy(
      "Wrapped COTI",
      "WCOTI",
    );
    const token = await (await ethers.getContractFactory("MockERC20")).deploy(
      "Paired Token",
      "PAIR",
      18,
    );
    await Promise.all([wrapped.waitForDeployment(), token.waitForDeployment()]);

    const vault = await deployFeeVault();
    const factory = await (await ethers.getContractFactory("PublicCPMMFactory")).deploy(
      await vault.getAddress(),
    );
    await factory.waitForDeployment();
    await factory.createPool(
      await wrapped.getAddress(),
      await token.getAddress(),
      18,
      18,
      30,
    );
    const key = await factory.poolKey(
      await wrapped.getAddress(),
      await token.getAddress(),
      18,
      18,
      30,
    );
    const pool = await ethers.getContractAt("PublicCPMM", await factory.getPool(key));
    const poolAddress = await pool.getAddress();
    const wrappedIsToken0 = (await pool.token0()).toLowerCase() ===
      (await wrapped.getAddress()).toLowerCase();

    const liquidity = ethers.parseEther("100");
    await wrapped.deposit({ value: liquidity });
    await token.mint(owner.address, liquidity);
    await wrapped.approve(poolAddress, liquidity);
    await token.approve(poolAddress, liquidity);
    await pool.addLiquidity(
      liquidity,
      liquidity,
      1n,
      0n,
      ethers.MaxUint256,
      DEADLINE,
    );

    const publicRouter = await (await ethers.getContractFactory("PublicCPMMRouter")).deploy(
      await factory.getAddress(),
    );
    const publicLiquidityRouter = await (
      await ethers.getContractFactory("PublicCPMMLiquidityRouter")
    ).deploy(await factory.getAddress());
    await Promise.all([
      publicRouter.waitForDeployment(),
      publicLiquidityRouter.waitForDeployment(),
    ]);
    const nativeRouter = await (
      await ethers.getContractFactory("PublicCPMMNativeRouter")
    ).deploy(
      await factory.getAddress(),
      await publicRouter.getAddress(),
      await publicLiquidityRouter.getAddress(),
      await wrapped.getAddress(),
    );
    await nativeRouter.waitForDeployment();

    return {
      owner,
      trader,
      recipient,
      wrapped,
      token,
      factory,
      pool,
      wrappedIsToken0,
      publicRouter,
      publicLiquidityRouter,
      nativeRouter,
    };
  }

  it("wraps native exact input and forwards the paired token without retaining assets", async function () {
    const {
      trader,
      recipient,
      wrapped,
      token,
      pool,
      wrappedIsToken0,
      publicRouter,
      nativeRouter,
    } = await deployFixture();
    const amountIn = ethers.parseEther("1");
    const quote = await pool.quoteExactInput(amountIn, wrappedIsToken0);
    const recipientBefore = await token.balanceOf(recipient.address);

    await nativeRouter.connect(trader).swapExactNativeForToken(
      await pool.getAddress(),
      quote,
      DEADLINE,
      recipient.address,
      { value: amountIn },
    );

    expect(await token.balanceOf(recipient.address)).to.equal(recipientBefore + quote);
    expect(await wrapped.balanceOf(await nativeRouter.getAddress())).to.equal(0n);
    expect(await token.balanceOf(await nativeRouter.getAddress())).to.equal(0n);
    expect(
      await wrapped.allowance(await nativeRouter.getAddress(), await publicRouter.getAddress()),
    ).to.equal(0n);
  });

  it("unwraps wrapped-native exact output and sends native value to the recipient", async function () {
    const {
      trader,
      recipient,
      wrapped,
      token,
      pool,
      wrappedIsToken0,
      publicRouter,
      nativeRouter,
    } = await deployFixture();
    const amountIn = ethers.parseEther("1");
    const zeroForOne = !wrappedIsToken0;
    const quote = await pool.quoteExactInput(amountIn, zeroForOne);
    await token.mint(trader.address, amountIn);
    await token.connect(trader).approve(await nativeRouter.getAddress(), amountIn);
    const recipientBefore = await ethers.provider.getBalance(recipient.address);

    await nativeRouter.connect(trader).swapExactTokenForNative(
      await pool.getAddress(),
      amountIn,
      quote,
      DEADLINE,
      recipient.address,
    );

    expect(await ethers.provider.getBalance(recipient.address)).to.equal(recipientBefore + quote);
    expect(await wrapped.balanceOf(await nativeRouter.getAddress())).to.equal(0n);
    expect(await token.balanceOf(await nativeRouter.getAddress())).to.equal(0n);
    expect(
      await token.allowance(await nativeRouter.getAddress(), await publicRouter.getAddress()),
    ).to.equal(0n);
  });

  it("rolls native input back when final slippage protection fails", async function () {
    const { trader, wrapped, token, pool, wrappedIsToken0, nativeRouter } =
      await deployFixture();
    const amountIn = ethers.parseEther("1");
    const quote = await pool.quoteExactInput(amountIn, wrappedIsToken0);
    const poolWrappedBefore = await wrapped.balanceOf(await pool.getAddress());
    const poolTokenBefore = await token.balanceOf(await pool.getAddress());

    await expect(
      nativeRouter.connect(trader).swapExactNativeForToken(
        await pool.getAddress(),
        quote + 1n,
        DEADLINE,
        trader.address,
        { value: amountIn },
      ),
    ).to.be.revertedWithCustomError(nativeRouter, "SlippageExceeded");

    expect(await wrapped.balanceOf(await pool.getAddress())).to.equal(poolWrappedBefore);
    expect(await token.balanceOf(await pool.getAddress())).to.equal(poolTokenBefore);
    expect(await wrapped.balanceOf(await nativeRouter.getAddress())).to.equal(0n);
    expect(await token.balanceOf(await nativeRouter.getAddress())).to.equal(0n);
  });

  it("rejects non-canonical pools, pools without wrapped native, and direct native transfers", async function () {
    const { trader, token, factory, nativeRouter } = await deployFixture();
    await expect(
      nativeRouter.connect(trader).swapExactNativeForToken(
        await token.getAddress(),
        0n,
        DEADLINE,
        trader.address,
        { value: 1n },
      ),
    ).to.be.revertedWithCustomError(nativeRouter, "InvalidPool");

    const other = await (await ethers.getContractFactory("MockERC20")).deploy(
      "Other Token",
      "OTHER",
      18,
    );
    await other.waitForDeployment();
    await factory.createPool(
      await token.getAddress(),
      await other.getAddress(),
      18,
      18,
      30,
    );
    const key = await factory.poolKey(
      await token.getAddress(),
      await other.getAddress(),
      18,
      18,
      30,
    );
    await expect(
      nativeRouter.connect(trader).swapExactNativeForToken(
        await factory.getPool(key),
        0n,
        DEADLINE,
        trader.address,
        { value: 1n },
      ),
    ).to.be.revertedWithCustomError(nativeRouter, "WrappedNativePairRequired");

    await expect(
      trader.sendTransaction({ to: await nativeRouter.getAddress(), value: 1n }),
    ).to.be.revertedWithCustomError(nativeRouter, "UnexpectedNativeSender");
  });

  it("binds the adapter to a router from the same immutable factory", async function () {
    const { wrapped, factory, publicLiquidityRouter } = await deployFixture();
    const otherVault = await deployFeeVault();
    const otherFactory = await (await ethers.getContractFactory("PublicCPMMFactory")).deploy(
      await otherVault.getAddress(),
    );
    await otherFactory.waitForDeployment();
    const otherRouter = await (await ethers.getContractFactory("PublicCPMMRouter")).deploy(
      await otherFactory.getAddress(),
    );
    await otherRouter.waitForDeployment();
    const nativeFactory = await ethers.getContractFactory("PublicCPMMNativeRouter");

    await expect(
      nativeFactory.deploy(
        await factory.getAddress(),
        await otherRouter.getAddress(),
        await publicLiquidityRouter.getAddress(),
        await wrapped.getAddress(),
      ),
    ).to.be.revertedWithCustomError(nativeFactory, "InvalidConfiguration");
  });

  it("keeps wrapped supply fully backed across deposit and withdrawal", async function () {
    const { trader, wrapped } = await deployFixture();
    const amount = ethers.parseEther("2");
    const backingBefore = await ethers.provider.getBalance(await wrapped.getAddress());
    const supplyBefore = await wrapped.totalSupply();

    await wrapped.connect(trader).deposit({ value: amount });
    expect(await wrapped.balanceOf(trader.address)).to.equal(amount);
    expect(await wrapped.totalSupply()).to.equal(supplyBefore + amount);
    expect(await ethers.provider.getBalance(await wrapped.getAddress())).to.equal(
      backingBefore + amount,
    );

    await wrapped.connect(trader).withdraw(amount);
    expect(await wrapped.balanceOf(trader.address)).to.equal(0n);
    expect(await wrapped.totalSupply()).to.equal(supplyBefore);
    expect(await ethers.provider.getBalance(await wrapped.getAddress())).to.equal(backingBefore);
  });

  it("adds native liquidity atomically and refunds the unused paired-token maximum", async function () {
    const { owner, wrapped, token, pool, nativeRouter } = await deployFixture();
    const nativeDesired = ethers.parseEther("1");
    const tokenDesired = ethers.parseEther("2");
    await token.mint(owner.address, tokenDesired);
    await token.approve(await nativeRouter.getAddress(), tokenDesired);
    const lp = await ethers.getContractAt("PublicLPToken", await pool.lpToken());
    const lpBefore = await lp.balanceOf(owner.address);

    const result = await nativeRouter.createOrAddLiquidityNative.staticCall(
      await token.getAddress(),
      18,
      30,
      tokenDesired,
      1n,
      0n,
      ethers.MaxUint256,
      DEADLINE,
      owner.address,
      { value: nativeDesired },
    );
    await nativeRouter.createOrAddLiquidityNative(
      await token.getAddress(),
      18,
      30,
      tokenDesired,
      1n,
      0n,
      ethers.MaxUint256,
      DEADLINE,
      owner.address,
      { value: nativeDesired },
    );

    expect(result[0]).to.equal(await pool.getAddress());
    expect(result[2]).to.equal(nativeDesired);
    expect(result[3]).to.equal(nativeDesired);
    expect(await token.balanceOf(owner.address)).to.equal(tokenDesired - nativeDesired);
    expect(await lp.balanceOf(owner.address)).to.equal(lpBefore + result[1]);
    expect(await wrapped.balanceOf(await nativeRouter.getAddress())).to.equal(0n);
    expect(await token.balanceOf(await nativeRouter.getAddress())).to.equal(0n);
  });

  it("removes liquidity and unwraps WCOTI atomically through an LP permit", async function () {
    const {
      owner,
      recipient,
      wrapped,
      token,
      pool,
      nativeRouter,
      publicLiquidityRouter,
    } = await deployFixture();
    const lp = await ethers.getContractAt("PublicLPToken", await pool.lpToken());
    const shareInput = (await lp.balanceOf(owner.address)) / 10n;
    const totalShares = await lp.totalSupply();
    const [reserve0, reserve1] = await pool.effectiveReserves();
    const wrappedIsToken0 = (await pool.token0()).toLowerCase() ===
      (await wrapped.getAddress()).toLowerCase();
    const expectedNative = shareInput * (wrappedIsToken0 ? reserve0 : reserve1) / totalShares;
    const expectedToken = shareInput * (wrappedIsToken0 ? reserve1 : reserve0) / totalShares;
    const permitDeadline = BigInt(Math.floor(Date.now() / 1000) + 3_600);
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const nonce = await lp.nonces(owner.address);
    const signature = ethers.Signature.from(await owner.signTypedData(
      {
        name: "CipherDEX Public LP Share",
        version: "1",
        chainId,
        verifyingContract: await lp.getAddress(),
      },
      {
        Permit: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      {
        owner: owner.address,
        spender: await nativeRouter.getAddress(),
        value: shareInput,
        nonce,
        deadline: permitDeadline,
      },
    ));
    const recipientNativeBefore = await ethers.provider.getBalance(recipient.address);
    const recipientTokenBefore = await token.balanceOf(recipient.address);

    await nativeRouter.removeLiquidityNativeWithPermit(
      await pool.getAddress(),
      shareInput,
      expectedToken,
      expectedNative,
      DEADLINE,
      recipient.address,
      permitDeadline,
      signature.v,
      signature.r,
      signature.s,
    );

    expect(await ethers.provider.getBalance(recipient.address)).to.equal(
      recipientNativeBefore + expectedNative,
    );
    expect(await token.balanceOf(recipient.address)).to.equal(
      recipientTokenBefore + expectedToken,
    );
    expect(await lp.balanceOf(await nativeRouter.getAddress())).to.equal(0n);
    expect(await lp.balanceOf(await publicLiquidityRouter.getAddress())).to.equal(0n);
    expect(await wrapped.balanceOf(await nativeRouter.getAddress())).to.equal(0n);
    expect(await token.balanceOf(await nativeRouter.getAddress())).to.equal(0n);
  });

  it("remains overcollateralized when native value is forced into the wrapper", async function () {
    const { wrapped } = await deployFixture();
    const wrapperAddress = await wrapped.getAddress();
    const supplyBefore = await wrapped.totalSupply();
    const backingBefore = await ethers.provider.getBalance(wrapperAddress);
    const forcedBacking = backingBefore + 1n;

    await ethers.provider.send("hardhat_setBalance", [
      wrapperAddress,
      `0x${forcedBacking.toString(16)}`,
    ]);

    expect(await wrapped.totalSupply()).to.equal(supplyBefore);
    expect(await ethers.provider.getBalance(wrapperAddress)).to.equal(forcedBacking);
    expect(await ethers.provider.getBalance(wrapperAddress)).to.be.gte(
      await wrapped.totalSupply(),
    );
  });
});
