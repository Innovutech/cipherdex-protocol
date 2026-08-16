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

function functionBody(source, functionName) {
  const marker = `function ${functionName}`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`ConfidentialCPMM is missing ${marker}`);
  const openingBrace = source.indexOf("{", start);
  if (openingBrace < 0) throw new Error(`ConfidentialCPMM has malformed ${marker}`);
  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(openingBrace + 1, index);
  }
  throw new Error(`ConfidentialCPMM has unterminated ${marker}`);
}

const quoteBody = functionBody(confidentialSource, "_quoteExactInput");
const amountOutBody = functionBody(confidentialSource, "_amountOut");
const swapAmountsBody = functionBody(confidentialSource, "_swapAmounts");
const settlementBody = functionBody(confidentialSource, "swapExactInput");
const addLiquidityBody = functionBody(confidentialSource, "addLiquidity");
const bootstrapLiquidityBody = functionBody(confidentialSource, "_bootstrapLiquidity");
const feeCollectionBody = functionBody(confidentialSource, "collectProtocolFees");
if (!quoteBody.includes("_amountOut(")) {
  throw new Error("Confidential quote bypasses the shared amount-out calculation");
}
if (!amountOutBody.includes("_swapAmounts(")) {
  throw new Error("Confidential amount-out calculation bypasses shared fee and CPMM math");
}
if (!settlementBody.includes("_swapAmounts(")) {
  throw new Error("Confidential settlement bypasses shared fee and CPMM math");
}
if (!swapAmountsBody.includes("_requirePositive(protocolFee)")) {
  throw new Error("Confidential dust swaps can pad fee batches without accruing a protocol fee");
}
for (const [body, helper, label] of [
  [settlementBody, "_pullPrivateExact(", "swap input"],
  [settlementBody, "_pushPrivateExact(", "swap output"],
  [addLiquidityBody, "_pullPrivateExact(", "liquidity input"],
  [bootstrapLiquidityBody, "_pullPrivateExact(", "bootstrap input"],
  [feeCollectionBody, "_pushPrivateExact(", "protocol fee output"],
]) {
  if (!body.includes(helper)) {
    throw new Error(`Confidential ${label} bypasses exact private-token balance validation`);
  }
}
if (bootstrapLiquidityBody.includes("_requirePrivatePoolBalance(")) {
  throw new Error("Confidential bootstrap can be griefed by an unmanaged preexisting balance");
}
if (!confidentialSource.includes("_supportsPrivateToken(token0_)") ||
    !confidentialSource.includes("_supportsPrivateToken(token1_)")) {
  throw new Error("ConfidentialCPMM does not enforce the private-token interface at construction");
}

const factorySource = await readFile("contracts/ConfidentialCPMMFactory.sol", "utf8");
if (
  !factorySource.includes("isApprovedPrivateTokenCodehash[tokenA.codehash]") ||
  !factorySource.includes("isApprovedPrivateTokenCodehash[tokenB.codehash]")
) {
  throw new Error("Confidential factory does not enforce immutable token implementation provenance");
}

const migratorSource = await readFile("contracts/ConfidentialLaunchpadMigrator.sol", "utf8");
const migrateBody = functionBody(migratorSource, "_migrate");
if (
  !migrateBody.includes("_pullPrivateExact(") ||
  !migrateBody.includes("approveGT(pool, gtAmount0)") ||
  !migrateBody.includes("approveGT(pool, gtAmount1)") ||
  !migrateBody.includes("_requirePrivateBalance(")
) {
  throw new Error("Launchpad migration bypasses exact atomic escrow accounting");
}

const privateLpSource = await readFile("contracts/PrivateLPToken.sol", "utf8");
for (const signature of ["burn(uint256)", "burn(itUint256 calldata)", "burnGt(gtUint256)"]) {
  if (!privateLpSource.includes(`function ${signature}`)) {
    throw new Error(`PrivateLPToken leaves holder-controlled ${signature} enabled`);
  }
}

for (const file of [
  "scripts/testnet-harness.ts",
  "scripts/testnet-preflight.ts",
  "scripts/testnet-quote-call-probe.ts",
  "scripts/testnet-scenario.ts",
  "scripts/testnet-launchpad.ts",
  "scripts/testnet-fee-collection.ts",
]) {
  const source = await readFile(file, "utf8");
  if (/\b(?:record|error)\.data\b|\.error\?\.data\b/.test(source)) {
    throw new Error(`${file}: funded runner reads raw RPC error data for logging`);
  }
  if (/console\.error\(\s*error\s+instanceof\s+Error\s*\?\s*error\.message/.test(source)) {
    throw new Error(`${file}: funded runner logs an untrusted external error message directly`);
  }
}

console.log("Security boundary checks passed for reentrancy, private storage, market-data disclosure, shared quote/settlement math, exact token accounting, LP supply control, dynamic execution and funded-runner log redaction.");
