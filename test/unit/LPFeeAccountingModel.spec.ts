import { expect } from "chai";

import {
  advanceFeeGrowth,
  FEE_GROWTH_SCALE,
  FungibleLpFeeModel,
  MAX_LP_FEE_OPERAND,
  MAX_RESERVE_OPERAND,
  MAX_TOTAL_SHARES,
  settleFeeGrowth,
  UINT256_MAX,
} from "../../scripts/lp-fee-accounting-model";

describe("fungible LP fee-accounting reference model", function () {
  const pool = "pool";
  const alice = "alice";
  const bob = "bob";
  const carol = "carol";

  function model(): FungibleLpFeeModel {
    return new FungibleLpFeeModel(pool);
  }

  function expectAtomic(
    accounting: FungibleLpFeeModel,
    operation: () => unknown,
    message: string,
  ): void {
    const before = accounting.inspect();
    expect(operation).to.throw(message);
    expect(accounting.inspect()).to.deep.equal(before);
  }

  it("prevents allocated historical-fee capture on mint", function () {
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

  it("settles direct and delegated transfers before balances change", function () {
    const accounting = model();
    accounting.mint(pool, alice, 100n);
    accounting.recordSwapFees(pool, 0, 0n, 0n, 100n);
    accounting.transfer(alice, bob, 40n);
    accounting.recordSwapFees(pool, 0, 0n, 0n, 100n);
    accounting.approve(alice, carol, 10n);
    accounting.transferFrom(carol, alice, bob, 10n);
    expect(accounting.claimableOf(alice, 0)).to.equal(160n);
    expect(accounting.claimableOf(bob, 0)).to.equal(40n);
    accounting.recordSwapFees(pool, 0, 0n, 0n, 100n);
    expect(accounting.consumeClaim(pool, alice, 0)).to.equal(210n);
    expect(accounting.consumeClaim(pool, bob, 0)).to.equal(90n);
  });

  it("cannot double-pay and preserves claims through full exit", function () {
    const accounting = model();
    accounting.mint(pool, alice, 10n);
    accounting.recordSwapFees(pool, 0, 0n, 0n, 30n);
    accounting.burn(pool, alice, 10n);
    expect(accounting.consumeClaim(pool, alice, 0)).to.equal(30n);
    expect(accounting.consumeClaim(pool, alice, 0)).to.equal(0n);
    expect(accounting.audit(0).paid).to.equal(30n);
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

  it("makes failed direct transfer transaction-atomic", function () {
    const accounting = model();
    accounting.mint(pool, alice, 100n);
    accounting.lock(pool, "locked", alice, 90n, 10n, false);
    accounting.recordSwapFees(pool, 0, 0n, 0n, 7n);
    expectAtomic(accounting, () => accounting.transfer(alice, bob, 11n), "locked principal");
  });

  it("restores allowance and settlement state after failed delegated transfer", function () {
    const accounting = model();
    accounting.mint(pool, alice, 100n);
    accounting.lock(pool, "locked", alice, 90n, 10n, false);
    accounting.recordSwapFees(pool, 0, 0n, 0n, 7n);
    accounting.approve(alice, carol, 11n);
    expectAtomic(
      accounting,
      () => accounting.transferFrom(carol, alice, bob, 11n),
      "locked principal",
    );
    expect(accounting.allowance(alice, carol)).to.equal(11n);
  });

  it("makes failed burn, lock, unlock and claim transaction-atomic", function () {
    const accounting = model();
    accounting.mint(pool, alice, 100n);
    accounting.lock(pool, "timed", alice, 90n, 50n, false);
    accounting.recordSwapFees(pool, 0, 0n, 0n, 7n);
    expectAtomic(accounting, () => accounting.burn(pool, alice, 11n), "locked principal");
    expectAtomic(
      accounting,
      () => accounting.lock(pool, "second", alice, 11n, 60n, false),
      "locked principal",
    );
    expectAtomic(accounting, () => accounting.unlock(pool, "timed", 49n), "not matured");
    expectAtomic(
      accounting,
      () => accounting.consumeClaim("not-pool", alice, 0),
      "pool authority",
    );
  });

  it("rolls a sub-unit global remainder across mint, burn, transfer and zero supply", function () {
    const accounting = model();
    accounting.mint(pool, alice, 3n);
    accounting.recordSwapFees(pool, 0, 0n, 0n, 1n);
    expect(accounting.globalRemainderOf(0)).to.equal(1n);
    expect(accounting.claimableOf(alice, 0)).to.equal(0n);
    accounting.mint(pool, bob, 3n);
    accounting.transfer(bob, carol, 1n);
    accounting.burn(pool, bob, 2n);
    accounting.burn(pool, carol, 1n);
    expect(accounting.totalShares()).to.equal(3n);
    expect(accounting.globalRemainderOf(0)).to.equal(1n);
    expect(accounting.claimableOf(bob, 0)).to.equal(0n);
    expect(accounting.claimableOf(carol, 0)).to.equal(0n);
    accounting.recordSwapFees(pool, 0, 0n, 0n, 2n);
    expect(accounting.globalRemainderOf(0)).to.equal(0n);
    expect(accounting.consumeClaim(pool, alice, 0)).to.equal(3n);
    accounting.burn(pool, alice, 3n);
    expect(accounting.totalShares()).to.equal(0n);
    expect(accounting.generationId()).to.equal(1n);
  });

  it("uses one rolling remainder across repeated zero-supply generations", function () {
    const accounting = model();
    for (let generation = 0; generation < 100; generation += 1) {
      accounting.mint(pool, alice, 3n);
      accounting.recordSwapFees(pool, 0, 0n, 0n, 1n);
      accounting.recordSwapFees(pool, 0, 0n, 0n, 2n);
      accounting.burn(pool, alice, 3n);
    }
    expect(accounting.generationId()).to.equal(100n);
    expect(accounting.globalRemainderOf(0)).to.equal(0n);
    expect(accounting.consumeClaim(pool, alice, 0)).to.equal(300n);
    expect(accounting.audit(0).liability).to.equal(0n);
  });

  it("exactly conserves many owner carries and out-of-order claims", function () {
    const accounting = model();
    const holders = Array.from({ length: 257 }, (_, index) => `holder-${index}`);
    for (const holder of holders) accounting.mint(pool, holder, 1n);
    for (let fee = 1n; fee <= 513n; fee += 1n) {
      accounting.recordSwapFees(pool, 0, 0n, 0n, fee);
    }
    for (const holder of [...holders].reverse()) accounting.consumeClaim(pool, holder, 0);
    const audit = accounting.audit(0);
    expect(audit.paid + audit.liability).to.equal(audit.accrued);
    expect(audit.ownerCarryScaled + audit.unallocatedGlobalRemainder)
      .to.equal(audit.fractionalLiabilityScaled);
  });

  it("reproduces the aggregate dormant-carry defect and eliminates it on exit", function () {
    const holderCount = 257n;
    const fee = holderCount - 1n;
    const advanced = advanceFeeGrowth({
      growth: { whole: 0n, fraction: 0n },
      globalRemainder: 0n,
      lifetimeAccrued: 0n,
    }, fee, holderCount);
    let legacyDormantCarry = 0n;
    for (let index = 0n; index < holderCount; index += 1n) {
      const settled = settleFeeGrowth(
        1n,
        { whole: 0n, fraction: 0n },
        0n,
        advanced.growth,
      );
      expect(settled.newClaim).to.equal(0n);
      legacyDormantCarry += settled.carry;
    }
    expect(legacyDormantCarry + advanced.globalRemainder)
      .to.equal(fee * FEE_GROWTH_SCALE);
    expect(legacyDormantCarry / FEE_GROWTH_SCALE).to.be.greaterThan(1n);

    const accounting = model();
    const holders = Array.from({ length: Number(holderCount) }, (_, index) => `churn-${index}`);
    for (const holder of holders) accounting.mint(pool, holder, 1n);
    accounting.recordSwapFees(pool, 0, 0n, 0n, fee);
    for (const holder of holders) accounting.burn(pool, holder, 1n);
    for (const holder of holders) {
      expect(accounting.balanceOf(holder)).to.equal(0n);
      expect(accounting.carryOf(holder, 0)).to.equal(0n);
    }
    const audit = accounting.audit(0);
    expect(audit.outstanding * FEE_GROWTH_SCALE + audit.unallocatedGlobalRemainder)
      .to.equal(fee * FEE_GROWTH_SCALE);
    expect(audit.unallocatedGlobalRemainder).to.be.lessThan(FEE_GROWTH_SCALE);
  });

  it("retains carry on partial transfer and recycles it on full transfer", function () {
    const accounting = model();
    accounting.mint(pool, alice, 2n);
    accounting.mint(pool, bob, 1n);
    accounting.recordSwapFees(pool, 0, 0n, 0n, 1n);

    accounting.transfer(alice, bob, 1n);
    expect(accounting.balanceOf(alice)).to.equal(1n);
    expect(accounting.carryOf(alice, 0)).to.be.greaterThan(0n);
    accounting.transfer(alice, bob, 1n);
    expect(accounting.balanceOf(alice)).to.equal(0n);
    expect(accounting.carryOf(alice, 0)).to.equal(0n);
    expect(accounting.consumeClaim(pool, bob, 0)).to.equal(1n);
    expect(accounting.audit(0).liability).to.equal(0n);
  });

  it("recycles burn carry without changing reserves, protocol fees or liability", function () {
    const accounting = model();
    accounting.mint(pool, alice, 2n);
    accounting.mint(pool, bob, 1n);
    accounting.creditPrincipal(pool, 0, 10n);
    accounting.recordSwapFees(pool, 0, 7n, 3n, 1n);
    const before = accounting.audit(0);

    accounting.burn(pool, bob, 1n);
    expect(accounting.carryOf(bob, 0)).to.equal(0n);
    const after = accounting.audit(0);
    expect(after.activeReserve).to.equal(before.activeReserve);
    expect(after.protocolFees).to.equal(before.protocolFees);
    expect(after.liability).to.equal(before.liability);
    expect(accounting.consumeClaim(pool, alice, 0)).to.equal(1n);
  });

  it("does not recycle carry on claim while the holder still owns shares", function () {
    const accounting = model();
    accounting.mint(pool, alice, 3n);
    accounting.recordSwapFees(pool, 0, 0n, 0n, 1n);
    const carry = accounting.carryOf(alice, 0);
    expect(carry).to.be.greaterThan(0n);
    expect(accounting.consumeClaim(pool, alice, 0)).to.equal(0n);
    expect(accounting.carryOf(alice, 0)).to.equal(carry);
  });

  it("bounds recycled value across repeated zero-supply generations", function () {
    const accounting = model();
    let accrued = 0n;
    for (let generation = 0; generation < 100; generation += 1) {
      accounting.mint(pool, alice, 2n);
      accounting.mint(pool, bob, 1n);
      accounting.recordSwapFees(pool, 0, 0n, 0n, 1n);
      accrued += 1n;
      accounting.burn(pool, bob, 1n);
      accounting.burn(pool, alice, 2n);
      expect(accounting.carryOf(alice, 0)).to.equal(0n);
      expect(accounting.carryOf(bob, 0)).to.equal(0n);
      expect(accounting.globalRemainderOf(0)).to.be.lessThan(FEE_GROWTH_SCALE);
    }
    const audit = accounting.audit(0);
    expect(audit.outstanding * FEE_GROWTH_SCALE + audit.unallocatedGlobalRemainder)
      .to.equal(accrued * FEE_GROWTH_SCALE);
  });

  it("keeps liabilities outside active reserves and protocol fees", function () {
    const accounting = model();
    accounting.mint(pool, alice, 100n);
    accounting.creditPrincipal(pool, 0, 10_000n);
    accounting.recordSwapFees(pool, 0, 997n, 1n, 5n);
    const before = accounting.audit(0);
    expect(before.activeReserve).to.equal(10_997n);
    expect(before.protocolFees).to.equal(1n);
    expect(before.liability).to.equal(5n);
    accounting.consumeClaim(pool, alice, 0);
    const after = accounting.audit(0);
    expect(after.activeReserve).to.equal(10_997n);
    expect(after.protocolFees).to.equal(1n);
  });

  it("accepts the concrete extreme per-operation share, reserve and fee bounds", function () {
    const accounting = model();
    accounting.mint(pool, alice, MAX_TOTAL_SHARES);
    accounting.creditPrincipal(pool, 0, MAX_RESERVE_OPERAND);
    accounting.recordSwapFees(pool, 1, 0n, 0n, MAX_LP_FEE_OPERAND);
    expect(accounting.consumeClaim(pool, alice, 1)).to.equal(MAX_LP_FEE_OPERAND);
    expect(accounting.audit(1).liability).to.equal(0n);
  });

  it("proves quotient/remainder operation bounds at maximum operands", function () {
    const advanced = advanceFeeGrowth({
      growth: { whole: 0n, fraction: FEE_GROWTH_SCALE - 1n },
      globalRemainder: FEE_GROWTH_SCALE - 1n,
      lifetimeAccrued: 0n,
    }, MAX_LP_FEE_OPERAND, MAX_TOTAL_SHARES);
    expect(advanced.growth.whole <= MAX_LP_FEE_OPERAND).to.equal(true);
    expect(advanced.growth.fraction < FEE_GROWTH_SCALE).to.equal(true);
    expect(advanced.globalRemainder < MAX_TOTAL_SHARES).to.equal(true);
  });

  it("settles the maximum reachable dormant-holder lifetime without wrap", function () {
    const settled = settleFeeGrowth(
      1n,
      { whole: 0n, fraction: 0n },
      0n,
      { whole: UINT256_MAX, fraction: FEE_GROWTH_SCALE - 1n },
    );
    expect(settled.newClaim).to.equal(UINT256_MAX);
    expect(settled.carry).to.equal(FEE_GROWTH_SCALE - 1n);
  });

  it("produces identical two-limb semantics for no-borrow and borrow settlement", function () {
    const firstFraction = FEE_GROWTH_SCALE / 3n;
    const noBorrow = settleFeeGrowth(
      3n,
      { whole: 0n, fraction: 0n },
      0n,
      { whole: 0n, fraction: firstFraction },
    );
    expect(noBorrow.newClaim).to.equal(0n);
    expect(noBorrow.carry).to.equal(FEE_GROWTH_SCALE - 1n);

    const borrow = settleFeeGrowth(
      3n,
      noBorrow.checkpoint,
      noBorrow.carry,
      { whole: 1n, fraction: 0n },
    );
    expect(borrow.newClaim).to.equal(3n);
    expect(borrow.carry).to.equal(0n);
  });

  it("fails closed at lifetime or fabricated holder-product overflow", function () {
    expect(() => advanceFeeGrowth({
      growth: { whole: 0n, fraction: 0n },
      globalRemainder: 0n,
      lifetimeAccrued: UINT256_MAX,
    }, 1n, 1n)).to.throw("lifetime accrued fees overflow");
    expect(() => settleFeeGrowth(
      2n,
      { whole: 0n, fraction: 0n },
      0n,
      { whole: UINT256_MAX, fraction: 0n },
    )).to.throw("holder whole claim overflow");
  });

  it("maintains exact conservation under deterministic mixed operations", function () {
    const accounting = model();
    const accounts = [alice, bob, carol];
    for (const account of accounts) accounting.mint(pool, account, 1_000n);
    let seed = 0xC1F3D3n;
    for (let step = 0; step < 1_000; step += 1) {
      seed = (seed * 1_103_515_245n + 12_345n) % 2_147_483_648n;
      const side = Number(seed & 1n) as 0 | 1;
      const first = accounts[Number(seed % 3n)]!;
      const second = accounts[(Number(seed % 2n) + accounts.indexOf(first) + 1) % 3]!;
      const action = Number((seed / 7n) % 5n);
      if (action === 0) {
        accounting.recordSwapFees(pool, side, seed % 100n, seed % 7n, 1n + seed % 31n);
      } else if (action === 1 && accounting.unlockedOf(first) > 1n) {
        accounting.transfer(first, second, 1n + seed % (accounting.unlockedOf(first) / 2n));
      } else if (action === 2 && accounting.totalShares() < MAX_TOTAL_SHARES - 10n) {
        accounting.mint(pool, first, 1n + seed % 10n);
      } else if (action === 3 && accounting.unlockedOf(first) > 1n) {
        accounting.burn(pool, first, 1n);
        if (accounting.totalShares() === 0n) accounting.mint(pool, second, 1n);
      } else {
        accounting.consumeClaim(pool, first, side);
      }
      for (const auditSide of [0, 1] as const) {
        const audit = accounting.audit(auditSide);
        expect(audit.paid + audit.liability).to.equal(audit.accrued);
        expect(audit.ownerCarryScaled + audit.unallocatedGlobalRemainder)
          .to.equal(audit.fractionalLiabilityScaled);
        expect(audit.custody).to.equal(
          audit.activeReserve + audit.protocolFees + audit.liability,
        );
      }
    }
  });

  it("rejects non-pool accounting authority atomically", function () {
    const accounting = model();
    expectAtomic(accounting, () => accounting.mint(alice, alice, 1n), "pool authority");
    expectAtomic(
      accounting,
      () => accounting.recordSwapFees(alice, 0, 0n, 0n, 1n),
      "pool authority",
    );
  });
});
