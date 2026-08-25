import { expect } from "chai";
import { ethers } from "../../hardhat/runtime.js";
import { deployFeeVault } from "../helpers/deployFeeVault";

describe("PublicLPToken", function () {
  const DEADLINE = 0xffffffff;

  async function deployFixture() {
    const [provider, recipient, attacker] = await ethers.getSigners();
    const tokenFactory = await ethers.getContractFactory("MockERC20");
    const tokenA = await tokenFactory.deploy("Token A", "TKA", 18);
    const tokenB = await tokenFactory.deploy("Token B", "TKB", 18);
    await Promise.all([tokenA.waitForDeployment(), tokenB.waitForDeployment()]);
    const vault = await deployFeeVault();
    const factory = await (
      await ethers.getContractFactory("PublicCPMMFactory")
    ).deploy(await vault.getAddress());
    const liquidityRouter = await (
      await ethers.getContractFactory("PublicCPMMLiquidityRouter")
    ).deploy(await factory.getAddress());
    await Promise.all([factory.waitForDeployment(), liquidityRouter.waitForDeployment()]);

    const amount = ethers.parseEther("100");
    await tokenA.mint(provider.address, amount);
    await tokenB.mint(provider.address, amount);
    await tokenA.approve(await liquidityRouter.getAddress(), amount);
    await tokenB.approve(await liquidityRouter.getAddress(), amount);
    const result = await liquidityRouter.createOrAddLiquidity.staticCall(
      await tokenA.getAddress(),
      await tokenB.getAddress(),
      18,
      18,
      30,
      amount,
      amount,
      1n,
      0n,
      ethers.MaxUint256,
      DEADLINE,
    );
    await liquidityRouter.createOrAddLiquidity(
      await tokenA.getAddress(),
      await tokenB.getAddress(),
      18,
      18,
      30,
      amount,
      amount,
      1n,
      0n,
      ethers.MaxUint256,
      DEADLINE,
    );
    const pool = await ethers.getContractAt("PublicCPMM", result[0]);
    const lp = await ethers.getContractAt("PublicLPToken", await pool.lpToken());
    return {
      provider,
      recipient,
      attacker,
      tokenA,
      tokenB,
      factory,
      liquidityRouter,
      pool,
      lp,
      mintedShares: result[1],
    };
  }

  it("binds one canonical permit-enabled LP token to its pool", async function () {
    const { provider, factory, pool, lp, mintedShares } = await deployFixture();
    const lpFactory = await ethers.getContractAt(
      "PublicLPTokenFactory",
      await factory.lpTokenFactory(),
    );

    expect(await lp.pool()).to.equal(await pool.getAddress());
    expect(await lp.totalSupply()).to.equal(mintedShares);
    expect(await lp.balanceOf(provider.address)).to.equal(mintedShares);
    expect(await pool.totalShares()).to.equal(mintedShares);
    expect(await pool.shares(provider.address)).to.equal(mintedShares);
    expect(
      await lpFactory.isIssuedToken(
        await pool.getAddress(),
        await lp.getAddress(),
        await pool.getAddress(),
      ),
    ).to.equal(true);
  });

  it("allows ordinary LP transfers while retaining pool-only supply authority", async function () {
    const { provider, recipient, attacker, pool, lp, mintedShares } = await deployFixture();
    const transferred = mintedShares / 4n;
    await lp.transfer(recipient.address, transferred);

    expect(await lp.balanceOf(recipient.address)).to.equal(transferred);
    expect(await pool.shares(recipient.address)).to.equal(transferred);
    await expect(
      lp.connect(attacker).mintFromPool(attacker.address, 1n),
    ).to.be.revertedWithCustomError(lp, "PoolOnly");
    await expect(
      lp.connect(attacker).burnFromPool(provider.address, 1n),
    ).to.be.revertedWithCustomError(lp, "PoolOnly");
    await expect(
      lp.connect(attacker).escrowFromPool(provider.address, 1n),
    ).to.be.revertedWithCustomError(lp, "PoolOnly");
  });

  it("escrows timed locks without changing total supply and releases only the owner record", async function () {
    const { provider, attacker, pool, lp, mintedShares } = await deployFixture();
    const locked = mintedShares / 5n;
    const latest = await ethers.provider.getBlock("latest");
    const unlockTime = BigInt(latest!.timestamp + 60);
    const tx = await pool.lockShares(locked, unlockTime, false, DEADLINE);
    const receipt = await tx.wait();
    const event = receipt?.logs
      .map((log) => {
        try {
          return pool.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((entry) => entry?.name === "LiquidityLocked");
    const lockId = event?.args.lockId as string;

    expect(await lp.balanceOf(await pool.getAddress())).to.equal(locked);
    expect(await lp.totalSupply()).to.equal(mintedShares);
    await expect(pool.connect(attacker).unlockShares(lockId))
      .to.be.revertedWithCustomError(pool, "InvalidLock");
    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(unlockTime)]);
    await pool.unlockShares(lockId);
    expect(await lp.balanceOf(await pool.getAddress())).to.equal(0n);
    expect(await lp.balanceOf(provider.address)).to.equal(mintedShares);
  });

  it("removes transferred shares through one permit-authorized transaction and rejects replay", async function () {
    const {
      provider,
      recipient,
      tokenA,
      tokenB,
      liquidityRouter,
      pool,
      lp,
      mintedShares,
    } = await deployFixture();
    const shareInput = mintedShares / 10n;
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const permitDeadline = BigInt(Math.floor(Date.now() / 1000) + 3_600);
    const nonce = await lp.nonces(provider.address);
    const signature = ethers.Signature.from(await provider.signTypedData(
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
        owner: provider.address,
        spender: await liquidityRouter.getAddress(),
        value: shareInput,
        nonce,
        deadline: permitDeadline,
      },
    ));
    const tokenABefore = await tokenA.balanceOf(recipient.address);
    const tokenBBefore = await tokenB.balanceOf(recipient.address);

    await liquidityRouter.removeLiquidityWithPermit(
      await pool.getAddress(),
      shareInput,
      1n,
      1n,
      DEADLINE,
      recipient.address,
      permitDeadline,
      signature.v,
      signature.r,
      signature.s,
    );

    expect(await tokenA.balanceOf(recipient.address)).to.be.gt(tokenABefore);
    expect(await tokenB.balanceOf(recipient.address)).to.be.gt(tokenBBefore);
    expect(await lp.balanceOf(await liquidityRouter.getAddress())).to.equal(0n);
    expect(await lp.allowance(provider.address, await liquidityRouter.getAddress())).to.equal(0n);
    await expect(
      liquidityRouter.removeLiquidityWithPermit(
        await pool.getAddress(),
        shareInput,
        1n,
        1n,
        DEADLINE,
        recipient.address,
        permitDeadline,
        signature.v,
        signature.r,
        signature.s,
      ),
    ).to.be.revertedWithCustomError(liquidityRouter, "PermitFailed");
  });
});
