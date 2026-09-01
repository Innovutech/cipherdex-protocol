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

export function shouldCloseObservation(
  lastObservationAt: number,
  now: number,
  operationsSinceObservation: number,
  minimumInterval: number,
  minimumOperations: number,
): boolean {
  const values = [lastObservationAt, now, operationsSinceObservation, minimumInterval];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error("observation values must be non-negative safe integers");
  }
  if (!Number.isSafeInteger(minimumOperations) || minimumOperations <= 0) {
    throw new Error("minimumOperations must be a positive safe integer");
  }
  if (now < lastObservationAt) throw new Error("observation time moved backwards");
  return operationsSinceObservation >= minimumOperations &&
    now - lastObservationAt >= minimumInterval;
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
