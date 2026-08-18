import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export function resolveHardhatCli(executionRoot) {
  const require = createRequire(resolve(executionRoot, "package.json"));
  const packageJsonCandidate = require.resolve("hardhat/package.json");
  const packageJsonStat = lstatSync(packageJsonCandidate);
  if (!packageJsonStat.isFile() || packageJsonStat.isSymbolicLink() || packageJsonStat.nlink !== 1) {
    throw new Error("Hardhat package manifest must be a single-link regular file");
  }

  const packageJsonPath = realpathSync(packageJsonCandidate);
  const packageRoot = realpathSync(dirname(packageJsonPath));
  const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const declaredBin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.hardhat;
  if (manifest.name !== "hardhat" || typeof declaredBin !== "string" || declaredBin.length === 0) {
    throw new Error("Hardhat package does not declare its CLI entry point");
  }

  const cliCandidate = resolve(packageRoot, declaredBin);
  const cliStat = lstatSync(cliCandidate);
  if (!cliStat.isFile() || cliStat.isSymbolicLink() || cliStat.nlink !== 1) {
    throw new Error("Hardhat CLI must be a single-link regular file");
  }
  const cliPath = realpathSync(cliCandidate);
  const fromPackage = relative(packageRoot, cliPath);
  if (fromPackage === "" || fromPackage.startsWith("..") || isAbsolute(fromPackage)) {
    throw new Error("Hardhat CLI resolves outside its authenticated package");
  }
  return cliPath;
}
