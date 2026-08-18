import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import {
  acquireProcessLease,
  appendUtf8RecordIfUnchanged,
  readLatestUtf8Record,
} from "./durable-append-log.mjs";
import { restrictPrivateDirectory } from "./private-filesystem.mjs";

const SIGNER_STATE_SCHEMA = "cipherdex.signer-transaction-state/v1";
const LEASE_ENV = "CIPHERDEX_ACTIVE_SIGNER_LEASES";
const TRANSACTION_STATUSES = new Set([
  "prepared",
  "broadcast",
  "outcome-unknown",
  "mined-success",
  "mined-failure",
]);
const TERMINAL_TRANSACTION_STATUSES = new Set(["mined-success", "mined-failure"]);
const MAX_RETAINED_TERMINAL_TRANSACTIONS = 256;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function coordinatorRoot() {
  const root = resolve(
    process.env.CIPHERDEX_COORDINATOR_ROOT ?? resolve(homedir(), ".cipherdex", "coordinator"),
  );
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(root) !== root) {
    throw new Error("CipherDEX coordinator root must be a real private directory");
  }
  return restrictPrivateDirectory(root);
}

function signerKey(chainId, signer) {
  if (!Number.isSafeInteger(chainId) || chainId <= 0 || !/^0x[0-9a-f]{40}$/i.test(signer)) {
    throw new Error("invalid signer lease identity");
  }
  return `${chainId}-${signer.toLowerCase()}`;
}

function parseSignerState(raw, chainId, signer) {
  if (raw === undefined) {
    return {
      schema: SIGNER_STATE_SCHEMA,
      chainId,
      signer: signer.toLowerCase(),
      transactions: [],
    };
  }
  const value = JSON.parse(raw);
  if (
    value?.schema !== SIGNER_STATE_SCHEMA ||
    value.chainId !== chainId ||
    value.signer !== signer.toLowerCase() ||
    !Array.isArray(value.transactions)
  ) throw new Error("signer transaction state identity is invalid");
  for (const transaction of value.transactions) {
    if (
      typeof transaction?.hash !== "string" ||
      !/^0x[0-9a-f]{64}$/i.test(transaction.hash) ||
      !Number.isSafeInteger(transaction.nonce) ||
      transaction.nonce < 0 ||
      !TRANSACTION_STATUSES.has(transaction.status) ||
      (
        transaction.blockNumber !== undefined &&
        (!Number.isSafeInteger(transaction.blockNumber) || transaction.blockNumber <= 0)
      ) ||
      typeof transaction.updatedAt !== "string"
    ) throw new Error("signer transaction state entry is invalid");
  }
  return value;
}

function compactSignerState(state) {
  const nonterminal = state.transactions.filter(
    (transaction) => !TERMINAL_TRANSACTION_STATUSES.has(transaction.status),
  );
  const terminal = state.transactions
    .filter((transaction) => TERMINAL_TRANSACTION_STATUSES.has(transaction.status))
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
    .slice(-MAX_RETAINED_TERMINAL_TRANSACTIONS);
  state.transactions = [...terminal, ...nonterminal];
  return state;
}

function signerPaths(chainId, signer) {
  const key = signerKey(chainId, signer);
  const root = coordinatorRoot();
  return Object.freeze({
    leasePath: resolve(root, `${key}.lease`),
    statePath: resolve(root, `${key}.journal`),
  });
}

function repositoryLeasePath(repositoryRoot) {
  const canonical = realpathSync(resolve(repositoryRoot));
  return resolve(coordinatorRoot(), `repository-${sha256(canonical.toLowerCase())}.lease`);
}

export function acquireRepositoryExecutionLease(repositoryRoot) {
  const canonical = realpathSync(resolve(repositoryRoot));
  return acquireProcessLease(repositoryLeasePath(canonical), `repository:${canonical}`);
}

export function acquireSignerExecutionLeases(chainId, signers) {
  const unique = [...new Set(signers.map((signer) => signer.toLowerCase()))].sort();
  const leases = [];
  try {
    for (const signer of unique) {
      const paths = signerPaths(chainId, signer);
      const lease = acquireProcessLease(paths.leasePath, `signer:${signerKey(chainId, signer)}`);
      leases.push(Object.freeze({
        chainId,
        signer,
        leasePath: lease.path,
        statePath: paths.statePath,
        token: lease.token,
        release: lease.release,
      }));
    }
  } catch (error) {
    for (const lease of leases.reverse()) lease.release();
    throw error;
  }
  return Object.freeze(leases);
}

export function signerLeaseEnvironment(leases) {
  return JSON.stringify(leases.map(({ chainId, signer, leasePath, statePath, token }) => ({
    chainId,
    signer,
    leasePath,
    statePath,
    token,
  })));
}

function activeLeaseFor(chainId, signer) {
  const raw = process.env[LEASE_ENV];
  if (!raw) throw new Error("funded signer operation lacks its parent execution lease");
  const entries = JSON.parse(raw);
  if (!Array.isArray(entries)) throw new Error("funded signer lease environment is invalid");
  const entry = entries.find((candidate) =>
    candidate?.chainId === chainId && candidate?.signer === signer.toLowerCase()
  );
  if (
    !entry ||
    typeof entry.leasePath !== "string" ||
    typeof entry.statePath !== "string" ||
    typeof entry.token !== "string"
  ) throw new Error("funded signer is not covered by an execution lease");
  if (!existsSync(entry.leasePath)) throw new Error("funded signer execution lease disappeared");
  const lease = JSON.parse(readFileSync(entry.leasePath, "utf8"));
  if (lease?.token !== entry.token || lease?.scope !== `signer:${signerKey(chainId, signer)}`) {
    throw new Error("funded signer execution lease ownership changed");
  }
  return entry;
}

function updateSignerState(chainId, signer, mutate) {
  const lease = activeLeaseFor(chainId, signer);
  const currentRaw = readLatestUtf8Record(lease.statePath);
  const current = parseSignerState(currentRaw, chainId, signer);
  const next = compactSignerState(mutate(structuredClone(current)));
  const nextRaw = `${JSON.stringify(next)}\n`;
  appendUtf8RecordIfUnchanged(lease.statePath, currentRaw, nextRaw);
}

function updateSignerStateForLease(lease, mutate) {
  const currentRaw = readLatestUtf8Record(lease.statePath);
  const current = parseSignerState(currentRaw, lease.chainId, lease.signer);
  const next = compactSignerState(mutate(structuredClone(current)));
  appendUtf8RecordIfUnchanged(lease.statePath, currentRaw, `${JSON.stringify(next)}\n`);
}

export async function reconcileSignerExecutionLeases(leases, inspectTransaction) {
  for (const lease of leases) {
    const state = parseSignerState(
      readLatestUtf8Record(lease.statePath),
      lease.chainId,
      lease.signer,
    );
    for (const transaction of state.transactions) {
      if (transaction.status === "mined-success" || transaction.status === "mined-failure") {
        continue;
      }
      const inspection = await inspectTransaction(lease, transaction);
      if (inspection?.state !== "confirmed") {
        throw new Error(
          `funded signer ${lease.signer} has unresolved transaction ${transaction.hash}; ` +
            "reconcile or identically rebroadcast it before another funded run",
        );
      }
      if (inspection.status !== 0 && inspection.status !== 1) {
        throw new Error("funded signer transaction confirmation status is invalid");
      }
      const status = inspection.status === 1 ? "mined-success" : "mined-failure";
      updateSignerStateForLease(lease, (next) => {
        const entry = next.transactions.find((candidate) =>
          candidate.hash.toLowerCase() === transaction.hash.toLowerCase()
        );
        if (!entry) throw new Error("signer transaction disappeared during reconciliation");
        entry.status = status;
        entry.blockNumber = inspection.blockNumber;
        entry.updatedAt = new Date().toISOString();
        return next;
      });
    }
  }
}

export function recordPreparedSignerTransaction(input) {
  const signer = input.signer.toLowerCase();
  updateSignerState(input.chainId, signer, (state) => {
    const existing = state.transactions.find((entry) => entry.hash.toLowerCase() === input.hash.toLowerCase());
    if (existing) {
      if (existing.nonce !== input.nonce) {
        throw new Error("prepared signer transaction identity changed");
      }
      return state;
    }
    if (state.transactions.some((entry) =>
      entry.nonce === input.nonce &&
      entry.status !== "mined-success" &&
      entry.status !== "mined-failure"
    )) throw new Error("funded signer nonce is already reserved by another transaction");
    state.transactions.push({
      hash: input.hash.toLowerCase(),
      nonce: input.nonce,
      status: "prepared",
      updatedAt: new Date().toISOString(),
    });
    return state;
  });
}

export function recordSignerTransactionStatus(chainId, signer, hash, status, blockNumber) {
  if (!TRANSACTION_STATUSES.has(status)) {
    throw new Error("invalid funded signer transaction status");
  }
  updateSignerState(chainId, signer.toLowerCase(), (state) => {
    const transaction = state.transactions.find((entry) => entry.hash.toLowerCase() === hash.toLowerCase());
    if (!transaction) throw new Error("signer transaction status lacks a prepared record");
    if (
      TERMINAL_TRANSACTION_STATUSES.has(transaction.status) &&
      transaction.status !== status
    ) throw new Error("terminal funded signer transaction status cannot change");
    transaction.status = status;
    transaction.updatedAt = new Date().toISOString();
    if (blockNumber !== undefined) transaction.blockNumber = blockNumber;
    return state;
  });
}

export function readSignerTransactionState(chainId, signer) {
  const paths = signerPaths(chainId, signer);
  return parseSignerState(readLatestUtf8Record(paths.statePath), chainId, signer);
}

export const ACTIVE_SIGNER_LEASES_ENVIRONMENT = LEASE_ENV;
