import { expect } from "chai";

const BPS = 10_000n;
const MAX_UINT256 = (1n << 256n) - 1n;
const PRICE_SCALE = 1_000_000_000_000_000_000n;

// COTI MpcCore.mux(bit, a, b) selects a when bit is false and b when true.
const cotiMux = <T>(bit: boolean, whenFalse: T, whenTrue: T): T =>
  bit ? whenTrue : whenFalse;

function quote(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeBps: bigint,
): { netIn: bigint; amountOut: bigint; retainedOut: bigint } {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) {
    throw new Error("invalid amount or reserve");
  }
  const netIn = (amountIn * (BPS - feeBps)) / BPS;
  if (netIn <= 0n) throw new Error("zero net input");
  const newReserveIn = reserveIn + netIn;
  const invariant = reserveIn * reserveOut;
  const retainedOut = (invariant + newReserveIn - 1n) / newReserveIn;
  const amountOut = reserveOut - retainedOut;
  return { netIn, amountOut, retainedOut };
}

function feeBreakdown(amountIn: bigint, feeBps: bigint) {
  const netIn = (amountIn * (BPS - feeBps)) / BPS;
  const totalFee = amountIn - netIn;
  const protocolFee = totalFee / 6n;
  return {
    netIn,
    totalFee,
    protocolFee,
    lpFee: totalFee - protocolFee,
    reserveCredit: amountIn - protocolFee,
  };
}

function nextRandom(seed: bigint): bigint {
  return (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
}

function initialShares(amount0: bigint, amount1: bigint, scale0: bigint, scale1: bigint): bigint {
  const normalized0 = amount0 * scale0;
  const normalized1 = amount1 * scale1;
  if (normalized0 <= 0n || normalized1 <= 0n) throw new Error("invalid initial liquidity");
  return normalized0 < normalized1 ? normalized0 : normalized1;
}

function proportionalJoin(
  input0: bigint,
  input1: bigint,
  reserve0: bigint,
  reserve1: bigint,
  totalShares: bigint,
) {
  const share0 = (input0 * totalShares) / reserve0;
  const share1 = (input1 * totalShares) / reserve1;
  const minted = share0 < share1 ? share0 : share1;
  const ceilDiv = (numerator: bigint, denominator: bigint) =>
    (numerator + denominator - 1n) / denominator;
  return {
    minted,
    deposit0: ceilDiv(minted * reserve0, totalShares),
    deposit1: ceilDiv(minted * reserve1, totalShares),
  };
}

function proportionalExit(
  shares: bigint,
  reserve0: bigint,
  reserve1: bigint,
  totalShares: bigint,
) {
  if (shares <= 0n || shares > totalShares) throw new Error("invalid exit");
  if (shares === totalShares) return { amount0: reserve0, amount1: reserve1 };
  return {
    amount0: (shares * reserve0) / totalShares,
    amount1: (shares * reserve1) / totalShares,
  };
}

function operationallyBounded(
  reserve0: bigint,
  reserve1: bigint,
  totalShares: bigint,
  scale0: bigint,
  scale1: bigint,
): boolean {
  const products = [
    reserve0 * reserve1,
    totalShares * reserve0,
    totalShares * reserve1,
    reserve0 * scale0,
    reserve1 * scale1,
    reserve1 * scale1 * PRICE_SCALE,
  ];
  return reserve0 > 0n && reserve1 > 0n && totalShares > 0n &&
    products.every((value) => value <= MAX_UINT256);
}

function priceWithinBounds(
  amount0: bigint,
  amount1: bigint,
  scale0: bigint,
  scale1: bigint,
  minimum: bigint,
  maximum: bigint,
): boolean {
  const normalized0 = amount0 * scale0;
  const numerator = amount1 * scale1 * PRICE_SCALE;
  const floorPrice = numerator / normalized0;
  const ceilingPrice = (numerator + normalized0 - 1n) / normalized0;
  return floorPrice >= minimum && ceilingPrice <= maximum;
}

describe("Confidential CPMM reference properties", function () {
  it("rounds retained reserves upward and never creates invariant value", function () {
    const result = quote(1n, 10n, 10n, 0n);
    expect(result.amountOut).to.equal(0n);
  });

  it("keeps the post-swap invariant at or above the pre-swap invariant", function () {
    let seed = 7n;
    for (let i = 0; i < 500; i += 1) {
      seed = nextRandom(seed);
      const reserveIn = (seed % 1_000_000_000_000n) + 1_000_000n;
      seed = nextRandom(seed);
      const reserveOut = (seed % 1_000_000_000_000n) + 1_000_000n;
      seed = nextRandom(seed);
      const amountIn = (seed % (reserveIn * 2n)) + 1n;
      const result = quote(amountIn, reserveIn, reserveOut, 30n);
      const before = reserveIn * reserveOut;
      const { reserveCredit } = feeBreakdown(amountIn, 30n);
      const after = (reserveIn + reserveCredit) * (reserveOut - result.amountOut);
      expect(after >= before, `invariant failed at iteration ${i}`).to.equal(true);
    }
  });

  it("is monotonic for valid increasing inputs", function () {
    const reserveIn = 1_000_000_000n;
    const reserveOut = 2_000_000_000n;
    let previous = 0n;
    for (let amount = 1_000_000n; amount <= 100_000_000n; amount += 1_000_000n) {
      const current = quote(amount, reserveIn, reserveOut, 30n).amountOut;
      expect(current >= previous).to.equal(true);
      previous = current;
    }
  });

  it("never exceeds the floor of the fee-adjusted output formula", function () {
    let seed = 31n;
    for (let i = 0; i < 200; i += 1) {
      seed = nextRandom(seed);
      const reserveIn = (seed % 10_000_000n) + 10_000n;
      seed = nextRandom(seed);
      const reserveOut = (seed % 10_000_000n) + 10_000n;
      seed = nextRandom(seed);
      const amountIn = (seed % reserveIn) + 1n;
      const result = quote(amountIn, reserveIn, reserveOut, 30n);
      const expected = (reserveOut * result.netIn) / (reserveIn + result.netIn);
      expect(result.amountOut <= expected).to.equal(true);
    }
  });

  it("supports an exact maximum-width ceiling division without increment overflow", function () {
    const numerator = (1n << 256n) - 1n;
    const denominator = 1n;
    const quotient = numerator / denominator;
    const remainder = numerator % denominator;
    const rounded = remainder === 0n ? quotient : quotient + 1n;
    expect(rounded).to.equal(numerator);
  });

  it("splits the existing input fee one-sixth to protocol without double charging", function () {
    expect(feeBreakdown(10_000n, 30n)).to.deep.equal({
      netIn: 9_970n,
      totalFee: 30n,
      protocolFee: 5n,
      lpFee: 25n,
      reserveCredit: 9_995n,
    });
    expect(feeBreakdown(334n, 30n)).to.deep.equal({
      netIn: 332n,
      totalFee: 2n,
      protocolFee: 0n,
      lpFee: 2n,
      reserveCredit: 334n,
    });
  });

  it("identifies zero-protocol-share dust that confidential pools reject", function () {
    expect(feeBreakdown(334n, 30n).protocolFee).to.equal(0n);
    expect(feeBreakdown(2_000n, 30n).protocolFee).to.equal(1n);
    expect(feeBreakdown(10_001n, 5n).protocolFee).to.equal(1n);
  });

  it("keeps encrypted protocol accrual outside effective reserves in both directions", function () {
    let reserve0 = 1_000_000n;
    let reserve1 = 2_000_000n;
    let protocol0 = 0n;
    let protocol1 = 0n;

    const firstInput = 10_000n;
    const firstQuote = quote(firstInput, reserve0, reserve1, 30n);
    const firstFees = feeBreakdown(firstInput, 30n);
    reserve0 += firstFees.reserveCredit;
    reserve1 -= firstQuote.amountOut;
    protocol0 += firstFees.protocolFee;

    const secondInput = 20_000n;
    const secondQuote = quote(secondInput, reserve1, reserve0, 30n);
    const secondFees = feeBreakdown(secondInput, 30n);
    reserve1 += secondFees.reserveCredit;
    reserve0 -= secondQuote.amountOut;
    protocol1 += secondFees.protocolFee;

    expect(protocol0).to.equal(5n);
    expect(protocol1).to.equal(10n);
    const effectiveBeforeCollection = [reserve0, reserve1];
    protocol0 = 0n;
    protocol1 = 0n;
    expect([reserve0, reserve1]).to.deep.equal(effectiveBeforeCollection);
    expect(protocol0 + protocol1).to.equal(0n);
  });

  it("excludes accrued protocol fees from partial and full LP exits", function () {
    const initial0 = 1_000_000n;
    const initial1 = 1_000_000n;
    const fees = feeBreakdown(10_000n, 30n);
    const result = quote(10_000n, initial0, initial1, 30n);
    const effective0 = initial0 + fees.reserveCredit;
    const effective1 = initial1 - result.amountOut;
    const full = proportionalExit(initialShares(initial0, initial1, 1n, 1n), effective0, effective1, initial0);

    expect(full).to.deep.equal({ amount0: effective0, amount1: effective1 });
    expect(effective0 + fees.protocolFee).to.equal(initial0 + 10_000n);
    expect(full.amount0).to.equal(initial0 + 10_000n - fees.protocolFee);
  });

  it("uses COTI mux branch order for exact ceiling division and full exits", function () {
    expect(cotiMux(true, 6n, 5n)).to.equal(5n);
    expect(cotiMux(false, 6n, 5n)).to.equal(6n);
    expect(cotiMux(true, 499n, 1_000n)).to.equal(1_000n);
  });

  it("supports arbitrary initial prices across decimal extremes", function () {
    expect(initialShares(2n, 9n, 1n, 1n)).to.equal(2n);
    expect(initialShares(3n, 7n, 1_000_000_000_000_000_000n, 1n)).to.equal(7n);
    expect(initialShares(11n, 5n, 1n, 1_000_000_000_000_000_000n)).to.equal(11n);
  });

  it("accepts a maximum encrypted upper price bound without multiplying by it", function () {
    expect(priceWithinBounds(3n, 7n, 1n, 1n, 0n, MAX_UINT256)).to.equal(true);
    expect(priceWithinBounds(3n, 7n, 1n, 1n, 2_333_333_333_333_333_333n, 2_333_333_333_333_333_334n)).to.equal(true);
    expect(priceWithinBounds(3n, 7n, 1n, 1n, 2_333_333_333_333_333_334n, MAX_UINT256)).to.equal(false);
  });

  it("rejects accepted states that would make later confidential arithmetic overflow", function () {
    expect(operationallyBounded(1_000_000n, 2_000_000n, 1_000_000n, 1n, 1n)).to.equal(true);
    expect(operationallyBounded(MAX_UINT256, 2n, 1n, 1n, 1n)).to.equal(false);
    expect(operationallyBounded(1n, MAX_UINT256 / PRICE_SCALE + 1n, 1n, 1n, 1n)).to.equal(false);

    let seed = 211n;
    for (let index = 0; index < 300; index += 1) {
      seed = nextRandom(seed);
      const reserve0 = (seed % 1_000_000_000_000n) + 1n;
      seed = nextRandom(seed);
      const reserve1 = (seed % 1_000_000_000_000n) + 1n;
      seed = nextRandom(seed);
      const shares = (seed % 1_000_000_000_000n) + 1n;
      expect(operationallyBounded(reserve0, reserve1, shares, 1n, 1n)).to.equal(true);
    }
  });

  it("accepts only proportional later liquidity and never transfers surplus", function () {
    const joined = proportionalJoin(500n, 9_999n, 1_000n, 2_000n, 1_000n);
    expect(joined).to.deep.equal({ minted: 500n, deposit0: 500n, deposit1: 1_000n });
    expect(joined.deposit0 <= 500n).to.equal(true);
    expect(joined.deposit1 <= 9_999n).to.equal(true);
  });

  it("rounds accepted deposits upward to prevent later-LP dilution", function () {
    const joined = proportionalJoin(2n, 2n, 3n, 3n, 2n);
    expect(joined).to.deep.equal({ minted: 1n, deposit0: 2n, deposit1: 2n });
    expect(joined.deposit0 * 2n >= joined.minted * 3n).to.equal(true);
    expect(joined.deposit1 * 2n >= joined.minted * 3n).to.equal(true);
  });

  it("keeps proportional LP ownership stable within integer rounding", function () {
    let seed = 101n;
    for (let i = 0; i < 300; i += 1) {
      seed = nextRandom(seed);
      const reserve0 = (seed % 1_000_000_000n) + 10_000n;
      seed = nextRandom(seed);
      const reserve1 = (seed % 1_000_000_000n) + 10_000n;
      const total = initialShares(reserve0, reserve1, 1n, 1n);
      seed = nextRandom(seed);
      const multiplier = (seed % 100n) + 1n;
      const input0 = reserve0 * multiplier;
      const input1 = reserve1 * multiplier;
      const joined = proportionalJoin(input0, input1, reserve0, reserve1, total);
      expect(joined.minted).to.equal(total * multiplier);
      expect(joined.deposit0).to.equal(input0);
      expect(joined.deposit1).to.equal(input1);
    }
  });

  it("preserves aggregate accounting across multiple LP joins, partial exits and final exit", function () {
    let reserve0 = 12_345n;
    let reserve1 = 987_654n;
    let totalShares = initialShares(reserve0, reserve1, 1n, 1n);
    const mintedByLaterLps: bigint[] = [];

    for (const [offered0, offered1] of [
      [6_173n, 600_000n],
      [25_000n, 1_100_000n],
      [1_000n, 200_000n],
    ] as const) {
      const joined = proportionalJoin(offered0, offered1, reserve0, reserve1, totalShares);
      expect(joined.minted > 0n).to.equal(true);
      expect(joined.deposit0 <= offered0).to.equal(true);
      expect(joined.deposit1 <= offered1).to.equal(true);
      expect(joined.deposit0 * totalShares >= joined.minted * reserve0).to.equal(true);
      expect(joined.deposit1 * totalShares >= joined.minted * reserve1).to.equal(true);
      reserve0 += joined.deposit0;
      reserve1 += joined.deposit1;
      totalShares += joined.minted;
      mintedByLaterLps.push(joined.minted);
    }

    const partialShares = mintedByLaterLps[0] / 2n;
    const partial = proportionalExit(partialShares, reserve0, reserve1, totalShares);
    expect(partial.amount0 > 0n).to.equal(true);
    expect(partial.amount1 > 0n).to.equal(true);
    reserve0 -= partial.amount0;
    reserve1 -= partial.amount1;
    totalShares -= partialShares;

    const final = proportionalExit(totalShares, reserve0, reserve1, totalShares);
    expect(final).to.deep.equal({ amount0: reserve0, amount1: reserve1 });
  });
});
