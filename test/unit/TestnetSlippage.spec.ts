import { expect } from "chai";
import {
  confidentialLiquidityBounds,
  minimumWithSlippage,
  testnetSlippageBps,
} from "../../scripts/testnet-slippage";

describe("funded testnet slippage bounds", function () {
  const original = process.env.COTI_TESTNET_SLIPPAGE_BPS;

  afterEach(function () {
    if (original === undefined) delete process.env.COTI_TESTNET_SLIPPAGE_BPS;
    else process.env.COTI_TESTNET_SLIPPAGE_BPS = original;
  });

  it("defaults to one percent and always returns a positive minimum", function () {
    delete process.env.COTI_TESTNET_SLIPPAGE_BPS;
    expect(testnetSlippageBps()).to.equal(100n);
    expect(minimumWithSlippage(10_000n)).to.equal(9_900n);
    expect(minimumWithSlippage(1n)).to.equal(1n);
    expect(minimumWithSlippage(101n)).to.equal(100n);
    expect(minimumWithSlippage(2n, 5_000n)).to.equal(1n);
    expect(minimumWithSlippage(3n, 5_000n)).to.equal(2n);
  });

  it("rejects malformed or excessively permissive funded-test configuration", function () {
    process.env.COTI_TESTNET_SLIPPAGE_BPS = "5001";
    expect(() => testnetSlippageBps()).to.throw("exceeds 5000");
    process.env.COTI_TESTNET_SLIPPAGE_BPS = "1.5";
    expect(() => testnetSlippageBps()).to.throw("must be an integer");
    expect(() => minimumWithSlippage(100n, -1n)).to.throw("between 0 and 5000");
  });

  it("derives nonzero share and normalized-price bounds for confidential liquidity", function () {
    const initial = confidentialLiquidityBounds(
      2n * 10n ** 18n,
      18,
      1_000_000n,
      6,
      false,
      100n,
    );
    expect(initial.minShares).to.equal(990_000_000_000_000_000n);
    expect(initial.minPriceX18).to.equal(495_000_000_000_000_000n);
    expect(initial.maxPriceX18).to.equal(505_000_000_000_000_000n);

    const later = confidentialLiquidityBounds(
      2n * 10n ** 18n,
      18,
      1_000_000n,
      6,
      true,
      100n,
    );
    expect(later.minShares).to.equal(1n);
    expect(later.minPriceX18).to.equal(initial.minPriceX18);
    expect(later.maxPriceX18).to.equal(initial.maxPriceX18);
  });
});
