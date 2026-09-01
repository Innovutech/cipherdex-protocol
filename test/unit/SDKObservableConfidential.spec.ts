import { expect } from "chai";
import { AbiCoder, getAddress, Interface, toBeHex, zeroPadValue } from "ethers";

import {
  PUBLIC_PRICE_OBSERVATION_TOPIC,
  OBSERVABLE_CONFIDENTIAL_FEE_VAULT_ABI,
  OBSERVABLE_MIN_CONFIDENTIAL_AGGREGATED_SWAPS,
  classifyObservablePriceFreshness,
  estimateObservableSwapOutput,
  parseObservablePriceObservation,
} from "../../sdk/src/observableConfidential";

describe("observable confidential SDK", function () {
  const pool = getAddress("0x1000000000000000000000000000000000000001");

  it("exposes the strict confidential fee anonymity threshold without a bypass", function () {
    const vault = new Interface(OBSERVABLE_CONFIDENTIAL_FEE_VAULT_ABI);
    expect(OBSERVABLE_MIN_CONFIDENTIAL_AGGREGATED_SWAPS).to.equal(8);
    expect(vault.getFunction("MIN_CONFIDENTIAL_AGGREGATED_SWAPS")).to.not.equal(null);
    expect(vault.getFunction("confidentialSwapCountByEpoch")).to.not.equal(null);
    expect(vault.getFunction("rescue")).to.equal(null);
    expect(vault.getFunction("sweepSubthreshold")).to.equal(null);
  });

  function observationLog(overrides: Partial<{
    sequence: bigint;
    price: bigint;
    observedAt: bigint;
    publishedAt: bigint;
    activityCount: bigint;
    quantum: bigint;
    initial: boolean;
  }> = {}) {
    const values = {
      sequence: 7n,
      price: 2n * 10n ** 18n,
      observedAt: 1_000n,
      publishedAt: 1_120n,
      activityCount: 3n,
      quantum: 10n ** 16n,
      initial: false,
      ...overrides,
    };
    return {
      address: pool,
      topics: [
        PUBLIC_PRICE_OBSERVATION_TOPIC,
        zeroPadValue(toBeHex(values.sequence), 32),
      ],
      data: AbiCoder.defaultAbiCoder().encode(
        ["uint256", "uint64", "uint64", "uint32", "uint256", "bool"],
        [
          values.price,
          values.observedAt,
          values.publishedAt,
          values.activityCount,
          values.quantum,
          values.initial,
        ],
      ),
    } as const;
  }

  it("authenticates and parses delayed observations", function () {
    expect(parseObservablePriceObservation(observationLog(), pool)).to.deep.equal({
      pool,
      sequence: 7n,
      priceBucketX18: 2n * 10n ** 18n,
      observedAt: 1_000n,
      publishedAt: 1_120n,
      activityCount: 3n,
      quantumX18: 10n ** 16n,
      initial: false,
    });
  });

  it("rejects the wrong emitter, topic and invalid initial activity", function () {
    expect(() => parseObservablePriceObservation(
      observationLog(),
      "0x2000000000000000000000000000000000000002",
    )).to.throw("Unauthenticated");
    expect(() => parseObservablePriceObservation({
      ...observationLog(),
      topics: [`0x${"00".repeat(32)}`, observationLog().topics[1]],
    }, pool)).to.throw("Unauthenticated");
    expect(() => parseObservablePriceObservation(observationLog({ initial: true }), pool))
      .to.throw("Invalid observable-price event values");
  });

  it("classifies unavailable, current and stale observations", function () {
    const current = {
      initialized: true,
      priceBucketX18: 2n * 10n ** 18n,
      quantumX18: 10n ** 16n,
      sequence: 1n,
      observedAt: 1_000n,
      publishedAt: 1_120n,
      activityCount: 3n,
      hasPendingObservation: true,
    } as const;
    expect(classifyObservablePriceFreshness(current, 1_300n, 300n)).to.equal("current");
    expect(classifyObservablePriceFreshness(current, 1_301n, 300n)).to.equal("stale");
    expect(classifyObservablePriceFreshness(
      { ...current, initialized: false },
      1_300n,
      300n,
    )).to.equal("unavailable");
  });

  it("estimates both directions with mixed decimals and marks outputs indicative", function () {
    const token0To1 = estimateObservableSwapOutput({
      amountIn: 1n * 10n ** 18n,
      zeroForOne: true,
      token0Decimals: 18,
      token1Decimals: 6,
      feeBps: 30n,
      priceBucketX18: 2n * 10n ** 18n,
    });
    expect(token0To1.amountOut).to.equal(1_994_000n);
    expect(token0To1.authoritative).to.equal(false);
    expect(token0To1.excludesPriceImpact).to.equal(true);

    const token1To0 = estimateObservableSwapOutput({
      amountIn: 2n * 10n ** 6n,
      zeroForOne: false,
      token0Decimals: 18,
      token1Decimals: 6,
      feeBps: 30n,
      priceBucketX18: 2n * 10n ** 18n,
    });
    expect(token1To0.amountOut).to.equal(997n * 10n ** 15n);
  });

  it("rejects zero, invalid fees and invalid decimals", function () {
    expect(() => estimateObservableSwapOutput({
      amountIn: 0n,
      zeroForOne: true,
      token0Decimals: 18,
      token1Decimals: 18,
      feeBps: 30n,
      priceBucketX18: 10n ** 18n,
    })).to.throw("must be positive");
    expect(() => estimateObservableSwapOutput({
      amountIn: 1n,
      zeroForOne: true,
      token0Decimals: 19,
      token1Decimals: 18,
      feeBps: 30n,
      priceBucketX18: 10n ** 18n,
    })).to.throw("token0Decimals");
  });
});
