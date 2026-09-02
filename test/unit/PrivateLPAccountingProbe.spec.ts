import { expect } from "chai";
import { Interface } from "ethers";
import { readFileSync } from "node:fs";

import { artifacts, ethers } from "../../hardhat/runtime.js";

describe("disposable private LP-accounting probe", function () {
  it("compiles and deploys through the pinned PrivateERC20 virtual hook", async function () {
    const underlying = await ethers.getContractFactory("MockERC20");
    const token0 = await underlying.deploy("Private probe token 0", "P0", 18);
    const token1 = await underlying.deploy("Private probe token 1", "P1", 18);
    await Promise.all([token0.waitForDeployment(), token1.waitForDeployment()]);

    const probe = await (
      await ethers.getContractFactory("PrivateLPAccountingProbe")
    ).deploy(await token0.getAddress(), await token1.getAddress());
    await probe.waitForDeployment();
    const lpTokenAddress = await probe.lpToken();
    const lpToken = await ethers.getContractAt(
      "PrivateLPAccountingProbeToken",
      lpTokenAddress,
    );

    expect(await lpToken.pool()).to.equal(await probe.getAddress());
    expect(await lpToken.SCALE()).to.equal(1n << 128n);
    expect(await ethers.provider.getCode(lpTokenAddress)).to.not.equal("0x");

    const tokenArtifact = await artifacts.readArtifact(
      "PrivateLPAccountingProbeToken",
    );
    expect((tokenArtifact.deployedBytecode.length - 2) / 2).to.be.at.most(24_576);
    const tokenInterface = new Interface(tokenArtifact.abi);
    expect(tokenInterface.getFunction("recordFees")).to.not.equal(null);
    expect(tokenInterface.getFunction("requestMyClaimable")).to.not.equal(null);
    expect(tokenInterface.getFunction("lockInfo")).to.not.equal(null);
    expect(tokenInterface.getFunction("transferGT")).to.not.equal(null);
    expect(tokenInterface.getFunction("transferFromGT")).to.not.equal(null);

    const probeArtifact = await artifacts.readArtifact("PrivateLPAccountingProbe");
    expect((probeArtifact.deployedBytecode.length - 2) / 2).to.be.at.most(24_576);
    expect((probeArtifact.bytecode.length - 2) / 2).to.be.at.most(49_152);
    const probeInterface = new Interface(probeArtifact.abi);
    expect(
      probeInterface.getEvent("PrivateLPAccountingConservationResult"),
    ).to.not.equal(null);
    expect(
      probeInterface.getEvent("LockedPrivatePrincipalDiagnostic"),
    ).to.not.equal(null);
    expect(
      probeInterface.getFunction("requestDiagnosticSnapshot"),
    ).to.not.equal(null);
    expect(
      probeInterface.getFunction("requestCarrySnapshot"),
    ).to.not.equal(null);
    expect(
      probeInterface.getEvent("PrivateLPAccountingCarrySnapshot"),
    ).to.not.equal(null);
    expect(
      probeInterface.getFunction("diagnoseLockedTransfer"),
    ).to.not.equal(null);
    expect(
      probeInterface.getFunction("diagnoseLockedBurn"),
    ).to.not.equal(null);

    const spenderArtifact = await artifacts.readArtifact(
      "PrivateLPAccountingDelegatedSpenderProbe",
    );
    const spenderInterface = new Interface(spenderArtifact.abi);
    expect(spenderInterface.getFunction("transferFrom")).to.not.equal(null);

    await expect(lpToken.recordFees(0, 0n))
      .to.be.revertedWithCustomError(lpToken, "PoolOnly");
  });

  it("does not expose a token-to-pool settlement callback", async function () {
    const tokenArtifact = await artifacts.readArtifact(
      "PrivateLPAccountingProbeToken",
    );
    const tokenInterface = new Interface(tokenArtifact.abi);
    expect(tokenInterface.getFunction("onLPTransfer")).to.equal(null);
    expect(tokenInterface.getFunction("beforeTokenTransfer")).to.equal(null);
  });

  it("uses mux instead of amount-derived successful settlement branching", function () {
    const source = readFileSync(
      new URL("../../contracts/mocks/PrivateLPAccountingProbe.sol", import.meta.url),
      "utf8",
    );
    expect(source).to.include("gtBool noBorrow = MpcCore.ge(currentFraction, previousFraction)");
    expect(source).to.include("wholeDelta = MpcCore.mux(");
    expect(source).to.include("fractionDelta = _selectFractionDelta(");
    expect(source).to.include("return MpcCore.mux(");
    expect(source).not.to.match(
      /if\s*\(\s*MpcCore\.decrypt\(MpcCore\.ge\(currentFraction,\s*previousFraction\)\)\s*\)/u,
    );
  });
});
