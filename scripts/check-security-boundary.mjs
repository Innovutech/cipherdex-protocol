import { readFile } from "node:fs/promises";

const requiredNonReentrant = new Map([
  [
    "contracts/ConfidentialCPMM.sol",
    [
      "swapExactInput",
      "addLiquidity",
      "bootstrapLiquidity",
      "bootstrapLiquidityWithDisposition",
      "removeLiquidity",
      "collectProtocolFees",
      "lockShares",
      "unlockShares",
    ],
  ],
  [
    "contracts/ConfidentialLaunchpadMigrator.sol",
    ["migrate", "migrateWithDisposition"],
  ],
  ["contracts/PublicCPMM.sol", ["swapExactInput", "addLiquidity", "removeLiquidity", "collectProtocolFees", "lockShares", "unlockShares"]],
  ["contracts/CipherDEXFeeVault.sol", ["sweepPublicToken", "sweepConfidentialToken"]],
  ["contracts/PublicCPMMRouter.sol", ["swapExactInput"]],
]);

for (const [file, functions] of requiredNonReentrant) {
  const source = await readFile(file, "utf8");
  for (const functionName of functions) {
    const marker = `function ${functionName}`;
    const start = source.indexOf(marker);
    if (start < 0) throw new Error(`${file}: missing ${marker}`);
    const openingBrace = source.indexOf("{", start);
    if (openingBrace < 0) throw new Error(`${file}: malformed ${marker}`);
    const declaration = source.slice(start, openingBrace);
    if (!/\bnonReentrant\b/.test(declaration)) {
      throw new Error(`${file}: ${functionName} is not protected by nonReentrant`);
    }
  }
}

const confidentialSource = await readFile("contracts/ConfidentialCPMM.sol", "utf8");
for (const line of confidentialSource.split("\n")) {
  if (/^\s*(?:mapping|ctUint\d+)\b[^;]*(totalShares|shares|locks)\b[^;]*;/.test(line)) {
    if (/\b(public|external)\b/.test(line)) {
      throw new Error("ConfidentialCPMM exposes private share or lock storage publicly");
    }
  }
}
if (/\bdelegatecall\b|\bselfdestruct\b/.test(confidentialSource)) {
  throw new Error("ConfidentialCPMM contains an unsafe dynamic execution primitive");
}

for (const forbidden of [
  "publishSpotPrice",
  "publicSpotPrice",
  "publicPriceCumulative",
  "marketDataPublisher",
]) {
  if (confidentialSource.includes(forbidden)) {
    throw new Error(`ConfidentialCPMM exposes forbidden public market data: ${forbidden}`);
  }
}

console.log("Security boundary checks passed for reentrancy, private storage, market-data disclosure and dynamic execution.");
