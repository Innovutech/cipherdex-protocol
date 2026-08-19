import { expect } from "chai";
import { ethers } from "../../hardhat/runtime.js";
import {
  verifyDeployedRuntimeArtifact,
  verifyDeployedRuntimeArtifactWithProvenance,
} from "../../scripts/runtime-artifact";
import {
  configureConfidentialLaunch,
  deployConfidentialFactory,
} from "../helpers/deployConfidentialFactory";

describe("funded runtime artifact verification", function () {
  it("accepts the current artifact including normalized immutable slots", async function () {
    const token = await (await ethers.getContractFactory("MockERC20")).deploy(
      "Runtime Token",
      "RUN",
      18,
    );
    await token.waitForDeployment();
    const address = await token.getAddress();
    expect(await verifyDeployedRuntimeArtifact("MockERC20", address)).to.equal(
      ethers.keccak256(await ethers.provider.getCode(address)),
    );
    const provenance = await verifyDeployedRuntimeArtifactWithProvenance(
      "MockERC20",
      address,
    );
    expect(provenance.runtimeCodehash).to.equal(
      ethers.keccak256(await ethers.provider.getCode(address)),
    );
    expect(provenance.solcVersion).to.equal("0.8.28");
    expect(provenance.settings.optimizer.runs).to.equal(200);
    expect(provenance.settings.viaIR).to.equal(false);
    expect(provenance.compilerInputHash).to.match(/^0x[0-9a-f]{64}$/);
  });

  it("rejects runtime code from another artifact", async function () {
    const token = await (await ethers.getContractFactory("MockERC20")).deploy(
      "Runtime Token",
      "RUN",
      18,
    );
    await token.waitForDeployment();
    let rejected = false;
    try {
      await verifyDeployedRuntimeArtifact("PublicCPMMRouter", await token.getAddress());
    } catch (error) {
      rejected = error instanceof Error && error.message.includes("runtime");
    }
    expect(rejected).to.equal(true);
  });

  it("matches the launch strategy's constructor-created migrator runtime", async function () {
    const deployment = await deployConfidentialFactory();
    const launch = await configureConfidentialLaunch(deployment);
    const address = await launch.migrator.getAddress();

    expect(
      await verifyDeployedRuntimeArtifact("ConfidentialLaunchpadMigrator", address),
    ).to.equal(ethers.keccak256(await ethers.provider.getCode(address)));
    const provenance = await verifyDeployedRuntimeArtifactWithProvenance(
      "ConfidentialLaunchpadMigrator",
      address,
    );
    expect(provenance.settings.optimizer.runs).to.equal(1);
  });

  it("matches a factory-created pool to the deployer's compilation context", async function () {
    const deployment = await deployConfidentialFactory();
    await configureConfidentialLaunch(deployment);
    const [token0, token1] = await Promise.all(
      deployment.representativeTokens.map((token) => token.getAddress()),
    );
    const transaction = await deployment.factory.createPool(token0, token1, 18, 6, 30);
    const receipt = await transaction.wait();
    const created = receipt?.logs.flatMap((log) => {
      try {
        const parsed = deployment.factory.interface.parseLog(log);
        return parsed?.name === "PoolCreated" ? [parsed] : [];
      } catch {
        return [];
      }
    });
    expect(created).to.have.length(1);
    const address = String(created?.[0].args.pool);

    const provenance = await verifyDeployedRuntimeArtifactWithProvenance(
      "ConfidentialCPMM",
      address,
    );
    expect(provenance.runtimeCodehash).to.equal(
      ethers.keccak256(await ethers.provider.getCode(address)),
    );
    expect(provenance.settings.optimizer.runs).to.equal(1);
  });
});
