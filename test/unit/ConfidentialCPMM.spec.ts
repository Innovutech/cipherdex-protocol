import { expect } from "chai";
import { ethers } from "hardhat";

describe("ConfidentialCPMM metadata and construction guards", function () {
  async function deploy(feeBps = 30) {
    const metadataFactory = await ethers.getContractFactory("MockTokenMetadata");
    const token0 = await metadataFactory.deploy(18);
    const token1 = await metadataFactory.deploy(6);
    await token0.waitForDeployment();
    await token1.waitForDeployment();
    const factory = await ethers.getContractFactory("ConfidentialCPMM");
    const pool = await factory.deploy(
      await token0.getAddress(),
      await token1.getAddress(),
      18,
      6,
      feeBps,
    );
    await pool.waitForDeployment();
    return { pool, token0, token1 };
  }

  it("pins the pair, fee, decimals and normalization scales", async function () {
    const { pool, token0, token1 } = await deploy();
    expect(await pool.token0()).to.equal(await token0.getAddress());
    expect(await pool.token1()).to.equal(await token1.getAddress());
    expect(await pool.PRIVACY_MODE()).to.equal(1n);
    expect(await pool.feeBps()).to.equal(30n);
    expect(await pool.scale0()).to.equal(1n);
    expect(await pool.scale1()).to.equal(1_000_000_000_000n);
    expect(await pool.initialized()).to.equal(false);
  });

  it("rejects an excessive fee", async function () {
    const metadataFactory = await ethers.getContractFactory("MockTokenMetadata");
    const token0 = await metadataFactory.deploy(18);
    const token1 = await metadataFactory.deploy(18);
    await token0.waitForDeployment();
    await token1.waitForDeployment();
    const factory = await ethers.getContractFactory("ConfidentialCPMM");
    await expect(
      factory.deploy(await token0.getAddress(), await token1.getAddress(), 18, 18, 1_001),
    ).to.be.revertedWithCustomError(factory, "InvalidFee");
  });

  it("rejects token decimals that do not match public token metadata", async function () {
    const metadataFactory = await ethers.getContractFactory("MockTokenMetadata");
    const token0 = await metadataFactory.deploy(18);
    const token1 = await metadataFactory.deploy(6);
    await token0.waitForDeployment();
    await token1.waitForDeployment();
    const factory = await ethers.getContractFactory("ConfidentialCPMM");
    await expect(
      factory.deploy(await token0.getAddress(), await token1.getAddress(), 18, 18, 30),
    ).to.be.revertedWithCustomError(factory, "InvalidDecimals");
  });

  it("rejects a zero or identical token pair", async function () {
    const metadataFactory = await ethers.getContractFactory("MockTokenMetadata");
    const token0 = await metadataFactory.deploy(18);
    await token0.waitForDeployment();
    const factory = await ethers.getContractFactory("ConfidentialCPMM");
    await expect(
      factory.deploy(ethers.ZeroAddress, await token0.getAddress(), 18, 18, 30),
    ).to.be.revertedWithCustomError(factory, "InvalidTokenPair");
    await expect(
      factory.deploy(await token0.getAddress(), await token0.getAddress(), 18, 18, 30),
    ).to.be.revertedWithCustomError(factory, "InvalidTokenPair");
  });

  it("rejects an expired swap before touching encrypted inputs", async function () {
    const { pool } = await deploy();
    const emptyInput = {
      ciphertext: { ciphertextHigh: 0n, ciphertextLow: 0n },
      signature: "0x",
    };
    await expect(
      pool.swapExactInput(emptyInput, emptyInput, true, 0),
    ).to.be.revertedWithCustomError(pool, "DeadlineExpired");
  });

  it("rejects invalid launchpad disposition metadata before MPC inputs", async function () {
    const { pool } = await deploy();
    await expect(
      pool.bootstrapLiquidityWithDisposition(
        await (await ethers.getSigners())[0].getAddress(),
        1n,
        1n,
        1n,
        0n,
        2n,
        3,
        0,
      ),
    ).to.be.revertedWithCustomError(pool, "InvalidLPDisposition");
    await expect(
      pool.bootstrapLiquidityWithDisposition(
        await (await ethers.getSigners())[0].getAddress(),
        1n,
        1n,
        1n,
        0n,
        2n,
        2,
        1,
      ),
    ).to.be.revertedWithCustomError(pool, "InvalidLPDisposition");
  });
});
