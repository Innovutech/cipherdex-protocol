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
const runtimeArtifactRawSource = await readFile("scripts/runtime-artifact.ts", "utf8");
const runtimeArtifactSource = maskSourceCommentsAndLiterals(runtimeArtifactRawSource);
if (
  !runtimeArtifactRawSource.includes('ConfidentialCPMM: "ConfidentialCPMMDeployer"') ||
  !functionBody(runtimeArtifactSource, "runtimeBuildContext").includes(
    "RUNTIME_BUILD_CONTEXTS[contractName] ?? contractName",
  ) ||
  !runtimeArtifactRawSource.includes("artifacts.readArtifact(buildContextName)") ||
  !runtimeArtifactRawSource.includes(
    "`${buildContextArtifact.sourceName}:${buildContextArtifact.contractName}`",
  ) ||
  !runtimeArtifactRawSource.includes("compilerSourceNameForArtifact(buildInfo, buildOutput, artifact)")
) {
  throw new Error("Factory-created confidential pool runtime is not bound to its deployer build context");
}
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

for (const fragment of [
  "bool public protectedInitializationCompleted",
  "!protectedInitializationCompleted",
  "protectedInitializationCompleted = true",
  "initialized = false",
]) {
  if (!confidentialSource.includes(fragment)) {
    throw new Error("Confidential protected-pool lifecycle cannot distinguish first bootstrap from re-seeding");
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
if (!confidentialSource.includes("PrivateTokenCompatibility.supportsPrivateToken(token0_)") ||
    !confidentialSource.includes("PrivateTokenCompatibility.supportsPrivateToken(token1_)") ||
    !confidentialSource.includes("PrivateTokenCompatibility.tryReadDecimals(token0_)")) {
  throw new Error("ConfidentialCPMM does not enforce the private-token interface at construction");
}

const factorySource = maskSourceCommentsAndLiterals(
  await readFile("contracts/ConfidentialCPMMFactory.sol", "utf8"),
);
const privateTokenCompatibilityRawSource = await readFile(
  "contracts/libraries/PrivateTokenCompatibility.sol",
  "utf8",
);
const privateTokenCompatibilitySource = maskSourceCommentsAndLiterals(
  privateTokenCompatibilityRawSource,
);
for (const fragment of [
  "token.code.length == 0",
  "type(IPrivateERC20).interfaceId",
  "IERC165(token).supportsInterface(",
  "value > 18",
]) {
  if (!privateTokenCompatibilitySource.includes(fragment)) {
    throw new Error("Canonical private-token compatibility checks are incomplete");
  }
}
if (!privateTokenCompatibilityRawSource.includes('abi.encodeWithSignature("decimals()")')) {
  throw new Error("Canonical private-token compatibility omits decimals introspection");
}
if (/\bdelegatecall\b|\bselfdestruct\b/.test(factorySource)) {
  throw new Error("Confidential factory contains an unsafe execution primitive");
}
for (const forbidden of [
  "isApprovedPrivateTokenCodehash",
  "approvedPrivateTokenCodehashes",
  "privateTokenCodehashes_",
]) {
  if (factorySource.includes(forbidden)) {
    throw new Error("Confidential factory reintroduced external-token implementation admission");
  }
}
for (const required of [
  "PrivateTokenCompatibility.supportsPrivateToken(tokenA)",
  "PrivateTokenCompatibility.supportsPrivateToken(tokenB)",
  "PrivateTokenCompatibility.tryReadDecimals(tokenA)",
  "actualDecimalsA != decimalsA",
  "actualDecimalsB != decimalsB",
]) {
  if (!factorySource.includes(required)) {
    throw new Error("Confidential factory does not enforce structural token compatibility");
  }
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
for (const fragment of [
  "feeBps,\n                PRIVACY_MODE,\n                PROTOCOL_VERSION,\n                initializationStrategy",
  "poolDeployer.codehash != poolDeployerRuntimeCodehash",
  "IConfidentialCPMMDeployer(poolDeployer).factory() != address(this)",
  "_requireRegisteredStrategy(msg.sender)",
  "IConfidentialCPMM(pool).initialized()",
  "strategy.authorizeInitialization(",
  "candidate.initializationStrategy() != initializationStrategy",
  "initializationStrategyRegistry.codehash !=",
]) {
  if (!factorySource.includes(fragment)) {
    throw new Error("Confidential factory does not enforce the complete protected-pool identity");
  }
}

const poolDeployerSource = maskSourceCommentsAndLiterals(
  await readFile("contracts/ConfidentialCPMMDeployer.sol", "utf8"),
);
if (/\bdelegatecall\b|\bselfdestruct\b/.test(poolDeployerSource)) {
  throw new Error("Confidential pool deployer contains an unsafe execution primitive");
}
for (const fragment of [
  "if (msg.sender != factory) revert DeploymentUnauthorized()",
  "factory != address(0)",
  "IConfidentialCPMMFactory(factory_).poolDeployer() != address(this)",
  "salt: key",
]) {
  if (!poolDeployerSource.includes(fragment)) {
    throw new Error("Confidential pool deployer is not one-time factory-bound and key-derived");
  }
}

const strategyRegistrySource = maskSourceCommentsAndLiterals(
  await readFile("contracts/ConfidentialInitializationStrategyRegistry.sol", "utf8"),
);
if (/\bdelegatecall\b|\bselfdestruct\b/.test(strategyRegistrySource)) {
  throw new Error("Initialization-strategy registry contains an unsafe execution primitive");
}
for (const fragment of [
  "MAX_INITIALIZATION_STRATEGIES = 2",
  "isReviewedInitializationStrategyCodehash[runtimeCodehash]",
  "candidate.supportsInterface(",
  "migrator.codehash != migratorRuntimeCodehash",
  "IConfidentialLaunchpadMigrator(migrator).factory() != factory",
  "IConfidentialLaunchpadMigrator(migrator).initializationStrategy() !=",
  "candidate.factoryRegistration() != bytes32(0)",
  "candidate.bindFactoryRegistration(registration)",
  "if (finalized) revert InitializationStrategyRegistryAlreadyFinalized()",
  "strategy.codehash != codehash",
  "candidate.factoryRegistration() == registration",
]) {
  if (!strategyRegistrySource.includes(fragment)) {
    throw new Error("Initialization-strategy registry omits bounded immutable provenance");
  }
}
for (const fragment of [
  "strategy.migrator() != msg.sender",
  "msg.sender.codehash != strategy.migratorRuntimeCodehash()",
  "candidate.token0Decimals() != decimals0",
  "candidate.token1Decimals() != decimals1",
]) {
  if (!factorySource.includes(fragment)) {
    throw new Error("Confidential factory does not bind immutable metadata and strategy-specific migrator authority");
  }
}
if (
  factorySource.includes("bootstrapAdapter") ||
  factorySource.includes("setBootstrapAdapter")
) {
  throw new Error("Confidential factory retains obsolete global migrator authority");
}

const signatureValidationSource = maskSourceCommentsAndLiterals(
  await readFile("contracts/libraries/SignatureValidation.sol", "utf8"),
);
for (const fragment of [
  "ECDSA.tryRecover(digest, signature)",
  "IERC1271.isValidSignature",
  "signer.staticcall(",
]) {
  if (!signatureValidationSource.includes(fragment)) {
    throw new Error("Shared creator-signature validation omits EOA or ERC-1271 support");
  }
}
const launchStrategySource = maskSourceCommentsAndLiterals(
  await readFile("contracts/ConfidentialLaunchInitializationStrategy.sol", "utf8"),
);
for (const source of [launchStrategySource, maskSourceCommentsAndLiterals(
  await readFile("contracts/ConfidentialLaunchpadMigrator.sol", "utf8"),
)]) {
  if (!source.includes("SignatureValidation.isValidSignatureNow(")) {
    throw new Error("Launch authorization paths do not share EOA/ERC-1271 validation");
  }
}
if (/\bdelegatecall\b|\bselfdestruct\b/.test(launchStrategySource)) {
  throw new Error("Launch initialization strategy contains an unsafe execution primitive");
}
for (const fragment of [
  "commitment.creator == launchAuthority",
  "_isValidSignature(\n                commitment.creator",
  "_isValidSignature(\n                launchAuthority",
  "canonicalFactory.getOrCreatePoolForCommitment(",
  "activeLaunchForPoolKey[poolKey]",
  "CompletedPoolCannotBeSuperseded()",
  "if (msg.sender != factory) revert InitializationUnauthorized()",
  "migratorCaller.codehash != migratorRuntimeCodehash",
  "record.status = LaunchStatus.COMPLETED",
  "IConfidentialCPMM(pool).initialized()",
  "commitment.chainId != block.chainid",
  "commitment.initializationStrategy != address(this)",
]) {
  if (!launchStrategySource.includes(fragment)) {
    throw new Error("Launch strategy omits dual authorization or one-shot pool binding");
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
const publicVaultSweepBody = functionBody(feeVaultSource, "sweepPublicToken");
for (const fragment of [
  "publicFees[token] = 0",
  "publicToken.safeTransfer(beneficiary, amount)",
  "beneficiaryBalanceAfter < beneficiaryBalanceBefore",
  "vaultBalanceBefore - vaultBalanceAfter != amount",
  "emit PublicFeesSweepReceipt(",
]) {
  if (!publicVaultSweepBody.includes(fragment)) {
    throw new Error("Public fee vault sweep does not bind claim clearance to its exact debit receipt");
  }
}
if (publicVaultSweepBody.includes(
  "beneficiaryBalanceAfter - beneficiaryBalanceBefore != amount",
)) {
  throw new Error("Public fee vault can permanently strand an authenticated sender-taxed claim");
}

const bestExecutionRouterSource = maskSourceCommentsAndLiterals(
  await readFile("contracts/ConfidentialBestExecutionRouter.sol", "utf8"),
);
if (/\bdelegatecall\b|\bselfdestruct\b/.test(bestExecutionRouterSource)) {
  throw new Error("Confidential best-execution router contains an unsafe execution primitive");
}
for (const fragment of [
  "MAX_CANDIDATES = 3",
  "MAX_POOL_CLASSES = 3",
  "CANDIDATE_BITMAP_BITS = 9",
  "DEFAULT_STANDARD_CANDIDATE_BITMAP",
  "_populationCount(candidateBitmap) > MAX_CANDIDATES",
  "canonicalFactory.initializationStrategyAt(",
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
const transactionEvidenceSource = await readFile(
  "scripts/testnet-transaction-evidence.ts",
  "utf8",
);
const transactionEvidenceAst = parseTypeScript(
  transactionEvidenceSource,
  "scripts/testnet-transaction-evidence.ts",
);
let acceptsExplicitTransactionHash = false;
let acceptsGenericHash = false;
const inspectTransactionHashKeys = (node) => {
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
    ts.isIdentifier(node.left) &&
    node.left.text === "key" &&
    ts.isStringLiteral(node.right)
  ) {
    if (node.right.text === "transactionHash") acceptsExplicitTransactionHash = true;
    if (node.right.text === "hash") acceptsGenericHash = true;
  }
  ts.forEachChild(node, inspectTransactionHashKeys);
};
inspectTransactionHashKeys(transactionEvidenceAst);
if (!acceptsExplicitTransactionHash || acceptsGenericHash) {
  throw new Error(
    "Funded transaction recovery accepts an uncorroborated generic hash from provider errors",
  );
}
const packageManifest = JSON.parse(await readFile("package.json", "utf8"));
const freshRunnerSource = await readFile("scripts/run-fresh-hardhat.mjs", "utf8");
const fundedDeploymentRecoverySource = await readFile(
  "scripts/recover-funded-deployment.ts",
  "utf8",
);
const operatorLauncherSource = await readFile(
  "scripts/operator-funded-launcher.mjs",
  "utf8",
);
const hardhatResolverSource = await readFile("scripts/resolve-hardhat-cli.mjs", "utf8");
const prepareFundedRuntimeSource = await readFile(
  "scripts/prepare-funded-runtime.mjs",
  "utf8",
);
const reviewedBuildReceiptSource = await readFile(
  "scripts/reviewed-build-receipt.mjs",
  "utf8",
);
const freshRuntimeEnvironmentSource = await readFile(
  "scripts/fresh-runtime-environment.mjs",
  "utf8",
);
const privateFilesystemSource = await readFile(
  "scripts/private-filesystem.mjs",
  "utf8",
);
const securePublicationSource = await readFile(
  "scripts/secure-publication.mjs",
  "utf8",
);
const fundedRpcConfirmationSource = await readFile(
  "scripts/funded-rpc-confirmation.mjs",
  "utf8",
);
const fundedTransactionWalletSource = await readFile(
  "scripts/funded-transaction-wallet.ts",
  "utf8",
);
const fundedRuntimeStateSource = await readFile(
  "scripts/funded-runtime-state.ts",
  "utf8",
);
const fundedEvidenceRecoverySource = await readFile(
  "scripts/rematerialize-funded-evidence.ts",
  "utf8",
);
for (const required of [
  "journal.reconcileTransactions(ethers.provider)",
  "journal.activeResources.length !== 0",
  "journal.activeAllowanceObligations.length !== 0",
  'journal.markRun("evidence-pending")',
  "writePreparedFundedRunEvidence",
  "reviewedSource.equals(currentSource)",
]) {
  if (!fundedEvidenceRecoverySource.includes(required)) {
    throw new Error(`Funded evidence recovery omits required control: ${required}`);
  }
}
if (/\b(?:sendTransaction|broadcastTransaction|withFundedTransactionEvidence)\b/u.test(
  fundedEvidenceRecoverySource,
)) {
  throw new Error("Funded evidence recovery contains a transaction submission path");
}
if (!freshRunnerSource.includes('"CIPHERDEX_LAUNCH_AUTHORITY"')) {
  throw new Error("Fresh deployment runner strips the required launch authority");
}
for (const script of [
  "testnet:harness",
  "testnet:preflight",
  "testnet:quote-call-probe",
  "testnet:best-execution-feasibility",
  "testnet:best-execution",
  "testnet:fee-collection",
  "testnet:launchpad",
  "evidence:finalize",
  "evidence:verify",
  "deploy:testnet",
  "secure:funded-env",
]) {
  if (packageManifest.scripts?.[script] !== undefined) {
    throw new Error(`${script} exposes a repository-local funded entry point`);
  }
}
if (packageManifest.scripts?.["gas:measure"] !== "hardhat run scripts/measure-deployment-gas.ts") {
  throw new Error("Secretless gas measurement is routed through the funded launcher");
}
if (
  packageManifest.scripts?.["prepare:funded-runtime"] !==
    "node scripts/prepare-funded-runtime.mjs"
) {
  throw new Error("Funded runtime preparation is not an explicit reviewed command");
}
if (
  !prepareFundedRuntimeSource.includes("Repository-local funded runtime preparation is disabled") ||
  /from\s+["']\.\.?\//.test(prepareFundedRuntimeSource)
) {
  throw new Error("Repository-local funded preparation does not fail closed");
}
if (/from\s+["']\.\.?\//.test(freshRunnerSource)) {
  throw new Error("Private Hardhat runner statically imports mutable local code");
}
if (/env:\s*process\.env/.test(freshRunnerSource)) {
  throw new Error("Private Hardhat runner forwards the ambient environment into a subprocess");
}
if (/spawnSync\(["']git["']/.test(freshRunnerSource + operatorLauncherSource)) {
  throw new Error("Funded launch resolves Git through an attacker-controlled search path");
}
for (const required of [
  "TRUSTED_GIT_CANDIDATES",
  '"cat-file", "-t", input.commit',
  '"fetch", "--quiet", "--no-tags"',
  '"checkout", "--quiet", "--detach", input.commit',
  '"ci", "--ignore-scripts"',
  'GIT_CONFIG_KEY_2: "safe.directory"',
  'safeDirectory.replaceAll("\\\\", "/")',
  "GIT_CONFIG_VALUE_2: canonicalSafeDirectory",
  "gitEnvironment(systemEnvironment, repositoryRoot)",
  'resolve(runtime, "scripts", "resolve-hardhat-cli.mjs")',
  "materializeInternalFileLinks(runtime)",
  "stageFundedEvidence(",
  "deploymentSourceCommit(runtime, environmentPath, input.commit)",
  "readReviewedEnvironment(environmentPath)",
  "funded finalization requires a canonical deployment record path",
  "promoteFundedEvidence(runtime, recoveryRoot, input.target, input.commit)",
  "FUNDED_EVIDENCE_RUNNERS",
  "MAX_FUNDED_EVIDENCE_BYTES",
  "parsed.runner !== runner",
  "parsed.sourceCommit !== sourceCommit",
  "durable funded evidence changed after publication",
  "privateKey|aesKey|signedTransaction|ciphertext",
  'resolve(runtime, ".git", "cipherdex-npm-cache")',
  "privateFilesystem.assertPrivateTree(runtime)",
  "recordReviewedBuild(runtime, input.commit, {",
  'resolve(runtime, ".git", "cipherdex-receipts")',
  "receiptRoot,",
  'CIPHERDEX_OPERATOR_LAUNCHER_ACTIVE: "1"',
  "rmSync(runtime, { recursive: true, force: true })",
]) {
  if (!operatorLauncherSource.includes(required)) {
    throw new Error(`External funded launcher omits required control: ${required}`);
  }
}
if (/hardhat\/internal\/cli\/cli\.js/u.test(operatorLauncherSource + freshRunnerSource)) {
  throw new Error("Funded execution resolves an unsupported Hardhat internal subpath");
}
for (const required of [
  "persistentRecoveryRoot(repositoryRoot)",
  "CIPHERDEX_FUNDED_STATE_ROOT: recoveryRoot",
]) {
  if (!operatorLauncherSource.includes(required)) {
    throw new Error(`Funded launcher omits durable recovery control: ${required}`);
  }
}
for (const required of [
  "funded recovery state requires an explicit absolute durable directory",
]) {
  if (!fundedTransactionWalletSource.includes(required)) {
    throw new Error(`Funded wallet omits durable recovery control: ${required}`);
  }
}
for (const required of [
  "CIPHERDEX_OPERATOR_LAUNCHER_ACTIVE",
  "CIPHERDEX_FUNDED_STATE_ROOT",
  "funded recovery state requires the authenticated operator launcher",
]) {
  if (!fundedRuntimeStateSource.includes(required)) {
    throw new Error(`Funded runtime state omits durable recovery control: ${required}`);
  }
}
for (const required of [
  'require.resolve("hardhat/package.json")',
  "manifest.bin?.hardhat",
  'fromPackage.startsWith("..")',
  "cliStat.isSymbolicLink()",
]) {
  if (!hardhatResolverSource.includes(required)) {
    throw new Error(`Hardhat CLI resolver omits required control: ${required}`);
  }
}
if (/^import[\s\S]*?from\s+["'](?!node:)/mu.test(operatorLauncherSource)) {
  throw new Error("External funded launcher statically imports non-builtin code before source authentication");
}
const hardhatConfigSource = await readFile("hardhat.config.ts", "utf8");
if (/dotenv(?:\/config)?/.test(hardhatConfigSource)) {
  throw new Error("Hardhat configuration eagerly loads a secret-bearing env file");
}
const sourceCheckPosition = freshRunnerSource.indexOf(
  'runGit(git, executionRoot, ["status", "--porcelain=v1", "--untracked-files=all"])',
);
const hardhatResolvePosition = freshRunnerSource.indexOf(
  'await import("./resolve-hardhat-cli.mjs")',
);
const repositoryEnvironmentRefusalPosition = freshRunnerSource.indexOf(
  'existsSync(resolve(executionRoot, ".env"))',
);
const environmentModulePosition = freshRunnerSource.indexOf(
  'await import("./fresh-runtime-environment.mjs")',
);
const reviewedBuildPosition = freshRunnerSource.indexOf(
  "verifyReviewedBuild(executionRoot, sourceCommit, {",
);
const environmentReadPosition = freshRunnerSource.indexOf(
  "readReviewedEnvironment(environmentPath)",
);
const freshRunPosition = freshRunnerSource.indexOf(
  '[hardhatCli, "run", "--no-compile", target, ...targetArguments]',
);
if (
  sourceCheckPosition < 0 ||
  sourceCheckPosition >= repositoryEnvironmentRefusalPosition ||
  repositoryEnvironmentRefusalPosition >= reviewedBuildPosition ||
  reviewedBuildPosition >= environmentModulePosition ||
  environmentModulePosition >= environmentReadPosition ||
  environmentReadPosition >= hardhatResolvePosition ||
  hardhatResolvePosition >= freshRunPosition
) {
  throw new Error("Private Hardhat runner does not authenticate source before reading funded configuration");
}
if (
  !freshRunnerSource.includes("funded targets may run only through the externally installed operator-funded launcher") ||
  !freshRunnerSource.includes("assertPrivateTree(executionRoot)") ||
  /["'](?:clean|compile)["']/.test(
    freshRunnerSource.slice(freshRunnerSource.indexOf("async function main()")),
  )
) {
  throw new Error("Private funded targets can compile or bypass the external launcher boundary");
}
if (
  freshRunnerSource.includes("process.loadEnvFile(") ||
  !freshRunnerSource.includes("buildReviewedRuntimeEnvironment({") ||
  !freshRunnerSource.includes("readReviewedEnvironment(environmentPath)") ||
  !freshRunnerSource.includes("allowAmbientConfiguration: false") ||
  !freshRunnerSource.includes("funded targets require an absolute external environment file") ||
  !freshRunnerSource.includes("funded environment must remain outside runtime and public repository") ||
  !freshRuntimeEnvironmentSource.includes("fresh Hardhat environment conflict for") ||
  !freshRuntimeEnvironmentSource.includes("readPrivateEnvironmentFile(path)") ||
  !privateFilesystemSource.includes("MAX_SECRET_FILE_BYTES") ||
  !privateFilesystemSource.includes("constants.O_NOFOLLOW") ||
  !privateFilesystemSource.includes("stat.nlink !== 1") ||
  !privateFilesystemSource.includes("assertPrivateDirectory(dirname(configured))") ||
  !privateFilesystemSource.includes("windowsAcl(configured, \"read\", false)") ||
  !privateFilesystemSource.includes("FileSystemRights]::ChangePermissions") ||
  !privateFilesystemSource.includes("FileSystemRights]::TakeOwnership") ||
  !privateFilesystemSource.includes("assertPrivateTree") ||
  !privateFilesystemSource.includes("WINDOWS_ICACLS")
) {
  throw new Error("Funded runner does not fail closed on secret-bearing environment conflicts");
}
for (const required of [
  "packageLockSha256",
  "sourceTreeSha256",
  "nodeModulesSha256",
  "artifactsSha256",
  "typechainSha256",
  "cipherdex.reviewed-build-receipt/v2",
  "assertPrivateTree(repositoryRoot)",
  "options.receiptRoot",
]) {
  if (!reviewedBuildReceiptSource.includes(required)) {
    throw new Error(`Reviewed build receipt omits required measurement: ${required}`);
  }
}
if (
  !freshRunnerSource.includes('requiredCanonicalDirectory("CIPHERDEX_BUILD_RECEIPT_ROOT")') ||
  !freshRunnerSource.includes("receiptRoot: buildReceiptRoot") ||
  !freshRunnerSource.includes("reviewed build receipt root must be a private runtime subdirectory")
) {
  throw new Error("Private runner does not bind reviewed-build verification to the launcher receipt root");
}
if (/executionSnapshot|requireExecutionSnapshot/u.test(reviewedBuildReceiptSource)) {
  throw new Error("Reviewed build receipt retains the superseded mutable snapshot model");
}
for (const required of [
  'GIT_CONFIG_NOSYSTEM: "1"',
  'GIT_CONFIG_GLOBAL:',
  'GIT_CONFIG_KEY_0: "core.fsmonitor"',
  'GIT_CONFIG_KEY_1: "core.hooksPath"',
  'GIT_NO_REPLACE_OBJECTS: "1"',
  '["--no-replace-objects", "--no-pager", ...arguments_]',
]) {
  if (!freshRunnerSource.includes(required) || !operatorLauncherSource.includes(required)) {
    throw new Error(`Fresh Hardhat source authentication omits Git isolation: ${required}`);
  }
}
for (const required of [
  "SYSTEM_ENVIRONMENT",
  "NETWORK_ENVIRONMENT",
  "FUNDED_NETWORK_ENVIRONMENT",
  "targetPolicy.funded",
  "targetPolicy.environment",
  "runtimeEnvironment.CIPHERDEX_TRUSTED_GIT = git",
  "inspectFundedTransaction(provider",
  "publishReviewedJson(",
]) {
  if (!freshRunnerSource.includes(required)) {
    throw new Error(`Fresh Hardhat runner omits credential-boundary control: ${required}`);
  }
}
for (const required of [
  "constants.O_NOFOLLOW",
  "stat.nlink !== 1",
  "MAX_PUBLIC_JSON_BYTES",
  "constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL",
  "fsyncSync(descriptor)",
  "renameSync(temporary, destination)",
]) {
  if (!securePublicationSource.includes(required)) {
    throw new Error(`Reviewed JSON publication omits required control: ${required}`);
  }
}
if (securePublicationSource.includes("copyFileSync")) {
  throw new Error("Reviewed JSON publication uses a mutable copy destination");
}
for (const required of [
  "provider.getTransaction(identity.hash)",
  "provider.getTransactionReceipt(identity.hash)",
  "provider.getBlock(receiptBlockNumber)",
  "minimumConfirmations",
  'state: "confirmed"',
]) {
  if (!fundedRpcConfirmationSource.includes(required)) {
    throw new Error(`Funded RPC confirmation omits required evidence: ${required}`);
  }
}
for (const path of [
  "scripts/deploy-testnet.ts",
  "scripts/funded-suite-evidence.ts",
  "scripts/testnet-deployment-provenance.ts",
  "scripts/testnet-quote-call-probe.ts",
]) {
  const source = await readFile(path, "utf8");
  for (const required of [
    "trustedGitExecutable",
    "trustedGitEnvironment",
    "trustedGitArguments",
  ]) {
    if (!source.includes(required)) {
      throw new Error(`${path}: deployment Git use omits ${required}`);
    }
  }
  if (/(?:execFileAsync|execFileSync|spawnSync)\(\s*["']git["']/.test(source)) {
    throw new Error(`${path}: resolves Git through an attacker-controlled search path`);
  }
}
if (
  freshRunnerSource.includes('"CIPHERDEX_SOURCE_COMMIT",') ||
  freshRunnerSource.includes("'CIPHERDEX_SOURCE_COMMIT',")
) {
  throw new Error("Fresh Hardhat runner permits ambient source-commit injection");
}
for (const path of [
  "scripts/testnet-best-execution-feasibility.ts",
  "scripts/testnet-best-execution.ts",
  "scripts/testnet-fee-collection.ts",
  "scripts/testnet-launchpad.ts",
]) {
  const source = await readFile(path, "utf8");
  if (!source.includes("const sourceCommit = deploymentRecord.sourceCommit;")) {
    throw new Error(`${path}: funded evidence is not bound to the reviewed deployment source`);
  }
}
for (const path of [
  "scripts/testnet-best-execution.ts",
  "scripts/testnet-launchpad.ts",
]) {
  const source = await readFile(path, "utf8");
  if (!source.includes("const FEE_VAULT_DEPLOY_GAS_LIMIT = 2_500_000n;")) {
    throw new Error(`${path}: funded fee-vault deployment gas cap is stale`);
  }
}
if (!hasStringCall(deploymentAst, "getContractFactory", "ConfidentialBestExecutionRouter")) {
  throw new Error("Testnet deployment does not deploy the confidential best-execution router");
}
for (const contractName of [
  "ConfidentialCPMMDeployer",
  "ConfidentialInitializationStrategyRegistry",
  "ConfidentialLaunchInitializationStrategy",
]) {
  if (!hasStringCall(deploymentAst, "getContractFactory", contractName)) {
    throw new Error(`Testnet deployment does not deploy ${contractName}`);
  }
}
for (const fragment of [
  "factory.setBestExecutionRouter(",
  "factory.bestExecutionRouter()",
  "journalContracts.bestExecutionRouterBinding =",
  "poolDeployerDeployment.contract.bindFactory(",
  "strategyRegistryDeployment.contract.bindFactory(",
  "launchStrategyDeployment.contract.migrator()",
  "const launchpadArtifact = await verifyDeployedRuntimeArtifactWithProvenance(",
  "strategyRegistryDeployment.contract.registerInitializationStrategy(",
  "strategyRegistryDeployment.contract.finalize(",
]) {
  if (!deploymentSource.includes(fragment)) {
    throw new Error("Testnet deployment omits canonical protocol binding provenance");
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
  "adapter.getTransaction(expectationSnapshot.transactionHash)",
  "adapter.getTransactionReceipt(expectationSnapshot.transactionHash)",
  "CONFIDENTIAL_BEST_EXECUTION_RESULT_EXPECTATION_FIELDS",
  "CONFIDENTIAL_BEST_EXECUTION_ROUTER_POLICY_FIELDS",
  "CONFIDENTIAL_POOL_POLICY_FIELDS",
  "PUBLIC_POOL_POLICY_FIELDS",
  "LAUNCHPAD_MIGRATION_POLICY_FIELDS",
  "buildConfidentialLaunchCommitment(",
  "buildConfidentialLaunchCommitCall(",
  "LAUNCH_COMMITMENT_EIP712_TYPES",
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
  "factory.isCompatiblePrivateToken(expectedToken0)",
  "factory.isCompatiblePrivateToken(expectedToken1)",
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
for (const fragment of [
  "openFundedRecoveryJournal(privateKey, {",
  "recoveryJournal.reconcileTransactions(provider)",
  "withFundedTransactionEvidence(",
  "journal().recordTransaction(",
  "UnresolvedDirectAllowanceError",
  "!(error instanceof UnknownBroadcastOutcomeError)",
  "BigInt(factoryVersion) !== 3n",
  "BigInt(poolVersion) !== 3n",
]) {
  if (!harnessSource.includes(fragment)) {
    throw new Error(`Basic funded harness omits recovery/version control: ${fragment}`);
  }
}
if (!harnessRawSource.includes('"failed-swap allowance recovery"')) {
  throw new Error("Basic funded harness omits deterministic failed-swap allowance recovery");
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
for (const contractName of [
  "ConfidentialCPMMDeployer",
  "ConfidentialInitializationStrategyRegistry",
]) {
  if (!new RegExp(`deployContract\\(\\s*["']${contractName}["']`).test(
    feeCollectionRawSource,
  )) {
    throw new Error(`Fee-collection runner does not deploy disposable ${contractName}`);
  }
}
for (const fragment of [
  "poolDeployer.contract.bindFactory(factory.address",
  "strategyRegistry.contract.bindFactory(factory.address",
  "strategyRegistryRuntimeCodehash",
  "poolDeployerRuntimeCodehash",
]) {
  if (!feeCollectionSource.includes(fragment)) {
    throw new Error("Fee-collection runner omits complete disposable factory bindings");
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
  !feeCollectionSource.includes("submitExpectedFailure(") ||
  !feeCollectionRawSource.includes('"premature confidential protocol fee collection"') ||
  !feeCollectionRawSource.includes("collectionReadyAt: Number(readyAt)") ||
  /confidential fee batch prepared; rerun after readyAt to collect[\s\S]{0,80}?return;/.test(
    feeCollectionSource,
  )
) {
  throw new Error("Fee-collection funded runner can report success before collection is complete");
}

for (const [file, source, ast] of [
  ["scripts/testnet-harness.ts", harnessSource, harnessAst],
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
    "assertCompatiblePrivateTokens(",
    "log.address.toLowerCase()",
    "matches.length !== 1",
  ]) {
    if (!source.includes(fragment)) {
      throw new Error(`${file}: funded evidence is not bound to current artifacts and one emitter`);
    }
  }
  const mainBody = functionBody(source, "main");
  if (
    mainBody.indexOf("assertCompatiblePrivateTokens(") >
    mainBody.indexOf("PRIVATE_ERC20_TESTNET_ABI")
  ) {
    throw new Error(`${file}: token interaction precedes structural compatibility validation`);
  }
}
const fundedEvidenceRawSource = await readFile("scripts/funded-run-evidence.ts", "utf8");
const fundedEvidenceSource = maskSourceCommentsAndLiterals(fundedEvidenceRawSource);
const fundedRecoveryRawSource = await readFile(
  "scripts/funded-recovery-journal.ts",
  "utf8",
);
const fundedRecoverySource = maskSourceCommentsAndLiterals(
  fundedRecoveryRawSource,
);
const durableAppendLogRawSource = await readFile(
  "scripts/durable-append-log.mjs",
  "utf8",
);
const durableAppendLogSource = maskSourceCommentsAndLiterals(
  durableAppendLogRawSource,
);
const deploymentProvenanceRawSource = await readFile(
  "scripts/testnet-deployment-provenance.ts",
  "utf8",
);
const fundedTransactionRawSource = await readFile(
  "scripts/funded-transaction-wallet.ts",
  "utf8",
);
const fundedTransactionSource = maskSourceCommentsAndLiterals(
  fundedTransactionRawSource,
);
const fundedCoordinatorRawSource = await readFile(
  "scripts/funded-process-coordinator.mjs",
  "utf8",
);
if (fundedCoordinatorRawSource.includes("signedTransaction")) {
  throw new Error("Signer coordinator persists replayable signed transaction bytes");
}
for (const [source, required, label] of [
  [fundedCoordinatorRawSource, "restrictPrivateDirectory(root)", "signer coordinator"],
  [reviewedBuildReceiptSource, "restrictPrivateDirectory(directory)", "build receipt"],
]) {
  if (!source.includes(required)) {
    throw new Error(`${label} storage is not protected by the private filesystem boundary`);
  }
}
const fundedAllowanceRawSource = await readFile(
  "scripts/funded-private-allowance.ts",
  "utf8",
);
for (const required of [
  "AsyncLocalStorage",
  "keccak256(signedTransaction)",
  "recordPreparedSignerTransaction(",
  "recordPreparedTransaction(",
  "provider.broadcastTransaction(signedTransaction)",
  "recordBroadcast(",
  "recordTransaction(localHash",
  "new AggregateError(causes",
  "recordUnknownBroadcastOutcome(context, chainId, signer, localHash, error)",
  "FundedWallet extends EthersWallet",
  "FundedCotiWallet extends CotiWallet",
  "validateFundedTransactionFeePolicy(populated)",
]) {
  if (!fundedTransactionSource.includes(required)) {
    throw new Error(`Funded transaction boundary omits required control: ${required}`);
  }
}
if (!fundedTransactionRawSource.includes("maximum network fee exceeds the reviewed cap")) {
  throw new Error("Funded transaction boundary omits the worst-case total fee cap");
}
if (!fundedTransactionRawSource.includes('recordTransaction(localHash, "outcome-unknown")')) {
  throw new Error("Funded transaction boundary does not retain uncertain broadcast state");
}
const preparedPosition = fundedTransactionSource.indexOf("recordPreparedTransaction(");
const signerPreparedPosition = fundedTransactionSource.indexOf(
  "recordPreparedSignerTransaction(",
);
const broadcastPosition = fundedTransactionSource.indexOf(
  "provider.broadcastTransaction(signedTransaction)",
);
const broadcastRecordPosition = fundedTransactionSource.indexOf("recordBroadcast(");
if (
  preparedPosition < 0 ||
  signerPreparedPosition < 0 ||
  broadcastPosition < 0 ||
  broadcastRecordPosition < 0 ||
  preparedPosition >= signerPreparedPosition ||
  signerPreparedPosition >= broadcastPosition ||
  broadcastPosition >= broadcastRecordPosition
) {
  throw new Error("Funded transaction boundary does not journal before RPC broadcast");
}
for (const required of [
  "acquireRepositoryExecutionLease",
  "acquireSignerExecutionLeases",
  "reconcileSignerExecutionLeases",
  "assertSoleRecoverableSignerTransaction",
  "recordPreparedSignerTransaction",
  "recordPreparedSignerTransactionAbandoned",
  '"abandoned-prebroadcast"',
  "TERMINAL_TRANSACTION_STATUSES.has(transaction.status)",
  'existing.status === "abandoned-prebroadcast"',
  'existing.status !== "prepared"',
  "entry !== existing",
  "pre-broadcast abandonment requires its dedicated proof boundary",
  "funded signer nonce is already reserved by another transaction",
  "reconcile or identically rebroadcast it before another funded run",
]) {
  if (!fundedCoordinatorRawSource.includes(required)) {
    throw new Error(`Funded process coordinator omits required control: ${required}`);
  }
}
for (const required of [
  "assertHistoricalPrebroadcastOrder(sourceCommit, authenticatedCommit)",
  'trustedGitArguments(["merge-base", "--is-ancestor"',
  '`${sourceCommit}:scripts/funded-transaction-wallet.ts`',
  'signerTransaction.status !== "prepared"',
  'inspection.state !== "absent"',
  'signerTransaction.status === "abandoned-prebroadcast"',
  "recordPreparedSignerTransaction({",
  'getTransactionCount(owner, "latest")',
  'getTransactionCount(owner, "pending")',
  "recordPreparedSignerTransactionAbandoned(CHAIN_ID, owner, transactionHash)",
]) {
  if (!fundedDeploymentRecoverySource.includes(required)) {
    throw new Error(`Funded deployment recovery omits pre-broadcast proof: ${required}`);
  }
}
for (const required of [
  '"scripts/recover-funded-deployment.ts"',
  "recovery: true",
  "assertSoleRecoverableSignerTransaction(signerLeases, expectedHash)",
  "CIPHERDEX_RECOVERY_TRANSACTION_HASH",
]) {
  if (!freshRunnerSource.includes(required)) {
    throw new Error(`Funded runner omits required recovery control: ${required}`);
  }
}
for (const required of [
  "recordAllowanceObligation",
  "markAllowanceCleared",
  "recoverPrivateAllowanceObligations",
  "verified !== input.amount",
]) {
  if (!fundedAllowanceRawSource.includes(required)) {
    throw new Error(`Funded allowance recovery omits required control: ${required}`);
  }
}
for (const forbidden of ["console.", "process.env", "safeTestnetErrorSummary"]){
  if (fundedTransactionSource.includes(forbidden)) {
    throw new Error(`Funded transaction boundary exposes forbidden data path: ${forbidden}`);
  }
}
for (const file of [
  "scripts/testnet-best-execution-feasibility.ts",
  "scripts/testnet-best-execution.ts",
  "scripts/testnet-fee-collection.ts",
  "scripts/testnet-harness.ts",
  "scripts/testnet-launchpad.ts",
]) {
  const source = await readFile(file, "utf8");
  if (
    !source.includes("FundedCotiWallet as CotiWallet") ||
    !source.includes("withFundedTransactionEvidence")
  ) {
    throw new Error(`${file}: funded writes can bypass deterministic local signing evidence`);
  }
}
for (const file of [
  "scripts/testnet-best-execution.ts",
  "scripts/testnet-fee-collection.ts",
  "scripts/testnet-harness.ts",
  "scripts/testnet-launchpad.ts",
]) {
  const source = await readFile(file, "utf8");
  if (
    !source.includes("recoverPrivateAllowanceObligations") ||
    !source.includes("setRecoverablePrivateAllowance") ||
    /\.approve\s*\(/.test(maskSourceCommentsAndLiterals(source))
  ) {
    throw new Error(`${file}: private allowances bypass durable recovery obligations`);
  }
}
for (const required of [
  "FundedWallet",
  "openFundedRecoveryJournal",
  "submitDeploymentTransaction(",
  "withFundedTransactionEvidence(",
]) {
  if (!deploymentRawSource.includes(required)) {
    throw new Error(`Testnet deployment bypasses funded signing boundary: ${required}`);
  }
}
const feasibilityRunnerSource = await readFile(
  "scripts/testnet-best-execution-feasibility.ts",
  "utf8",
);
for (const required of [
  '"pool probe 0 output funding"',
  '"pool probe 1 output funding"',
]) {
  if (!feasibilityRunnerSource.includes(required)) {
    throw new Error(`Best-execution feasibility runner omits unique funded label: ${required}`);
  }
}
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
  "targetArtifactLabel",
  "requirement.selectors.includes(transaction.selector.toLowerCase())",
  "creationTransactionHash",
  "recoveryTransactionHashes",
  "verifyRecoveryResourceCreation(",
  "verifyRecoveryResourceTerminalState(",
  "LAUNCHPAD_MIGRATE_SELECTOR",
  "LAUNCHPAD_MIGRATE_WITH_DISPOSITION_SELECTOR",
  "CONFIDENTIAL_CPMM_ABI",
  "requireSelector(",
  "SELECTOR.addLiquidity",
  "BEST_EXECUTION_FUNDED_ASSERTIONS",
  "attestationDigest(",
  "verifyMessage(",
  "requireOnchainSemanticBindings(",
  "writePreparedFundedRunEvidence(",
  "requireDirectCreationBindings(",
  "Interface(compiled.abi).encodeDeploy(",
  "transaction.contractAddress",
  "requireFactoryChildBindings(",
  "requireMigratorConstructorChildBinding(",
  "requireBestExecutionFeasibilityBindings(",
  "requireFeeCollectionBindings(",
  "requireProtectedPoolLifecycleOrder(",
  "transactionIndex",
  "isStrictlyAfter(",
  "immutableReferenceCount",
]) {
  if (!fundedEvidenceSource.includes(required)) {
    throw new Error(`Funded evidence omits required provenance control: ${required}`);
  }
}
for (const required of [
  "cipherdex.funded-run-evidence/v6",
  "funded run cannot produce evidence with unresolved transactions",
  "funded evidence lacks a selector-bound semantic transaction",
  "funded artifact constructor calldata is invalid",
  "funded confidential pools and LP tokens are not one-to-one",
  "funded launchpad migrator lacks constructor-child provenance",
  "funded feasibility requests are not independently replay-bound",
  "funded vault epoch does not match the correlated aggregate deposits",
  "funded launch commitment lacks independent creator and authority signatures",
  "funded protected-pool lifecycle is not strictly commit/reject/migrate/replay/exit/reseed/exit ordered",
  "premature confidential protocol fee collection",
  "collectionReadyAt",
  "confidentialSwapCountByEpoch",
]) {
  if (!fundedEvidenceRawSource.includes(required)) {
    throw new Error(`Funded evidence omits required literal control: ${required}`);
  }
}
for (const required of [
  "createCipheriv(\"aes-256-gcm\"",
  "createDecipheriv(\"aes-256-gcm\"",
  "cipherdex.funded-recovery-envelope/v1",
  "appendUtf8RecordIfUnchanged(",
  "persistedEnvelope",
  "allowanceObligations",
  "funded operation label is already journaled and cannot be re-signed",
  "signedTransaction: undefined",
]) {
  if (!fundedRecoveryRawSource.includes(required)) {
    throw new Error(`Funded recovery journal omits required control: ${required}`);
  }
}
for (const required of [
  "constants.O_EXCL",
  "constants.O_NOFOLLOW",
  "fsyncSync(descriptor)",
  "payloadSha256",
  "previousDigest",
  "acquireProcessLease",
  "processIsAlive",
  "restrictPrivateDirectory(canonical)",
  "restrictAndAssertPrivateRegularFile",
  "restrictPrivateFile(path)",
  "assertDescriptorMatchesPrivatePath",
  "compactedFrom",
  "renameSync(checkpointPath, targetPath)",
]) {
  if (!durableAppendLogSource.includes(required)) {
    throw new Error(`Durable append log omits required control: ${required}`);
  }
}
if (
  !durableAppendLogRawSource.includes("cipherdex.durable-append-log/v1") ||
  !durableAppendLogRawSource.includes("durable append log changed since it was read") ||
  !durableAppendLogRawSource.includes("durable append-log checkpoint could not be verified")
) {
  throw new Error("Durable append log omits the stale-writer rejection diagnostic");
}
for (const required of [
  "trustedGitExecutable(",
  "trustedGitArguments(",
  "createHash(\"sha256\").update(immutableRecord",
  "recordPath: resolved.relativePath",
  '"log"',
  '"--format=%H"',
  "manifestCommit: sourceState.recordCommit.toLowerCase()",
]) {
  if (!deploymentProvenanceRawSource.includes(required)) {
    throw new Error(`Funded deployment provenance omits immutable Git binding: ${required}`);
  }
}
if (!deploymentProvenanceRawSource.includes('"show"')) {
  throw new Error("Funded deployment provenance does not read an immutable Git object");
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
  const evidencePosition = source.lastIndexOf("writePreparedFundedRunEvidence({");
  const planPosition = source.lastIndexOf("prepareEvidence({");
  const recoveryPosition = source.lastIndexOf("markRecovered(");
  if (
    evidencePosition < 0 ||
    planPosition < 0 ||
    recoveryPosition < 0 ||
    recoveryPosition >= planPosition ||
    planPosition >= evidencePosition
  ) {
    throw new Error(`${file}: passing funded evidence is not gated by completed recovery`);
  }
}

const launchpadRawSource = await readFile("scripts/testnet-launchpad.ts", "utf8");
const launchpadSource = maskSourceCommentsAndLiterals(launchpadRawSource);
const launchpadMainBody = functionBody(launchpadSource, "main");
for (const fragment of [
  "verifyConfiguredTestnetDeployment(",
  "assertCompatiblePrivateTokens(",
  "verifyDeployedRuntimeArtifact(",
  "openFundedRecoveryJournal(privateKey, {",
  "recoverLaunchpadResources()",
  "writePreparedFundedRunEvidence({",
]) {
  if (!launchpadMainBody.includes(fragment)) {
    throw new Error("Launchpad funded runner bypasses source or token compatibility provenance");
  }
}
for (const contractName of [
  "ConfidentialCPMMDeployer",
  "ConfidentialInitializationStrategyRegistry",
  "ConfidentialLaunchInitializationStrategy",
]) {
  if (!hasStringCall(parseTypeScript(launchpadRawSource, "scripts/testnet-launchpad.ts"), "getContractFactory", contractName)) {
    throw new Error(`Launchpad funded runner does not deploy disposable ${contractName}`);
  }
}
for (const fragment of [
  "poolDeployer.bindFactory(",
  "strategyRegistry.bindFactory(",
  "strategy.migrator()",
  "await verifyDeployedRuntimeArtifact(",
  "strategyRegistry.registerInitializationStrategy(",
  "strategyRegistry.finalize(",
  "futureChainDeadline(",
  "requireMinedFailureSelector(",
  "evidence.receipt.gasUsed >= failedTransaction.gasLimit",
  "{ allowUnavailable: true }",
]) {
  if (!launchpadSource.includes(fragment)) {
    throw new Error("Launchpad funded runner omits one-time strategy-stack bindings");
  }
}
if (
  (launchpadRawSource.match(/allowUnavailable:\s*true/gu) ?? []).length !== 1 ||
  (transactionEvidenceSource.match(/allowUnavailable:\s*true/gu) ?? []).length !== 0
) {
  throw new Error("Opaque COTI revert evidence escaped the single reviewed launchpad call site");
}
const launchDeadlinePosition = launchpadRawSource.indexOf("const deadline = futureChainDeadline(");
const finalizedStrategyPosition = launchpadRawSource.indexOf(
  '"initialization strategy registry finalization"',
);
if (
  launchDeadlinePosition < 0 ||
  finalizedStrategyPosition < 0 ||
  launchDeadlinePosition <= finalizedStrategyPosition ||
  !launchpadRawSource.includes('ethers.id("PriceOutsideBounds()")') ||
  !launchpadRawSource.includes("launchpad migration deadline window exhausted before submission")
) {
  throw new Error("Launchpad funded runner does not prove a live, reason-bound migration deadline");
}
if (!launchpadSource.includes("verifyRecoveryResourceCreation(")) {
  throw new Error("Launchpad funded recovery does not authenticate resource creation");
}
for (const literal of [
  "full disposable launchpad-pool exit",
  "full configured launchpad-pool exit",
  "successful launch commitment has no canonical pool to recover",
  "launchpad pool recovery canonical provenance changed",
  "launchpad recovery cannot uniquely prove canonical pool creation",
  "factory.filters.PoolCreated(token0Address, token1Address)",
  "atomic launchpad migration recovery",
  "launchpad pool direct paid quote",
  "launchpad pool direct private swap",
  "protected launchpad pool partial exit",
  "direct private quote and swap preserved exact balance and allowance deltas",
  "partial and full LP removal succeeded",
  "protected pool ordinary re-seed",
  "completed protected pool remained permissionless after a full exit and ordinary re-seed",
  "prepareEvidence({",
]) {
  if (!launchpadRawSource.includes(literal)) {
    throw new Error("Launchpad funded runner omits required recovery evidence");
  }
}
if (launchpadMainBody.indexOf("assertCompatiblePrivateTokens(") >
    launchpadMainBody.indexOf("tokenARead = new Contract")) {
  throw new Error("Launchpad funded runner validates compatibility after token interaction begins");
}
for (const fragment of [
  "tokenARead.decimals()",
  "tokenBRead.decimals()",
  "onchainDecimalsA !== decimalsA",
  "onchainDecimalsB !== decimalsB",
  "deriveFundedTestAmount(",
  "minimumInputWithProtocolFee(feeBps)",
  "exitAllLaunchpadShares(",
  "pool.protectedInitializationCompleted()",
  "pool.addLiquidity(",
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
if (!bestExecutionProductionSource.includes("assertCompatiblePrivateTokens(")) {
  throw new Error("Best-execution funded runner accepts technically incompatible private tokens");
}
for (const contractName of [
  "CipherDEXFeeVault",
  "PrivateLPTokenFactory",
  "ConfidentialCPMMDeployer",
  "ConfidentialInitializationStrategyRegistry",
  "ConfidentialCPMMFactory",
  "ConfidentialLaunchInitializationStrategy",
  "ConfidentialBestExecutionRouter",
]) {
  if (!new RegExp(`deployContract\\(\\s*[\"']${contractName}[\"']`).test(
    bestExecutionProductionRawSource,
  )) {
    throw new Error(`Best-execution funded runner does not deploy disposable ${contractName}`);
  }
}
for (const fragment of [
  "poolDeployerDeployment.contract.bindFactory(",
  "strategyRegistryDeployment.contract.bindFactory(",
  "strategyDeployment.contract.migrator()",
  "await verifyDeployedRuntimeArtifact(",
  "strategyRegistryDeployment.contract.registerInitializationStrategy(",
  "strategyRegistryDeployment.contract.finalize(",
  "BigInt(configuredRouterVersion) !== 2n",
  "!Boolean(registryFinalized)",
]) {
  if (!bestExecutionProductionSource.includes(fragment)) {
    throw new Error("Best-execution funded runner omits current strategy-stack verification");
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

const bestExecutionRunnerRaw = await readFile("scripts/testnet-best-execution.ts", "utf8");
const bestExecutionRunner = maskSourceCommentsAndLiterals(bestExecutionRunnerRaw);
for (const required of [
  "fundedScenarioCap(balanceA)",
  "fundedScenarioCap(balanceB)",
  "minimumInputWithProtocolFee(5)",
  "requiredA > scenarioCapA",
  "requiredB > scenarioCapB",
  "reviewedFeeVault.beneficiary()",
]) {
  if (!bestExecutionRunnerRaw.includes(required)) {
    throw new Error(`Best-execution funded runner omits reviewed input control: ${required}`);
  }
}
if (bestExecutionRunnerRaw.includes("CIPHERDEX_FEE_BENEFICIARY")) {
  throw new Error("Best-execution funded runner accepts an unreviewed fee beneficiary");
}
for (const required of [
  "buildConfidentialLaunchCommitment({",
  "buildConfidentialLaunchCommitCall(",
  "initializationStrategy.commitLaunch(",
  "migrator.migrate(",
  "requestBestQuoteExactInputWithCandidates(",
  "swapBestExactInputWithCandidates(",
  "MIXED_TWO_CANDIDATE_BITMAP",
  "MIXED_THREE_CANDIDATE_BITMAP",
  "pool30.initializationStrategy !== strategyDeployment.address",
]) {
  if (!bestExecutionRunner.includes(required)) {
    throw new Error(`Best-execution funded runner omits mixed-class proof: ${required}`);
  }
}
if (!bestExecutionRunnerRaw.includes('candidateStrategyClasses: "standard,launch-protected"')) {
  throw new Error("Best-execution funded evidence omits mixed-class configuration");
}
if (!bestExecutionRunner.includes("BEST_EXECUTION_FUNDED_ASSERTIONS")) {
  throw new Error("Best-execution runner does not consume the canonical funded assertion list");
}
for (const required of [
  '"signed launch commitment initialized the protected 30 bps candidate"',
  '"bounded mixed standard and launch-protected candidate bitmap exercised"',
  '"protected candidate selected and settled through the shared router"',
]) {
  if (!fundedEvidenceRawSource.includes(required)) {
    throw new Error(`Canonical funded evidence omits mixed-class assertion: ${required}`);
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
  "deploymentRecord.evidenceCommit !== evidenceCommit",
  "const sourceCommit = deploymentRecord.sourceCommit",
  "serializeMinedEvidence(deploymentEvidence)",
  "serializeMinedEvidence(controlEvidence)",
  "openFundedRecoveryJournal(quoteKey, {",
  "withFundedTransactionEvidence(",
]) {
  if (!quoteCallProbeRunner.includes(required)) {
    throw new Error(`Quote-call feasibility runner lacks provenance evidence: ${required}`);
  }
}
for (const required of [
  '"status", "--porcelain=v1", "--untracked-files=all"',
  '"ls-files",',
  '"cipherdex.testnet-quote-call-probe/v1"',
  "paidPerPoolQuoteIsOnlyProvenExactPath: true",
]) {
  if (!quoteCallProbeRunnerRaw.includes(required)) {
    throw new Error(`Quote-call feasibility runner lacks committed evidence output: ${required}`);
  }
}

for (const file of [
  "scripts/deploy-testnet.ts",
  "scripts/testnet-harness.ts",
  "scripts/testnet-quote-call-probe.ts",
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
  !deploymentTransactionProvenance.includes("const canonicalTarget = addressOf(binding.targetKey)") ||
  !deploymentTransactionProvenance.includes("const canonicalArguments = binding.argumentKeys.map(addressOf)") ||
  !deploymentTransactionProvenance.includes("deploymentAuthority") ||
  !deploymentTransactionProvenance.includes("canonicalArguments") ||
  !deploymentTransactionProvenance.includes("transaction hashes must be unique")
) {
  throw new Error("Deployment records are not protected by review-before-publication controls");
}

console.log("Supplemental lexed security boundary checks passed; executable unit, fuzz, invariant and funded tests remain the authoritative behavioral evidence.");
