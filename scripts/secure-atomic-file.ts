import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";

function assertRealDirectory(path: string): string {
  const resolved = resolve(path);
  const stat = lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("secure atomic file parent must be a real directory");
  }
  const canonical = realpathSync(resolved);
  if (canonical !== resolved || realpathSync(dirname(resolved)) !== dirname(canonical)) {
    throw new Error("secure atomic file parent must not traverse a link");
  }
  return canonical;
}

function assertReplaceableTarget(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("secure atomic file target must be a regular file");
  }
}

function syncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const descriptor = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(descriptor).isDirectory()) {
      throw new Error("secure atomic file parent changed before directory sync");
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeUtf8FileAtomicInternal(path: string, contents: string): void {
  const targetPath = resolve(path);
  const directory = assertRealDirectory(dirname(targetPath));
  if (directory !== dirname(targetPath)) {
    throw new Error("secure atomic file target escaped its canonical parent");
  }
  assertReplaceableTarget(targetPath);

  const temporaryPath = `${targetPath}.${process.pid}.${randomBytes(16).toString("hex")}.tmp`;
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600,
    );
    const temporaryStat = fstatSync(descriptor);
    if (!temporaryStat.isFile() || temporaryStat.nlink !== 1) {
      throw new Error("secure atomic temporary path is not a private regular file");
    }
    writeFileSync(descriptor, contents, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;

    assertRealDirectory(directory);
    assertReplaceableTarget(targetPath);
    renameSync(temporaryPath, targetPath);
    syncDirectory(directory);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

export function writeUtf8FileAtomic(path: string, contents: string): void {
  writeUtf8FileAtomicInternal(path, contents);
}
