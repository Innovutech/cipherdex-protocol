import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

import { appendUtf8RecordIfUnchanged, readLatestUtf8Record } from "./durable-append-log.mjs";
import { assertPrivateTree, restrictPrivateDirectory } from "./private-filesystem.mjs";

const SCHEMA = "cipherdex.reviewed-build-receipt/v2";

function digestFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function digestTree(root) {
  if (!existsSync(root)) throw new Error(`reviewed build path is missing: ${root}`);
  const hash = createHash("sha256");
  const visit = (path) => {
    const stat = lstatSync(path);
    const name = relative(root, path).replaceAll("\\", "/") || ".";
    if (stat.isSymbolicLink()) {
      throw new Error(`reviewed build contains a link or reparse point: ${name}`);
    }
    if (stat.isDirectory()) {
      hash.update(`D\0${name}\0`);
      for (const entry of readdirSync(path).sort()) visit(resolve(path, entry));
      return;
    }
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error(`reviewed build contains a non-single-link file: ${name}`);
    }
    hash.update(`F\0${name}\0${stat.size}\0`);
    hash.update(readFileSync(path));
  };
  visit(root);
  return hash.digest("hex");
}

function normalizedTrackedFiles(files) {
  return [...new Set(files ?? [])].map((file) => file.replaceAll("\\", "/")).sort();
}

function digestTrackedSource(repositoryRoot, trackedFiles) {
  const hash = createHash("sha256");
  for (const file of normalizedTrackedFiles(trackedFiles)) {
    if (!file || isAbsolute(file) || file.split("/").includes("..")) {
      throw new Error("reviewed source inventory contains an unsafe path");
    }
    const path = resolve(repositoryRoot, file);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error(`reviewed source inventory contains a non-single-link file: ${file}`);
    }
    hash.update(`F\0${file}\0${stat.size}\0`);
    hash.update(readFileSync(path));
  }
  return hash.digest("hex");
}

function receiptPath(repositoryRoot, configuredRoot) {
  const key = createHash("sha256").update(resolve(repositoryRoot).toLowerCase()).digest("hex");
  const directory = resolve(
    configuredRoot ??
      process.env.CIPHERDEX_BUILD_RECEIPT_ROOT ??
      resolve(homedir(), ".cipherdex", "reviewed-builds"),
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return resolve(restrictPrivateDirectory(directory), `${key}.journal`);
}

function currentMeasurement(repositoryRoot, sourceCommit, trackedFiles = []) {
  assertPrivateTree(repositoryRoot);
  return Object.freeze({
    schema: SCHEMA,
    sourceCommit: sourceCommit.toLowerCase(),
    sourceTreeSha256: digestTrackedSource(repositoryRoot, trackedFiles),
    packageLockSha256: digestFile(resolve(repositoryRoot, "package-lock.json")),
    nodeModulesSha256: digestTree(resolve(repositoryRoot, "node_modules")),
    artifactsSha256: digestTree(resolve(repositoryRoot, "artifacts")),
    typechainSha256: digestTree(resolve(repositoryRoot, "typechain-types")),
  });
}

export function recordReviewedBuild(repositoryRoot, sourceCommit, options = {}) {
  const path = receiptPath(repositoryRoot, options.receiptRoot);
  const previous = readLatestUtf8Record(path);
  const receipt = {
    ...currentMeasurement(repositoryRoot, sourceCommit, options.trackedFiles),
    preparedAt: new Date().toISOString(),
  };
  appendUtf8RecordIfUnchanged(path, previous, `${JSON.stringify(receipt)}\n`);
  return Object.freeze(receipt);
}

export function verifyReviewedBuild(repositoryRoot, sourceCommit, options = {}) {
  const raw = readLatestUtf8Record(receiptPath(repositoryRoot, options.receiptRoot));
  if (raw === undefined) throw new Error("funded runtime has no operator-reviewed build receipt");
  const receipt = JSON.parse(raw);
  const measured = currentMeasurement(repositoryRoot, sourceCommit, options.trackedFiles);
  for (const [key, value] of Object.entries(measured)) {
    if (receipt?.[key] !== value) {
      throw new Error(`funded runtime reviewed build mismatch for ${key}`);
    }
  }
  return Object.freeze(receipt);
}
