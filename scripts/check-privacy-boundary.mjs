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
    .filter((name) => name.endsWith(".json"))
    .map(async (name) => ({
      name,
      modifiedAt: (await stat(join(buildInfoDirectory, name))).mtimeMs,
    })),
);
buildInfoFiles.sort((left, right) => right.modifiedAt - left.modifiedAt);

async function sourceClosureMatches(buildInfo) {
  for (const [sourceName, sourceInput] of Object.entries(buildInfo.input?.sources ?? {})) {
    const sourcePath = sourceName.startsWith("contracts/")
      ? join(repositoryRoot, sourceName)
      : join(repositoryRoot, "node_modules", sourceName);
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
for (const { name } of buildInfoFiles) {
  const buildInfo = JSON.parse(await readFile(join(buildInfoDirectory, name), "utf8"));
  if (!await sourceClosureMatches(buildInfo)) continue;
  const targetPaths = [];
  for (const [file, source] of productionSources) {
    const path = relative(repositoryRoot, file).replaceAll("\\", "/");
    if (
      !assignments.has(path) &&
      buildInfo.input?.sources?.[path]?.content === source &&
      buildInfo.output?.sources?.[path]?.ast
    ) {
      assignments.set(path, name);
      targetPaths.push(path);
    }
  }
  if (targetPaths.length > 0) {
    const count = assertCompiledPrivacyDecryptBoundary(buildInfo.output.sources, targetPaths);
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
const plaintextCount = [...assignments.entries()]
  .filter(([key]) => key.endsWith(":plaintext-count"))
  .reduce((total, [, count]) => total + Number(count), 0);
if (plaintextCount !== 1) {
  throw new Error(`Expected exactly one reviewed plaintext route-index decryption, found ${plaintextCount}`);
}

console.log(`Privacy boundary checks passed for ${files.length} Solidity files using fresh compiler ASTs.`);
