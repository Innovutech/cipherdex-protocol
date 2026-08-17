const BPS_DENOMINATOR = 10_000n;
const MAX_TEST_SLIPPAGE_BPS = 5_000n;
const UINT256_MAX = (1n << 256n) - 1n;

const ceilDiv = (numerator: bigint, denominator: bigint): bigint =>
  numerator / denominator + (numerator % denominator === 0n ? 0n : 1n);

export function testnetSlippageBps(): bigint {
  const raw = process.env.COTI_TESTNET_SLIPPAGE_BPS?.trim() ?? "100";
  if (!/^\d+$/.test(raw)) {
    throw new Error("COTI_TESTNET_SLIPPAGE_BPS must be an integer");
  }
  const parsed = BigInt(raw);
  if (parsed > MAX_TEST_SLIPPAGE_BPS) {
    throw new Error("COTI_TESTNET_SLIPPAGE_BPS exceeds 5000");
  }
  return parsed;
}

export function minimumWithSlippage(
  value: bigint,
  slippageBps = testnetSlippageBps(),
): bigint {
  if (value <= 0n) throw new Error("slippage reference value must be positive");
  if (slippageBps < 0n || slippageBps > MAX_TEST_SLIPPAGE_BPS) {
    throw new Error("slippage bps must be between 0 and 5000");
  }
  const bounded = ceilDiv(
    value * (BPS_DENOMINATOR - slippageBps),
    BPS_DENOMINATOR,
  );
  return bounded > 0n ? bounded : 1n;
}

export function confidentialLiquidityBounds(
  amount0: bigint,
  token0Decimals: number,
  amount1: bigint,
  token1Decimals: number,
  expectedInitialized: boolean,
  slippageBps = testnetSlippageBps(),
): Readonly<{ minShares: bigint; minPriceX18: bigint; maxPriceX18: bigint }> {
  if (
    amount0 <= 0n ||
    amount1 <= 0n ||
    !Number.isInteger(token0Decimals) ||
    !Number.isInteger(token1Decimals) ||
    token0Decimals < 0 ||
    token1Decimals < 0 ||
    token0Decimals > 18 ||
    token1Decimals > 18
  ) throw new Error("invalid confidential liquidity bound inputs");

  const normalized0 = amount0 * 10n ** BigInt(18 - token0Decimals);
  const normalized1 = amount1 * 10n ** BigInt(18 - token1Decimals);
  const priceNumerator = normalized1 * 10n ** 18n;
  if (normalized0 > UINT256_MAX || normalized1 > UINT256_MAX || priceNumerator > UINT256_MAX) {
    throw new Error("confidential liquidity bound calculation exceeds uint256");
  }
  const floorPrice = priceNumerator / normalized0;
  const ceilingPrice = ceilDiv(priceNumerator, normalized0);
  const minPriceX18 = minimumWithSlippage(floorPrice, slippageBps);
  const maxPriceNumerator = ceilingPrice * (BPS_DENOMINATOR + slippageBps);
  if (maxPriceNumerator > UINT256_MAX * BPS_DENOMINATOR) {
    throw new Error("confidential maximum price bound exceeds uint256");
  }
  const maxPriceX18 = ceilDiv(maxPriceNumerator, BPS_DENOMINATOR);
  const initialShares = normalized0 < normalized1 ? normalized0 : normalized1;
  return {
    minShares: expectedInitialized ? 1n : minimumWithSlippage(initialShares, slippageBps),
    minPriceX18,
    maxPriceX18,
  };
}
