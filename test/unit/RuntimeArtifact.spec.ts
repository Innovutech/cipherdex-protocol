import { expect } from "chai";
import { ethers } from "hardhat";
import {
  verifyDeployedRuntimeArtifact,
  verifyDeployedRuntimeArtifactWithProvenance,
} from "../../scripts/runtime-artifact";

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
});
