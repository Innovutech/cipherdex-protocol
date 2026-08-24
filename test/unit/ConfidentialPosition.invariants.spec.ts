import { expect } from "chai";

const PRICE_SCALE = 10n ** 18n;

function positionClaim(
  shares: bigint,
  totalShares: bigint,
  reserve0: bigint,
  reserve1: bigint,
  scale0: bigint,
  scale1: bigint,
) {
  return {
    amount0: shares * reserve0 / totalShares,
    amount1: shares * reserve1 / totalShares,
    priceX18: reserve1 * scale1 * PRICE_SCALE / (reserve0 * scale0),
  };
}

describe("confidential position arithmetic invariants", function () {
  it("never overstates reserves and gives a full owner the complete effective reserves", function () {
    let state = 0x9e3779b9;
    const next = () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return BigInt(state + 1);
    };

    for (let index = 0; index < 2_000; index += 1) {
      const totalShares = next() * 10_000n;
      const shares = next() % totalShares + 1n;
      const reserve0 = next() * 1_000_000n;
      const reserve1 = next() * 1_000_000n;
      const scale0 = index % 2 === 0 ? 1n : 10n ** 12n;
      const scale1 = index % 2 === 0 ? 10n ** 12n : 1n;
      const claim = positionClaim(
        shares,
        totalShares,
        reserve0,
        reserve1,
        scale0,
        scale1,
      );

      expect(claim.amount0).to.be.at.most(reserve0);
      expect(claim.amount1).to.be.at.most(reserve1);
      expect(claim.priceX18).to.be.greaterThan(0n);
      expect(positionClaim(
        totalShares,
        totalShares,
        reserve0,
        reserve1,
        scale0,
        scale1,
      )).to.deep.include({ amount0: reserve0, amount1: reserve1 });
    }
  });

  it("keeps active and locked claims within LP-owned reserves across state movement", function () {
    const totalShares = 1_000_000n;
    const activeShares = 610_001n;
    const lockedShares = totalShares - activeShares;
    const before = { reserve0: 25_000_000n, reserve1: 40_000_000n };
    const after = { reserve0: 27_500_000n, reserve1: 36_500_000n };

    for (const state of [before, after]) {
      const active = positionClaim(
        activeShares,
        totalShares,
        state.reserve0,
        state.reserve1,
        1n,
        1n,
      );
      const locked = positionClaim(
        lockedShares,
        totalShares,
        state.reserve0,
        state.reserve1,
        1n,
        1n,
      );
      expect(active.amount0 + locked.amount0).to.be.at.most(state.reserve0);
      expect(active.amount1 + locked.amount1).to.be.at.most(state.reserve1);
      expect(state.reserve0 - active.amount0 - locked.amount0).to.be.lessThan(2n);
      expect(state.reserve1 - active.amount1 - locked.amount1).to.be.lessThan(2n);
    }

    const oldPreview = positionClaim(
      activeShares,
      totalShares,
      before.reserve0,
      before.reserve1,
      1n,
      1n,
    );
    const currentExecution = positionClaim(
      activeShares,
      totalShares,
      after.reserve0,
      after.reserve1,
      1n,
      1n,
    );
    expect(currentExecution).not.to.deep.equal(oldPreview);
    expect(currentExecution.amount1).to.be.lessThan(oldPreview.amount1);
  });
});
