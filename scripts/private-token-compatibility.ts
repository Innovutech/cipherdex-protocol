import { isAddress } from "ethers";

export type PrivateTokenCompatibilityReader = Readonly<{
  isCompatiblePrivateToken(token: string): Promise<boolean>;
}>;

function isCompatibilityReader(
  value: unknown,
): value is PrivateTokenCompatibilityReader {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Readonly<{ isCompatiblePrivateToken?: unknown }>;
  return typeof candidate.isCompatiblePrivateToken === "function";
}

export async function assertCompatiblePrivateTokens(
  factory: unknown,
  tokenAddresses: readonly string[],
): Promise<void> {
  if (
    tokenAddresses.length === 0 ||
    tokenAddresses.some((token) => !isAddress(token))
  ) {
    throw new Error("private-token compatibility requires deployed token addresses");
  }
  if (!isCompatibilityReader(factory)) {
    throw new Error("factory does not expose private-token compatibility");
  }
  const compatibility = await Promise.all(
    tokenAddresses.map((token) => factory.isCompatiblePrivateToken(token)),
  );
  const incompatibleIndex = compatibility.findIndex((compatible) => !compatible);
  if (incompatibleIndex >= 0) {
    throw new Error(
      `configured private token is not technically compatible: ${tokenAddresses[incompatibleIndex]}`,
    );
  }
}
