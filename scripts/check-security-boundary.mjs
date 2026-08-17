import { readFile } from "node:fs/promises";
import ts from "typescript";

import {
  maskSourceCommentsAndLiterals,
  uniqueFunctionBody,
  uniqueFunctionDeclaration,
} from "./source-boundary-lint.mjs";

const requiredNonReentrant = new Map([
  [
    "contracts/ConfidentialCPMM.sol",
    [
      "swapExactInput",
      "settleExactInputForRouter",
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
  [
    "contracts/CipherDEXFeeVault.sol",
    ["depositPublicFees", "depositConfidentialFees", "sweepPublicToken", "sweepConfidentialToken"],
  ],
  ["contracts/PublicCPMMRouter.sol", ["swapExactInput"]],
  [
    "contracts/ConfidentialBestExecutionRouter.sol",
    ["requestBestQuoteExactInput", "swapBestExactInput"],
  ],
]);

for (const [file, functions] of requiredNonReentrant) {
  const source = await readFile(file, "utf8");
  for (const functionName of functions) {
    const declaration = uniqueFunctionDeclaration(source, functionName, file);
    if (!/\bnonReentrant\b/.test(declaration)) {
      throw new Error(`${file}: ${functionName} is not protected by nonReentrant`);
    }
  }
}

const confidentialSource = maskSourceCommentsAndLiterals(
  await readFile("contracts/ConfidentialCPMM.sol", "utf8"),
);
const publicSource = maskSourceCommentsAndLiterals(
  await readFile("contracts/PublicCPMM.sol", "utf8"),
);
const publicRouterSource = maskSourceCommentsAndLiterals(
  await readFile("contracts/PublicCPMMRouter.sol", "utf8"),
);
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

function functionBody(source, functionName, sourceLabel = "source") {
  return uniqueFunctionBody(source, functionName, sourceLabel);
}

function parseTypeScript(source, file) {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function callName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return `${callName(expression.expression)}.${expression.name.text}`;
  return "";
}

function hasStringCall(sourceFile, expectedCallee, expectedValue, argumentIndex = 0) {
  let found = false;
  const visit = (node) => {
    if (found) return;
    if (ts.isCallExpression(node)) {
      const argument = node.arguments[argumentIndex];
      if (
        callName(node.expression).endsWith(expectedCallee) &&
        argument &&
        (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) &&
        argument.text === expectedValue
      ) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

for (const functionName of ["quoteExactInput", "swapExactInput"]) {
  if (!functionBody(publicSource, functionName).includes(
    "if (!initialized) revert PoolNotInitialized();",
  )) {
    throw new Error(`PublicCPMM ${functionName} can use unmanaged balances while uninitialized`);
  }
}

const quoteBody = functionBody(confidentialSource, "_quoteExactInput");
const strictSwapTransitionBody = functionBody(confidentialSource, "_strictSwapTransition");
const swapAmountsBody = functionBody(confidentialSource, "_swapAmounts");
const settlementBody = functionBody(confidentialSource, "swapExactInput");
const routerSettlementBody = functionBody(
  confidentialSource,
  "settleExactInputForRouter",
);
const settlementCoreBody = functionBody(confidentialSource, "_settleExactInput");
const addLiquidityBody = functionBody(confidentialSource, "addLiquidity");
const bootstrapLiquidityBody = functionBody(confidentialSource, "_bootstrapLiquidity");
const feeCollectionBody = functionBody(confidentialSource, "collectProtocolFees");
const feeDepositBody = functionBody(confidentialSource, "_depositProtocolFees");
const terminalFeeDepositBody = functionBody(confidentialSource, "_depositTerminalProtocolFees");
const routerQuoteBody = functionBody(confidentialSource, "_routerQuoteAmounts");
const routerSettlementValidityBody = functionBody(
  confidentialSource,
  "_routerSettlementValidity",
);
const routerOperationalValidityBody = functionBody(
  confidentialSource,
  "_routerOperationalValidity",
);
if (!quoteBody.includes("_strictSwapTransition(")) {
  throw new Error("Confidential paid quote bypasses the strict settlement transition");
}
for (const fragment of [
  "_swapAmounts(",
  "_assertOperationalBounds(",
  "_addChecked(_protocolFees0(), protocolFee)",
  "_addChecked(_protocolFees1(), protocolFee)",
  "protocolFeeSwapCount0 == type(uint32).max",
  "protocolFeeSwapCount1 == type(uint32).max",
]) {
  if (!strictSwapTransitionBody.includes(fragment)) {
    throw new Error("Confidential strict quote/settlement transition omits an operational bound");
  }
}
if (
  !settlementBody.includes("_settleExactInput(") ||
  !routerSettlementBody.includes("_settleExactInput(") ||
  !settlementCoreBody.includes("_strictSwapTransition(")
) {
  throw new Error("Confidential settlement bypasses shared fee and CPMM math");
}
if (!swapAmountsBody.includes("_requirePositive(protocolFee)")) {
  throw new Error("Confidential dust swaps can pad fee batches without accruing a protocol fee");
}
for (const [fragment, label] of [
  ["_selectIf(\n            denominatorIsZero,\n            one,\n            newReserveIn", "safe non-zero quote denominator"],
  ["_selectIf(\n            exact,\n            quotient,\n            roundedUp", "authoritative ceil-division branch order"],
  ["_selectIf(valid, candidateOutput, zero)", "valid-output masking branch order"],
]) {
  if (!routerQuoteBody.includes(fragment)) {
    throw new Error(`Confidential router quote has an invalid mux branch order for ${label}`);
  }
}
if (!routerQuoteBody.includes("_routerSettlementValidity(")) {
  throw new Error("Confidential router selection can choose a quote that strict settlement rejects");
}
for (const fragment of [
  "checkedSubWithOverflowBit(amountIn, protocolFee)",
  "checkedAddWithOverflowBit(reserve0, reserveCredit)",
  "checkedSubWithOverflowBit(reserve1, amountOut)",
  "checkedAddWithOverflowBit(reserve1, reserveCredit)",
  "checkedSubWithOverflowBit(reserve0, amountOut)",
  "_routerOperationalValidity(",
]) {
  if (!routerSettlementValidityBody.includes(fragment)) {
    throw new Error("Confidential router quote omits a strict settlement reserve bound");
  }
}
for (const fragment of [
  "_routerMulValidity(valid, nextReserve0, nextReserve1)",
  "_routerMulValidity(valid, shareSupply, nextReserve0)",
  "_routerMulValidity(valid, shareSupply, nextReserve1)",
  "_routerMulValidity(valid, nextReserve0, scale0)",
  "_routerMulValidity(valid, normalized1, PRICE_SCALE)",
  "checkedAddWithOverflowBit(accruedFees, protocolFee)",
  "swapCount < type(uint32).max",
]) {
  if (!routerOperationalValidityBody.includes(fragment)) {
    throw new Error("Confidential router quote omits a strict operational settlement bound");
  }
}

const publicRouterSwapBody = functionBody(publicRouterSource, "swapExactInput");
for (const fragment of [
  "inputBalanceBefore = input.balanceOf(address(this))",
  "inputBalanceAfter - inputBalanceBefore != amountIn",
  "input.balanceOf(address(this)) != inputBalanceBefore",
]) {
  if (!publicRouterSwapBody.includes(fragment)) {
    throw new Error("Public router can consume a pre-funded balance after a short input credit");
  }
}
for (const [body, helper, label] of [
  [settlementCoreBody, "_pullPrivateExact(", "swap input"],
  [settlementCoreBody, "_pushPrivateExact(", "swap output"],
  [addLiquidityBody, "_pullPrivateExact(", "liquidity input"],
  [bootstrapLiquidityBody, "_pullPrivateExact(", "bootstrap input"],
]) {
  if (!body.includes(helper)) {
    throw new Error(`Confidential ${label} bypasses exact private-token balance validation`);
  }
}
if (!feeCollectionBody.includes("_depositProtocolFees(")) {
  throw new Error("Confidential protocol fees bypass encrypted vault aggregation");
}
for (const fragment of [
  "token.approveGT(feeVault, amount)",
  "IConfidentialFeeVault(feeVault).depositConfidentialFees(",
  "token.allowance(feeVault, false)",
  "revert ResidualAllowance()",
]) {
  if (!feeDepositBody.includes(fragment)) {
    throw new Error("Confidential protocol-fee deposit lacks exact temporary-allowance cleanup");
  }
}
if (
  !terminalFeeDepositBody.includes("_depositProtocolFees(token0") ||
  !terminalFeeDepositBody.includes("_depositProtocolFees(token1") ||
  !functionBody(confidentialSource, "removeLiquidity").includes("_depositTerminalProtocolFees()")
) {
  throw new Error("Confidential full exit can strand or distribute terminal protocol fees");
}
if (bootstrapLiquidityBody.includes("_requirePrivatePoolBalance(")) {
  throw new Error("Confidential bootstrap can be griefed by an unmanaged preexisting balance");
}
if (!confidentialSource.includes("_supportsPrivateToken(token0_)") ||
    !confidentialSource.includes("_supportsPrivateToken(token1_)")) {
  throw new Error("ConfidentialCPMM does not enforce the private-token interface at construction");
}

const factorySource = maskSourceCommentsAndLiterals(
  await readFile("contracts/ConfidentialCPMMFactory.sol", "utf8"),
);
if (
  !factorySource.includes("isApprovedPrivateTokenCodehash[tokenA.codehash]") ||
  !factorySource.includes("isApprovedPrivateTokenCodehash[tokenB.codehash]")
) {
  throw new Error("Confidential factory does not enforce immutable token implementation provenance");
}
for (const fragment of [
  "lpTokenFactory_.codehash != PRIVATE_LP_TOKEN_FACTORY_RUNTIME_CODEHASH",
  "isPool[pool] = true",
  "IPrivateLPTokenFactory(issuer).isIssuedToken(",
]) {
  if (!factorySource.includes(fragment) && !confidentialSource.includes(fragment)) {
    throw new Error("Confidential LP-token factory provenance is not cryptographically bound");
  }
}

const feeVaultSource = maskSourceCommentsAndLiterals(
  await readFile("contracts/CipherDEXFeeVault.sol", "utf8"),
);
const vaultDepositBody = functionBody(feeVaultSource, "depositConfidentialFees");
for (const fragment of [
  "IConfidentialCPMMFactory(factory).isPool(msg.sender)",
  "source.feeVault() != address(this)",
  "sourceCount != aggregatedSwapCount",
  "transferFromGT(msg.sender, address(this), amount)",
  "gtUint256 expectedBalanceAfter = _addChecked(balanceBefore, amount)",
  "MpcCore.eq(balanceAfter, expectedBalanceAfter)",
]) {
  if (!vaultDepositBody.includes(fragment)) {
    throw new Error("Confidential fee vault accepts an unauthenticated or inexact private deposit");
  }
}
const vaultSweepBody = functionBody(feeVaultSource, "sweepConfidentialToken");
for (const fragment of [
  "aggregatedSwapCount < MIN_CONFIDENTIAL_AGGREGATED_SWAPS",
  "_matureEpochEnd(token, start)",
  "nextConfidentialEpochIndex[token] = end",
  "gtUint256 expectedBalanceAfter = _subChecked(balanceBefore, amount)",
  "MpcCore.eq(balanceAfter, expectedBalanceAfter)",
]) {
  if (!vaultSweepBody.includes(fragment)) {
    throw new Error("Confidential fee vault sweep bypasses fixed epoch aggregation");
  }
}

const bestExecutionRouterSource = maskSourceCommentsAndLiterals(
  await readFile("contracts/ConfidentialBestExecutionRouter.sol", "utf8"),
);
if (/\bdelegatecall\b|\bselfdestruct\b/.test(bestExecutionRouterSource)) {
  throw new Error("Confidential best-execution router contains an unsafe execution primitive");
}
for (const fragment of [
  "_selectIf(replace, candidateOutput, bestOutput)",
  "MpcCore.setPublic256(index),\n                bestIndex",
  "canonicalFactory.poolKey(",
  "canonicalFactory.getPool(key)",
  "canonicalFactory.isPool(pool)",
  "_requireZeroCandidateAllowances(privateInputToken, candidates)",
  "privateInputToken.approveGT(selectedPool, input)",
]) {
  if (!bestExecutionRouterSource.includes(fragment)) {
    throw new Error("Confidential best-execution selection has an invalid mux branch order");
  }
}
for (const [source, label] of [
  [confidentialSource, "pool"],
  [bestExecutionRouterSource, "best-execution router"],
]) {
  const selectBody = functionBody(source, "_selectIf");
  if (!selectBody.includes("MpcCore.mux(condition, whenFalse, whenTrue)")) {
    throw new Error(`Confidential ${label} does not normalize COTI mux semantics`);
  }
}
const bestQuoteBody = functionBody(
  bestExecutionRouterSource,
  "requestBestQuoteExactInput",
);
if (/transfer(?:From)?GT|approveGT/.test(bestQuoteBody)) {
  throw new Error("Confidential best quote unexpectedly moves funds or grants allowance");
}

const deploymentRawSource = await readFile("scripts/deploy-testnet.ts", "utf8");
const deploymentSource = maskSourceCommentsAndLiterals(deploymentRawSource);
const deploymentAst = parseTypeScript(deploymentRawSource, "scripts/deploy-testnet.ts");
const packageManifest = JSON.parse(await readFile("package.json", "utf8"));
const freshRunnerSource = await readFile("scripts/run-fresh-hardhat.mjs", "utf8");
const freshHardhatScripts = new Map([
  ["testnet:harness", "scripts/testnet-harness.ts --network cotiTestnet"],
  ["testnet:preflight", "scripts/testnet-preflight.ts --network cotiTestnet"],
  ["testnet:scenario", "scripts/testnet-scenario.ts --network cotiTestnet"],
  ["testnet:quote-call-probe", "scripts/testnet-quote-call-probe.ts --network cotiTestnet"],
  ["testnet:best-execution-feasibility", "scripts/testnet-best-execution-feasibility.ts --network cotiTestnet"],
  ["testnet:best-execution", "scripts/testnet-best-execution.ts --network cotiTestnet"],
  ["testnet:fee-collection", "scripts/testnet-fee-collection.ts --network cotiTestnet"],
  ["evidence:finalize", "scripts/finalize-funded-evidence.ts --network cotiTestnet"],
  ["evidence:verify", "scripts/verify-funded-suite-evidence.ts --network cotiTestnet"],
  ["testnet:launchpad", "scripts/testnet-launchpad.ts --network cotiTestnet"],
  ["gas:measure", "scripts/measure-deployment-gas.ts"],
  ["deploy:testnet", "scripts/deploy-testnet.ts --network cotiTestnet"],
]);
for (const [script, target] of freshHardhatScripts) {
  if (
    packageManifest.scripts?.[script] !==
      `node scripts/run-fresh-hardhat.mjs ${target}`
  ) {
    throw new Error(`${script} does not enforce process-isolated clean compilation`);
  }
}
if (/from\s+["']\.\.?\//.test(freshRunnerSource)) {
  throw new Error("Fresh Hardhat runner imports a local module before compilation");
}
if (/env:\s*process\.env/.test(freshRunnerSource)) {
  throw new Error("Fresh Hardhat runner forwards the ambient environment into a subprocess");
}
const hardhatConfigSource = await readFile("hardhat.config.ts", "utf8");
if (/dotenv(?:\/config)?/.test(hardhatConfigSource)) {
  throw new Error("Hardhat configuration eagerly loads a secret-bearing env file");
}
const sourceCheckPosition = freshRunnerSource.indexOf(
  'runGit(["status", "--porcelain=v1", "--untracked-files=all"])',
);
const hardhatResolvePosition = freshRunnerSource.indexOf(
  'require.resolve("hardhat/internal/cli/cli.js")',
);
const freshCleanPosition = freshRunnerSource.lastIndexOf(
  'runHardhat(["clean"], systemEnvironment)',
);
const freshCompilePosition = freshRunnerSource.lastIndexOf(
  'runHardhat(["compile"], systemEnvironment)',
);
const envLoadPosition = freshRunnerSource.indexOf("process.loadEnvFile(");
const freshRunPosition = freshRunnerSource.lastIndexOf(
  'runHardhat(["run", "--no-compile", target, ...targetArguments], runtimeEnvironment)',
);
if (
  sourceCheckPosition < 0 ||
  sourceCheckPosition >= hardhatResolvePosition ||
  hardhatResolvePosition >= freshCleanPosition ||
  freshCleanPosition >= freshCompilePosition ||
  freshCompilePosition >= envLoadPosition ||
  envLoadPosition >= freshRunPosition
) {
  throw new Error("Fresh Hardhat runner does not authenticate source and isolate secretless build execution");
}
for (const required of [
  "Fresh Hardhat runner requires a clean committed worktree",
  "SYSTEM_ENVIRONMENT",
  "NETWORK_ENVIRONMENT",
  "FUNDED_NETWORK_ENVIRONMENT",
  "targetPolicy.funded",
  "targetPolicy.environment",
  "runtimeEnvironment.CIPHERDEX_SOURCE_COMMIT = sourceCommit",
]) {
  if (!freshRunnerSource.includes(required)) {
    throw new Error(`Fresh Hardhat runner omits credential-boundary control: ${required}`);
  }
}
if (
  freshRunnerSource.includes('"CIPHERDEX_SOURCE_COMMIT",') ||
  freshRunnerSource.includes("'CIPHERDEX_SOURCE_COMMIT',")
) {
  throw new Error("Fresh Hardhat runner permits ambient source-commit injection");
}
if (!hasStringCall(deploymentAst, "getContractFactory", "ConfidentialBestExecutionRouter")) {
  throw new Error("Testnet deployment does not deploy the confidential best-execution router");
}
for (const fragment of [
  "factory.setBestExecutionRouter(",
  "factory.bestExecutionRouter()",
  "journalContracts.bestExecutionRouterBinding =",
]) {
  if (!deploymentSource.includes(fragment)) {
    throw new Error("Testnet deployment omits canonical best-execution router provenance");
  }
}
if (!hasStringCall(deploymentAst, "recordDeployment", "confidentialBestExecutionRouter")) {
  throw new Error("Testnet deployment omits the confidential router deployment journal");
}

const sdkSource = maskSourceCommentsAndLiterals(
  await readFile("sdk/src/index.ts", "utf8"),
);
for (const fragment of [
  "verifyConfidentialBestExecutionRouter(",
  "expectedChainId",
  "readChainId()",
  "readFactoryBestExecutionRouter",
  "buildVerifiedConfidentialBestQuoteTransaction(",
  "buildVerifiedConfidentialBestSwapTransaction(",
  "decryptConfidentialBestExecutionResult(",
  "CONFIDENTIAL_BEST_QUOTE_RESULT_TOPIC",
  "CONFIDENTIAL_BEST_SWAP_RESULT_TOPIC",
  "getCanonicalPool(",
  "getTransaction(",
  "getTransactionReceipt(",
  "adapter.getTransaction(expectation.transactionHash)",
  "adapter.getTransactionReceipt(expectation.transactionHash)",
]) {
  if (!sdkSource.includes(fragment)) {
    throw new Error("SDK omits canonical best-execution target or result binding");
  }
}
if (sdkSource.includes("export type ConfidentialBestExecutionResultEvidence")) {
  throw new Error("SDK exports caller-authored aggregate transaction evidence");
}

const harnessRawSource = await readFile("scripts/testnet-harness.ts", "utf8");
const harnessSource = maskSourceCommentsAndLiterals(harnessRawSource);
const harnessAst = parseTypeScript(harnessRawSource, "scripts/testnet-harness.ts");
if (
  harnessSource.includes("quoteExactInput.staticCall") ||
  !harnessSource.includes("requestQuoteExactInput(") ||
  !harnessSource.includes("encryptedMinimumForSwap")
) {
  throw new Error("Basic funded harness does not derive a nonzero minimum from a paid quote");
}
for (const fragment of [
  "factory.isPool(poolAddress)",
  "factory.poolKey(",
  "factory.getPool(canonicalKey)",
  "factory.isApprovedPrivateToken(expectedToken0)",
  "factory.isApprovedPrivateTokenCodehash(codehash)",
  "getAddress(String(bootstrapper)) !== factoryAddress",
  "matches.length !== 1",
]) {
  if (!harnessSource.includes(fragment)) {
    throw new Error("Basic funded harness does not prove canonical confidential pool provenance");
  }
}
if (!hasStringCall(harnessAst, "requiredAddress", "COTI_FACTORY")) {
  throw new Error("Basic funded harness does not require an independently configured factory");
}

const scenarioRawSource = await readFile("scripts/testnet-scenario.ts", "utf8");
const scenarioSource = maskSourceCommentsAndLiterals(scenarioRawSource);
const scenarioAst = parseTypeScript(scenarioRawSource, "scripts/testnet-scenario.ts");
const scenarioMainBody = functionBody(scenarioSource, "main");
const scenarioLiquidityBody = functionBody(scenarioSource, "addPrivateLiquidity");
if (
  scenarioMainBody.indexOf("ethers.provider.getNetwork()") < 0 ||
  scenarioMainBody.indexOf("ethers.provider.getNetwork()") >
    scenarioMainBody.indexOf("resolvePrivateTokenCodehashes(")
) {
  throw new Error("Full funded scenario validates the chain after network-dependent work");
}
if (
  !scenarioMainBody.includes("assertReviewedPrivateTokens(deploymentRecord") ||
  scenarioMainBody.indexOf("assertReviewedPrivateTokens(deploymentRecord") >
    scenarioMainBody.indexOf("ethers.getContractFactory(")
) {
  throw new Error("Full funded scenario can move assets through unreviewed token instances");
}
if (
  !scenarioLiquidityBody.includes("confidentialLiquidityBounds(") ||
  !scenarioLiquidityBody.includes("bounds.minShares") ||
  !scenarioLiquidityBody.includes("bounds.minPriceX18") ||
  !scenarioLiquidityBody.includes("bounds.maxPriceX18")
) {
  throw new Error("Full funded scenario uses ineffective liquidity bounds");
}
for (const name of [
  "COTI_SECOND_LP_REMOVE_MIN0",
  "COTI_SECOND_LP_REMOVE_MIN1",
  "COTI_PERSONAL_REMOVE_MIN0",
  "COTI_PERSONAL_REMOVE_MIN1",
  "COTI_FULL_EXIT_MIN0",
  "COTI_FULL_EXIT_MIN1",
]) {
  if (!hasStringCall(scenarioAst, "requiredPositiveBigInt", name)) {
    throw new Error(`Full funded scenario does not require positive ${name}`);
  }
}
if (
  /(?:secondRemoveMinimum[01]|removeMinimum[01]|quoteRemoveMinimum[01])\s*=\s*await[\s\S]{0,160}?encryptValue256\(\s*0n/.test(
    scenarioSource,
  )
) {
  throw new Error("Full funded scenario uses a zero encrypted withdrawal minimum");
}

const feeCollectionRawSource = await readFile("scripts/testnet-fee-collection.ts", "utf8");
const feeCollectionSource = maskSourceCommentsAndLiterals(feeCollectionRawSource);
const feeCollectionAst = parseTypeScript(
  feeCollectionRawSource,
  "scripts/testnet-fee-collection.ts",
);
for (const fragment of [
  "requestPrivateQuote(",
  "minimumWithSlippage(quote)",
  "minimumWithSlippage(model.reserve0)",
  "minimumWithSlippage(model.reserve1)",
  "createDisposableStack(",
  "validateStackResource(",
]) {
  if (!feeCollectionSource.includes(fragment)) {
    throw new Error("Fee-collection funded runner omits quote-derived swap or LP-exit protection");
  }
}
for (const fragment of [
  'kind: "fee-collection-pool"',
  'phase: "awaiting-maturity"',
]) {
  if (!feeCollectionRawSource.includes(fragment)) {
    throw new Error("Fee-collection runner lacks source-bound disposable state");
  }
}
for (const forbidden of [
  "COTI_FEE_COLLECTION_POOL",
  "COTI_FEE_TEST_REMOVE_MIN0",
  "COTI_FEE_TEST_REMOVE_MIN1",
]) {
  if (feeCollectionRawSource.includes(forbidden)) {
    throw new Error(`Fee-collection runner still accepts unsafe ${forbidden}`);
  }
}
if (
  !feeCollectionSource.includes("requireFeeCollectionMature(") ||
  /confidential fee batch prepared; rerun after readyAt to collect[\s\S]{0,80}?return;/.test(
    feeCollectionSource,
  )
) {
  throw new Error("Fee-collection funded runner can report success before collection is complete");
}

for (const [file, source, ast] of [
  ["scripts/testnet-harness.ts", harnessSource, harnessAst],
  ["scripts/testnet-scenario.ts", scenarioSource, scenarioAst],
  ["scripts/testnet-fee-collection.ts", feeCollectionSource, feeCollectionAst],
]) {
  for (const fragment of [
    "requiredTestnetDeploymentRecordPath()",
    "verifyConfiguredTestnetDeployment(",
  ]) {
    if (!source.includes(fragment)) {
      throw new Error(`${file}: configured contracts are not bound to reviewed source provenance`);
    }
  }
}
for (const [file, ast] of [
  ["scripts/testnet-harness.ts", harnessAst],
  ["scripts/testnet-fee-collection.ts", feeCollectionAst],
]) {
  if (!hasStringCall(ast, "verifyDeployedRuntimeArtifact", "ConfidentialCPMM")) {
    throw new Error(`${file}: configured pool runtime is not bound to current artifacts`);
  }
}

const deploymentSourceBody = functionBody(deploymentSource, "main");
if (
  !functionBody(deploymentSource, "requiredDeploymentRecordPath").includes("if (!outputPath)") ||
  !functionBody(deploymentSource, "requiredDeploymentRecordPath").includes("throw new Error(") ||
  deploymentSourceBody.indexOf("requiredDeploymentRecordPath()") < 0 ||
  deploymentSourceBody.indexOf("requiredDeploymentRecordPath()") >
    deploymentSourceBody.indexOf("ethers.provider.getNetwork()") ||
  !deploymentSourceBody.includes("await deploymentRecord.write({") ||
  !deploymentSourceBody.includes("await deploymentRecord.close()")
) {
  throw new Error("Testnet deployment does not fail closed on deployment-record persistence");
}
for (const fragment of [
  "transactions: journalTransactions",
  "await recordTransaction(",
  "await recordDeployment(",
  "await writeJournal(",
  "transactionHashFromError(error)",
  "failure:",
  "await deploymentRecord.close()",
]) {
  if (!deploymentSourceBody.includes(fragment)) {
    throw new Error("Testnet deployment does not journal partial and terminal transaction evidence");
  }
}

const deployAndReportBody = functionBody(deploymentSource, "deployAndReport");
const firstMinedJournal = deployAndReportBody.indexOf("await onMined({");
for (const laterOperation of [
  "if (!contract)",
  "factory.attach(receiptAddress)",
  "await contract.getAddress()",
  "verifyDeployedRuntimeArtifactWithProvenance(",
]) {
  const position = deployAndReportBody.indexOf(laterOperation);
  if (firstMinedJournal < 0 || position < 0 || firstMinedJournal >= position) {
    throw new Error(
      "Testnet deployment does not durably journal mined evidence before contract recovery",
    );
  }
}
for (const fragment of [
  "receipt.contractAddress",
  "deploymentTx: evidence.transactionHash",
  "upsertMinedDeploymentTransaction(journalTransactions, evidence)",
  "if (error instanceof PostMinedDeploymentError) throw error",
]) {
  if (!deploymentSource.includes(fragment)) {
    throw new Error("Testnet deployment cannot safely recover and enrich post-mined evidence");
  }
}

for (const file of [
  "scripts/testnet-best-execution-feasibility.ts",
  "scripts/testnet-best-execution.ts",
]) {
  const source = await readFile(file, "utf8");
  for (const fragment of [
    "verifyConfiguredTestnetDeployment(",
    "assertReviewedPrivateTokens(deploymentRecord",
    "log.address.toLowerCase()",
    "matches.length !== 1",
  ]) {
    if (!source.includes(fragment)) {
      throw new Error(`${file}: funded evidence is not bound to current artifacts and one emitter`);
    }
  }
  const mainBody = functionBody(source, "main");
  if (
    mainBody.indexOf("assertReviewedPrivateTokens(deploymentRecord") >
    mainBody.indexOf("new Contract(")
  ) {
    throw new Error(`${file}: token interaction precedes exact reviewed-token authorization`);
  }
}
const fundedEvidenceRawSource = await readFile("scripts/funded-run-evidence.ts", "utf8");
const fundedEvidenceSource = maskSourceCommentsAndLiterals(fundedEvidenceRawSource);
for (const required of [
  "verifyDeployedRuntimeArtifactWithProvenance(",
  "provider.getTransactionReceipt(",
  "provider.getTransaction(",
  "provider.getBlock(",
  "transaction.blockHash.toLowerCase()",
  "configurationHash(configuration)",
  "journal.activeResources.length !== 0",
  "requireRunnerPolicy(",
  "requireTransactionBindings(",
  "creationTransactionHash",
]) {
  if (!fundedEvidenceSource.includes(required)) {
    throw new Error(`Funded evidence omits required provenance control: ${required}`);
  }
}
for (const required of [
  "cipherdex.funded-run-evidence/v2",
  "funded run cannot produce evidence with unresolved transactions",
]) {
  if (!fundedEvidenceRawSource.includes(required)) {
    throw new Error(`Funded evidence omits required literal control: ${required}`);
  }
}
for (const forbidden of [
  "process.env",
  "decrypt",
  "aesKey",
  "privateKey",
]) {
  if (fundedEvidenceSource.toLowerCase().includes(forbidden.toLowerCase())) {
    throw new Error(`Funded evidence crosses the private-data boundary: ${forbidden}`);
  }
}
for (const file of [
  "scripts/testnet-best-execution-feasibility.ts",
  "scripts/testnet-best-execution.ts",
  "scripts/testnet-fee-collection.ts",
  "scripts/testnet-launchpad.ts",
]) {
  const source = await readFile(file, "utf8");
  const evidencePosition = source.lastIndexOf("writeFundedRunEvidence({");
  const passPosition = source.lastIndexOf('markRun("passed")');
  const recoveryPosition = source.lastIndexOf("markRecovered(");
  if (
    evidencePosition < 0 ||
    passPosition < 0 ||
    recoveryPosition < 0 ||
    recoveryPosition >= passPosition ||
    passPosition >= evidencePosition
  ) {
    throw new Error(`${file}: passing funded evidence is not gated by completed recovery`);
  }
}

const launchpadRawSource = await readFile("scripts/testnet-launchpad.ts", "utf8");
const launchpadSource = maskSourceCommentsAndLiterals(launchpadRawSource);
const launchpadMainBody = functionBody(launchpadSource, "main");
for (const fragment of [
  "verifyConfiguredTestnetDeployment(",
  "assertReviewedPrivateTokens(deploymentRecord",
  "verifyDeployedRuntimeArtifact(",
  "FundedRecoveryJournal.open({",
  "recoverLaunchpadResources()",
  "writeFundedRunEvidence({",
]) {
  if (!launchpadMainBody.includes(fragment)) {
    throw new Error("Launchpad funded runner bypasses reviewed source or token provenance");
  }
}
if (!launchpadSource.includes("verifyRecoveryResourceCreation(")) {
  throw new Error("Launchpad funded recovery does not authenticate resource creation");
}
for (const literal of [
  "full disposable launchpad-pool exit",
  "successful launchpad migration has no canonical pool to recover",
  "launchpad pool recovery canonical provenance changed",
  "creationTransactionHash: successfulMigrations[0].hash",
  'markRun("passed")',
]) {
  if (!launchpadRawSource.includes(literal)) {
    throw new Error("Launchpad funded runner omits required recovery evidence");
  }
}
if (launchpadMainBody.indexOf("assertReviewedPrivateTokens(deploymentRecord") >
    launchpadMainBody.indexOf("getContractFactory(")) {
  throw new Error("Launchpad funded runner validates provenance after deployment begins");
}
for (const fragment of [
  "tokenARead.decimals()",
  "tokenBRead.decimals()",
  "onchainDecimalsA !== decimalsA",
  "onchainDecimalsB !== decimalsB",
]) {
  if (!launchpadMainBody.includes(fragment)) {
    throw new Error("Launchpad funded runner does not bind CREATE2 inputs to onchain decimals");
  }
}
if (
  launchpadMainBody.indexOf("onchainDecimalsA !== decimalsA") >
  launchpadMainBody.indexOf("getContractFactory(")
) {
  throw new Error("Launchpad funded runner validates decimals after deployment begins");
}
for (const forbidden of ["prefundAmount", "deterministic pool pre-fund proof"]) {
  if (launchpadRawSource.includes(forbidden)) {
    throw new Error("Launchpad funded runner intentionally strands a private-token pre-fund");
  }
}

const migratorSource = maskSourceCommentsAndLiterals(
  await readFile("contracts/ConfidentialLaunchpadMigrator.sol", "utf8"),
);
const migrateBody = functionBody(migratorSource, "_migrate");
if (
  !migrateBody.includes("_pullPrivateExact(") ||
  !migrateBody.includes("approveGT(pool, gtAmount0)") ||
  !migrateBody.includes("approveGT(pool, gtAmount1)") ||
  !migrateBody.includes("_requirePrivateBalance(")
) {
  throw new Error("Launchpad migration bypasses exact atomic escrow accounting");
}

const privateLpSource = maskSourceCommentsAndLiterals(
  await readFile("contracts/PrivateLPToken.sol", "utf8"),
);
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
  "scripts/testnet-best-execution-feasibility.ts",
  "scripts/testnet-best-execution.ts",
]) {
  const source = maskSourceCommentsAndLiterals(await readFile(file, "utf8"));
  if (/\b(?:record|error)\.data\b|\.error\?\.data\b/.test(source)) {
    throw new Error(`${file}: funded runner reads raw RPC error data for logging`);
  }
  if (/console\.error\(\s*error\s+instanceof\s+Error\s*\?\s*error\.message/.test(source)) {
    throw new Error(`${file}: funded runner logs an untrusted external error message directly`);
  }
  if (/BigInt\(\s*process\.env\./.test(source)) {
    throw new Error(`${file}: funded runner converts unvalidated environment text with BigInt`);
  }
}
const bestExecutionProductionRawSource = await readFile(
  "scripts/testnet-best-execution.ts",
  "utf8",
);
const bestExecutionProductionSource = maskSourceCommentsAndLiterals(
  bestExecutionProductionRawSource,
);
const bestExecutionProductionMain = functionBody(
  bestExecutionProductionSource,
  "main",
  "scripts/testnet-best-execution.ts",
);
if (!bestExecutionProductionSource.includes("assertReviewedPrivateTokens(deploymentRecord")) {
  throw new Error("Best-execution funded runner accepts unreviewed private-token instances");
}
for (const contractName of [
  "CipherDEXFeeVault",
  "PrivateLPTokenFactory",
  "ConfidentialCPMMFactory",
  "ConfidentialBestExecutionRouter",
]) {
  if (!new RegExp(`deployContract\\(\\s*[\"']${contractName}[\"']`).test(
    bestExecutionProductionRawSource,
  )) {
    throw new Error(`Best-execution funded runner does not deploy disposable ${contractName}`);
  }
}
if (
  !bestExecutionProductionMain.includes(
    "feeVaultDeployment.contract.setConfidentialFactory(factoryDeployment.address",
  ) ||
  /new\s+Contract\(\s*(?:factoryAddress|routerAddress|feeVaultAddress)\b/.test(
    bestExecutionProductionMain,
  )
) {
  throw new Error("Best-execution funded runner can mutate the reviewed deployment");
}
for (const required of [
  "for (const context of allPools)",
  "await removeAllLiquidity(context, primary)",
  "sharesAfter !== 0n",
  "balance0 !== 0n",
  "balance1 !== 0n",
  "allowance0 !== 0n",
  "allowance1 !== 0n",
  "finalBalanceA !== balanceA - expectedProtocolFeeA",
  "finalBalanceB !== balanceB - expectedProtocolFeeB",
]) {
  if (!bestExecutionProductionSource.includes(required)) {
    throw new Error(`Best-execution funded runner is missing full cleanup evidence: ${required}`);
  }
}

const feasibilityRouterProbe = maskSourceCommentsAndLiterals(
  await readFile("contracts/mocks/MpcBestExecutionRouterProbe.sol", "utf8"),
);
for (const functionName of ["requestBestQuoteExactInput", "swapBestExactInput"]) {
  const declaration = uniqueFunctionDeclaration(
    feasibilityRouterProbe,
    functionName,
    "contracts/mocks/MpcBestExecutionRouterProbe.sol",
  );
  if (!/\bonlyAuthorizedCaller\b/.test(declaration) || !/\bonlyOpen\b/.test(declaration)) {
    throw new Error(`MPC router probe ${functionName} is not caller-bound and closeable`);
  }
}
const feasibilityPoolProbe = maskSourceCommentsAndLiterals(
  await readFile("contracts/mocks/MpcBestExecutionPoolProbe.sol", "utf8"),
);
for (const functionName of ["quoteGt", "settleGt"]) {
  const body = functionBody(
    feasibilityPoolProbe,
    functionName,
    "contracts/mocks/MpcBestExecutionPoolProbe.sol",
  );
  if (!body.includes("if (closed) revert Closed()") || !body.includes("_requireRouter()")) {
    throw new Error(`MPC pool probe ${functionName} is not router-bound and closeable`);
  }
}
for (const source of [feasibilityRouterProbe, feasibilityPoolProbe]) {
  const recovery = functionBody(source, "closeAndRecover", "MPC feasibility probe");
  if (!recovery.includes("closed = true") || !recovery.includes("transferGT(recipient")) {
    throw new Error("MPC feasibility probe has no permanent private-asset recovery path");
  }
}
const feasibilityRunner = maskSourceCommentsAndLiterals(
  await readFile("scripts/testnet-best-execution-feasibility.ts", "utf8"),
);
for (const required of [
  "MAX_PROBE_INPUT",
  "probe.closeAndRecover(caller",
  "Boolean(await probe.closed())",
  "inputResidue !== 0n || outputResidue !== 0n",
  "inputAfterRecovery !== inputBalanceBefore",
  "outputAfterRecovery !== outputBalanceBefore",
]) {
  if (!feasibilityRunner.includes(required)) {
    throw new Error(`Best-execution feasibility runner is missing cleanup control: ${required}`);
  }
}

const quoteCallProbeRunnerRaw = await readFile(
  "scripts/testnet-quote-call-probe.ts",
  "utf8",
);
const quoteCallProbeRunner = maskSourceCommentsAndLiterals(quoteCallProbeRunnerRaw);
for (const required of [
  "assertCleanCommittedSource",
  "network.chainId !== COTI_TESTNET_CHAIN_ID",
  "verifyDeployedRuntimeArtifactWithProvenance",
  "serializeMinedEvidence(deploymentEvidence)",
  "serializeMinedEvidence(controlEvidence)",
]) {
  if (!quoteCallProbeRunner.includes(required)) {
    throw new Error(`Quote-call feasibility runner lacks provenance evidence: ${required}`);
  }
}
for (const required of [
  '"status", "--porcelain=v1", "--untracked-files=all"',
  '"ls-files",',
  '"cipherdex.testnet-quote-call-probe/v1"',
  "paidPerPoolQuoteRemainsPrimary: true",
]) {
  if (!quoteCallProbeRunnerRaw.includes(required)) {
    throw new Error(`Quote-call feasibility runner lacks committed evidence output: ${required}`);
  }
}

const destructiveScenario = maskSourceCommentsAndLiterals(
  await readFile("scripts/testnet-scenario.ts", "utf8"),
);
if (
  !destructiveScenario.includes(
    "process.env.COTI_POOL?.trim() || process.env.COTI_QUOTE_POOL?.trim()",
  ) ||
  destructiveScenario.includes("usesConfiguredDeployment")
) {
  throw new Error("Destructive scenario can reuse configured canonical pool state");
}

for (const file of [
  "scripts/deploy-testnet.ts",
  "scripts/testnet-harness.ts",
  "scripts/testnet-quote-call-probe.ts",
  "scripts/testnet-scenario.ts",
  "scripts/testnet-launchpad.ts",
  "scripts/testnet-fee-collection.ts",
  "scripts/testnet-best-execution-feasibility.ts",
  "scripts/testnet-best-execution.ts",
]) {
  const source = maskSourceCommentsAndLiterals(await readFile(file, "utf8"));
  if (/\.wait\s*\(|\.waitForDeployment\s*\(/.test(source)) {
    throw new Error(`${file}: funded broadcast bypasses mined-success reconciliation`);
  }
  if (!source.includes("requireMinedSuccess")) {
    throw new Error(`${file}: funded broadcast has no mined-success reconciliation helper`);
  }
}

const gitignore = await readFile(".gitignore", "utf8");
const deploymentReadme = await readFile("deployments/README.md", "utf8");
const deploymentProvenance = await readFile(
  "scripts/testnet-deployment-provenance.ts",
  "utf8",
);
const deploymentTransactionProvenance = await readFile(
  "scripts/deployment-transaction-provenance.ts",
  "utf8",
);
if (
  !/^deployments\/\*\.json$/m.test(gitignore) ||
  !deploymentReadme.includes("git add -f deployments/coti-testnet-<commit>.json") ||
  !deploymentReadme.includes("separate evidence commit") ||
  !deploymentReadme.includes("match the tracked blob at") ||
  !deploymentProvenance.includes('"ls-files", "--error-unmatch"') ||
  !deploymentProvenance.includes('"merge-base", "--is-ancestor"') ||
  !deploymentProvenance.includes("recordMatchesHead") ||
  !deploymentProvenance.includes("changedPathsSinceSource") ||
  !deploymentProvenance.includes('"docs/VERIFICATION_REPORT.md"') ||
  !deploymentProvenance.includes("verifyDeploymentTransactionEvidence") ||
  !deploymentTransactionProvenance.includes("provider.getTransaction(hash)") ||
  !deploymentTransactionProvenance.includes("provider.getTransactionReceipt(hash)") ||
  !deploymentTransactionProvenance.includes("encodeDeploy(args)") ||
  !deploymentTransactionProvenance.includes("encodeFunctionData(binding.functionName, args)") ||
  !deploymentTransactionProvenance.includes("transaction hashes must be unique")
) {
  throw new Error("Deployment records are not protected by review-before-publication controls");
}

console.log("Supplemental lexed security boundary checks passed; executable unit, fuzz, invariant and funded tests remain the authoritative behavioral evidence.");
