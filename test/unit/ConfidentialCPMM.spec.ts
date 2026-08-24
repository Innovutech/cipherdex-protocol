import { expect } from "chai";
import { Interface } from "ethers";
import { ethers } from "../../hardhat/runtime.js";
import { deployFeeVault } from "../helpers/deployFeeVault";

describe("ConfidentialCPMM metadata and construction guards", function () {
  async function deploy(feeBps = 30) {
    const metadataFactory = await ethers.getContractFactory("MockTokenMetadata");
    const token0 = await metadataFactory.deploy(18);
    const token1 = await metadataFactory.deploy(6);
    await token0.waitForDeployment();
    await token1.waitForDeployment();
    const vault = await deployFeeVault();
    const bootstrapAdapter = await (
      await ethers.getContractFactory("MockBootstrapAdapter")
    ).deploy();
    await bootstrapAdapter.waitForDeployment();
    const factory = await ethers.getContractFactory("ConfidentialCPMM");
    const pool = await factory.deploy(
      await token0.getAddress(),
      await token1.getAddress(),
      18,
      6,
      feeBps,
      await vault.getAddress(),
      ethers.ZeroAddress,
      await bootstrapAdapter.getAddress(),
    );
    await pool.waitForDeployment();
    return { bootstrapAdapter, pool, token0, token1, vault };
  }

  it("pins the pair, fee, decimals and normalization scales", async function () {
    const { pool, token0, token1, vault } = await deploy();
    expect(await pool.token0()).to.equal(await token0.getAddress());
    expect(await pool.token1()).to.equal(await token1.getAddress());
    expect(await pool.PRIVACY_MODE()).to.equal(1n);
    expect(await pool.feeBps()).to.equal(30n);
    expect(await pool.feeVault()).to.equal(await vault.getAddress());
    expect(await pool.PROTOCOL_FEE_SHARE_NUMERATOR()).to.equal(1n);
    expect(await pool.PROTOCOL_FEE_SHARE_DENOMINATOR()).to.equal(6n);
    expect(await pool.MIN_CONFIDENTIAL_COLLECTION_SWAPS()).to.equal(8n);
    expect(await pool.MIN_CONFIDENTIAL_COLLECTION_DELAY()).to.equal(3_600n);
    expect(await pool.scale0()).to.equal(1n);
    expect(await pool.scale1()).to.equal(1_000_000_000_000n);
    expect(await pool.initialized()).to.equal(false);
  });

  it("does not expose public reserve-derived market data", async function () {
    const { bootstrapAdapter, pool } = await deploy();
    const abi = new Interface(pool.interface.fragments);
    expect(abi.getFunction("publishSpotPrice")).to.equal(null);
    expect(abi.getFunction("publicSpotPriceX18")).to.equal(null);
    expect(abi.getFunction("publicPriceCumulativeX18SecondsNow")).to.equal(null);
    expect(abi.getFunction("quoteExactInput")).to.not.equal(null);
    expect(abi.getFunction("requestQuoteExactInput")).to.not.equal(null);
    expect(abi.getFunction("requestAddLiquidityQuote")).to.not.equal(null);
    expect(abi.getFunction("requestMyPosition")).to.not.equal(null);
    expect(abi.getFunction("requestRemoveLiquidityQuote")).to.not.equal(null);
    expect(abi.getFunction("requestLockedPosition")).to.not.equal(null);
    expect(abi.getEvent("ConfidentialQuoteResult")).to.not.equal(null);
    expect(abi.getEvent("ConfidentialLiquidityQuoteResult")).to.not.equal(null);
    expect(abi.getEvent("ConfidentialPositionResult")).to.not.equal(null);
    expect(abi.getEvent("ConfidentialRemoveLiquidityQuoteResult")).to.not.equal(null);
    expect(abi.getEvent("ConfidentialLockedPositionResult")).to.not.equal(null);
    expect(abi.getFunction("collectProtocolFees")).to.not.equal(null);
    expect(abi.getEvent("ConfidentialProtocolFeesCollected")).to.not.equal(null);
    expect(abi.getFunction("protocolFees0")).to.equal(null);
    expect(abi.getFunction("protocolFees1")).to.equal(null);
  });

  it("rejects an excessive fee", async function () {
    const metadataFactory = await ethers.getContractFactory("MockTokenMetadata");
    const token0 = await metadataFactory.deploy(18);
    const token1 = await metadataFactory.deploy(18);
    await token0.waitForDeployment();
    await token1.waitForDeployment();
    const vault = await deployFeeVault();
    const factory = await ethers.getContractFactory("ConfidentialCPMM");
    await expect(
      factory.deploy(
        await token0.getAddress(),
        await token1.getAddress(),
        18,
        18,
        1_001,
        await vault.getAddress(),
        ethers.ZeroAddress,
        await vault.getAddress(),
      ),
    ).to.be.revertedWithCustomError(factory, "InvalidFee");
  });

  it("rejects a non-v1 fee tier", async function () {
    const metadataFactory = await ethers.getContractFactory("MockTokenMetadata");
    const token0 = await metadataFactory.deploy(18);
    const token1 = await metadataFactory.deploy(18);
    await token0.waitForDeployment();
    await token1.waitForDeployment();
    const vault = await deployFeeVault();
    const factory = await ethers.getContractFactory("ConfidentialCPMM");
    await expect(
      factory.deploy(
        await token0.getAddress(),
        await token1.getAddress(),
        18,
        18,
        25,
        await vault.getAddress(),
        ethers.ZeroAddress,
        await vault.getAddress(),
      ),
    ).to.be.revertedWithCustomError(factory, "InvalidFee");
  });

  it("rejects token decimals that do not match public token metadata", async function () {
    const metadataFactory = await ethers.getContractFactory("MockTokenMetadata");
    const token0 = await metadataFactory.deploy(18);
    const token1 = await metadataFactory.deploy(6);
    await token0.waitForDeployment();
    await token1.waitForDeployment();
    const vault = await deployFeeVault();
    const factory = await ethers.getContractFactory("ConfidentialCPMM");
    await expect(
      factory.deploy(
        await token0.getAddress(),
        await token1.getAddress(),
        18,
        18,
        30,
        await vault.getAddress(),
        ethers.ZeroAddress,
        await vault.getAddress(),
      ),
    ).to.be.revertedWithCustomError(factory, "InvalidDecimals");
  });

  it("rejects ordinary ERC-20 contracts that do not advertise the private-token interface", async function () {
    const publicToken = await (
      await ethers.getContractFactory("MockERC20")
    ).deploy("Public Token", "PUB", 18);
    const privateMetadata = await (
      await ethers.getContractFactory("MockTokenMetadata")
    ).deploy(18);
    await Promise.all([publicToken.waitForDeployment(), privateMetadata.waitForDeployment()]);
    const vault = await deployFeeVault();
    const poolFactory = await ethers.getContractFactory("ConfidentialCPMM");

    await expect(
      poolFactory.deploy(
        await publicToken.getAddress(),
        await privateMetadata.getAddress(),
        18,
        18,
        30,
        await vault.getAddress(),
        ethers.ZeroAddress,
        await vault.getAddress(),
      ),
    ).to.be.revertedWithCustomError(poolFactory, "UnsupportedPrivateToken");
  });

  it("rejects a zero or identical token pair", async function () {
    const metadataFactory = await ethers.getContractFactory("MockTokenMetadata");
    const token0 = await metadataFactory.deploy(18);
    await token0.waitForDeployment();
    const vault = await deployFeeVault();
    const factory = await ethers.getContractFactory("ConfidentialCPMM");
    await expect(
      factory.deploy(
        ethers.ZeroAddress,
        await token0.getAddress(),
        18,
        18,
        30,
        await vault.getAddress(),
        ethers.ZeroAddress,
        await vault.getAddress(),
      ),
    ).to.be.revertedWithCustomError(factory, "InvalidTokenPair");
    await expect(
      factory.deploy(
        await token0.getAddress(),
        await token0.getAddress(),
        18,
        18,
        30,
        await vault.getAddress(),
        ethers.ZeroAddress,
        await vault.getAddress(),
      ),
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

  it("rejects invalid liquidity previews before touching pool state or MPC inputs", async function () {
    const { pool } = await deploy();
    const emptyInput = {
      ciphertext: { ciphertextHigh: 0n, ciphertextLow: 0n },
      signature: "0x",
    };
    await expect(pool.requestAddLiquidityQuote(
      emptyInput,
      true,
      ethers.ZeroHash,
      0,
    )).to.be.revertedWithCustomError(pool, "DeadlineExpired");
    await expect(pool.requestAddLiquidityQuote(
      emptyInput,
      true,
      ethers.ZeroHash,
      (1n << 64n) - 1n,
    )).to.be.revertedWithCustomError(pool, "InvalidRequestId");
  });

  it("rejects invalid position requests before touching pool state or MPC inputs", async function () {
    const { pool } = await deploy();
    const emptyInput = {
      ciphertext: { ciphertextHigh: 0n, ciphertextLow: 0n },
      signature: "0x",
    };
    const future = (1n << 64n) - 1n;
    const requestId = ethers.id("position-request");
    const lockId = ethers.id("position-lock");

    await expect(pool.requestMyPosition(requestId, 0))
      .to.be.revertedWithCustomError(pool, "DeadlineExpired");
    await expect(pool.requestMyPosition(ethers.ZeroHash, future))
      .to.be.revertedWithCustomError(pool, "InvalidRequestId");
    await expect(pool.requestMyPosition(requestId, future))
      .to.be.revertedWithCustomError(pool, "CanonicalLPTokenRequired");

    await expect(pool.requestRemoveLiquidityQuote(emptyInput, requestId, 0))
      .to.be.revertedWithCustomError(pool, "DeadlineExpired");
    await expect(pool.requestRemoveLiquidityQuote(emptyInput, ethers.ZeroHash, future))
      .to.be.revertedWithCustomError(pool, "InvalidRequestId");
    await expect(pool.requestRemoveLiquidityQuote(emptyInput, requestId, future))
      .to.be.revertedWithCustomError(pool, "CanonicalLPTokenRequired");

    await expect(pool.requestLockedPosition(lockId, requestId, 0))
      .to.be.revertedWithCustomError(pool, "DeadlineExpired");
    await expect(pool.requestLockedPosition(lockId, ethers.ZeroHash, future))
      .to.be.revertedWithCustomError(pool, "InvalidRequestId");
    await expect(pool.requestLockedPosition(lockId, requestId, future))
      .to.be.revertedWithCustomError(pool, "CanonicalLPTokenRequired");
  });

  it("rejects an empty confidential collection request before MPC work", async function () {
    const { pool } = await deploy();
    await expect(pool.collectProtocolFees(false, false))
      .to.be.revertedWithCustomError(pool, "InvalidCollectionSelection");
    await expect(pool.collectProtocolFees(true, false))
      .to.be.revertedWithCustomError(pool, "CanonicalLPTokenRequired");
  });

  it("prevents directly deployed pools from entering the liquidity lifecycle", async function () {
    const { bootstrapAdapter, pool } = await deploy();
    const decoy = await (await ethers.getContractFactory("PrivateLPToken")).deploy(
      await pool.getAddress(),
    );
    await decoy.waitForDeployment();

    await expect(pool.initializeLPToken(await decoy.getAddress()))
      .to.be.revertedWithCustomError(pool, "BootstrapUnauthorized");
    await expect(
      bootstrapAdapter.initializeLPToken(
        await pool.getAddress(),
        await decoy.getAddress(),
      ),
    )
      .to.be.revertedWithCustomError(pool, "InvalidLPToken");
    expect(await pool.lpToken()).to.equal(ethers.ZeroAddress);

    const emptyInput = {
      ciphertext: { ciphertextHigh: 0n, ciphertextLow: 0n },
      signature: "0x",
    };
    await expect(pool.addLiquidity(
      emptyInput,
      emptyInput,
      emptyInput,
      emptyInput,
      emptyInput,
      false,
      (1n << 64n) - 1n,
    )).to.be.revertedWithCustomError(pool, "CanonicalLPTokenRequired");
    const [caller] = await ethers.getSigners();
    await expect(pool.bootstrapLiquidity(
      caller.address,
      caller.address,
      1n,
      1n,
      1n,
      0n,
      1n,
    )).to.be.revertedWithCustomError(pool, "BootstrapUnauthorized");
    await expect(bootstrapAdapter.bootstrapLiquidity(
      await pool.getAddress(),
      caller.address,
      caller.address,
      1n,
      1n,
      1n,
      0n,
      1n,
    )).to.be.revertedWithCustomError(pool, "CanonicalLPTokenRequired");
    await expect(pool.myShares())
      .to.be.revertedWithCustomError(pool, "CanonicalLPTokenRequired");
  });

  it("rejects invalid launchpad disposition metadata before MPC inputs", async function () {
    const { bootstrapAdapter, pool } = await deploy();
    const [caller] = await ethers.getSigners();
    await expect(
      bootstrapAdapter.bootstrapLiquidityWithDisposition(
        await pool.getAddress(),
        caller.address,
        caller.address,
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
      bootstrapAdapter.bootstrapLiquidityWithDisposition(
        await pool.getAddress(),
        caller.address,
        caller.address,
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
