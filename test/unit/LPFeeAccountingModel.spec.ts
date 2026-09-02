import { expect } from "chai";

import { FungibleLpFeeModel } from "../../scripts/lp-fee-accounting-model";

describe("fungible LP fee-accounting reference model", function () {
  const pool = "pool";
  const alice = "alice";
  const bob = "bob";
  const carol = "carol";

  function model(scale = 1_000_000n): FungibleLpFeeModel {
    return new FungibleLpFeeModel(scale, pool);
  }

  it("prevents historical-fee capture on mint", function () {
    const accounting = model();
    accounting.mint(pool, alice, 100n);
    accounting.recordSwapFees(pool, 0, 1_000n, 10n, 100n);
    accounting.mint(pool, bob, 100n);

    expect(accounting.claimableOf(alice, 0)).to.equal(100n);
    expect(accounting.claimableOf(bob, 0)).to.equal(0n);

    accounting.recordSwapFees(pool, 0, 2_000n, 20n, 200n);
    expect(accounting.consumeClaim(pool, alice, 0)).to.equal(200n);
    expect(accounting.consumeClaim(pool, bob, 0)).to.equal(100n);
  });

  it("settles before direct transfer so the sender keeps history", function () {
    const accounting = model();
    accounting.mint(pool, alice, 100n);
    accounting.recordSwapFees(pool, 0, 0n, 0n, 100n);
    accounting.transfer(alice, bob, 50n);

    expect(accounting.claimableOf(alice, 0)).to.equal(100n);
    expect(accounting.claimableOf(bob, 0)).to.equal(0n);

    accounting.recordSwapFees(pool, 0, 0n, 0n, 100n);
    expect(accounting.consumeClaim(pool, alice, 0)).to.equal(150n);
    expect(accounting.consumeClaim(pool, bob, 0)).to.equal(50n);
  });

  it("applies the same ordering to delegated transfer", function () {
    const accounting = model();
    accounting.mint(pool, alice, 100n);
    accounting.recordSwapFees(pool, 1, 0n, 0n, 100n);
    accounting.approve(alice, carol, 40n);
    accounting.transferFrom(carol, alice, bob, 40n);

    expect(accounting.allowance(alice, carol)).to.equal(0n);
    expect(accounting.claimableOf(alice, 1)).to.equal(100n);
    expect(accounting.claimableOf(bob, 1)).to.equal(0n);

    accounting.recordSwapFees(pool, 1, 0n, 0n, 100n);
    expect(accounting.consumeClaim(pool, alice, 1)).to.equal(160n);
    expect(accounting.consumeClaim(pool, bob, 1)).to.equal(40n);
  });

  it("cannot double-pay repeated claims", function () {
    const accounting = model();
    accounting.mint(pool, alice, 10n);
    accounting.recordSwapFees(pool, 0, 0n, 0n, 30n);
    expect(accounting.consumeClaim(pool, alice, 0)).to.equal(30n);
    expect(accounting.consumeClaim(pool, alice, 0)).to.equal(0n);
    expect(accounting.audit(0).paid).to.equal(30n);
  });

  it("preserves accrued claims across burn and a full exit", function () {
    const accounting = model();
    accounting.mint(pool, alice, 100n);
    accounting.recordSwapFees(pool, 0, 0n, 0n, 100n);
    accounting.burn(pool, alice, 100n);

    expect(accounting.totalShares()).to.equal(0n);
    expect(accounting.claimableOf(alice, 0)).to.equal(100n);
    expect(accounting.consumeClaim(pool, alice, 0)).to.equal(100n);
  });

  it("keeps locked and unlocked shares economically identical", function () {
    const accounting = model();
    accounting.mint(pool, alice, 100n);
    accounting.mint(pool, bob, 100n);
    accounting.lock(pool, "alice-lock", alice, 100n, 50n, false);
    accounting.recordSwapFees(pool, 0, 0n, 0n, 200n);
    accounting.recordSwapFees(pool, 1, 0n, 0n, 400n);

    expect(accounting.consumeClaim(pool, alice, 0)).to.equal(100n);
    expect(accounting.consumeClaim(pool, bob, 0)).to.equal(100n);
    expect(accounting.consumeClaim(pool, alice, 1)).to.equal(200n);
    expect(accounting.consumeClaim(pool, bob, 1)).to.equal(200n);
  });

  it("blocks locked principal and makes unlock change transferability only", function () {
    const accounting = model();
    accounting.mint(pool, alice, 100n);
    accounting.lock(pool, "timed", alice, 80n, 50n, false);
    accounting.recordSwapFees(pool, 0, 0n, 0n, 100n);
    const claimBeforeUnlock = accounting.claimableOf(alice, 0);

    expect(() => accounting.transfer(alice, bob, 21n)).to.throw("locked principal");
    expect(() => accounting.burn(pool, alice, 21n)).to.throw("locked principal");
    expect(() => accounting.unlock(pool, "timed", 49n)).to.throw("not matured");

    accounting.unlock(pool, "timed", 50n);
    expect(accounting.claimableOf(alice, 0)).to.equal(claimBeforeUnlock);
    accounting.transfer(alice, bob, 80n);
    expect(accounting.balanceOf(bob)).to.equal(80n);

    accounting.lock(pool, "permanent", bob, 80n, 0n, true);
    expect(() => accounting.unlock(pool, "permanent", 1_000n)).to.throw("permanent");
  });

  it("quarantines an old zero-supply remainder from reinitialization", function () {
    const accounting = model(1_000n);
    accounting.mint(pool, alice, 3n);
    accounting.recordSwapFees(pool, 0, 0n, 0n, 1n);
    accounting.burn(pool, alice, 3n);

    expect(accounting.retiredRemainders(0)).to.deep.equal([{
      generation: 0n,
      numerator: 1n,
      denominator: 1_000n,
    }]);

    accounting.mint(pool, bob, 3n);
    expect(accounting.claimableOf(bob, 0)).to.equal(0n);
    expect(accounting.carryOf(bob, 0)).to.equal(0n);

    accounting.recordSwapFees(pool, 0, 0n, 0n, 1n);
    expect(accounting.claimableOf(bob, 0)).to.equal(0n);
    expect(accounting.carryOf(bob, 0)).to.equal(999n);
    expect(accounting.retiredRemainders(0)[0]?.numerator).to.equal(1n);
  });

  it("keeps LP liabilities outside active reserves and protocol fees", function () {
    const accounting = model();
    accounting.mint(pool, alice, 100n);
    accounting.creditPrincipal(pool, 0, 10_000n);
    accounting.recordSwapFees(pool, 0, 997n, 1n, 5n);
    const beforeClaim = accounting.audit(0);

    expect(beforeClaim.activeReserve).to.equal(10_997n);
    expect(beforeClaim.protocolFees).to.equal(1n);
    expect(beforeClaim.liability).to.equal(5n);
    expect(beforeClaim.custody).to.equal(11_003n);

    expect(accounting.consumeClaim(pool, alice, 0)).to.equal(5n);
    const afterClaim = accounting.audit(0);
    expect(afterClaim.activeReserve).to.equal(10_997n);
    expect(afterClaim.protocolFees).to.equal(1n);
    expect(afterClaim.liability).to.equal(0n);
  });

  it("maintains conservation under deterministic mixed operations", function () {
    const accounting = model(1_000_000_000n);
    const accounts = [alice, bob, carol];
    accounting.mint(pool, alice, 1_000n);
    accounting.mint(pool, bob, 1_000n);
    accounting.mint(pool, carol, 1_000n);
    let seed = 0xC1F3D3n;

    for (let step = 0; step < 500; step += 1) {
      seed = (seed * 1_103_515_245n + 12_345n) % 2_147_483_648n;
      const side = Number(seed & 1n) as 0 | 1;
      const first = accounts[Number(seed % 3n)]!;
      const second = accounts[(Number(seed % 2n) + accounts.indexOf(first) + 1) % 3]!;
      const action = Number((seed / 7n) % 5n);

      if (action === 0) {
        accounting.recordSwapFees(pool, side, seed % 100n, seed % 7n, seed % 31n);
      } else if (action === 1 && accounting.balanceOf(first) > 1n) {
        accounting.transfer(first, second, 1n + seed % (accounting.balanceOf(first) / 2n));
      } else if (action === 2 && accounting.totalShares() < accounting.scale - 10n) {
        accounting.mint(pool, first, 1n + seed % 10n);
      } else if (action === 3 && accounting.unlockedOf(first) > 1n) {
        accounting.burn(pool, first, 1n);
        if (accounting.totalShares() === 0n) accounting.mint(pool, second, 1n);
      } else {
        accounting.consumeClaim(pool, first, side);
      }

      for (const auditSide of [0, 1] as const) {
        const audit = accounting.audit(auditSide);
        expect(audit.paid + audit.outstanding + audit.explicitDust)
          .to.equal(audit.accrued);
        expect(audit.explicitDust).to.be.at.most(audit.dustUpperBound);
        expect(audit.custody).to.equal(
          audit.activeReserve + audit.protocolFees + audit.liability,
        );
      }
    }
  });

  it("rejects non-pool accounting authority", function () {
    const accounting = model();
    expect(() => accounting.mint(alice, alice, 1n)).to.throw("pool authority");
    expect(() => accounting.recordSwapFees(alice, 0, 0n, 0n, 1n))
      .to.throw("pool authority");
    expect(() => accounting.lock(alice, "x", alice, 1n, 0n, false))
      .to.throw("pool authority");
  });
});
