import {
  cpmmSwapExactInput,
  inferAggregateInputRange,
  normalizedPriceX18,
  quantizePriceFloor,
  type Reserves,
} from "./observable-price-model";

const OPENING: Reserves = Object.freeze({
  reserve0: 1_000_000n,
  reserve1: 2_000_000n,
});
const FEE_BPS = 30n;
const MAXIMUM_SEARCH_INPUT = 100_000n;
const TRADE_INPUTS = Object.freeze([3_000n, 5_000n, 7_000n, 11_000n, 13_000n]);

type LeakageRow = Readonly<{
  bucketBps: number;
  operations: number;
  actualAggregateInput: string;
  candidateMinimum: string;
  candidateMaximum: string;
  candidateCount: string;
  aggregateRangeWidthBps: string;
  individualAmountsIdentifiable: boolean;
}>;

const initialPrice = normalizedPriceX18(OPENING, 6, 6);
const rows: LeakageRow[] = [];

for (const bucketBps of [25, 50, 100]) {
  const quantum = (initialPrice * BigInt(bucketBps)) / 10_000n;
  for (const operations of [1, 3, 5]) {
    let reserves = OPENING;
    let aggregateInput = 0n;
    for (const input of TRADE_INPUTS.slice(0, operations)) {
      reserves = cpmmSwapExactInput(reserves, input, FEE_BPS, true);
      aggregateInput += input;
    }
    const bucket = quantizePriceFloor(normalizedPriceX18(reserves, 6, 6), quantum);
    const inferred = inferAggregateInputRange(
      OPENING,
      bucket,
      quantum,
      MAXIMUM_SEARCH_INPUT,
      FEE_BPS,
      true,
      6,
      6,
    );
    if (!inferred) throw new Error("configured leakage scenario has no inferred candidates");
    const width = inferred.maximum - inferred.minimum;
    const widthBps = aggregateInput === 0n ? 0n : (width * 10_000n) / aggregateInput;
    rows.push(Object.freeze({
      bucketBps,
      operations,
      actualAggregateInput: aggregateInput.toString(),
      candidateMinimum: inferred.minimum.toString(),
      candidateMaximum: inferred.maximum.toString(),
      candidateCount: inferred.count.toString(),
      aggregateRangeWidthBps: widthBps.toString(),
      individualAmountsIdentifiable: operations === 1 && inferred.count === 1n,
    }));
  }
}

console.log(JSON.stringify({
  model: "known-opening-reserves, known-direction, same-direction aggregate",
  openingReserves: {
    reserve0: OPENING.reserve0.toString(),
    reserve1: OPENING.reserve1.toString(),
  },
  feeBps: FEE_BPS.toString(),
  rows,
}, null, 2));
