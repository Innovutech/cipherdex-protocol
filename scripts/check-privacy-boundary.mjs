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
for (const file of files) {
  const rawSource = await readFile(file, "utf8");
  if (!file.replaceAll("\\", "/").includes("/contracts/mocks/")) {
    productionSources.set(file, rawSource);
  }
  const source = maskSourceCommentsAndLiterals(rawSource);
  const confidentialSurface = /(?:Confidential|IConfidential)/i.test(file);
  const events = [...source.matchAll(/^\s*event\s+[^;]+;/gm)].map(([event]) => event);
  if (confidentialSurface && events.some((event) => /amount|reserve|share|value|input|output/i.test(event))) {
    throw new Error(`Private amount-like data was added to a public event declaration: ${file}`);
  }

  if (confidentialSurface && /emit\s+[^;]*(amount|reserve|share|value|input|output)/i.test(source)) {
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
  for (const [file, source] of productionSources) {
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
      ? assertCompiledPrivacyDecryptBoundary(normalizedOutputSources, targetPaths)
      : 0;
    if (includesMpcCore) mpcCompilationCount += 1;
    assignments.set(`${name}:plaintext-count`, count);
  }
}

const expectedPaths = [...productionSources.keys()].map((file) =>
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
if (plaintextCount !== 1) {
  throw new Error(`Expected exactly one reviewed plaintext route-index decryption, found ${plaintextCount}`);
}

console.log(`Privacy boundary checks passed for ${files.length} Solidity files using fresh compiler ASTs.`);
