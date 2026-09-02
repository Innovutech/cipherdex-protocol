import { expect } from "chai";

import { ethers } from "../../hardhat/runtime.js";

describe("disposable public LP-accounting probe", function () {
  async function fixture() {
    const [alice, bob, spender] = await ethers.getSigners();
    const probe = await (
      await ethers.getContractFactory("PublicLPAccountingProbe")
    ).deploy();
    await probe.waitForDeployment();
    const token = await ethers.getContractAt(
      "PublicLPAccountingProbeToken",
      await probe.lpToken(),
    );
    return { alice, bob, spender, probe, token };
  }

  it("settles mint, direct transfer and delegated transfer before balances change", async function () {
    const { alice, bob, spender, probe, token } = await fixture();
    await probe.connect(alice).mint(100);
    await probe.accrue(0, 1_000, 10, 100);
    await probe.connect(bob).mint(100);

    expect(await token.previewClaim(alice.address, 0)).to.equal(100n);
    expect(await token.previewClaim(bob.address, 0)).to.equal(0n);

    await token.connect(alice).transfer(bob.address, 20);
    expect(await token.claimable(alice.address, 0)).to.equal(100n);
    expect(await token.claimable(bob.address, 0)).to.equal(0n);

    await probe.accrue(0, 0, 0, 200);
    await token.connect(bob).approve(spender.address, 10);
    await token.connect(spender).transferFrom(bob.address, alice.address, 10);
    expect(await token.claimable(alice.address, 0)).to.equal(180n);
    expect(await token.claimable(bob.address, 0)).to.equal(120n);

    await expect(probe.connect(alice).claim(0)).to.not.revert(ethers);
    await expect(probe.connect(bob).claim(0)).to.not.revert(ethers);
    expect(await probe.paidClaims(0)).to.equal(300n);
    expect(await probe.lpFeeLiability(0)).to.equal(0n);
  });

  it("keeps fee methods pool-only without a token-to-pool transfer callback", async function () {
    const { alice, probe, token } = await fixture();
    await probe.connect(alice).mint(100);
    await expect(token.connect(alice).recordFees(0, 1))
      .to.be.revertedWithCustomError(token, "PoolOnly");
    await expect(token.connect(alice).mintFromPool(alice.address, 1))
      .to.be.revertedWithCustomError(token, "PoolOnly");
    await expect(token.connect(alice).consumeClaimFromPool(alice.address, 0))
      .to.be.revertedWithCustomError(token, "PoolOnly");
  });

  it("retains locked balances, blocks principal, and unlocks without changing claims", async function () {
    const { alice, bob, probe, token } = await fixture();
    await probe.connect(alice).mint(100);
    await probe.connect(bob).mint(100);
    const block = await ethers.provider.getBlock("latest");
    const unlockAt = BigInt(block!.timestamp + 60);
    const lockId = await probe.connect(alice).lock.staticCall(80, unlockAt, false);
    await probe.connect(alice).lock(80, unlockAt, false);
    await probe.accrue(1, 0, 0, 200);

    expect(await token.balanceOf(alice.address)).to.equal(100n);
    expect(await token.previewClaim(alice.address, 1)).to.equal(100n);
    expect(await token.previewClaim(bob.address, 1)).to.equal(100n);
    await expect(token.connect(alice).transfer(bob.address, 21))
      .to.be.revertedWithCustomError(token, "LockedPrincipal");
    await expect(probe.connect(alice).burn(21))
      .to.be.revertedWithCustomError(token, "LockedPrincipal");
    await expect(probe.connect(bob).unlock(lockId))
      .to.be.revertedWithCustomError(probe, "LockOwnerOnly");

    const before = await token.previewClaim(alice.address, 1);
    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(unlockAt)]);
    await probe.connect(alice).unlock(lockId);
    expect(await token.previewClaim(alice.address, 1)).to.equal(before);
    await expect(token.connect(alice).transfer(bob.address, 80)).to.not.revert(ethers);
  });

  it("preserves claims and retires global remainder across full exit/reinitialization", async function () {
    const { alice, bob, probe, token } = await fixture();
    await probe.connect(alice).mint(3);
    await probe.accrue(0, 0, 0, 1);
    await probe.connect(alice).burn(3);

    expect(await token.totalSupply()).to.equal(0n);
    expect(await token.retiredRemainder(0)).to.equal(1n);
    const aliceClaim = await token.previewClaim(alice.address, 0);

    await probe.connect(bob).mint(3);
    expect(await token.previewClaim(bob.address, 0)).to.equal(0n);
    expect(await token.retiredRemainder(0)).to.equal(1n);
    expect(await token.previewClaim(alice.address, 0)).to.equal(aliceClaim);
  });

  it("never credits LP fee liabilities into reserves or protocol fees", async function () {
    const { alice, probe } = await fixture();
    await probe.connect(alice).mint(100);
    await probe.accrue(0, 997, 1, 5);
    expect(await probe.activeReserve(0)).to.equal(997n);
    expect(await probe.protocolFees(0)).to.equal(1n);
    expect(await probe.lpFeeLiability(0)).to.equal(5n);
    await probe.connect(alice).claim(0);
    expect(await probe.activeReserve(0)).to.equal(997n);
    expect(await probe.protocolFees(0)).to.equal(1n);
    expect(await probe.lpFeeLiability(0)).to.equal(0n);
  });
});
