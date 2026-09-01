import { expect } from "chai";
import { AbiCoder, Interface, keccak256 } from "ethers";

import { artifacts, ethers } from "../../hardhat/runtime.js";
import {
  configureObservableConfidentialLaunch,
  deployObservableConfidentialFactory,
} from "../helpers/deployObservableConfidentialFactory";

describe("observable confidential stack", function () {
  it("deploys a separately bound mode-2 stack while reusing its LP issuer", async function () {
    const deployment = await deployObservableConfidentialFactory();
    const configured = await configureObservableConfidentialLaunch(deployment);
    const metadata = await ethers.getContractFactory("MockTokenMetadata");
    const tokenA = await metadata.deploy(18);
    const tokenB = await metadata.deploy(6);
    await Promise.all([tokenA.waitForDeployment(), tokenB.waitForDeployment()]);

    expect(await deployment.factory.PROTOCOL_VERSION()).to.equal(1n);
    expect(await deployment.factory.PRIVACY_MODE()).to.equal(2n);
    expect(await deployment.factory.lpTokenFactory()).to.equal(
      await deployment.lpTokenFactory.getAddress(),
    );
    expect(await deployment.vault.PRIVACY_MODE()).to.equal(2n);
    expect(await deployment.vault.confidentialFactory()).to.equal(
      await deployment.factory.getAddress(),
    );
    expect(new Interface(deployment.vault.interface.fragments)
      .getFunction("setPublicFactory")).to.equal(null);
    expect(await configured.router.PRIVACY_MODE()).to.equal(2n);
    expect(await configured.router.factory()).to.equal(
      await deployment.factory.getAddress(),
    );
    expect(await configured.strategy.PRIVACY_MODE()).to.equal(2n);
    expect(await configured.migrator.factory()).to.equal(
      await deployment.factory.getAddress(),
    );

    const poolArtifact = await artifacts.readArtifact(
      "ObservableConfidentialCPMM",
    );
    const deployerArtifact = await artifacts.readArtifact(
      "ObservableConfidentialCPMMDeployer",
    );
    expect((poolArtifact.deployedBytecode.length - 2) / 2).to.be.at.most(24_576);
    expect((deployerArtifact.deployedBytecode.length - 2) / 2).to.be.at.most(24_576);
    expect((deployerArtifact.bytecode.length - 2) / 2).to.be.at.most(49_152);
    expect(await deployment.poolDeployer.creationCodeHash()).to.equal(
      keccak256(poolArtifact.bytecode),
    );
    expect(
      await deployment.poolDeployer.creationCodeSize0() +
      await deployment.poolDeployer.creationCodeSize1(),
    ).to.equal(BigInt((poolArtifact.bytecode.length - 2) / 2));

    await deployment.factory.createPool(
      await tokenA.getAddress(),
      await tokenB.getAddress(),
      18,
      6,
      30,
    );
    const key = await deployment.factory.poolKey(
      await tokenA.getAddress(),
      await tokenB.getAddress(),
      18,
      6,
      30,
      ethers.ZeroAddress,
    );
    const poolAddress = await deployment.factory.getPool(key);
    const pool = await ethers.getContractAt(
      "ObservableConfidentialCPMM",
      poolAddress,
    );
    expect(await pool.PRIVACY_MODE()).to.equal(2n);
    expect(await pool.initialPriceReferenceX18()).to.equal(0n);
    expect(await pool.MIN_OBSERVATION_SWAPS()).to.equal(3n);
    expect(await pool.MIN_OBSERVATION_INTERVAL()).to.equal(120n);
    expect(await pool.OBSERVATION_BUCKET_BPS()).to.equal(50n);
    expect(await pool.publicPriceBucketX18()).to.equal(0n);
    expect(await pool.observationDueForNextSwap()).to.equal(false);
    expect(await deployment.factory.isPool(poolAddress)).to.equal(true);
    expect(await deployment.lpTokenFactory.poolByToken(await pool.lpToken()))
      .to.equal(poolAddress);

    await expect(deployment.factory.createPool(
      await tokenB.getAddress(),
      await tokenA.getAddress(),
      6,
      18,
      30,
    )).to.be.revertedWithCustomError(deployment.factory, "PoolAlreadyExists");

    const emptyInput = {
      ciphertext: { ciphertextHigh: 0n, ciphertextLow: 0n },
      signature: "0x",
    };
    const future = (1n << 64n) - 1n;
    await expect(pool.addLiquidity(
      emptyInput,
      emptyInput,
      emptyInput,
      emptyInput,
      emptyInput,
      false,
      future,
    )).to.be.revertedWithCustomError(pool, "InvalidInitialPriceReference");
    await expect(pool.initializeLiquidity(
      emptyInput,
      emptyInput,
      emptyInput,
      emptyInput,
      emptyInput,
      0,
      future,
    )).to.be.revertedWithCustomError(pool, "InvalidInitialPriceReference");

    const encoder = AbiCoder.defaultAbiCoder();
    const ordered = [await tokenA.getAddress(), await tokenB.getAddress()].sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase())
    );
    const mode1Key = keccak256(encoder.encode(
      ["address", "address", "uint256", "uint8", "uint256", "address"],
      [ordered[0], ordered[1], 30, 1, 1, ethers.ZeroAddress],
    ));
    expect(key).to.not.equal(mode1Key);
  });

  it("keeps public-price disclosure out of the mode-1 ABI", async function () {
    const mode1 = new Interface((await artifacts.readArtifact("ConfidentialCPMM")).abi);
    const mode2 = new Interface(
      (await artifacts.readArtifact("ObservableConfidentialCPMM")).abi,
    );
    expect(mode1.getFunction("publicPriceBucketX18")).to.equal(null);
    expect(mode1.getEvent("PublicPriceObservation")).to.equal(null);
    expect(mode2.getFunction("publicPriceBucketX18")).to.not.equal(null);
    expect(mode2.getEvent("PublicPriceObservation")).to.not.equal(null);
  });
});
