import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import {
  restrictPrivateDirectory,
  restrictPrivateFile,
} from "./private-filesystem.mjs";

const LOG_SCHEMA = "cipherdex.durable-append-log/v1";
const LEASE_SCHEMA = "cipherdex.process-lease/v1";
const MAX_LOG_BYTES = 64 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const MAX_RECORD_BYTES = Math.ceil((MAX_PAYLOAD_BYTES * 4) / 3) + 4 * 1024;
// A legacy append could cross MAX_LOG_BYTES by one complete record before the
// next read. Accept exactly that bounded condition so it can be checkpointed.
const MAX_RECOVERABLE_LOG_BYTES = MAX_LOG_BYTES + MAX_RECORD_BYTES;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertRealDirectory(path) {
  const resolved = resolve(path);
  mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const stat = lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("durable append-log parent must be a real directory");
  }
  const canonical = realpathSync(resolved);
  if (canonical !== resolved || realpathSync(dirname(resolved)) !== dirname(canonical)) {
    throw new Error("durable append-log parent must not traverse a link");
  }
  return restrictPrivateDirectory(canonical);
}

function assertPrivateRegularFile(path, descriptor) {
  const stat = descriptor === undefined ? lstatSync(path) : fstatSync(descriptor);
  if (!stat.isFile() || stat.isSymbolicLink?.() || stat.nlink !== 1) {
    throw new Error("durable append-log path must be a private regular file");
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error("durable append-log path permissions are too broad");
  }
}

function assertDescriptorMatchesPrivatePath(path, descriptor) {
  assertPrivateRegularFile(path, descriptor);
  const pathStat = lstatSync(path);
  const descriptorStat = fstatSync(descriptor);
  if (descriptorStat.dev !== pathStat.dev || descriptorStat.ino !== pathStat.ino) {
    throw new Error("durable append-log descriptor no longer identifies its path");
  }
  assertPrivateRegularFile(path);
}

function restrictAndAssertPrivateRegularFile(path, descriptor) {
  if (descriptor !== undefined) assertPrivateRegularFile(path, descriptor);
  const canonical = restrictPrivateFile(path);
  if (descriptor !== undefined) {
    assertDescriptorMatchesPrivatePath(canonical, descriptor);
  } else {
    assertPrivateRegularFile(canonical);
  }
  return canonical;
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function parseLease(raw) {
  const value = JSON.parse(raw);
  if (
    value?.schema !== LEASE_SCHEMA ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.token !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.token) ||
    typeof value.scope !== "string" ||
    value.scope.length === 0 ||
    typeof value.createdAt !== "string"
  ) throw new Error("process lease is invalid");
  return value;
}

export function acquireProcessLease(path, scope) {
  if (typeof scope !== "string" || scope.length === 0) {
    throw new Error("process lease scope is required");
  }
  const leasePath = resolve(path);
  const directory = assertRealDirectory(dirname(leasePath));
  if (directory !== dirname(leasePath)) throw new Error("process lease escaped its parent");
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const token = randomBytes(32).toString("hex");
    let descriptor;
    try {
      descriptor = openSync(
        leasePath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
        0o600,
      );
      restrictAndAssertPrivateRegularFile(leasePath, descriptor);
      const record = `${JSON.stringify({
        schema: LEASE_SCHEMA,
        pid: process.pid,
        token,
        scope,
        createdAt: new Date().toISOString(),
      })}\n`;
      writeFileSync(descriptor, record, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;

      let released = false;
      return Object.freeze({
        path: leasePath,
        token,
        release() {
          if (released) return;
          released = true;
          if (!existsSync(leasePath)) return;
          restrictAndAssertPrivateRegularFile(leasePath);
          const current = parseLease(readFileSync(leasePath, "utf8"));
          if (current.pid !== process.pid || current.token !== token || current.scope !== scope) {
            throw new Error("process lease ownership changed before release");
          }
          unlinkSync(leasePath);
        },
      });
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      if (error?.code !== "EEXIST") throw error;
      restrictAndAssertPrivateRegularFile(leasePath);
      const existingRaw = readFileSync(leasePath, "utf8");
      const existing = parseLease(existingRaw);
      if (processIsAlive(existing.pid)) {
        throw new Error(`process lease is held by live pid ${existing.pid} for ${existing.scope}`);
      }
      const quarantine = `${leasePath}.stale.${existing.token}.${randomBytes(8).toString("hex")}`;
      try {
        renameSync(leasePath, quarantine);
        unlinkSync(quarantine);
      } catch (reclaimError) {
        if (reclaimError?.code !== "ENOENT") throw reclaimError;
      }
    }
  }
  throw new Error("unable to acquire process lease after stale-owner recovery");
}

function parseLog(raw) {
  if (Buffer.byteLength(raw, "utf8") > MAX_RECOVERABLE_LOG_BYTES) {
    throw new Error("durable append log is too large");
  }
  const hasCompleteTail = raw.endsWith("\n");
  const lines = raw.split("\n");
  if (!hasCompleteTail) lines.pop();
  let latest;
  let previousDigest = "0".repeat(64);
  let sequence = 0;
  for (const line of lines) {
    if (line.length === 0) continue;
    if (Buffer.byteLength(line, "utf8") > MAX_RECORD_BYTES) {
      throw new Error("durable append-log record is too large");
    }
    const record = JSON.parse(line);
    const checkpoint = record?.compactedFrom;
    if (
      record?.schema !== LOG_SCHEMA ||
      record.sequence !== sequence ||
      record.previousDigest !== previousDigest ||
      typeof record.payload !== "string" ||
      typeof record.payloadSha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(record.payloadSha256) ||
      (
        checkpoint !== undefined &&
        (
          sequence !== 0 ||
          previousDigest !== "0".repeat(64) ||
          !Number.isSafeInteger(checkpoint?.sequence) ||
          checkpoint.sequence <= 0 ||
          typeof checkpoint.digest !== "string" ||
          !/^[0-9a-f]{64}$/.test(checkpoint.digest)
        )
      )
    ) throw new Error("durable append-log hash chain is invalid");
    const payload = Buffer.from(record.payload, "base64");
    if (
      payload.length > MAX_PAYLOAD_BYTES ||
      payload.toString("base64") !== record.payload ||
      sha256(payload) !== record.payloadSha256
    ) {
      throw new Error("durable append-log payload authentication failed");
    }
    previousDigest = sha256(Buffer.from(line, "utf8"));
    latest = payload.toString("utf8");
    sequence += 1;
  }
  return Object.freeze({ latest, previousDigest, sequence });
}

function encodeRecord(sequence, previousDigest, contents, compactedFrom) {
  const payload = Buffer.from(contents, "utf8");
  const record = {
    schema: LOG_SCHEMA,
    sequence,
    previousDigest,
    payload: payload.toString("base64"),
    payloadSha256: sha256(payload),
    ...(compactedFrom === undefined ? {} : { compactedFrom }),
  };
  const encoded = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  if (encoded.length > MAX_RECORD_BYTES) {
    throw new Error("durable append-log record is too large");
  }
  return encoded;
}

function replaceWithCheckpoint(targetPath, directory, encoded) {
  const checkpointPath = `${targetPath}.checkpoint.${randomBytes(16).toString("hex")}`;
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  let descriptor;
  try {
    descriptor = openSync(
      checkpointPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600,
    );
    restrictAndAssertPrivateRegularFile(checkpointPath, descriptor);
    writeFileSync(descriptor, encoded);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(checkpointPath, targetPath);
    restrictAndAssertPrivateRegularFile(targetPath);

    if (process.platform !== "win32") {
      const directoryDescriptor = openSync(directory, constants.O_RDONLY);
      try {
        fsyncSync(directoryDescriptor);
      } finally {
        closeSync(directoryDescriptor);
      }
    }
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(checkpointPath)) unlinkSync(checkpointPath);
    throw error;
  }
}

export function readLatestUtf8Record(path) {
  const targetPath = resolve(path);
  if (!existsSync(targetPath)) return undefined;
  restrictAndAssertPrivateRegularFile(targetPath);
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const descriptor = openSync(targetPath, constants.O_RDONLY | noFollow);
  try {
    assertDescriptorMatchesPrivatePath(targetPath, descriptor);
    return parseLog(readFileSync(descriptor, "utf8")).latest;
  } finally {
    closeSync(descriptor);
  }
}

export function appendUtf8RecordIfUnchanged(path, expectedContents, contents) {
  if (typeof contents !== "string" || Buffer.byteLength(contents, "utf8") > MAX_PAYLOAD_BYTES) {
    throw new Error("durable append-log payload is invalid");
  }
  const targetPath = resolve(path);
  const directory = assertRealDirectory(dirname(targetPath));
  if (directory !== dirname(targetPath)) throw new Error("durable append log escaped its parent");
  const lease = acquireProcessLease(`${targetPath}.lease`, `append:${targetPath}`);
  try {
    const targetExists = existsSync(targetPath);
    if (targetExists) restrictAndAssertPrivateRegularFile(targetPath);
    const currentRaw = targetExists ? readFileSync(targetPath, "utf8") : "";
    const current = parseLog(currentRaw);
    if (current.latest !== expectedContents) {
      throw new Error("durable append log changed since it was read");
    }
    const encoded = encodeRecord(current.sequence, current.previousDigest, contents);
    if (Buffer.byteLength(currentRaw, "utf8") + encoded.length > MAX_LOG_BYTES) {
      const checkpoint = encodeRecord(0, "0".repeat(64), contents, {
        sequence: current.sequence,
        digest: current.previousDigest,
      });
      replaceWithCheckpoint(targetPath, directory, checkpoint);
      if (readLatestUtf8Record(targetPath) !== contents) {
        throw new Error("durable append-log checkpoint could not be verified");
      }
      return;
    }
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    const descriptor = openSync(
      targetPath,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | noFollow,
      0o600,
    );
    try {
      if (targetExists) assertDescriptorMatchesPrivatePath(targetPath, descriptor);
      else restrictAndAssertPrivateRegularFile(targetPath, descriptor);
      writeFileSync(descriptor, encoded);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    if (readLatestUtf8Record(targetPath) !== contents) {
      throw new Error("durable append-log commit could not be verified");
    }
  } finally {
    lease.release();
  }
}
