export const FIELD_BITS = 128n;
export const FIELD_BASE = 1n << FIELD_BITS;
export const FIELD_MASK = FIELD_BASE - 1n;
export const UINT256_MAX = (1n << 256n) - 1n;
export const DEVIATION_DENOMINATOR_BPS = 10_000n;

export type PackedUint128Pair = Readonly<{ high: bigint; low: bigint }>;
export type SymmetricPriceBounds = Readonly<{ minimum: bigint; maximum: bigint }>;

function requireBigInt(value: unknown, name: string): asserts value is bigint {
  if (typeof value !== "bigint") throw new TypeError(`${name} must be a bigint`);
}

function requireUint128(value: unknown, name: string): asserts value is bigint {
  requireBigInt(value, name);
  if (value < 0n || value > FIELD_MASK) {
    throw new RangeError(`${name} must be in 0..2^128-1`);
  }
}

function requireUint256(value: unknown, name: string): asserts value is bigint {
  requireBigInt(value, name);
  if (value < 0n || value > UINT256_MAX) {
    throw new RangeError(`${name} must be in 0..2^256-1`);
  }
}

export function packUint128Pair(high: bigint, low: bigint): bigint {
  requireUint128(high, "high field");
  requireUint128(low, "low field");
  return high * FIELD_BASE + low;
}

export function unpackUint128Pair(packed: bigint): PackedUint128Pair {
  requireUint256(packed, "packed word");
  return Object.freeze({
    high: packed / FIELD_BASE,
    low: packed % FIELD_BASE,
  });
}

export function packSwapInput(amountIn: bigint, minimumOut: bigint): bigint {
  return packUint128Pair(amountIn, minimumOut);
}

export function packLiquidityAmounts(
  amount0Maximum: bigint,
  amount1Maximum: bigint,
): bigint {
  return packUint128Pair(amount0Maximum, amount1Maximum);
}

export function packRemovalMinimums(
  minimumAmount0: bigint,
  minimumAmount1: bigint,
): bigint {
  return packUint128Pair(minimumAmount0, minimumAmount1);
}

export function deriveSymmetricPriceBounds(
  expectedPriceX18: bigint,
  maximumDeviationBps: bigint,
): SymmetricPriceBounds {
  requireUint256(expectedPriceX18, "expected price");
  requireBigInt(maximumDeviationBps, "maximum deviation");
  if (maximumDeviationBps < 0n || maximumDeviationBps > DEVIATION_DENOMINATOR_BPS) {
    throw new RangeError("maximum deviation must be in 0..10000 bps");
  }

  const quotient = expectedPriceX18 / DEVIATION_DENOMINATOR_BPS;
  const remainder = expectedPriceX18 % DEVIATION_DENOMINATOR_BPS;
  const delta = quotient * maximumDeviationBps +
    (remainder * maximumDeviationBps) / DEVIATION_DENOMINATOR_BPS;
  const mathematicalMaximum = expectedPriceX18 + delta;
  return Object.freeze({
    minimum: expectedPriceX18 - delta,
    maximum: mathematicalMaximum > UINT256_MAX ? UINT256_MAX : mathematicalMaximum,
  });
}

export function deriveInitialShares(
  amount0: bigint,
  amount1: bigint,
  scale0: bigint,
  scale1: bigint,
): bigint {
  requireUint128(amount0, "amount0");
  requireUint128(amount1, "amount1");
  requireUint256(scale0, "scale0");
  requireUint256(scale1, "scale1");
  if (amount0 === 0n || amount1 === 0n || scale0 === 0n || scale1 === 0n) {
    throw new RangeError("initial amounts and scales must be positive");
  }
  const normalized0 = amount0 * scale0;
  const normalized1 = amount1 * scale1;
  if (normalized0 > UINT256_MAX || normalized1 > UINT256_MAX) {
    throw new RangeError("normalized initial amount overflows uint256");
  }
  return normalized0 < normalized1 ? normalized0 : normalized1;
}

export class PackingTransitionModel {
  private used = new Set<string>();
  private calls = 0n;

  successfulCalls(): bigint { return this.calls; }
  requestUsed(requestId: string): boolean { return this.used.has(requestId); }

  swapSeparate(
    requestId: string,
    amountIn: bigint,
    minimumOut: bigint,
    deadline: bigint,
    now: bigint,
  ): bigint {
    return this.transact(() => this.swap(requestId, amountIn, minimumOut, deadline, now));
  }

  swapPacked(requestId: string, packed: bigint, deadline: bigint, now: bigint): bigint {
    return this.transact(() => {
      const fields = unpackUint128Pair(packed);
      return this.swap(requestId, fields.high, fields.low, deadline, now);
    });
  }

  liquiditySeparate(requestId: string, amount0: bigint, amount1: bigint): bigint {
    return this.transact(() => this.liquidity(requestId, amount0, amount1));
  }

  liquidityPacked(requestId: string, packed: bigint): bigint {
    return this.transact(() => {
      const fields = unpackUint128Pair(packed);
      return this.liquidity(requestId, fields.high, fields.low);
    });
  }

  private swap(
    requestId: string,
    amountIn: bigint,
    minimumOut: bigint,
    deadline: bigint,
    now: bigint,
  ): bigint {
    this.consume(requestId);
    requireUint128(amountIn, "amountIn");
    requireUint128(minimumOut, "minimumOut");
    if (deadline < now) throw new Error("deadline expired");
    if (amountIn === 0n) throw new Error("input must be positive");
    const output = amountIn * 2n;
    if (output > UINT256_MAX) throw new Error("transition overflow");
    if (output < minimumOut) throw new Error("minimum output not met");
    this.calls += 1n;
    return output;
  }

  private liquidity(requestId: string, amount0: bigint, amount1: bigint): bigint {
    this.consume(requestId);
    requireUint128(amount0, "amount0");
    requireUint128(amount1, "amount1");
    if (amount0 === 0n || amount1 === 0n) throw new Error("amounts must be positive");
    const result = amount0 + amount1;
    if (result > UINT256_MAX) throw new Error("transition overflow");
    this.calls += 1n;
    return result;
  }

  private consume(requestId: string): void {
    if (!/^0x[0-9a-f]{64}$/iu.test(requestId) || /^0x0{64}$/iu.test(requestId)) {
      throw new Error("invalid request id");
    }
    if (this.used.has(requestId)) throw new Error("request already used");
    this.used.add(requestId);
  }

  private transact<T>(operation: () => T): T {
    const used = new Set(this.used);
    const calls = this.calls;
    try {
      return operation();
    } catch (error) {
      this.used = used;
      this.calls = calls;
      throw error;
    }
  }
}
