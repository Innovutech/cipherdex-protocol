import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

const MAX_PUBLIC_JSON_BYTES = 10_000_000;

function assertRealDirectory(path) {
  const resolved = resolve(path);
  const stat = lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("public output parent must be a real directory");
  }
  const canonical = realpathSync(resolved);
  if (canonical !== resolved || realpathSync(dirname(resolved)) !== dirname(canonical)) {
    throw new Error("public output parent must not traverse a link");
  }
  return canonical;
}

function assertSingleLinkFile(path, label) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error(`${label} must be a single-link regular file`);
  }
  return stat;
}

function openNoFollow(path, flags, mode) {
  return openSync(path, flags | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW), mode);
}

function descriptorStillMatches(path, descriptor, label) {
  const file = assertSingleLinkFile(path, label);
  const opened = fstatSync(descriptor);
  if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== file.dev || opened.ino !== file.ino) {
    throw new Error(`${label} changed while it was being processed`);
  }
  return opened;
}

function readBoundedJsonSource(path) {
  const source = resolve(path);
  assertSingleLinkFile(source, "reviewed public output source");
  const descriptor = openNoFollow(source, constants.O_RDONLY);
  try {
    const stat = descriptorStillMatches(source, descriptor, "reviewed public output source");
    if (stat.size <= 0 || stat.size > MAX_PUBLIC_JSON_BYTES) {
      throw new Error("reviewed public output has an invalid size");
    }
    const contents = readFileSync(descriptor);
    descriptorStillMatches(source, descriptor, "reviewed public output source");
    JSON.parse(contents.toString("utf8"));
    return contents;
  } finally {
    closeSync(descriptor);
  }
}

function syncDirectory(path) {
  if (process.platform === "win32") return;
  const descriptor = openNoFollow(path, constants.O_RDONLY);
  try {
    if (!fstatSync(descriptor).isDirectory()) {
      throw new Error("public output parent changed before synchronization");
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function publishReviewedJson(sourcePath, destinationPath) {
  const contents = readBoundedJsonSource(sourcePath);
  const destination = resolve(destinationPath);
  const directory = assertRealDirectory(dirname(destination));
  if (directory !== dirname(destination)) throw new Error("public output escaped its parent");
  if (existsSync(destination)) assertSingleLinkFile(destination, "public output target");

  const temporary = resolve(
    directory,
    `.${createHash("sha256").update(destination).digest("hex")}.${process.pid}.` +
      `${randomBytes(16).toString("hex")}.tmp`,
  );
  let descriptor;
  try {
    descriptor = openNoFollow(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error("public output temporary path is not a single-link regular file");
    }
    writeFileSync(descriptor, contents);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;

    assertRealDirectory(directory);
    if (existsSync(destination)) assertSingleLinkFile(destination, "public output target");
    renameSync(temporary, destination);
    syncDirectory(directory);

    const readback = openNoFollow(destination, constants.O_RDONLY);
    try {
      descriptorStillMatches(destination, readback, "published output");
      if (!readFileSync(readback).equals(contents)) {
        throw new Error("published output read-back verification failed");
      }
      descriptorStillMatches(destination, readback, "published output");
    } finally {
      closeSync(readback);
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
