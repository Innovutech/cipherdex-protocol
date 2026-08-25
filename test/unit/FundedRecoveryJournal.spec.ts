import { expect } from "chai";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  linkSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Interface, Transaction, Wallet, keccak256, type Provider } from "ethers";
import { ethers } from "../../hardhat/runtime.js";

import {
  FundedRecoveryJournal,
  verifyRecoveryResourceCreation,
  verifyRecoveryResourceTerminalState,
} from "../../scripts/funded-recovery-journal";
import { validateFundedDeploymentBinding } from "../../scripts/funded-deployment-binding";
import {
  deriveFundedRecoveryKeyFromSecret,
  FundedWallet,
  openFundedRecoveryJournal,
  sendPreparedFundedTransaction,
  withFundedTransactionEvidence,
} from "../../scripts/funded-transaction-wallet";
import { requiredFundedRecoveryDirectory } from "../../scripts/funded-runtime-state";
import {
  ACTIVE_SIGNER_LEASES_ENVIRONMENT,
  acquireSignerExecutionLeases,
  assertSoleRecoverableSignerTransaction,
  readSignerTransactionState,
  reconcileSignerExecutionLeases,
  recordPreparedSignerTransactionAbandoned,
  recordPreparedSignerTransaction,
  recordSignerTransactionStatus,
  signerLeaseEnvironment,
} from "../../scripts/funded-process-coordinator.mjs";
import {
  acquireProcessLease,
  appendUtf8RecordIfUnchanged,
  readLatestUtf8Record,
} from "../../scripts/durable-append-log.mjs";
import { setRecoverablePrivateAllowance } from "../../scripts/funded-private-allowance";
import {
  recordReviewedBuild,
  verifyReviewedBuild,
} from "../../scripts/reviewed-build-receipt.mjs";
import {
  assertPrivateFile,
  readPrivateEnvironmentFile,
  restrictPrivateDirectory,
  restrictPrivateFile,
} from "../../scripts/private-filesystem.mjs";
import { inspectFundedTransaction } from "../../scripts/funded-rpc-confirmation.mjs";
import { publishReviewedJson } from "../../scripts/secure-publication.mjs";

const COMMIT = "a".repeat(40);
const RECOVERY_KEY = `0x${"dd".repeat(32)}`;
const TEST_SIGNER = new Wallet(`0x${"11".repeat(32)}`);
const OWNER = TEST_SIGNER.address;
const RESOURCE = `0x${"22".repeat(20)}`;
const RAW1 = await TEST_SIGNER.signTransaction({
  chainId: 7_082_400,
  nonce: 1,
  to: RESOURCE,
  value: 1n,
  gasLimit: 21_000n,
  gasPrice: 1n,
  type: 0,
});
const RAW2 = await TEST_SIGNER.signTransaction({
  chainId: 7_082_400,
  nonce: 2,
  to: RESOURCE,
  value: 2n,
  gasLimit: 21_000n,
  gasPrice: 1n,
  type: 0,
});
const TX1 = keccak256(RAW1);
const TX2 = keccak256(RAW2);
const TX3 = keccak256("0x03");
const TOKEN0 = `0x${"88".repeat(20)}`;
const TOKEN1 = `0x${"99".repeat(20)}`;
const STRATEGY = `0x${"aa".repeat(20)}`;
const MIGRATOR = `0x${"bb".repeat(20)}`;
const DEPLOYMENT = Object.freeze({
  recordPath: `deployments/coti-testnet-${COMMIT}.json`,
  recordSha256: "b".repeat(64),
  manifestCommit: "c".repeat(40),
  sourceCommit: COMMIT,
});

function grantAuthenticatedUsersModify(path: string): void {
  const result = spawnSync(
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-Command",
      [
        "$ErrorActionPreference='Stop'",
        "$path=$env:CIPHERDEX_TEST_PRIVATE_PATH",
        "$acl=[System.IO.File]::GetAccessControl($path)",
        "$sid=New-Object System.Security.Principal.SecurityIdentifier('S-1-5-11')",
        "$rights=[System.Security.AccessControl.FileSystemRights]::Modify",
        "$allow=[System.Security.AccessControl.AccessControlType]::Allow",
        "$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,$rights,$allow)",
        "$acl.AddAccessRule($rule)",
        "[System.IO.File]::SetAccessControl($path,$acl)",
      ].join("\n"),
    ],
    {
      encoding: "utf8",
      env: { ...process.env, CIPHERDEX_TEST_PRIVATE_PATH: path },
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message ?? result.stderr.trim());
  }
}

describe("funded recovery journal", function () {
  let directory: string;

  beforeEach(function () {
    directory = mkdtempSync(join(tmpdir(), "cipherdex-funded-recovery-"));
  });

  afterEach(function () {
    rmSync(directory, { recursive: true, force: true });
  });

  it("accepts only canonical COTI testnet and mainnet deployment bindings", function () {
    for (const network of ["testnet", "mainnet"]) {
      expect(validateFundedDeploymentBinding({
        ...DEPLOYMENT,
        recordPath: `deployments/coti-${network}-${COMMIT}.json`,
      }).recordPath).to.equal(`deployments/coti-${network}-${COMMIT}.json`);
    }
    expect(() => validateFundedDeploymentBinding({
      ...DEPLOYMENT,
      recordPath: `deployments/coti-staging-${COMMIT}.json`,
    })).to.throw("invalid provenance");
  });

  it("derives a domain-bound recovery key without a signer private key", function () {
    const identity = {
      runner: "deployment",
      sourceCommit: COMMIT,
      chainId: 2_632_500,
      owner: OWNER,
      deployment: DEPLOYMENT,
      directory,
    };
    const first = deriveFundedRecoveryKeyFromSecret(RECOVERY_KEY, identity);
    const second = deriveFundedRecoveryKeyFromSecret(RECOVERY_KEY, identity);
    const otherChain = deriveFundedRecoveryKeyFromSecret(RECOVERY_KEY, {
      ...identity,
      chainId: 7_082_400,
    });
    expect(first.equals(second)).to.equal(true);
    expect(first.equals(otherChain)).to.equal(false);
    expect(() => deriveFundedRecoveryKeyFromSecret("0x12", identity))
      .to.throw("exactly 32 bytes");
  });

  it("recovers dead process leases but never steals a live lease", function () {
    const leases = join(directory, "leases");
    mkdirSync(leases, { recursive: true });
    const path = join(leases, "runner.lease");
    const live = acquireProcessLease(path, "test-live");
    expect(() => acquireProcessLease(path, "test-live")).to.throw("held by live pid");
    live.release();

    writeFileSync(path, `${JSON.stringify({
      schema: "cipherdex.process-lease/v1",
      pid: 2_147_483_647,
      token: "a".repeat(64),
      scope: "test-stale",
      createdAt: new Date().toISOString(),
    })}\n`);
    const recovered = acquireProcessLease(path, "test-recovered");
    recovered.release();
  });

  it("retains the last fsynced append record after an incomplete tail", function () {
    const path = join(directory, "append.journal");
    appendUtf8RecordIfUnchanged(path, undefined, "first");
    appendUtf8RecordIfUnchanged(path, "first", "second");
    writeFileSync(path, `${readFileSync(path, "utf8")}incomplete-tail`, "utf8");
    expect(readLatestUtf8Record(path)).to.equal("second");
  });

  it("atomically checkpoints a legacy log that crossed its former size limit", function () {
    this.timeout(90_000);
    const path = join(directory, "bounded-append.journal");
    const body = "x".repeat(8 * 1024 * 1024);
    const records: string[] = [];
    let previousDigest = "0".repeat(64);
    let previous: string | undefined;
    for (let index = 0; index < 6; index += 1) {
      const next = `${index}:${body}`;
      const payload = Buffer.from(next, "utf8");
      const line = JSON.stringify({
        schema: "cipherdex.durable-append-log/v1",
        sequence: index,
        previousDigest,
        payload: payload.toString("base64"),
        payloadSha256: createHash("sha256").update(payload).digest("hex"),
      });
      records.push(line);
      previousDigest = createHash("sha256").update(line, "utf8").digest("hex");
      previous = next;
    }
    writeFileSync(path, `${records.join("\n")}\n`, "utf8");
    expect(statSync(path).size).to.be.greaterThan(64 * 1024 * 1024);

    const checkpointed = `6:${body}`;
    appendUtf8RecordIfUnchanged(path, previous, checkpointed);

    expect(statSync(path).size).to.be.lessThan(24 * 1024 * 1024);
    expect(readLatestUtf8Record(path)).to.equal(checkpointed);
    expect(() => appendUtf8RecordIfUnchanged(path, "stale", "rejected")).to.throw(
      "durable append log changed since it was read",
    );
  });

  it("repairs and validates Windows child ACLs before reading journals or leases", function () {
    if (process.platform !== "win32") this.skip();
    const path = join(directory, "private-children", "append.journal");
    appendUtf8RecordIfUnchanged(path, undefined, "first");
    grantAuthenticatedUsersModify(path);
    expect(() => assertPrivateFile(path, "read")).to.throw(
      "not restricted to the current identity",
    );
    expect(readLatestUtf8Record(path)).to.equal("first");
    expect(() => assertPrivateFile(path, "read")).not.to.throw();

    const leasePath = join(directory, "private-children", "runner.lease");
    writeFileSync(leasePath, `${JSON.stringify({
      schema: "cipherdex.process-lease/v1",
      pid: 2_147_483_647,
      token: "b".repeat(64),
      scope: "test-stale-acl",
      createdAt: new Date().toISOString(),
    })}\n`, "utf8");
    grantAuthenticatedUsersModify(leasePath);
    const recovered = acquireProcessLease(leasePath, "test-recovered-acl");
    expect(() => assertPrivateFile(leasePath)).not.to.throw();
    recovered.release();
  });

  it("rejects a funded build after any reviewed runtime artifact changes", function () {
    const root = join(directory, "reviewed-build");
    mkdirSync(root);
    restrictPrivateDirectory(root);
    for (const path of ["node_modules", "artifacts", "typechain-types"]) {
      mkdirSync(join(root, path), { recursive: true });
      writeFileSync(join(root, path, "entry"), path, "utf8");
    }
    writeFileSync(join(root, "package-lock.json"), "{}", "utf8");
    const previous = process.env.CIPHERDEX_BUILD_RECEIPT_ROOT;
    process.env.CIPHERDEX_BUILD_RECEIPT_ROOT = join(directory, "build-receipts");
    try {
      recordReviewedBuild(root, COMMIT);
      expect(verifyReviewedBuild(root, COMMIT).sourceCommit).to.equal(COMMIT);
      writeFileSync(join(root, "artifacts", "entry"), "tampered", "utf8");
      expect(() => verifyReviewedBuild(root, COMMIT)).to.throw(
        "reviewed build mismatch for artifactsSha256",
      );
    } finally {
      if (previous === undefined) delete process.env.CIPHERDEX_BUILD_RECEIPT_ROOT;
      else process.env.CIPHERDEX_BUILD_RECEIPT_ROOT = previous;
    }
  });

  it("uses the explicit reviewed-build receipt root for launcher handoff", function () {
    const root = join(directory, "reviewed-build-explicit");
    const receiptRoot = join(directory, "explicit-build-receipts");
    mkdirSync(root);
    restrictPrivateDirectory(root);
    for (const path of ["node_modules", "artifacts", "typechain-types"]) {
      mkdirSync(join(root, path), { recursive: true });
      writeFileSync(join(root, path, "entry"), path, "utf8");
    }
    writeFileSync(join(root, "package-lock.json"), "{}", "utf8");
    const previous = process.env.CIPHERDEX_BUILD_RECEIPT_ROOT;
    process.env.CIPHERDEX_BUILD_RECEIPT_ROOT = join(directory, "wrong-build-receipts");
    try {
      recordReviewedBuild(root, COMMIT, { receiptRoot });
      expect(verifyReviewedBuild(root, COMMIT, { receiptRoot }).sourceCommit).to.equal(COMMIT);
      expect(() => verifyReviewedBuild(root, COMMIT)).to.throw(
        "funded runtime has no operator-reviewed build receipt",
      );
    } finally {
      if (previous === undefined) delete process.env.CIPHERDEX_BUILD_RECEIPT_ROOT;
      else process.env.CIPHERDEX_BUILD_RECEIPT_ROOT = previous;
    }
  });

  it("rejects reviewed build links that escape the measured dependency tree", function () {
    const root = join(directory, "reviewed-build-linked");
    const external = join(directory, "external-package");
    mkdirSync(root);
    restrictPrivateDirectory(root);
    for (const path of ["node_modules", "artifacts", "typechain-types", "external-package"]) {
      mkdirSync(join(directory, path === "external-package" ? path : `reviewed-build-linked/${path}`), {
        recursive: true,
      });
    }
    writeFileSync(join(root, "package-lock.json"), "{}", "utf8");
    writeFileSync(join(external, "entry"), "outside", "utf8");
    symlinkSync(
      external,
      join(root, "node_modules", "linked-package"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const previous = process.env.CIPHERDEX_BUILD_RECEIPT_ROOT;
    process.env.CIPHERDEX_BUILD_RECEIPT_ROOT = join(directory, "build-receipts-linked");
    try {
      expect(() => recordReviewedBuild(root, COMMIT)).to.throw("must not contain links");
    } finally {
      if (previous === undefined) delete process.env.CIPHERDEX_BUILD_RECEIPT_ROOT;
      else process.env.CIPHERDEX_BUILD_RECEIPT_ROOT = previous;
    }
  });

  it("binds a reviewed receipt to the complete private runtime without recording a path", function () {
    const root = join(directory, "reviewed-source");
    mkdirSync(root);
    restrictPrivateDirectory(root);
    for (const path of ["node_modules", "artifacts", "typechain-types", ".git/info"]) {
      mkdirSync(join(root, path), { recursive: true });
    }
    writeFileSync(join(root, "package-lock.json"), "{}", "utf8");
    writeFileSync(join(root, "source.ts"), "export const reviewed = true;\n", "utf8");
    writeFileSync(join(root, "node_modules", "entry"), "dependency", "utf8");
    writeFileSync(join(root, "artifacts", "entry"), "artifact", "utf8");
    writeFileSync(join(root, "typechain-types", "entry"), "typechain", "utf8");
    writeFileSync(join(root, ".git", "HEAD"), `ref: refs/heads/main\n`, "utf8");

    const previousReceiptRoot = process.env.CIPHERDEX_BUILD_RECEIPT_ROOT;
    process.env.CIPHERDEX_BUILD_RECEIPT_ROOT = join(directory, "snapshot-receipts");
    try {
      const trackedFiles = ["package-lock.json", "source.ts"];
      const receipt = recordReviewedBuild(root, COMMIT, { trackedFiles });
      expect(receipt).not.to.have.property("executionSnapshotPath");
      expect(verifyReviewedBuild(root, COMMIT, { trackedFiles }).sourceCommit).to.equal(COMMIT);

      writeFileSync(join(root, "source.ts"), "export const reviewed = false;\n", "utf8");
      expect(() => verifyReviewedBuild(root, COMMIT, { trackedFiles })).to.throw(
        "reviewed build mismatch for sourceTreeSha256",
      );
    } finally {
      if (previousReceiptRoot === undefined) delete process.env.CIPHERDEX_BUILD_RECEIPT_ROOT;
      else process.env.CIPHERDEX_BUILD_RECEIPT_ROOT = previousReceiptRoot;
    }
  });

  it("publishes bounded JSON atomically and rejects a pre-positioned hard-link target", function () {
    const sourceDirectory = join(directory, "private-output");
    const destinationDirectory = join(directory, "public-output");
    mkdirSync(sourceDirectory);
    mkdirSync(destinationDirectory);
    const source = join(sourceDirectory, "evidence.json");
    const destination = join(destinationDirectory, "evidence.json");
    writeFileSync(source, '{"ok":true}\n', "utf8");
    publishReviewedJson(source, destination);
    expect(readFileSync(destination, "utf8")).to.equal('{"ok":true}\n');

    rmSync(destination);
    const outside = join(directory, "outside.json");
    writeFileSync(outside, '{"protected":true}\n', "utf8");
    linkSync(outside, destination);
    expect(() => publishReviewedJson(source, destination)).to.throw(
      "public output target must be a single-link regular file",
    );
    expect(readFileSync(outside, "utf8")).to.equal('{"protected":true}\n');
  });

  it("requires a single-link secret file inside a private real directory", function () {
    const secretDirectory = join(directory, "funded-secrets");
    const secretPath = join(secretDirectory, "testnet.env");
    mkdirSync(secretDirectory, { recursive: true });
    writeFileSync(secretPath, "COTI_TESTNET_PRIVATE_KEY=secret\n", "utf8");
    restrictPrivateDirectory(secretDirectory);
    restrictPrivateFile(secretPath);
    expect(readPrivateEnvironmentFile(secretPath)).to.contain("COTI_TESTNET_PRIVATE_KEY");

    const alias = join(secretDirectory, "alias.env");
    linkSync(secretPath, alias);
    expect(() => readPrivateEnvironmentFile(secretPath)).to.throw(
      "bounded single-link regular file",
    );
  });

  function open(): FundedRecoveryJournal {
    return FundedRecoveryJournal.open({
      runner: "best-execution",
      sourceCommit: COMMIT,
      chainId: 7_082_400,
      owner: OWNER,
      deployment: DEPLOYMENT,
      recoveryKey: RECOVERY_KEY,
      directory,
    });
  }

  async function expectRejected(
    operation: Promise<unknown>,
    message: string,
  ): Promise<void> {
    let error: unknown;
    try {
      await operation;
    } catch (caught) {
      error = caught;
    }
    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.contain(message);
  }

  it("keeps a canonically mined transaction nonterminal until confirmation depth is met", async function () {
    const parsed = Transaction.from(RAW1);
    const blockHash = `0x${"66".repeat(32)}`;
    const result = await inspectFundedTransaction({
      async getNetwork() { return { chainId: 7_082_400n }; },
      async getTransaction() {
        return {
          hash: TX1,
          from: OWNER,
          nonce: parsed.nonce,
          chainId: parsed.chainId,
          blockHash,
          blockNumber: 456,
        };
      },
      async getTransactionReceipt() {
        return { hash: TX1, status: 1, blockHash, blockNumber: 456 };
      },
      async getBlock() { return { hash: blockHash, number: 456 }; },
      async getBlockNumber() { return 456; },
    }, {
      chainId: 7_082_400,
      signer: OWNER,
      nonce: parsed.nonce,
      hash: TX1,
    });
    expect(result).to.deep.equal({
      state: "mined-unconfirmed",
      status: 1,
      blockNumber: 456,
      blockHash,
      confirmations: 1,
    });
  });

  it("rejects mismatched signer and canonical block evidence", async function () {
    const parsed = Transaction.from(RAW1);
    const blockHash = `0x${"77".repeat(32)}`;
    const expected = {
      chainId: 7_082_400,
      signer: OWNER,
      nonce: parsed.nonce,
      hash: TX1,
    };
    const provider = {
      async getNetwork() { return { chainId: 7_082_400n }; },
      async getTransaction() {
        return {
          hash: TX1,
          from: `0x${"55".repeat(20)}`,
          nonce: parsed.nonce,
          chainId: parsed.chainId,
          blockHash,
          blockNumber: 456,
        };
      },
      async getTransactionReceipt() {
        return { hash: TX1, status: 1, blockHash, blockNumber: 456 };
      },
      async getBlock() { return { hash: blockHash, number: 456 }; },
      async getBlockNumber() { return 457; },
    };
    await expectRejected(
      inspectFundedTransaction(provider, expected),
      "transaction identity does not match",
    );

    provider.getTransaction = async () => ({
      hash: TX1,
      from: OWNER,
      nonce: parsed.nonce,
      chainId: parsed.chainId,
      blockHash,
      blockNumber: 456,
    });
    provider.getBlock = async () => ({ hash: `0x${"88".repeat(32)}`, number: 456 });
    await expectRejected(
      inspectFundedTransaction(provider, expected),
      "receipt is not anchored to the canonical block",
    );
  });

  function recordBroadcast(
    journal: FundedRecoveryJournal,
    label: string,
    hash: string,
  ): void {
    const signedTransaction = hash === TX1 ? RAW1 : RAW2;
    journal.recordPreparedTransaction(label, hash, signedTransaction);
    journal.recordBroadcast(label, hash);
  }

  it("persists authenticated encrypted recovery evidence and resumes the same identity", function () {
    const journal = open();
    recordBroadcast(journal, "pool creation", TX1);
    journal.recordTransaction(TX1, "mined-success", 123);
    journal.recordResource({
      id: "pool-30",
      kind: "confidential-pool",
      address: RESOURCE,
      creationTransactionHash: TX1,
      metadata: { feeBps: 30, initialized: true },
    });

    const persisted = readFileSync(journal.path, "utf8");
    expect(persisted).not.to.include("privateKey");
    expect(persisted).not.to.include("aesKey");
    expect(persisted).not.to.include("pool creation");
    expect(persisted).not.to.include(RESOURCE);

    const resumed = open();
    expect(resumed.transactions).to.deep.include({
      label: "pool creation",
      hash: TX1,
      status: "mined-success",
      blockNumber: 123,
    });
    expect(resumed.activeResources).to.have.length(1);
    resumed.markRecovered("pool-30", [TX1]);
    expect(open().activeResources).to.have.length(0);
  });

  it("requires the authenticated launcher to provide durable recovery state", function () {
    const previousActive = process.env.CIPHERDEX_OPERATOR_LAUNCHER_ACTIVE;
    const previousRoot = process.env.CIPHERDEX_FUNDED_STATE_ROOT;
    delete process.env.CIPHERDEX_OPERATOR_LAUNCHER_ACTIVE;
    delete process.env.CIPHERDEX_FUNDED_STATE_ROOT;
    const identity = {
      runner: "best-execution",
      sourceCommit: COMMIT,
      chainId: 7_082_400,
      owner: OWNER,
      deployment: DEPLOYMENT,
    } as const;
    try {
      expect(requiredFundedRecoveryDirectory).to.throw(
        "requires the authenticated operator launcher",
      );
      process.env.CIPHERDEX_OPERATOR_LAUNCHER_ACTIVE = "1";
      expect(requiredFundedRecoveryDirectory).to.throw("requires an absolute durable directory");
      process.env.CIPHERDEX_FUNDED_STATE_ROOT = directory;
      const durableDirectory = requiredFundedRecoveryDirectory();
      const journal = openFundedRecoveryJournal(TEST_SIGNER.privateKey, {
        ...identity,
        directory: durableDirectory,
      });
      expect(journal.path.startsWith(`${directory}\\`) || journal.path.startsWith(`${directory}/`))
        .to.equal(true);
      expect(() => openFundedRecoveryJournal(TEST_SIGNER.privateKey, {
        ...identity,
        directory: "relative-state",
      })).to.throw("explicit absolute durable directory");
    } finally {
      if (previousActive === undefined) delete process.env.CIPHERDEX_OPERATOR_LAUNCHER_ACTIVE;
      else process.env.CIPHERDEX_OPERATOR_LAUNCHER_ACTIVE = previousActive;
      if (previousRoot === undefined) delete process.env.CIPHERDEX_FUNDED_STATE_ROOT;
      else process.env.CIPHERDEX_FUNDED_STATE_ROOT = previousRoot;
    }
  });

  it("rejects a stale concurrent writer before a second transaction can be broadcast", function () {
    const first = open();
    const stale = open();

    first.recordPreparedTransaction("first writer", TX1, RAW1);
    expect(() => stale.recordPreparedTransaction("stale writer", TX2, RAW2)).to.throw(
      "changed since it was read",
    );
    expect(open().transactions).to.deep.equal([{
      label: "first writer",
      hash: TX1,
      status: "prepared",
    }]);
  });

  it("rejects recovery journals routed through a linked directory", function () {
    const target = mkdtempSync(join(tmpdir(), "cipherdex-funded-recovery-target-"));
    const linked = join(directory, "linked-state");
    try {
      symlinkSync(target, linked, process.platform === "win32" ? "junction" : "dir");
      expect(() => FundedRecoveryJournal.open({
        runner: "best-execution",
        sourceCommit: COMMIT,
        chainId: 7_082_400,
        owner: OWNER,
        deployment: DEPLOYMENT,
        recoveryKey: RECOVERY_KEY,
        directory: linked,
      })).to.throw("must be a real directory");
    } finally {
      rmSync(linked, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("resumes awaiting and terminal runs without silently resetting paid evidence", function () {
    const awaiting = open();
    recordBroadcast(awaiting, "pool creation", TX1);
    awaiting.recordTransaction(TX1, "mined-success", 123);
    awaiting.recordResource({
      id: "pool-30",
      kind: "confidential-pool",
      address: RESOURCE,
      creationTransactionHash: TX1,
      metadata: { phase: "batched" },
    });
    awaiting.updateResourceMetadata("pool-30", { phase: "awaiting-maturity" });
    awaiting.markRun("awaiting-maturity");
    expect(open().runStatus).to.equal("awaiting-maturity");
    expect(open().activeResources[0]?.metadata.phase).to.equal("awaiting-maturity");

    awaiting.markRecovered("pool-30", [TX1]);
    awaiting.markRun("failed");
    const restarted = open();
    expect(restarted.runStatus).to.equal("failed");
    expect(restarted.resources).to.have.length(1);
    expect(restarted.activeResources).to.have.length(0);
    expect(restarted.transactions).to.have.length(1);
    expect(() => restarted.recordPreparedTransaction("new paid action", TX2, RAW2)).to.throw(
      "funded recovery run is terminal",
    );
  });

  it("reconciles known receipts and retains absent broadcasts as uncertain", async function () {
    const journal = open();
    recordBroadcast(journal, "known", TX1);
    recordBroadcast(journal, "unknown", TX2);

    const parsed = Transaction.from(RAW1);
    const blockHash = `0x${"44".repeat(32)}`;
    const unresolved = await journal.reconcileTransactions({
      async getNetwork() { return { chainId: 7_082_400n }; },
      async getTransaction(hash) {
        return hash === TX1 ? {
          hash: TX1,
          from: OWNER,
          nonce: parsed.nonce,
          chainId: parsed.chainId,
          blockHash,
          blockNumber: 456,
        } : null;
      },
      async getTransactionReceipt(hash) {
        return hash === TX1 ? { hash: TX1, status: 1, blockHash, blockNumber: 456 } : null;
      },
      async getBlock(blockNumber) { return { hash: blockHash, number: blockNumber }; },
      async getBlockNumber() { return 457; },
    });

    expect(unresolved).to.deep.equal([TX2]);
    expect(journal.transactions).to.deep.include({
      label: "known",
      hash: TX1,
      status: "mined-success",
      blockNumber: 456,
    });
    expect(journal.transactions).to.deep.include({
      label: "unknown",
      hash: TX2,
      status: "outcome-unknown",
    });
  });

  it("fails closed on malformed receipt status without terminalizing the transaction", async function () {
    const journal = open();
    recordBroadcast(journal, "indeterminate", TX1);

    const parsed = Transaction.from(RAW1);
    const blockHash = `0x${"55".repeat(32)}`;
    await expectRejected(journal.reconcileTransactions({
      async getNetwork() { return { chainId: 7_082_400n }; },
      async getTransaction() {
        return {
          hash: TX1,
          from: OWNER,
          nonce: parsed.nonce,
          chainId: parsed.chainId,
          blockHash,
          blockNumber: 456,
        };
      },
      async getTransactionReceipt() {
        return { hash: TX1, status: null, blockHash, blockNumber: 456 };
      },
      async getBlock(blockNumber) { return { hash: blockHash, number: blockNumber }; },
      async getBlockNumber() { return 457; },
    }), "receipt status is invalid");
    expect(journal.transactions).to.deep.include({
      label: "indeterminate",
      hash: TX1,
      status: "broadcast",
    });
  });

  it("rejects identity mismatches, wrong keys, and authenticated-state tampering", function () {
    const journal = open();
    expect(() => FundedRecoveryJournal.open({
      runner: "best-execution",
      sourceCommit: COMMIT,
      chainId: 7_082_400,
      owner: `0x${"55".repeat(20)}`,
      deployment: DEPLOYMENT,
      recoveryKey: RECOVERY_KEY,
      directory,
    })).to.throw("identity mismatch");

    expect(() => FundedRecoveryJournal.open({
      runner: "best-execution",
      sourceCommit: COMMIT,
      chainId: 7_082_400,
      owner: OWNER,
      deployment: DEPLOYMENT,
      recoveryKey: `0x${"ee".repeat(32)}`,
      directory,
    })).to.throw("authentication failed");

    const records = readFileSync(journal.path, "utf8").trimEnd().split("\n");
    const record = JSON.parse(records.at(-1)!);
    record.payload = `${record.payload[0] === "A" ? "B" : "A"}${record.payload.slice(1)}`;
    records[records.length - 1] = JSON.stringify(record);
    writeFileSync(journal.path, `${records.join("\n")}\n`);
    expect(open).to.throw("authentication failed");
  });

  it("persists a deterministic local hash before broadcast without exposing the signed payload", function () {
    const journal = open();
    journal.recordPreparedTransaction("uncertain send", TX1, RAW1);
    expect(journal.transactions).to.deep.equal([{
      label: "uncertain send",
      hash: TX1,
      status: "prepared",
    }]);
    expect(readFileSync(journal.path, "utf8")).not.to.include(RAW1);
    expect(readFileSync(journal.path, "utf8")).not.to.include("signedTransaction");
    expect(JSON.stringify(journal.transactions)).not.to.include(RAW1);
    expect(open().transactions[0]).to.include({ hash: TX1, status: "prepared" });
  });

  it("journals a locally signed hash before a funded wallet broadcasts", async function () {
    const wallet = new FundedWallet(
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      ethers.provider,
    );
    const journal = FundedRecoveryJournal.open({
      runner: "best-execution",
      sourceCommit: COMMIT,
      chainId: 31_337,
      owner: wallet.address,
      deployment: DEPLOYMENT,
      recoveryKey: RECOVERY_KEY,
      directory,
    });
    const previousCoordinatorRoot = process.env.CIPHERDEX_COORDINATOR_ROOT;
    process.env.CIPHERDEX_COORDINATOR_ROOT = join(directory, "coordinator");
    const leases = acquireSignerExecutionLeases(31_337, [wallet.address]);
    const previous = process.env[ACTIVE_SIGNER_LEASES_ENVIRONMENT];
    process.env[ACTIVE_SIGNER_LEASES_ENVIRONMENT] = signerLeaseEnvironment(leases);
    try {
      const response = await withFundedTransactionEvidence(
        "deterministic broadcast",
        journal,
        () => wallet.sendTransaction({ to: wallet.address, value: 0n }),
      );
      expect(journal.transactions).to.deep.equal([{
        label: "deterministic broadcast",
        hash: response.hash,
        status: "broadcast",
      }]);
      const receipt = await response.wait();
      expect(receipt?.status).to.equal(1);
      journal.recordTransaction(response.hash, "mined-success", receipt!.blockNumber);
      expect(readFileSync(journal.path, "utf8")).not.to.include("signedTransaction");
    } finally {
      if (previous === undefined) delete process.env[ACTIVE_SIGNER_LEASES_ENVIRONMENT];
      else process.env[ACTIVE_SIGNER_LEASES_ENVIRONMENT] = previous;
      if (previousCoordinatorRoot === undefined) delete process.env.CIPHERDEX_COORDINATOR_ROOT;
      else process.env.CIPHERDEX_COORDINATOR_ROOT = previousCoordinatorRoot;
      for (const lease of [...leases].reverse()) lease.release();
    }
  });

  it("preserves the deterministic hash when coordinator recording fails after broadcast", async function () {
    const signingWallet = new Wallet(
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    );
    const journal = FundedRecoveryJournal.open({
      runner: "best-execution",
      sourceCommit: COMMIT,
      chainId: 31_337,
      owner: signingWallet.address,
      deployment: DEPLOYMENT,
      recoveryKey: RECOVERY_KEY,
      directory,
    });
    const previousCoordinatorRoot = process.env.CIPHERDEX_COORDINATOR_ROOT;
    process.env.CIPHERDEX_COORDINATOR_ROOT = join(directory, "coordinator-post-broadcast");
    const leases = acquireSignerExecutionLeases(31_337, [signingWallet.address]);
    const previous = process.env[ACTIVE_SIGNER_LEASES_ENVIRONMENT];
    process.env[ACTIVE_SIGNER_LEASES_ENVIRONMENT] = signerLeaseEnvironment(leases);
    let transactionHash: string | undefined;
    const provider = {
      async broadcastTransaction(signedTransaction: string) {
        transactionHash = keccak256(signedTransaction);
        recordPreparedSignerTransactionAbandoned(
          31_337,
          signingWallet.address,
          transactionHash,
        );
        return { hash: transactionHash };
      },
    } as unknown as Provider;
    const wallet = {
      provider,
      async populateTransaction(transaction: Record<string, unknown>) {
        return {
          ...transaction,
          chainId: 31_337,
          nonce: 7,
          gasLimit: 21_000n,
          gasPrice: 1n,
          type: 0,
        };
      },
      async signTransaction(transaction: Parameters<Wallet["signTransaction"]>[0]) {
        return signingWallet.signTransaction(transaction);
      },
    };
    let captured: unknown;
    try {
      await withFundedTransactionEvidence(
        "post-broadcast coordinator failure",
        journal,
        () => sendPreparedFundedTransaction(wallet, {
          to: signingWallet.address,
          value: 0n,
        }),
      );
    } catch (error) {
      captured = error;
    } finally {
      if (previous === undefined) delete process.env[ACTIVE_SIGNER_LEASES_ENVIRONMENT];
      else process.env[ACTIVE_SIGNER_LEASES_ENVIRONMENT] = previous;
      if (previousCoordinatorRoot === undefined) delete process.env.CIPHERDEX_COORDINATOR_ROOT;
      else process.env.CIPHERDEX_COORDINATOR_ROOT = previousCoordinatorRoot;
      for (const lease of [...leases].reverse()) lease.release();
    }
    expect(transactionHash).to.match(/^0x[0-9a-f]{64}$/u);
    expect(captured).to.be.instanceOf(Error);
    expect((captured as Error).name).to.equal("PreparedFundedBroadcastError");
    expect(captured).to.have.property("transactionHash", transactionHash);
    expect((captured as Error & { cause?: unknown }).cause).to.be.instanceOf(AggregateError);
    expect(journal.transactions[0]).to.include({
      hash: transactionHash,
      status: "outcome-unknown",
    });
  });

  it("retains the signed payload for recovery when signer reservation fails before broadcast", async function () {
    const wallet = new FundedWallet(
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      ethers.provider,
    );
    const journal = FundedRecoveryJournal.open({
      runner: "best-execution",
      sourceCommit: COMMIT,
      chainId: 31_337,
      owner: wallet.address,
      deployment: DEPLOYMENT,
      recoveryKey: RECOVERY_KEY,
      directory,
    });
    const previous = process.env[ACTIVE_SIGNER_LEASES_ENVIRONMENT];
    delete process.env[ACTIVE_SIGNER_LEASES_ENVIRONMENT];
    const nonceBefore = await ethers.provider.getTransactionCount(wallet.address);
    try {
      await expectRejected(
        withFundedTransactionEvidence(
          "reservation failure",
          journal,
          () => wallet.sendTransaction({ to: wallet.address, value: 0n }),
        ),
        "lacks its parent execution lease",
      );
      expect(journal.transactions).to.have.length(1);
      expect(journal.transactions[0]).to.include({
        label: "reservation failure",
        status: "prepared",
      });
      expect(await ethers.provider.getTransactionCount(wallet.address)).to.equal(nonceBefore);
    } finally {
      if (previous === undefined) delete process.env[ACTIVE_SIGNER_LEASES_ENVIRONMENT];
      else process.env[ACTIVE_SIGNER_LEASES_ENVIRONMENT] = previous;
    }
  });

  it("rebroadcasts only the identical signed transaction retained by recovery", async function () {
    const journal = open();
    journal.recordPreparedTransaction("identical recovery", TX1, RAW1);
    const parsed = Transaction.from(RAW1);
    let broadcastRaw: string | undefined;
    await journal.rebroadcastIdenticalTransaction(TX1, {
      async getNetwork() { return { chainId: 7_082_400n }; },
      async getTransaction() { return null; },
      async getTransactionReceipt() { return null; },
      async getBlock() { return null; },
      async getBlockNumber() { return 1; },
      async broadcastTransaction(rawTransaction) {
        broadcastRaw = rawTransaction;
        return { hash: keccak256(rawTransaction) };
      },
    });
    expect(parsed.nonce).to.equal(1);
    expect(broadcastRaw).to.equal(RAW1);
    expect(journal.transactions[0]).to.include({ hash: TX1, status: "broadcast" });
  });

  it("releases only a prepared signer reservation through the dedicated abandonment boundary", async function () {
    const previousCoordinatorRoot = process.env.CIPHERDEX_COORDINATOR_ROOT;
    process.env.CIPHERDEX_COORDINATOR_ROOT = join(directory, "coordinator-abandoned");
    const leases = acquireSignerExecutionLeases(31_337, [OWNER]);
    const previous = process.env[ACTIVE_SIGNER_LEASES_ENVIRONMENT];
    process.env[ACTIVE_SIGNER_LEASES_ENVIRONMENT] = signerLeaseEnvironment(leases);
    try {
      recordPreparedSignerTransaction({
        chainId: 31_337,
        signer: OWNER,
        nonce: 7,
        hash: TX1,
      });
      const unsafeStatusWrite = recordSignerTransactionStatus as (
        chainId: number,
        signer: string,
        hash: string,
        status: string,
      ) => void;
      expect(() => unsafeStatusWrite(
        31_337,
        OWNER,
        TX1,
        "abandoned-prebroadcast",
      )).to.throw("dedicated proof boundary");
      recordPreparedSignerTransactionAbandoned(31_337, OWNER, TX1);
      expect(readSignerTransactionState(31_337, OWNER).transactions[0]).to.include({
        hash: TX1.toLowerCase(),
        nonce: 7,
        status: "abandoned-prebroadcast",
      });
      expect(() => recordSignerTransactionStatus(
        31_337,
        OWNER,
        TX1,
        "outcome-unknown",
      )).to.throw("terminal funded signer transaction status cannot change");
      let inspections = 0;
      await reconcileSignerExecutionLeases(leases, async () => {
        inspections += 1;
        throw new Error("terminal reservations must not reach RPC inspection");
      });
      expect(inspections).to.equal(0);
      expect(() => recordPreparedSignerTransaction({
        chainId: 31_337,
        signer: OWNER,
        nonce: 7,
        hash: TX2,
      })).not.to.throw();
      expect(() => recordPreparedSignerTransaction({
        chainId: 31_337,
        signer: OWNER,
        nonce: 7,
        hash: TX1,
      })).to.throw("nonce is already reserved");
    } finally {
      if (previous === undefined) delete process.env[ACTIVE_SIGNER_LEASES_ENVIRONMENT];
      else process.env[ACTIVE_SIGNER_LEASES_ENVIRONMENT] = previous;
      if (previousCoordinatorRoot === undefined) delete process.env.CIPHERDEX_COORDINATOR_ROOT;
      else process.env.CIPHERDEX_COORDINATOR_ROOT = previousCoordinatorRoot;
      for (const lease of [...leases].reverse()) lease.release();
    }
  });

  it("reactivates only the exact abandoned signed transaction identity", function () {
    const previousCoordinatorRoot = process.env.CIPHERDEX_COORDINATOR_ROOT;
    process.env.CIPHERDEX_COORDINATOR_ROOT = join(directory, "coordinator-reactivated");
    const leases = acquireSignerExecutionLeases(31_337, [OWNER]);
    const previous = process.env[ACTIVE_SIGNER_LEASES_ENVIRONMENT];
    process.env[ACTIVE_SIGNER_LEASES_ENVIRONMENT] = signerLeaseEnvironment(leases);
    try {
      recordPreparedSignerTransaction({
        chainId: 31_337,
        signer: OWNER,
        nonce: 7,
        hash: TX1,
      });
      recordPreparedSignerTransactionAbandoned(31_337, OWNER, TX1);
      expect(() => assertSoleRecoverableSignerTransaction(leases, TX1)).not.to.throw();
      expect(() => recordPreparedSignerTransaction({
        chainId: 31_337,
        signer: OWNER,
        nonce: 8,
        hash: TX1,
      })).to.throw("identity changed");
      recordPreparedSignerTransaction({
        chainId: 31_337,
        signer: OWNER,
        nonce: 7,
        hash: TX1,
      });
      expect(readSignerTransactionState(31_337, OWNER).transactions[0]).to.include({
        hash: TX1.toLowerCase(),
        nonce: 7,
        status: "prepared",
      });
      recordSignerTransactionStatus(31_337, OWNER, TX1, "broadcast");
      expect(() => assertSoleRecoverableSignerTransaction(leases, TX1)).not.to.throw();
      recordPreparedSignerTransaction({
        chainId: 31_337,
        signer: OWNER,
        nonce: 8,
        hash: TX2,
      });
      expect(() => assertSoleRecoverableSignerTransaction(leases, TX1))
        .to.throw("sole recoverable signer transaction");
      expect(() => recordPreparedSignerTransaction({
        chainId: 31_337,
        signer: OWNER,
        nonce: 7,
        hash: TX1,
      })).to.throw("cannot be prepared from its current status");
    } finally {
      if (previous === undefined) delete process.env[ACTIVE_SIGNER_LEASES_ENVIRONMENT];
      else process.env[ACTIVE_SIGNER_LEASES_ENVIRONMENT] = previous;
      if (previousCoordinatorRoot === undefined) delete process.env.CIPHERDEX_COORDINATOR_ROOT;
      else process.env.CIPHERDEX_COORDINATOR_ROOT = previousCoordinatorRoot;
      for (const lease of [...leases].reverse()) lease.release();
    }
  });

  it("rejects signer nonce reuse and immutable terminal status changes", function () {
    const previousCoordinatorRoot = process.env.CIPHERDEX_COORDINATOR_ROOT;
    process.env.CIPHERDEX_COORDINATOR_ROOT = join(directory, "coordinator-status");
    const leases = acquireSignerExecutionLeases(31_337, [OWNER]);
    const previous = process.env[ACTIVE_SIGNER_LEASES_ENVIRONMENT];
    process.env[ACTIVE_SIGNER_LEASES_ENVIRONMENT] = signerLeaseEnvironment(leases);
    try {
      recordPreparedSignerTransaction({
        chainId: 31_337,
        signer: OWNER,
        nonce: 7,
        hash: TX1,
      });
      expect(() => recordPreparedSignerTransaction({
        chainId: 31_337,
        signer: OWNER,
        nonce: 7,
        hash: TX2,
      })).to.throw("nonce is already reserved");
      recordSignerTransactionStatus(31_337, OWNER, TX1, "mined-success", 88);
      expect(readSignerTransactionState(31_337, OWNER).transactions[0]).not.to.have.property("signedTransaction");
      expect(readFileSync(leases[0]!.statePath, "utf8")).not.to.include(RAW1);
      expect(() => recordSignerTransactionStatus(
        31_337,
        OWNER,
        TX1,
        "outcome-unknown",
      )).to.throw("terminal funded signer transaction status cannot change");
    } finally {
      if (previous === undefined) delete process.env[ACTIVE_SIGNER_LEASES_ENVIRONMENT];
      else process.env[ACTIVE_SIGNER_LEASES_ENVIRONMENT] = previous;
      if (previousCoordinatorRoot === undefined) delete process.env.CIPHERDEX_COORDINATOR_ROOT;
      else process.env.CIPHERDEX_COORDINATOR_ROOT = previousCoordinatorRoot;
      for (const lease of [...leases].reverse()) lease.release();
    }
  });

  it("requires a locally signed durable record before recording a broadcast", function () {
    const journal = open();
    expect(() => journal.recordBroadcast("unmarked", TX1)).to.throw(
      "without a locally signed record",
    );
    recordBroadcast(journal, "marked", TX1);
    expect(journal.transactions[0]).to.include({ status: "broadcast" });
  });

  it("persists allowance obligations until an onchain-verified cleanup closes them", function () {
    const journal = open();
    const id = `allowance:${OWNER.toLowerCase()}:${TOKEN0.toLowerCase()}:${RESOURCE.toLowerCase()}`;
    journal.recordAllowanceObligation({
      id,
      owner: OWNER,
      token: TOKEN0,
      spender: RESOURCE,
    });
    expect(journal.activeAllowanceObligations).to.have.length(1);
    expect(open().activeAllowanceObligations[0]).to.include({ id, active: true });

    recordBroadcast(journal, "allowance cleanup", TX1);
    expect(() => journal.markAllowanceCleared(id, [TX1])).to.throw(
      "cleanup transaction is not mined-success",
    );
    journal.recordTransaction(TX1, "mined-success", 77);
    journal.markAllowanceCleared(id, [TX1]);
    expect(journal.activeAllowanceObligations).to.have.length(0);
    expect(open().allowanceObligations[0]).to.deep.include({
      id,
      active: false,
      cleanupTransactionHashes: [TX1],
    });
  });

  it("journals a pre-existing private allowance before clearing it", async function () {
    const journal = open();
    let allowance = 9n;
    let transactionIndex = 0;
    const wallet = {
      async getAddress() { return OWNER; },
      async encryptValue256(value: bigint) { return { value }; },
      async decryptValue256(ciphertext: { ciphertextLow: bigint }) {
        return ciphertext.ciphertextLow;
      },
    };
    const token = {
      interface: { getFunction() { return { selector: "0x095ea7b3" }; } },
      allowance: {
        async staticCall() {
          return { ownerCiphertext: { ciphertextHigh: allowance === 0n ? 0n : 1n, ciphertextLow: allowance } };
        },
      },
      async approve(_spender: string, encrypted: { value: bigint }) {
        allowance = encrypted.value;
        return {};
      },
    };
    await setRecoverablePrivateAllowance({
      journal,
      wallet,
      token: token as any,
      tokenAddress: TOKEN0,
      spender: RESOURCE,
      amount: 0n,
      label: "legacy allowance cleanup",
      overrides: { gasLimit: 100_000n },
      submit: async (label, operation) => {
        await operation();
        transactionIndex += 1;
        const raw = `0x${transactionIndex.toString(16).padStart(2, "0")}`;
        const hash = keccak256(raw);
        journal.recordPreparedTransaction(label, hash, raw);
        journal.recordBroadcast(label, hash);
        journal.recordTransaction(hash, "mined-success", transactionIndex);
        return { transactionHash: hash };
      },
    });
    expect(allowance).to.equal(0n);
    expect(journal.activeAllowanceObligations).to.have.length(0);
    expect(journal.allowanceObligations[0].cleanupTransactionHashes).to.have.length(1);
  });

  it("rejects reusing a broadcast hash for another operation", function () {
    const journal = open();
    recordBroadcast(journal, "first operation", TX1);

    expect(() => journal.recordPreparedTransaction("second operation", TX1, RAW1)).to.throw(
      "belongs to a different operation",
    );
    expect(journal.transactions).to.deep.equal([{
      label: "first operation",
      hash: TX1,
      status: "broadcast",
    }]);
  });

  it("never re-signs a logical operation after its first transaction mined", function () {
    const journal = open();
    recordBroadcast(journal, "single-use paid operation", TX1);
    journal.recordTransaction(TX1, "mined-success", 123);

    expect(() => journal.recordPreparedTransaction(
      "single-use paid operation",
      TX2,
      RAW2,
    )).to.throw("cannot be re-signed");
    expect(() => journal.recordObservedMinedTransaction(
      "single-use paid operation",
      TX3,
      124,
    )).to.throw("already journaled with another transaction");
    expect(journal.transactions).to.have.length(1);
  });

  it("binds observed mined transaction evidence to its operation label", function () {
    const journal = open();
    journal.recordObservedMinedTransaction("first operation", TX1, 123);

    expect(() => journal.recordObservedMinedTransaction(
      "second operation",
      TX1,
      123,
    )).to.throw("conflicts with the journal");
    expect(() => journal.recordObservedMinedTransaction(
      "first operation",
      TX1,
      123,
    )).not.to.throw();
  });

  it("proves pool recovery from the mined full-exit call and live terminal state", async function () {
    const journal = open();
    journal.recordObservedMinedTransaction("pool creation", TX1, 123);
    journal.recordObservedMinedTransaction("full pool exit", TX2, 124);
    journal.recordResource({
      id: "pool-30",
      kind: "confidential-pool",
      address: RESOURCE,
      creationTransactionHash: TX1,
      metadata: { feeBps: 30 },
    });
    journal.markRecovered("pool-30", [TX2]);
    const pool = new Interface([
      "function initialized() view returns (bool)",
      "function removeLiquidity(((uint256,uint256),bytes),((uint256,uint256),bytes),((uint256,uint256),bytes),uint64)",
    ]);
    const provider = {
      async getTransaction(hash: string) {
        return {
          from: OWNER,
          to: hash === TX2 ? RESOURCE : null,
          chainId: 7_082_400,
          data: hash === TX2
            ? pool.getFunction("removeLiquidity")!.selector
            : "0x",
        };
      },
      async getTransactionReceipt(hash: string) {
        return { status: 1, blockNumber: hash === TX2 ? 124 : 123 };
      },
      async call() {
        return pool.encodeFunctionResult("initialized", [false]);
      },
    };
    await verifyRecoveryResourceTerminalState(journal, journal.resources[0], provider);

    await expectRejected(
      verifyRecoveryResourceTerminalState(journal, journal.resources[0], {
        ...provider,
        async call() { return pool.encodeFunctionResult("initialized", [true]); },
      }),
      "not terminal onchain",
    );
  });

  it("requires a migrator-bound allowance reset for each launchpad token", async function () {
    const journal = open();
    journal.recordObservedMinedTransaction("launchpad stack deployment", TX1, 123);
    journal.recordObservedMinedTransaction("token0 allowance reset", TX2, 124);
    journal.recordObservedMinedTransaction("token1 allowance reset", TX3, 125);
    journal.recordResource({
      id: "launchpad-stack",
      kind: "launchpad-stack",
      address: RESOURCE,
      creationTransactionHash: TX1,
      metadata: {
        token0Address: TOKEN0,
        token1Address: TOKEN1,
        migratorAddress: MIGRATOR,
      },
    });
    journal.markRecovered("launchpad-stack", [TX2, TX3]);
    const approval = new Interface([
      "function approve(address,((uint256,uint256),bytes))",
    ]);
    const provider = {
      async getTransaction(hash: string) {
        return {
          from: OWNER,
          to: hash === TX2 ? TOKEN0 : TOKEN1,
          chainId: 7_082_400,
          data: approval.encodeFunctionData("approve", [MIGRATOR, [[0n, 0n], "0x"]]),
        };
      },
      async getTransactionReceipt(hash: string) {
        return { status: 1, blockNumber: hash === TX2 ? 124 : 125 };
      },
      async call() { return "0x"; },
    };
    await verifyRecoveryResourceTerminalState(journal, journal.resources[0], provider);

    await expectRejected(
      verifyRecoveryResourceTerminalState(journal, journal.resources[0], {
        ...provider,
        async getTransaction() {
          return {
            from: OWNER,
            to: TOKEN0,
            chainId: 7_082_400,
            data: approval.encodeFunctionData("approve", [MIGRATOR, [[0n, 0n], "0x"]]),
          };
        },
      }),
      "token-specific migrator allowance reset",
    );
  });

  it("accepts only an owner-created direct deployment bound to the journal chain", async function () {
    const journal = open();
    recordBroadcast(journal, "probe deployment", TX1);
    journal.recordTransaction(TX1, "mined-success", 123);
    journal.recordResource({
      id: "probe",
      kind: "best-execution-probe",
      address: RESOURCE,
      creationTransactionHash: TX1,
      metadata: { contractName: "MpcBestExecutionPoolProbe" },
    });

    const provider = {
      async getCode() { return "0x6000"; },
      async getTransaction() {
        return { from: OWNER, to: null, chainId: 7_082_400 };
      },
      async getTransactionReceipt() {
        return {
          status: 1,
          blockNumber: 123,
          contractAddress: RESOURCE,
          logs: [],
        };
      },
    };
    await verifyRecoveryResourceCreation(journal, journal.resources[0], provider);

    await expectRejected(verifyRecoveryResourceCreation(journal, journal.resources[0], {
      ...provider,
      async getTransaction() {
        return { from: `0x${"55".repeat(20)}`, to: null, chainId: 7_082_400 };
      },
    }), "creation provenance is invalid");
    await expectRejected(verifyRecoveryResourceCreation(journal, journal.resources[0], {
      ...provider,
      async getTransaction() {
        return { from: OWNER, to: null, chainId: 7_082_401 };
      },
    }), "creation provenance is invalid");
  });

  it("requires factory-created resources to be identified by the bound creator's receipt log", async function () {
    const factory = `0x${"66".repeat(20)}`;
    const unrelatedEmitter = `0x${"77".repeat(20)}`;
    const poolFactoryInterface = new Interface([
      "event PoolCreated(address indexed token0,address indexed token1,uint8 token0Decimals,uint8 token1Decimals,uint256 feeBps,address initializationStrategy,address pool)",
    ]);
    const encodedEvent = poolFactoryInterface.encodeEventLog(
      poolFactoryInterface.getEvent("PoolCreated")!,
      [TOKEN0, TOKEN1, 18, 6, 30, "0x0000000000000000000000000000000000000000", RESOURCE],
    );
    const journal = open();
    recordBroadcast(journal, "pool creation", TX1);
    journal.recordTransaction(TX1, "mined-success", 123);
    journal.recordResource({
      id: "pool-30",
      kind: "confidential-pool",
      address: RESOURCE,
      creationTransactionHash: TX1,
      metadata: {
        factoryAddress: factory,
        token0Address: TOKEN0,
        token1Address: TOKEN1,
        decimals0: 18,
        decimals1: 6,
        feeBps: 30,
      },
    });
    const provider = {
      async getCode() { return "0x6000"; },
      async getTransaction() {
        return { from: OWNER, to: factory, chainId: 7_082_400 };
      },
      async getTransactionReceipt() {
        return {
          status: 1,
          blockNumber: 123,
          contractAddress: null,
          logs: [{ address: factory, topics: encodedEvent.topics, data: encodedEvent.data }],
        };
      },
    };
    await verifyRecoveryResourceCreation(journal, journal.resources[0], provider);

    await expectRejected(verifyRecoveryResourceCreation(journal, journal.resources[0], {
      ...provider,
      async getTransactionReceipt() {
        return {
          status: 1,
          blockNumber: 123,
          contractAddress: null,
          logs: [{ address: unrelatedEmitter, topics: encodedEvent.topics, data: encodedEvent.data }],
        };
      },
    }), "pool creation event is missing or ambiguous");

    await expectRejected(verifyRecoveryResourceCreation(journal, journal.resources[0], {
      ...provider,
      async getTransaction() {
        return { from: OWNER, to: unrelatedEmitter, chainId: 7_082_400 };
      },
      async getTransactionReceipt() {
        return {
          status: 1,
          blockNumber: 123,
          contractAddress: null,
          logs: [{ address: unrelatedEmitter, topics: encodedEvent.topics, data: encodedEvent.data }],
        };
      },
    }), "pool creator is not the bound factory");

    await expectRejected(verifyRecoveryResourceCreation(journal, journal.resources[0], {
      ...provider,
      async getTransactionReceipt() {
        return {
          status: 1,
          blockNumber: 123,
          contractAddress: null,
          logs: [{
            address: factory,
            topics: [TX2],
            data: `0x${"00".repeat(12)}${RESOURCE.slice(2)}`,
          }],
        };
      },
    }), "pool creation event is missing or ambiguous");

    await expectRejected(verifyRecoveryResourceCreation(journal, journal.resources[0], {
      ...provider,
      async getTransactionReceipt() {
        const log = { address: factory, topics: encodedEvent.topics, data: encodedEvent.data };
        return {
          status: 1,
          blockNumber: 123,
          contractAddress: null,
          logs: [log, log],
        };
      },
    }), "pool creation event is missing or ambiguous");
  });

  it("binds protected-pool recovery to the atomic migrator and complete key", async function () {
    const factory = `0x${"66".repeat(20)}`;
    const migrator = `0x${"77".repeat(20)}`;
    const poolFactoryInterface = new Interface([
      "event PoolCreated(address indexed token0,address indexed token1,uint8 token0Decimals,uint8 token1Decimals,uint256 feeBps,address initializationStrategy,address pool)",
    ]);
    const encodedEvent = poolFactoryInterface.encodeEventLog(
      poolFactoryInterface.getEvent("PoolCreated")!,
      [TOKEN0, TOKEN1, 18, 6, 30, STRATEGY, RESOURCE],
    );
    const journal = open();
    recordBroadcast(journal, "atomic launchpad migration", TX1);
    journal.recordTransaction(TX1, "mined-success", 123);
    journal.recordResource({
      id: "protected-pool-30",
      kind: "launchpad-pool",
      address: RESOURCE,
      creationTransactionHash: TX1,
      metadata: {
        factoryAddress: factory,
        migratorAddress: migrator,
        initializationStrategyAddress: STRATEGY,
        token0Address: TOKEN0,
        token1Address: TOKEN1,
        decimals0: 18,
        decimals1: 6,
        feeBps: 30,
      },
    });
    const provider = {
      async getCode() { return "0x6000"; },
      async getTransaction() {
        return { from: OWNER, to: migrator, chainId: 7_082_400 };
      },
      async getTransactionReceipt() {
        return {
          status: 1,
          blockNumber: 123,
          contractAddress: null,
          logs: [{ address: factory, topics: encodedEvent.topics, data: encodedEvent.data }],
        };
      },
    };
    await verifyRecoveryResourceCreation(journal, journal.resources[0], provider);

    await expectRejected(verifyRecoveryResourceCreation(journal, journal.resources[0], {
      ...provider,
      async getTransaction() {
        return { from: OWNER, to: STRATEGY, chainId: 7_082_400 };
      },
    }), "creator is not the bound migrator");

    const wrongStrategyEvent = poolFactoryInterface.encodeEventLog(
      poolFactoryInterface.getEvent("PoolCreated")!,
      [TOKEN0, TOKEN1, 18, 6, 30, migrator, RESOURCE],
    );
    await expectRejected(verifyRecoveryResourceCreation(journal, journal.resources[0], {
      ...provider,
      async getTransactionReceipt() {
        return {
          status: 1,
          blockNumber: 123,
          contractAddress: null,
          logs: [{
            address: factory,
            topics: wrongStrategyEvent.topics,
            data: wrongStrategyEvent.data,
          }],
        };
      },
    }), "protected-pool creation event is missing or ambiguous");
  });
});
