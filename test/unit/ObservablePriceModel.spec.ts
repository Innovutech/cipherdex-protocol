import { expect } from "chai";

import {
  PRICE_SCALE,
  adaptiveObservationBucket,
  boundedObservationPrice,
  cpmmSwapExactInput,
  inferAggregateInputRange,
  normalizedPriceX18,
  observationQuantum,
  quantizePriceFloor,
  shouldCloseObservation,
} from "../../scripts/observable-price-model";

describe("observable confidential price model", function () {
  it("normalizes mixed token decimals consistently", function () {
    expect(normalizedPriceX18(
      { reserve0: 2n * 10n ** 18n, reserve1: 5n * 10n ** 6n },
      18,
      6,
    )).to.equal((5n * PRICE_SCALE) / 2n);
  });

  it("quantizes inside a deterministic floor bucket", function () {
    expect(quantizePriceFloor(1_987_654_321_000_000_000n, 10n ** 16n))
      .to.equal(1_980_000_000_000_000_000n);
  });

  it("uses overflow-safe adaptive 50-bps quantization", function () {
    expect(observationQuantum(2n * PRICE_SCALE)).to.equal(10n ** 16n);
    expect(observationQuantum(1n)).to.equal(1n);
    const maximum = (1n << 256n) - 1n;
    expect(observationQuantum(maximum)).to.be.lessThan(maximum);
  });

  it("bounds extreme price movement before quantization", function () {
    const reference = 2n * PRICE_SCALE;
    expect(boundedObservationPrice(10n * PRICE_SCALE, reference))
      .to.equal(4n * PRICE_SCALE);
    expect(boundedObservationPrice(PRICE_SCALE / 10n, reference))
      .to.equal(PRICE_SCALE);
    expect(adaptiveObservationBucket(10n * PRICE_SCALE, reference)).to.deep.equal({
      bucketX18: 4n * PRICE_SCALE,
      quantumX18: 10n ** 16n,
    });
  });

  it("matches the confidential CPMM retained-reserve rounding", function () {
    const result = cpmmSwapExactInput(
      { reserve0: 1_000_000n, reserve1: 2_000_000n },
      10_000n,
      30n,
      true,
    );
    const netInput = (10_000n * 9_970n) / 10_000n;
    const denominator = 1_000_000n + netInput;
    const retained = (2_000_000_000_000n + denominator - 1n) / denominator;
    expect(result).to.deep.equal({
      reserve0: denominator,
      reserve1: retained,
      amountOut: 2_000_000n - retained,
    });
    expect(result.reserve0 * result.reserve1).to.be.gte(2_000_000_000_000n);
  });

  it("closes only after both time and activity thresholds", function () {
    expect(shouldCloseObservation(100, 220, 2, 120, 3)).to.equal(false);
    expect(shouldCloseObservation(100, 219, 3, 120, 3)).to.equal(false);
    expect(shouldCloseObservation(100, 220, 3, 120, 3)).to.equal(true);
  });

  it("shows that a coarse bucket leaves an aggregate input interval", function () {
    const opening = { reserve0: 1_000_000n, reserve1: 2_000_000n };
    const actual = cpmmSwapExactInput(opening, 10_000n, 30n, true);
    const quantum = 10n ** 16n;
    const bucket = quantizePriceFloor(normalizedPriceX18(actual, 6, 6), quantum);
    const inferred = inferAggregateInputRange(
      opening,
      bucket,
      quantum,
      25_000n,
      30n,
      true,
      6,
      6,
    );
    expect(inferred).to.not.equal(undefined);
    expect(inferred!.minimum).to.be.lte(10_000n);
    expect(inferred!.maximum).to.be.gte(10_000n);
    expect(inferred!.count).to.be.greaterThan(1n);
  });

  it("rejects invalid model inputs", function () {
    expect(() => quantizePriceFloor(1n, 0n)).to.throw("quantum must be positive");
    expect(() => cpmmSwapExactInput(
      { reserve0: 1n, reserve1: 1n },
      1n,
      10_000n,
      true,
    )).to.throw("feeBps is outside");
    expect(() => shouldCloseObservation(2, 1, 1, 0, 1))
      .to.throw("observation time moved backwards");
  });
});
