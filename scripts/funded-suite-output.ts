import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

const SOURCE_COMMIT = /^[0-9a-f]{40}$/u;

function requireRealDirectory(path: string, label: string): string {
  const resolved = resolve(path);
  const stat = lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
  return realpathSync(resolved);
}

export function fundedSuiteOutputPath(
  publicRepositoryRoot: string,
  sourceCommit: string,
): string {
  if (!isAbsolute(publicRepositoryRoot)) {
    throw new Error("funded suite public repository root must be absolute");
  }
  if (!SOURCE_COMMIT.test(sourceCommit)) {
    throw new Error("funded suite source commit is invalid");
  }
  const repository = requireRealDirectory(
    publicRepositoryRoot,
    "funded suite public repository root",
  );
  const evidence = requireRealDirectory(
    resolve(repository, "evidence"),
    "funded suite evidence root",
  );
  return resolve(evidence, `coti-testnet-${sourceCommit}.json`);
}
