import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const expectedDirectory = join(repository, "sdk", "dist");
const temporaryDirectory = mkdtempSync(join(tmpdir(), "cipherdex-sdk-"));
const compiler = realpathSync(join(
  repository,
  "node_modules",
  "typescript",
  "bin",
  "tsc",
));
const expectedCompilerRoot = realpathSync(join(
  repository,
  "node_modules",
  "typescript",
));
if (!compiler.startsWith(`${expectedCompilerRoot}${sep}`)) {
  throw new Error("SDK distribution check resolved an untrusted TypeScript compiler");
}

function files(directory, root = directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return files(path, root);
    if (!entry.isFile()) return [];
    return [relative(root, path).replaceAll("\\", "/")];
  }).sort();
}

try {
  execFileSync(process.execPath, [
    compiler,
    "-p",
    join(repository, "sdk", "tsconfig.build.json"),
    "--outDir",
    temporaryDirectory,
  ], {
    cwd: repository,
    env: {
      PATH: process.env.PATH ?? "",
      SystemRoot: process.env.SystemRoot ?? "",
    },
    stdio: "inherit",
    windowsHide: true,
  });

  const expectedFiles = files(expectedDirectory);
  const generatedFiles = files(temporaryDirectory);
  if (JSON.stringify(expectedFiles) !== JSON.stringify(generatedFiles)) {
    throw new Error("SDK distribution file set is stale; run npm run build:sdk");
  }
  for (const file of generatedFiles) {
    const expected = readFileSync(join(expectedDirectory, file));
    const generated = readFileSync(join(temporaryDirectory, file));
    if (!expected.equals(generated)) {
      throw new Error(`SDK distribution is stale: ${file}; run npm run build:sdk`);
    }
  }
  console.log(`SDK distribution matches ${generatedFiles.length} generated files.`);
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
