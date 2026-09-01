export const PRICE_SCALE = 10n ** 18n;
export const FEE_DENOMINATOR = 10_000n;

export type Reserves = Readonly<{
  reserve0: bigint;
  reserve1: bigint;
}>;

export type SwapResult = Readonly<Reserves & {
  amountOut: bigint;
}>;

function requirePositive(value: bigint, name: string): void {
  if (value <= 0n) throw new Error(`${name} must be positive`);
}

export function normalizedPriceX18(
  reserves: Reserves,
  token0Decimals: number,
  token1Decimals: number,
): bigint {
  requirePositive(reserves.reserve0, "reserve0");
  requirePositive(reserves.reserve1, "reserve1");
  if (
    !Number.isInteger(token0Decimals) ||
    !Number.isInteger(token1Decimals) ||
    token0Decimals < 0 ||
    token1Decimals < 0 ||
    token0Decimals > 18 ||
    token1Decimals > 18
  ) throw new Error("token decimals must be integers from 0 through 18");
  const scale0 = 10n ** BigInt(18 - token0Decimals);
  const scale1 = 10n ** BigInt(18 - token1Decimals);
  return (reserves.reserve1 * scale1 * PRICE_SCALE) / (reserves.reserve0 * scale0);
}

export function quantizePriceFloor(priceX18: bigint, quantumX18: bigint): bigint {
  if (priceX18 < 0n) throw new Error("price must not be negative");
  requirePositive(quantumX18, "quantum");
  return (priceX18 / quantumX18) * quantumX18;
}

export function observationQuantum(
  referencePriceX18: bigint,
  bucketBps = 50n,
): bigint {
  requirePositive(referencePriceX18, "referencePriceX18");
  requirePositive(bucketBps, "bucketBps");
  if (bucketBps >= FEE_DENOMINATOR) {
    throw new Error("bucketBps must be below 10000");
  }
  const quotient = referencePriceX18 / FEE_DENOMINATOR;
  const remainder = referencePriceX18 % FEE_DENOMINATOR;
  const quantum = quotient * bucketBps +
    (remainder * bucketBps) / FEE_DENOMINATOR;
  return quantum === 0n ? 1n : quantum;
}

export function boundedObservationPrice(
  exactPriceX18: bigint,
  referencePriceX18: bigint,
): bigint {
  requirePositive(exactPriceX18, "exactPriceX18");
  requirePositive(referencePriceX18, "referencePriceX18");
  const half = referencePriceX18 / 2n;
  const lower = half === 0n ? 1n : half;
  const upper = referencePriceX18 * 2n;
  if (exactPriceX18 < lower) return lower;
  if (exactPriceX18 > upper) return upper;
  return exactPriceX18;
}

export function adaptiveObservationBucket(
  exactPriceX18: bigint,
  referencePriceX18: bigint,
  bucketBps = 50n,
): Readonly<{ bucketX18: bigint; quantumX18: bigint }> {
  const quantumX18 = observationQuantum(referencePriceX18, bucketBps);
  const bounded = boundedObservationPrice(exactPriceX18, referencePriceX18);
  return Object.freeze({
    bucketX18: quantizePriceFloor(bounded, quantumX18),
    quantumX18,
  });
}

export function cpmmSwapExactInput(
  reserves: Reserves,
  amountIn: bigint,
  feeBps: bigint,
  zeroForOne: boolean,
): SwapResult {
  requirePositive(reserves.reserve0, "reserve0");
  requirePositive(reserves.reserve1, "reserve1");
  requirePositive(amountIn, "amountIn");
  if (feeBps < 0n || feeBps >= FEE_DENOMINATOR) {
    throw new Error("feeBps is outside the CPMM fee range");
  }
  const netAmountIn = (amountIn * (FEE_DENOMINATOR - feeBps)) / FEE_DENOMINATOR;
  requirePositive(netAmountIn, "netAmountIn");
  const reserveIn = zeroForOne ? reserves.reserve0 : reserves.reserve1;
  const reserveOut = zeroForOne ? reserves.reserve1 : reserves.reserve0;
  const nextReserveIn = reserveIn + netAmountIn;
  const invariant = reserveIn * reserveOut;
  const retainedReserve = (invariant + nextReserveIn - 1n) / nextReserveIn;
  const amountOut = reserveOut - retainedReserve;
  requirePositive(amountOut, "amountOut");
  return zeroForOne
    ? { reserve0: nextReserveIn, reserve1: retainedReserve, amountOut }
    : { reserve0: retainedReserve, reserve1: nextReserveIn, amountOut };
}

export function shouldPublishObservation(
  publicBucketX18: bigint,
  nextBucketX18: bigint,
): boolean {
  requirePositive(publicBucketX18, "publicBucketX18");
  requirePositive(nextBucketX18, "nextBucketX18");
  return publicBucketX18 !== nextBucketX18;
}

export type CandidateInputRange = Readonly<{
  minimum: bigint;
  maximum: bigint;
  count: bigint;
}>;

/**
 * Enumerates a bounded attacker search space. This intentionally models the
 * strongest case where the attacker already knows the exact opening reserves.
 */
export function inferAggregateInputRange(
  opening: Reserves,
  observedBucketX18: bigint,
  quantumX18: bigint,
  maximumInput: bigint,
  feeBps: bigint,
  zeroForOne: boolean,
  token0Decimals: number,
  token1Decimals: number,
): CandidateInputRange | undefined {
  requirePositive(quantumX18, "quantum");
  requirePositive(maximumInput, "maximumInput");
  let minimum: bigint | undefined;
  let maximum: bigint | undefined;
  let count = 0n;
  for (let input = 1n; input <= maximumInput; input += 1n) {
    let result: SwapResult;
    try {
      result = cpmmSwapExactInput(opening, input, feeBps, zeroForOne);
    } catch {
      continue;
    }
    const bucket = quantizePriceFloor(
      normalizedPriceX18(result, token0Decimals, token1Decimals),
      quantumX18,
    );
    if (bucket !== observedBucketX18) continue;
    minimum ??= input;
    maximum = input;
    count += 1n;
  }
  return minimum === undefined || maximum === undefined
    ? undefined
    : Object.freeze({ minimum, maximum, count });
}
