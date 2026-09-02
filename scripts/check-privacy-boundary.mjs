import { readdir, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

import { maskSourceCommentsAndLiterals } from "./source-boundary-lint.mjs";
import { assertCompiledPrivacyDecryptBoundary } from "./solidity-privacy-ast.mjs";

async function solidityFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await solidityFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".sol")) files.push(path);
  }
  return files;
}

const contractsDirectory = fileURLToPath(new URL("../contracts/", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const files = await solidityFiles(contractsDirectory);
const productionSources = new Map();
const disposablePrivacyPatternSources = new Map();
const PRIVATE_AMOUNT_PATTERN = /amount|reserve|share|value|input|output|price|tvl/i;
const REVIEWED_OBSERVABLE_DISCLOSURE_EVENTS = new Set([
  "eventPublicPriceObservation(uint64indexedsequence,uint256priceBucketX18,uint64observedAt,uint64publishedAt,uint32activityCount,uint256quantumX18,boolinitial);",
  "eventPoolCreated(addressindexedtoken0,addressindexedtoken1,uint8token0Decimals,uint8token1Decimals,uint256feeBps,addressinitializationStrategy,addresspool);",
  "eventLaunchPrepared(bytes32indexedlaunchId,bytes32indexedpoolKey,addressindexedpool,addresscreator,uint256initialPriceReferenceX18,uint64migrationDeadline,bytes32authorizationHash);",
]);
function isReviewedObservableDisclosureEvent(file, event) {
  const normalizedPath = file.replaceAll("\\", "/");
  if (!normalizedPath.includes("ObservableConfidential")) return false;
  return REVIEWED_OBSERVABLE_DISCLOSURE_EVENTS.has(event.replace(/\s+/g, ""));
}
for (const file of files) {
  const rawSource = await readFile(file, "utf8");
  if (!file.replaceAll("\\", "/").includes("/contracts/mocks/")) {
    productionSources.set(file, rawSource);
  }
  if (file.replaceAll("\\", "/").endsWith("/contracts/mocks/PrivateLPAccountingProbe.sol")) {
    disposablePrivacyPatternSources.set(file, rawSource);
  }
  const source = maskSourceCommentsAndLiterals(rawSource);
  const confidentialSurface = /(?:Confidential|IConfidential)/i.test(file);
  const events = [...source.matchAll(/^\s*event\s+[^;]+;/gm)].map(([event]) => event);
  const ciphertextEventNames = new Set();
  for (const event of events) {
    const eventName = event.match(/^\s*event\s+([A-Za-z_]\w*)/)?.[1];
    const withoutCiphertextParameters = event.replace(
      /\bctUint(?:8|16|32|64|128|256)\s+(?:indexed\s+)?[A-Za-z_]\w*/g,
      "",
    );
    if (
      eventName &&
      withoutCiphertextParameters !== event &&
      !PRIVATE_AMOUNT_PATTERN.test(withoutCiphertextParameters)
    ) {
      ciphertextEventNames.add(eventName);
    }
  }
  if (
    confidentialSurface &&
    events.some((event) => {
      const withoutCiphertextParameters = event.replace(
        /\bctUint(?:8|16|32|64|128|256)\s+(?:indexed\s+)?[A-Za-z_]\w*/g,
        "",
      );
      return (
        PRIVATE_AMOUNT_PATTERN.test(withoutCiphertextParameters) &&
        !isReviewedObservableDisclosureEvent(file, event)
      );
    })
  ) {
    throw new Error(`Private amount-like data was added to a public event declaration: ${file}`);
  }

  const unsafeEmit = [...source.matchAll(/\bemit\s+([A-Za-z_]\w*)\s*\([^;]*\);/gs)]
    .some(([statement, eventName]) => {
      const normalizedPath = file.replaceAll("\\", "/");
      const reviewedObservableEmit =
        normalizedPath.includes("ObservableConfidential") &&
        ["PublicPriceObservation", "PoolCreated", "LaunchPrepared"].includes(eventName);
      return (
        PRIVATE_AMOUNT_PATTERN.test(statement) &&
        !ciphertextEventNames.has(eventName) &&
        !reviewedObservableEmit
      );
    });
  if (confidentialSurface && unsafeEmit) {
    throw new Error(`Private amount-like data was added to an emitted event: ${file}`);
  }

  if (/console\s*\./.test(source)) {
    throw new Error(`Debug output is forbidden in the protocol contract: ${file}`);
  }

}

const buildInfoDirectory = fileURLToPath(new URL("../artifacts/build-info/", import.meta.url));
const buildInfoFiles = await Promise.all(
  (await readdir(buildInfoDirectory))
    .filter((name) => name.endsWith(".json") && !name.endsWith(".output.json"))
    .map(async (name) => ({
      name,
      modifiedAt: (await stat(join(buildInfoDirectory, name))).mtimeMs,
    })),
);
buildInfoFiles.sort((left, right) => right.modifiedAt - left.modifiedAt);

function compilerSourceToDiskPath(buildInfo, compilerSourceName) {
  const originalSourceName = Object.entries(buildInfo.userSourceNameMap ?? {})
    .find(([, mappedName]) => mappedName === compilerSourceName)?.[0];
  if (originalSourceName) {
    return originalSourceName.startsWith("contracts/")
      ? join(repositoryRoot, originalSourceName)
      : join(repositoryRoot, "node_modules", originalSourceName);
  }
  if (compilerSourceName.startsWith("project/")) {
    return join(repositoryRoot, compilerSourceName.slice("project/".length));
  }
  if (compilerSourceName.startsWith("npm/")) {
    const versionedName = compilerSourceName.slice("npm/".length);
    const scoped = versionedName.match(/^(@[^/]+\/[^/]+)@[^/]+\/(.+)$/);
    const unscoped = versionedName.match(/^([^/@]+)@[^/]+\/(.+)$/);
    const packagePath = scoped
      ? `${scoped[1]}/${scoped[2]}`
      : unscoped
        ? `${unscoped[1]}/${unscoped[2]}`
        : undefined;
    return packagePath ? join(repositoryRoot, "node_modules", packagePath) : undefined;
  }
  return undefined;
}

async function sourceClosureMatches(buildInfo) {
  for (const [sourceName, sourceInput] of Object.entries(buildInfo.input?.sources ?? {})) {
    const sourcePath = compilerSourceToDiskPath(buildInfo, sourceName);
    if (!sourcePath) return false;
    let currentSource;
    try {
      currentSource = await readFile(sourcePath, "utf8");
    } catch {
      return false;
    }
    if (sourceInput?.content !== currentSource) return false;
  }
  return true;
}

const assignments = new Map();
let mpcCompilationCount = 0;
const compiledPrivacySources = new Map([
  ...productionSources,
  ...disposablePrivacyPatternSources,
]);
const privacyContractFilters = new Map([
  [
    "contracts/mocks/PrivateLPAccountingProbe.sol",
    new Set(["PrivateLPAccountingProbeToken"]),
  ],
]);
for (const { name } of buildInfoFiles) {
  const buildInfo = JSON.parse(await readFile(join(buildInfoDirectory, name), "utf8"));
  const outputName = name.replace(/\.json$/, ".output.json");
  let buildOutput;
  try {
    buildOutput = JSON.parse(await readFile(join(buildInfoDirectory, outputName), "utf8"));
  } catch {
    continue;
  }
  if (!await sourceClosureMatches(buildInfo)) continue;
  const normalizedOutputSources = Object.fromEntries(
    Object.entries(buildOutput.output?.sources ?? {}).map(([sourceName, sourceOutput]) => [
      sourceName.startsWith("project/") ? sourceName.slice("project/".length) : sourceName,
      sourceOutput,
    ]),
  );
  const targetPaths = [];
  for (const [file, source] of compiledPrivacySources) {
    const path = relative(repositoryRoot, file).replaceAll("\\", "/");
    const compilerPath = buildInfo.userSourceNameMap?.[path] ?? `project/${path}`;
    if (
      !assignments.has(path) &&
      buildInfo.input?.sources?.[compilerPath]?.content === source &&
      normalizedOutputSources[path]?.ast
    ) {
      assignments.set(path, name);
      targetPaths.push(path);
    }
  }
  if (targetPaths.length > 0) {
    const includesMpcCore = Object.values(normalizedOutputSources).some((source) =>
      source?.ast?.nodes?.some(
        (node) => node.nodeType === "ContractDefinition" && node.name === "MpcCore",
      ),
    );
    const count = includesMpcCore
      ? assertCompiledPrivacyDecryptBoundary(
          normalizedOutputSources,
          targetPaths,
          privacyContractFilters,
        )
      : 0;
    if (includesMpcCore) mpcCompilationCount += 1;
    assignments.set(`${name}:plaintext-count`, count);
  }
}

const expectedPaths = [...compiledPrivacySources.keys()].map((file) =>
  relative(repositoryRoot, file).replaceAll("\\", "/")
);
const missingAsts = expectedPaths.filter((path) => !assignments.has(path));
if (missingAsts.length > 0) {
  throw new Error(`Fresh compiled Solidity AST is missing for: ${missingAsts.join(", ")}`);
}
if (mpcCompilationCount === 0) {
  throw new Error("Fresh compiled Solidity AST omits the COTI MpcCore dependency graph");
}
const plaintextCount = [...assignments.entries()]
  .filter(([key]) => key.endsWith(":plaintext-count"))
  .reduce((total, [, count]) => total + Number(count), 0);
if (plaintextCount !== 4) {
  throw new Error(
    `Expected two reviewed route-index and two observable-price decryptions, found ${plaintextCount}`,
  );
}

console.log(`Privacy boundary checks passed for ${files.length} Solidity files using fresh compiler ASTs.`);
