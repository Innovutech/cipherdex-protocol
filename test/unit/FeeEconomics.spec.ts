import { expect } from "chai";
import { ethers } from "hardhat";
import { deployFeeVault } from "../helpers/deployFeeVault";

const DEADLINE = 0xffffffff;

async function deployPublicFeeFixture() {
  const [beneficiary, lp, trader, outsider] = await ethers.getSigners();
  const vault = await deployFeeVault(beneficiary.address);
  const tokenFactory = await ethers.getContractFactory("MockERC20");
  const token0 = await tokenFactory.deploy("Token 0", "TK0", 18);
  const token1 = await tokenFactory.deploy("Token 1", "TK1", 18);
  await token0.waitForDeployment();
  await token1.waitForDeployment();

  const pool = await (await ethers.getContractFactory("PublicCPMM")).deploy(
    await token0.getAddress(),
    await token1.getAddress(),
    18,
    18,
    30,
    await vault.getAddress(),
  );
  await pool.waitForDeployment();

  const initial = 1_000_000n;
  await token0.mint(lp.address, initial * 2n);
  await token1.mint(lp.address, initial * 2n);
  await token0.mint(trader.address, initial);
  await token1.mint(trader.address, initial);
  await token0.connect(lp).approve(await pool.getAddress(), ethers.MaxUint256);
  await token1.connect(lp).approve(await pool.getAddress(), ethers.MaxUint256);
  await token0.connect(trader).approve(await pool.getAddress(), ethers.MaxUint256);
  await token1.connect(trader).approve(await pool.getAddress(), ethers.MaxUint256);
  await pool.connect(lp).addLiquidity(initial, initial, 1n, 0n, ethers.MaxUint256, DEADLINE);

  return { beneficiary, lp, trader, outsider, vault, token0, token1, pool, initial };
}

describe("CipherDEX v1 fee economics", function () {
  it("pins approved total-fee tiers and the immutable one-sixth protocol split", async function () {
    const [beneficiary] = await ethers.getSigners();
    const vault = await deployFeeVault(beneficiary.address);
    const factory = await (await ethers.getContractFactory("PublicCPMMFactory")).deploy(
      await vault.getAddress(),
    );
    await factory.waitForDeployment();

    expect(await factory.isApprovedFeeTier(5)).to.equal(true);
    expect(await factory.isApprovedFeeTier(30)).to.equal(true);
    expect(await factory.isApprovedFeeTier(100)).to.equal(true);
    expect(await factory.isApprovedFeeTier(0)).to.equal(false);
    expect(await factory.isApprovedFeeTier(25)).to.equal(false);
    expect(await factory.PROTOCOL_FEE_SHARE_NUMERATOR()).to.equal(1n);
    expect(await factory.PROTOCOL_FEE_SHARE_DENOMINATOR()).to.equal(6n);

    await expect(
      (await ethers.getContractFactory("CipherDEXFeeVault")).deploy(ethers.ZeroAddress),
    ).to.be.revertedWithCustomError(vault, "InvalidBeneficiary");
    await expect(
      (await ethers.getContractFactory("PublicCPMMFactory")).deploy(beneficiary.address),
    ).to.be.revertedWithCustomError(factory, "InvalidFeeVault");
  });

  it("separates public and confidential vault sweep paths", async function () {
    const [beneficiary, outsider] = await ethers.getSigners();
    const vault = await deployFeeVault(beneficiary.address);
    const publicToken = await (await ethers.getContractFactory("MockERC20")).deploy(
      "Public token",
      "PUB",
      18,
    );
    const privateToken = await (await ethers.getContractFactory("PrivateLPToken")).deploy(
      beneficiary.address,
    );
    await publicToken.waitForDeployment();
    await privateToken.waitForDeployment();

    await expect(vault.sweepPublicToken(await privateToken.getAddress()))
      .to.be.revertedWithCustomError(vault, "InvalidTokenMode");
    await expect(vault.sweepConfidentialToken(await publicToken.getAddress()))
      .to.be.revertedWithCustomError(vault, "InvalidTokenMode");
    await expect(vault.connect(outsider).sweepConfidentialToken(await privateToken.getAddress()))
      .to.be.revertedWithCustomError(vault, "BeneficiaryOnly");
    await expect(vault.sweepConfidentialToken(await privateToken.getAddress()))
      .to.be.revertedWithCustomError(vault, "ConfidentialSweepNotReady");
    expect(
      await vault.getFunction("MIN_CONFIDENTIAL_SWEEP_DELAY").staticCall(),
    ).to.equal(86_400n);
  });

  it("rejects a reentrant public-token callback during a vault sweep", async function () {
    const [beneficiary] = await ethers.getSigners();
    const vault = await deployFeeVault(beneficiary.address);
    const token = await (await ethers.getContractFactory("ReentrantERC20")).deploy(18);
    await token.waitForDeployment();

    const vaultAddress = await vault.getAddress();
    const tokenAddress = await token.getAddress();
    await token.mint(vaultAddress, 100n);
    await token.configureCallback(
      vaultAddress,
      vault.interface.encodeFunctionData("sweepPublicToken", [tokenAddress]),
    );

    await expect(vault.sweepPublicToken(tokenAddress))
      .to.be.revertedWithCustomError(vault, "BeneficiaryOnly");
    expect(await token.balanceOf(vaultAddress)).to.equal(100n);
    expect(await token.balanceOf(beneficiary.address)).to.equal(0n);
  });

  it("accrues each input token separately while preserving quote and effective-reserve math", async function () {
    const { trader, pool, token0, token1, initial } = await deployPublicFeeFixture();
    const poolAddress = await pool.getAddress();

    const amount0In = 10_000n;
    const output0 = await pool.quoteExactInput(amount0In, true);
    await pool.connect(trader).swapExactInput(amount0In, output0, true, DEADLINE);
    expect(await pool.protocolFees0()).to.equal(5n);
    expect(await pool.protocolFees1()).to.equal(0n);

    let [effective0, effective1] = await pool.effectiveReserves();
    expect(effective0).to.equal(initial + amount0In - 5n);
    expect(effective1).to.equal(initial - output0);
    expect(await token0.balanceOf(poolAddress)).to.equal(effective0 + 5n);

    const amount1In = 20_000n;
    const output1 = await pool.quoteExactInput(amount1In, false);
    await pool.connect(trader).swapExactInput(amount1In, output1, false, DEADLINE);
    expect(await pool.protocolFees0()).to.equal(5n);
    expect(await pool.protocolFees1()).to.equal(10n);

    [effective0, effective1] = await pool.effectiveReserves();
    expect(await token0.balanceOf(poolAddress)).to.equal(effective0 + 5n);
    expect(await token1.balanceOf(poolAddress)).to.equal(effective1 + 10n);
  });

  it("rounds the total fee up through net-input flooring and the protocol share down", async function () {
    const { trader, pool } = await deployPublicFeeFixture();

    const tinyInput = 334n;
    const tinyOutput = await pool.quoteExactInput(tinyInput, true);
    await pool.connect(trader).swapExactInput(tinyInput, tinyOutput, true, DEADLINE);
    expect(tinyInput - (tinyInput * 9_970n) / 10_000n).to.equal(2n);
    expect(await pool.protocolFees0()).to.equal(0n);

    const thresholdInput = 2_000n;
    const thresholdOutput = await pool.quoteExactInput(thresholdInput, true);
    await pool.connect(trader).swapExactInput(
      thresholdInput,
      thresholdOutput,
      true,
      DEADLINE,
    );
    expect(thresholdInput - (thresholdInput * 9_970n) / 10_000n).to.equal(6n);
    expect(await pool.protocolFees0()).to.equal(1n);
  });

  it("collects to the fixed vault without moving price or giving an outsider withdrawal authority", async function () {
    const { beneficiary, trader, outsider, vault, token0, token1, pool } =
      await deployPublicFeeFixture();
    const amount0In = 10_000n;
    const amount1In = 20_000n;
    await pool.connect(trader).swapExactInput(
      amount0In,
      await pool.quoteExactInput(amount0In, true),
      true,
      DEADLINE,
    );
    await pool.connect(trader).swapExactInput(
      amount1In,
      await pool.quoteExactInput(amount1In, false),
      false,
      DEADLINE,
    );

    const reservesBefore = await pool.effectiveReserves();
    const quoteBefore = await pool.quoteExactInput(1_000n, true);
    await pool.connect(outsider).collectProtocolFees(true, true);
    expect(await pool.effectiveReserves()).to.deep.equal(reservesBefore);
    expect(await pool.quoteExactInput(1_000n, true)).to.equal(quoteBefore);
    expect(await token0.balanceOf(await vault.getAddress())).to.equal(5n);
    expect(await token1.balanceOf(await vault.getAddress())).to.equal(10n);
    expect(await pool.protocolFees0()).to.equal(0n);
    expect(await pool.protocolFees1()).to.equal(0n);

    await expect(vault.connect(outsider).sweepPublicToken(await token0.getAddress()))
      .to.be.revertedWithCustomError(vault, "BeneficiaryOnly");
    const beneficiaryBefore = await token0.balanceOf(beneficiary.address);
    await vault.connect(beneficiary).sweepPublicToken(await token0.getAddress());
    expect(await token0.balanceOf(beneficiary.address)).to.equal(beneficiaryBefore + 5n);
  });

  it("excludes protocol fees from a full LP exit and supports reinitialization before collection", async function () {
    const { lp, trader, vault, token0, token1, pool, initial } =
      await deployPublicFeeFixture();
    const poolAddress = await pool.getAddress();
    const amountIn = 10_000n;
    const amountOut = await pool.quoteExactInput(amountIn, true);
    await pool.connect(trader).swapExactInput(amountIn, amountOut, true, DEADLINE);
    const reverseAmountIn = 20_000n;
    await pool.connect(trader).swapExactInput(
      reverseAmountIn,
      await pool.quoteExactInput(reverseAmountIn, false),
      false,
      DEADLINE,
    );

    const [owed0, owed1] = await pool.effectiveReserves();
    expect(await pool.protocolFees0()).to.equal(5n);
    expect(await pool.protocolFees1()).to.equal(10n);
    await pool.connect(lp).removeLiquidity(initial, 0n, 0n, DEADLINE);
    expect(await pool.initialized()).to.equal(false);
    expect(await token0.balanceOf(poolAddress)).to.equal(5n);
    expect(await token1.balanceOf(poolAddress)).to.equal(10n);
    expect(owed0).to.be.greaterThan(0n);
    expect(owed1).to.be.greaterThan(0n);

    await pool.connect(lp).addLiquidity(initial, initial, 1n, 0n, ethers.MaxUint256, DEADLINE);
    expect(await pool.effectiveReserves()).to.deep.equal([initial, initial]);
    expect(await token0.balanceOf(poolAddress)).to.equal(initial + 5n);

    await pool.collectProtocolFees(true, true);
    expect(await pool.effectiveReserves()).to.deep.equal([initial, initial]);
    expect(await token0.balanceOf(await vault.getAddress())).to.equal(5n);
    expect(await token1.balanceOf(await vault.getAddress())).to.equal(10n);
  });

  it("collects outbound-tax fees independently without changing effective reserves", async function () {
    const [lp, trader] = await ethers.getSigners();
    const vault = await deployFeeVault();
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
    await Promise.all([normal.waitForDeployment(), taxed.waitForDeployment()]);
    const pool = await (await ethers.getContractFactory("PublicCPMM")).deploy(
      await normal.getAddress(),
      await taxed.getAddress(),
      18,
      18,
      30,
      await vault.getAddress(),
    );
    await pool.waitForDeployment();

    const poolAddress = await pool.getAddress();
    await taxed.setTaxedSender(poolAddress);
    const initial = 10_000_000n;
    await normal.mint(lp.address, initial);
    await taxed.mint(lp.address, initial);
    await normal.mint(trader.address, 1_000_000n);
    await taxed.mint(trader.address, 1_000_000n);
    await normal.connect(lp).approve(poolAddress, initial);
    await taxed.connect(lp).approve(poolAddress, initial);
    await normal.connect(trader).approve(poolAddress, ethers.MaxUint256);
    await taxed.connect(trader).approve(poolAddress, ethers.MaxUint256);
    await pool.connect(lp).addLiquidity(
      initial,
      initial,
      1n,
      0n,
      ethers.MaxUint256,
      DEADLINE,
    );

    const taxedIsToken0 = (await pool.token0()).toLowerCase() ===
      (await taxed.getAddress()).toLowerCase();
    await pool.connect(trader).swapExactInput(1_000_000n, 0n, taxedIsToken0, DEADLINE);
    await pool.connect(trader).swapExactInput(1_000_000n, 0n, !taxedIsToken0, DEADLINE);
    const taxedAccrued = taxedIsToken0
      ? await pool.protocolFees0()
      : await pool.protocolFees1();
    const normalAccrued = taxedIsToken0
      ? await pool.protocolFees1()
      : await pool.protocolFees0();
    expect(taxedAccrued).to.equal(500n);
    expect(normalAccrued).to.equal(500n);

    const reservesBefore = await pool.effectiveReserves();
    await pool.collectProtocolFees(!taxedIsToken0, taxedIsToken0);
    expect(await normal.balanceOf(await vault.getAddress())).to.equal(normalAccrued);
    expect(taxedIsToken0 ? await pool.protocolFees0() : await pool.protocolFees1())
      .to.equal(taxedAccrued);

    const [received0, received1] = taxedIsToken0
      ? await pool.collectProtocolFees.staticCall(true, false)
      : await pool.collectProtocolFees.staticCall(false, true);
    expect(taxedIsToken0 ? received0 : received1).to.equal(495n);
    await pool.collectProtocolFees(taxedIsToken0, !taxedIsToken0);
    expect(await taxed.balanceOf(await vault.getAddress())).to.equal(495n);
    expect(await pool.effectiveReserves()).to.deep.equal(reservesBefore);
    expect(await pool.protocolFees0()).to.equal(0n);
    expect(await pool.protocolFees1()).to.equal(0n);
  });
});
