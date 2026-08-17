import { readFile } from "node:fs/promises";
import ts from "typescript";

import {
  assertEarlyHardhatRunSequence,
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
  ["contracts/CipherDEXFeeVault.sol", ["sweepPublicToken", "sweepConfidentialToken"]],
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
const amountOutBody = functionBody(confidentialSource, "_amountOut");
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
const routerQuoteBody = functionBody(confidentialSource, "_routerQuoteAmounts");
const routerSettlementValidityBody = functionBody(
  confidentialSource,
  "_routerSettlementValidity",
);
const routerOperationalValidityBody = functionBody(
  confidentialSource,
  "_routerOperationalValidity",
);
if (!quoteBody.includes("_amountOut(")) {
  throw new Error("Confidential quote bypasses the shared amount-out calculation");
}
if (!amountOutBody.includes("_swapAmounts(")) {
  throw new Error("Confidential amount-out calculation bypasses shared fee and CPMM math");
}
if (
  !settlementBody.includes("_settleExactInput(") ||
  !routerSettlementBody.includes("_settleExactInput(") ||
  !settlementCoreBody.includes("_swapAmounts(")
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

const factorySource = maskSourceCommentsAndLiterals(
  await readFile("contracts/ConfidentialCPMMFactory.sol", "utf8"),
);
if (
  !factorySource.includes("isApprovedPrivateTokenCodehash[tokenA.codehash]") ||
  !factorySource.includes("isApprovedPrivateTokenCodehash[tokenB.codehash]")
) {
  throw new Error("Confidential factory does not enforce immutable token implementation provenance");
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
assertEarlyHardhatRunSequence(
  deploymentRawSource,
  "scripts/deploy-testnet.ts",
  ["clean", "compile"],
  [
    "DeploymentRecordWriter.reserve",
    "ethers.provider.getNetwork",
    "ethers.getContractFactory",
  ],
);

const gasMeasurementFile = "scripts/measure-deployment-gas.ts";
const gasMeasurementRawSource = await readFile(gasMeasurementFile, "utf8");
assertEarlyHardhatRunSequence(
  gasMeasurementRawSource,
  gasMeasurementFile,
  ["clean", "compile"],
  [
    "ethers.getSigners",
    "ethers.provider.getNetwork",
    "ethers.getContractFactory",
  ],
);

const packageManifest = JSON.parse(await readFile("package.json", "utf8"));
const freshRunnerSource = await readFile("scripts/run-fresh-hardhat.mjs", "utf8");
const freshHardhatScripts = new Map([
  ["testnet:preflight", "scripts/testnet-preflight.ts --network cotiTestnet"],
  ["testnet:best-execution-feasibility", "scripts/testnet-best-execution-feasibility.ts --network cotiTestnet"],
  ["testnet:best-execution", "scripts/testnet-best-execution.ts --network cotiTestnet"],
  ["testnet:fee-collection", "scripts/testnet-fee-collection.ts --network cotiTestnet"],
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
const freshCleanPosition = freshRunnerSource.lastIndexOf('runHardhat(["clean"])');
const freshCompilePosition = freshRunnerSource.lastIndexOf('runHardhat(["compile"])');
const freshRunPosition = freshRunnerSource.lastIndexOf(
  'runHardhat(["run", "--no-compile", target, ...targetArguments])',
);
if (
  freshCleanPosition < 0 ||
  freshCleanPosition >= freshCompilePosition ||
  freshCompilePosition >= freshRunPosition
) {
  throw new Error("Fresh Hardhat runner does not isolate clean, compile and target execution");
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
assertEarlyHardhatRunSequence(
  harnessRawSource,
  "scripts/testnet-harness.ts",
  ["clean", "compile"],
  [
    "verifyConfiguredTestnetDeployment",
    "verifyDeployedRuntimeArtifact",
    "provider.getNetwork",
  ],
);
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
assertEarlyHardhatRunSequence(
  scenarioRawSource,
  "scripts/testnet-scenario.ts",
  ["clean", "compile"],
  [
    "verifyConfiguredTestnetDeployment",
    "verifyDeployedRuntimeArtifact",
    "ethers.provider.getNetwork",
    "ethers.getContractFactory",
  ],
);
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
assertEarlyHardhatRunSequence(
  feeCollectionRawSource,
  "scripts/testnet-fee-collection.ts",
  ["clean", "compile"],
  [
    "verifyConfiguredTestnetDeployment",
    "verifyDeployedRuntimeArtifact",
    "ethers.provider.getNetwork",
  ],
);
for (const fragment of [
  "requestPrivateQuote(",
  "minimumFromQuote(quote)",
]) {
  if (!feeCollectionSource.includes(fragment)) {
    throw new Error("Fee-collection funded runner omits quote-derived swap or LP-exit protection");
  }
}
for (const name of ["COTI_FEE_TEST_REMOVE_MIN0", "COTI_FEE_TEST_REMOVE_MIN1"]) {
  if (!hasStringCall(feeCollectionAst, "requiredPositiveRawAmount", name)) {
    throw new Error(`Fee-collection funded runner does not require positive ${name}`);
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
  const source = maskSourceCommentsAndLiterals(await readFile(file, "utf8"));
  const rawSource = await readFile(file, "utf8");
  assertEarlyHardhatRunSequence(
    rawSource,
    file,
    ["clean", "compile"],
    [
      "ethers.provider.getNetwork",
      "ethers.getContractFactory",
      "verifyDeployedRuntimeArtifact",
    ],
  );
  for (const fragment of [
    "verifyDeployedRuntimeArtifact(",
    "log.address.toLowerCase()",
    "matches.length !== 1",
  ]) {
    if (!source.includes(fragment)) {
      throw new Error(`${file}: funded evidence is not bound to current artifacts and one emitter`);
    }
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
if (
  !/^deployments\/\*\.json$/m.test(gitignore) ||
  !deploymentReadme.includes("git add -f deployments/coti-testnet-<commit>.json")
) {
  throw new Error("Deployment records are not protected by review-before-publication controls");
}

console.log("Supplemental lexed security boundary checks passed; executable unit, fuzz, invariant and funded tests remain the authoritative behavioral evidence.");
