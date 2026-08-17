import { expect } from "chai";
import {
  CIPHERDEX_V1_FEE_POLICY,
  calculateCipherDEXV1FeeBreakdown,
  minimumCipherDEXV1ConfidentialInput,
} from "../../sdk/src";

const MAX_UINT256 = (1n << 256n) - 1n;
const FEE_DENOMINATOR = 10_000n;
const FEE_TIERS = CIPHERDEX_V1_FEE_POLICY.approvedTotalFeeBps;

type Quote = Readonly<{
  valid: boolean;
  amountOut: bigint;
  netAmountIn: bigint;
  protocolFee: bigint;
}>;

type Candidate = Readonly<{
  feeBps: number;
  exists: boolean;
  initialized: boolean;
  reserveIn: bigint;
  reserveOut: bigint;
  totalShares?: bigint;
  scaleIn?: bigint;
  scaleOut?: bigint;
  protocolFeesIn?: bigint;
  protocolFeeSwapCount?: bigint;
}>;

type PoolState = {
  reserveIn: bigint;
  reserveOut: bigint;
  protocolFeesIn: bigint;
};

const invalidQuote = (): Quote => ({
  valid: false,
  amountOut: 0n,
  netAmountIn: 0n,
  protocolFee: 0n,
});

function quoteExactInput(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeBps: number,
): Quote {
  if (
    amountIn <= 0n ||
    reserveIn <= 0n ||
    reserveOut <= 0n ||
    amountIn > MAX_UINT256 ||
    reserveIn > MAX_UINT256 ||
    reserveOut > MAX_UINT256
  ) return invalidQuote();

  const feeFactor = BigInt(10_000 - feeBps);
  const netProduct = amountIn * feeFactor;
  if (netProduct > MAX_UINT256) return invalidQuote();
  const netAmountIn = netProduct / FEE_DENOMINATOR;
  if (netAmountIn === 0n) return invalidQuote();
  const totalFee = amountIn - netAmountIn;
  const protocolFee = totalFee / 6n;
  if (protocolFee === 0n) return invalidQuote();

  const pricingReserveIn = reserveIn + netAmountIn;
  const invariant = reserveIn * reserveOut;
  if (pricingReserveIn > MAX_UINT256 || invariant > MAX_UINT256) {
    return invalidQuote();
  }
  const retainedReserve =
    invariant / pricingReserveIn +
    (invariant % pricingReserveIn === 0n ? 0n : 1n);
  if (retainedReserve > reserveOut) return invalidQuote();
  const amountOut = reserveOut - retainedReserve;
  if (amountOut === 0n) return invalidQuote();
  return { valid: true, amountOut, netAmountIn, protocolFee };
}

function selectBest(
  amountIn: bigint,
  candidates: readonly Candidate[],
): Readonly<{ candidate: Candidate; quote: Quote }> | undefined {
  let selected: Readonly<{ candidate: Candidate; quote: Quote }> | undefined;
  for (const candidate of candidates) {
    if (!candidate.exists || !candidate.initialized) continue;
    const quote = quoteExactInput(
      amountIn,
      candidate.reserveIn,
      candidate.reserveOut,
      candidate.feeBps,
    );
    if (!quote.valid || !settlementIsOperational(amountIn, candidate, quote)) continue;
    if (!selected || quote.amountOut > selected.quote.amountOut) {
      selected = { candidate, quote };
    }
  }
  return selected;
}

function settlementIsOperational(
  amountIn: bigint,
  candidate: Candidate,
  quote: Quote,
): boolean {
  const nextReserveIn = candidate.reserveIn + amountIn - quote.protocolFee;
  const nextReserveOut = candidate.reserveOut - quote.amountOut;
  const shares = candidate.totalShares ?? 1n;
  const scaleIn = candidate.scaleIn ?? 1n;
  const scaleOut = candidate.scaleOut ?? 1n;
  const protocolFees = candidate.protocolFeesIn ?? 0n;
  const swapCount = candidate.protocolFeeSwapCount ?? 0n;
  if (
    nextReserveIn <= 0n ||
    nextReserveOut <= 0n ||
    shares <= 0n ||
    nextReserveIn > MAX_UINT256 ||
    nextReserveOut > MAX_UINT256 ||
    protocolFees + quote.protocolFee > MAX_UINT256 ||
    swapCount >= (1n << 32n) - 1n
  ) return false;
  return [
    nextReserveIn * nextReserveOut,
    shares * nextReserveIn,
    shares * nextReserveOut,
    nextReserveIn * scaleIn,
    nextReserveOut * scaleOut,
    nextReserveOut * scaleOut * 10n ** 18n,
  ].every((value) => value <= MAX_UINT256);
}

function settleExactInput(
  state: Readonly<PoolState>,
  amountIn: bigint,
  minimumOut: bigint,
  feeBps: number,
): PoolState {
  const quote = quoteExactInput(
    amountIn,
    state.reserveIn,
    state.reserveOut,
    feeBps,
  );
  if (!quote.valid || quote.amountOut < minimumOut) {
    throw new Error("settlement rejected");
  }
  const nextReserveIn = state.reserveIn + amountIn - quote.protocolFee;
  const nextReserveOut = state.reserveOut - quote.amountOut;
  const nextProtocolFees = state.protocolFeesIn + quote.protocolFee;
  if (nextReserveIn > MAX_UINT256 || nextProtocolFees > MAX_UINT256) {
    throw new Error("settlement overflow");
  }
  if (nextReserveIn * nextReserveOut < state.reserveIn * state.reserveOut) {
    throw new Error("constant-product invariant decreased");
  }
  return {
    reserveIn: nextReserveIn,
    reserveOut: nextReserveOut,
    protocolFeesIn: nextProtocolFees,
  };
}

function collectProtocolFees(
  state: Readonly<PoolState>,
  amount: bigint,
): PoolState {
  if (amount < 0n || amount > state.protocolFeesIn) {
    throw new Error("invalid protocol-fee collection");
  }
  return { ...state, protocolFeesIn: state.protocolFeesIn - amount };
}

function deterministicValues(count: number): bigint[] {
  let state = 0x9e3779b97f4a7c15n;
  const values: bigint[] = [];
  for (let index = 0; index < count; index += 1) {
    state ^= state << 13n;
    state ^= state >> 7n;
    state ^= state << 17n;
    state &= (1n << 128n) - 1n;
    values.push(state + 1n);
  }
  return values;
}

describe("Confidential best-execution model and invariants", function () {
  it("matches the published fee calculation and quote/settlement math across tiers", function () {
    const values = deterministicValues(768);
    for (let index = 0; index < values.length; index += 3) {
      const reserve0 = 1_000_000n + values[index] % 10n ** 24n;
      const reserve1 = 1_000_000n + values[index + 1] % 10n ** 24n;
      for (const feeBps of FEE_TIERS) {
        const minimum = minimumCipherDEXV1ConfidentialInput(feeBps);
        const amountIn = minimum + values[index + 2] % 10n ** 18n;
        for (const [reserveIn, reserveOut] of [
          [reserve0, reserve1],
          [reserve1, reserve0],
        ] as const) {
          const quote = quoteExactInput(amountIn, reserveIn, reserveOut, feeBps);
          const fees = calculateCipherDEXV1FeeBreakdown(amountIn, feeBps);
          expect(quote.valid).to.equal(true);
          expect(quote.netAmountIn).to.equal(fees.netAmountIn);
          expect(quote.protocolFee).to.equal(fees.protocolFee);

          const before: PoolState = {
            reserveIn,
            reserveOut,
            protocolFeesIn: values[index] % 10_000n,
          };
          const after = settleExactInput(before, amountIn, quote.amountOut, feeBps);
          expect(after.reserveOut).to.equal(reserveOut - quote.amountOut);
          expect(after.reserveIn).to.equal(reserveIn + amountIn - quote.protocolFee);
          expect(after.protocolFeesIn).to.equal(
            before.protocolFeesIn + quote.protocolFee,
          );
          expect(after.reserveIn * after.reserveOut).to.be.gte(
            before.reserveIn * before.reserveOut,
          );
        }
      }
    }
  });

  it("skips absent, uninitialized and encrypted-invalid candidates", function () {
    const amountIn = 501n;
    const selected = selectBest(amountIn, [
      { feeBps: 5, exists: true, initialized: true, reserveIn: 1_000_000n, reserveOut: 2_000_000n },
      { feeBps: 30, exists: true, initialized: true, reserveIn: 1_000_000n, reserveOut: 2_000_000n },
      { feeBps: 100, exists: true, initialized: true, reserveIn: 1_000_000n, reserveOut: 2_000_000n },
    ]);
    expect(selected?.candidate.feeBps).to.equal(100);

    expect(selectBest(20_000n, [
      { feeBps: 5, exists: false, initialized: false, reserveIn: 0n, reserveOut: 0n },
      { feeBps: 30, exists: true, initialized: false, reserveIn: 0n, reserveOut: 0n },
      { feeBps: 100, exists: true, initialized: true, reserveIn: MAX_UINT256, reserveOut: 2n },
    ])).to.equal(undefined);
  });

  it("selects every approved tier and resolves exact ties to the lower tier", function () {
    const amountIn = 20_000n;
    const base = (feeBps: number, reserveOut: bigint): Candidate => ({
      feeBps,
      exists: true,
      initialized: true,
      reserveIn: 1_000_000n,
      reserveOut,
    });

    expect(selectBest(amountIn, [base(5, 5_000_000n), base(30, 4_000_000n), base(100, 3_000_000n)])?.candidate.feeBps).to.equal(5);
    expect(selectBest(amountIn, [base(5, 3_000_000n), base(30, 5_000_000n), base(100, 4_000_000n)])?.candidate.feeBps).to.equal(30);
    expect(selectBest(amountIn, [base(5, 3_000_000n), base(30, 4_000_000n), base(100, 5_000_000n)])?.candidate.feeBps).to.equal(100);

    const tied = [base(5, 5_000_000n), base(30, 5_012_518n)];
    const firstQuote = quoteExactInput(amountIn, tied[0].reserveIn, tied[0].reserveOut, tied[0].feeBps);
    let exactTie: Candidate | undefined;
    for (
      let reserveOut = tied[1].reserveOut - 20_000n;
      reserveOut <= tied[1].reserveOut + 20_000n;
      reserveOut += 1n
    ) {
      const candidate = base(30, reserveOut);
      if (quoteExactInput(amountIn, candidate.reserveIn, candidate.reserveOut, 30).amountOut === firstQuote.amountOut) {
        exactTie = candidate;
        break;
      }
    }
    expect(exactTie).to.not.equal(undefined);
    expect(selectBest(amountIn, [tied[0], exactTie!])?.candidate.feeBps).to.equal(5);
  });

  it("enforces tiny-input and uint256 operational boundaries", function () {
    for (const feeBps of FEE_TIERS) {
      const minimum = minimumCipherDEXV1ConfidentialInput(feeBps);
      expect(quoteExactInput(minimum - 1n, 1_000_000n, 2_000_000n, feeBps).valid).to.equal(false);
      expect(quoteExactInput(minimum, 1_000_000n, 2_000_000n, feeBps).valid).to.equal(true);
    }
    expect(quoteExactInput(MAX_UINT256, 1n, 1n, 30).valid).to.equal(false);
    expect(quoteExactInput(20_000n, MAX_UINT256, 2n, 30).valid).to.equal(false);
    expect(quoteExactInput(20_000n, 2n ** 200n, 2n ** 100n, 30).valid).to.equal(false);
  });

  it("skips a better-looking quote that cannot pass strict settlement bounds", function () {
    const reserve = (1n << 128n) - 1n;
    const selected = selectBest(12_001n, [
      {
        feeBps: 5,
        exists: true,
        initialized: true,
        reserveIn: reserve,
        reserveOut: reserve,
      },
      {
        feeBps: 30,
        exists: true,
        initialized: true,
        reserveIn: reserve / 2n,
        reserveOut: reserve / 2n,
      },
    ]);
    expect(quoteExactInput(12_001n, reserve, reserve, 5).amountOut).to.equal(11_993n);
    expect(settlementIsOperational(
      12_001n,
      {
        feeBps: 5,
        exists: true,
        initialized: true,
        reserveIn: reserve,
        reserveOut: reserve,
      },
      quoteExactInput(12_001n, reserve, reserve, 5),
    )).to.equal(false);
    expect(selected?.candidate.feeBps).to.equal(30);
  });

  it("keeps quote-only state immutable and collection outside effective reserves", function () {
    const before: PoolState = {
      reserveIn: 4_000_000n,
      reserveOut: 9_000_000n,
      protocolFeesIn: 77n,
    };
    const snapshot = structuredClone(before);
    const quote = quoteExactInput(20_000n, before.reserveIn, before.reserveOut, 30);
    expect(quote.valid).to.equal(true);
    expect(before).to.deep.equal(snapshot);

    const settled = settleExactInput(before, 20_000n, quote.amountOut, 30);
    const collected = collectProtocolFees(settled, settled.protocolFeesIn);
    expect(collected.reserveIn).to.equal(settled.reserveIn);
    expect(collected.reserveOut).to.equal(settled.reserveOut);
    expect(collected.protocolFeesIn).to.equal(0n);
    expect(() => collectProtocolFees(settled, settled.protocolFeesIn + 1n)).to.throw(
      "invalid protocol-fee collection",
    );
  });

  it("does not mutate modeled state when deadline, slippage or settlement checks fail", function () {
    const before: PoolState = {
      reserveIn: 1_000_000n,
      reserveOut: 2_000_000n,
      protocolFeesIn: 0n,
    };
    const quote = quoteExactInput(20_000n, before.reserveIn, before.reserveOut, 30);
    const snapshot = structuredClone(before);
    expect(() => settleExactInput(before, 20_000n, quote.amountOut + 1n, 30)).to.throw(
      "settlement rejected",
    );
    expect(before).to.deep.equal(snapshot);
  });
});
