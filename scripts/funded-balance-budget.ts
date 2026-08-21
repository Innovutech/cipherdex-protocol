export const MAX_SCENARIO_BALANCE_DIVISOR = 1_000n;
export const PREFERRED_TEST_BALANCE_DIVISOR = 10_000n;

export function fundedScenarioCap(balance: bigint): bigint {
  if (balance <= 0n) throw new Error("funded scenario requires a positive private balance");
  return balance / MAX_SCENARIO_BALANCE_DIVISOR;
}

export function deriveFundedTestAmount(
  balance: bigint,
  minimumSafeAmount: bigint,
): Readonly<{ amount: bigint; cap: bigint }> {
  if (minimumSafeAmount <= 0n) throw new Error("minimum funded amount must be positive");
  const cap = fundedScenarioCap(balance);
  const preferred = balance / PREFERRED_TEST_BALANCE_DIVISOR;
  const amount = preferred > minimumSafeAmount ? preferred : minimumSafeAmount;
  if (amount <= 0n || amount > cap) {
    throw new Error("private balance cannot satisfy the funded test amount within the 0.1% cap");
  }
  return Object.freeze({ amount, cap });
}

export function minimumInputWithProtocolFee(feeBps: number): bigint {
  if (!Number.isInteger(feeBps) || feeBps <= 0 || feeBps >= 10_000) {
    throw new Error("funded fee tier is invalid");
  }
  for (let amount = 1n; amount <= 100_000n; amount += 1n) {
    const netAmount = amount * BigInt(10_000 - feeBps) / 10_000n;
    if ((amount - netAmount) / 6n > 0n) return amount;
  }
  throw new Error("unable to derive a safe minimum private swap input");
}
