import { expect } from "chai";
import { ethers } from "hardhat";

describe("ConfidentialCPMM metadata and construction guards", function () {
  async function deploy(feeBps = 30) {
    const [token0, token1] = await ethers.getSigners();
    const factory = await ethers.getContractFactory("ConfidentialCPMM");
    const pool = await factory.deploy(
      token0.address,
      token1.address,
      18,
      6,
      feeBps,
    );
    await pool.waitForDeployment();
    return { pool, token0, token1 };
  }

  it("pins the pair, fee, decimals and normalization scales", async function () {
    const { pool, token0, token1 } = await deploy();
    expect(await pool.token0()).to.equal(token0.address);
    expect(await pool.token1()).to.equal(token1.address);
    expect(await pool.feeBps()).to.equal(30n);
    expect(await pool.scale0()).to.equal(1n);
    expect(await pool.scale1()).to.equal(1_000_000_000_000n);
    expect(await pool.initialized()).to.equal(false);
  });

  it("rejects an excessive fee", async function () {
    const [token0, token1] = await ethers.getSigners();
    const factory = await ethers.getContractFactory("ConfidentialCPMM");
    await expect(
      factory.deploy(token0.address, token1.address, 18, 18, 1_001),
    ).to.be.revertedWithCustomError(factory, "InvalidFee");
  });

  it("rejects a zero or identical token pair", async function () {
    const [token0] = await ethers.getSigners();
    const factory = await ethers.getContractFactory("ConfidentialCPMM");
    await expect(
      factory.deploy(ethers.ZeroAddress, token0.address, 18, 18, 30),
    ).to.be.revertedWithCustomError(factory, "InvalidTokenPair");
    await expect(
      factory.deploy(token0.address, token0.address, 18, 18, 30),
    ).to.be.revertedWithCustomError(factory, "InvalidTokenPair");
  });
});

