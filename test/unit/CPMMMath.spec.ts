import { expect } from "chai";

const BPS = 10_000n;

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

function nextRandom(seed: bigint): bigint {
  return (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
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
      const after = (reserveIn + result.netIn) * (reserveOut - result.amountOut);
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
});
