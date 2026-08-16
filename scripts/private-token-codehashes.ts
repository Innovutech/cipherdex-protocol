import { ethers } from "ethers";

type CodeProvider = {
  getCode(address: string): Promise<string>;
};

function parseConfiguredCodehashes(): string[] | undefined {
  const configured = process.env.CIPHERDEX_PRIVATE_TOKEN_CODEHASHES?.trim();
  if (!configured) return undefined;
  const values = configured.split(",").map((value) => value.trim()).filter(Boolean);
  if (values.length === 0 || values.some((value) => !/^0x[0-9a-fA-F]{64}$/.test(value))) {
    throw new Error("CIPHERDEX_PRIVATE_TOKEN_CODEHASHES must be comma-separated bytes32 values");
  }
  return [...new Set(values.map((value) => value.toLowerCase()))].sort();
}

export async function resolvePrivateTokenCodehashes(
  provider: CodeProvider,
  tokenAddresses: readonly string[],
): Promise<string[]> {
  if (tokenAddresses.length === 0) {
    throw new Error("at least one reviewed private token is required for codehash policy");
  }
  const derived: string[] = [];
  for (const tokenAddress of tokenAddresses) {
    if (!ethers.isAddress(tokenAddress)) throw new Error("invalid private token address");
    const code = await provider.getCode(tokenAddress);
    if (code === "0x") throw new Error("reviewed private token has no deployed bytecode");
    derived.push(ethers.keccak256(code).toLowerCase());
  }

  const uniqueDerived = [...new Set(derived)].sort();
  const configured = parseConfiguredCodehashes();
  if (!configured) return uniqueDerived;
  for (const codehash of uniqueDerived) {
    if (!configured.includes(codehash)) {
      throw new Error("configured private-token codehash policy excludes a reviewed token");
    }
  }
  return configured;
}
