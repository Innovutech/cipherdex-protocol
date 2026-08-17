import { expect } from "chai";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FundedRecoveryJournal,
  verifyRecoveryResourceCreation,
} from "../../scripts/funded-recovery-journal";

const COMMIT = "a".repeat(40);
const OWNER = `0x${"11".repeat(20)}`;
const RESOURCE = `0x${"22".repeat(20)}`;
const TX1 = `0x${"33".repeat(32)}`;
const TX2 = `0x${"44".repeat(32)}`;
const DEPLOYMENT = Object.freeze({
  recordPath: `deployments/coti-testnet-${COMMIT}.json`,
  recordSha256: "b".repeat(64),
  manifestCommit: "c".repeat(40),
  sourceCommit: COMMIT,
});

describe("funded recovery journal", function () {
  let directory: string;

  beforeEach(function () {
    directory = mkdtempSync(join(tmpdir(), "cipherdex-funded-recovery-"));
  });

  afterEach(function () {
    rmSync(directory, { recursive: true, force: true });
  });

  function open(): FundedRecoveryJournal {
    return FundedRecoveryJournal.open({
      runner: "best-execution",
      sourceCommit: COMMIT,
      chainId: 7_082_400,
      owner: OWNER,
      deployment: DEPLOYMENT,
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

  it("persists only public recovery evidence and resumes the same identity", function () {
    const journal = open();
    journal.recordBroadcast("pool creation", TX1);
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
    expect(persisted).not.to.include("ciphertext");

    const resumed = open();
    expect(resumed.transactions).to.deep.include({
      label: "pool creation",
      hash: TX1,
      status: "mined-success",
      blockNumber: 123,
    });
    expect(resumed.activeResources).to.have.length(1);
    resumed.markRecovered("pool-30");
    expect(open().activeResources).to.have.length(0);
  });

  it("resumes an awaiting run and resets a terminal fully recovered run", function () {
    const awaiting = open();
    awaiting.recordBroadcast("pool creation", TX1);
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

    awaiting.markRecovered("pool-30");
    awaiting.markRun("failed");
    const restarted = open();
    expect(restarted.runStatus).to.equal("active");
    expect(restarted.resources).to.have.length(0);
    expect(restarted.transactions).to.have.length(0);
  });

  it("reconciles known receipts and retains absent broadcasts as uncertain", async function () {
    const journal = open();
    journal.recordBroadcast("known", TX1);
    journal.recordBroadcast("unknown", TX2);

    const unresolved = await journal.reconcileTransactions({
      async getTransactionReceipt(hash) {
        return hash === TX1 ? { status: 1, blockNumber: 456 } : null;
      },
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

  it("rejects identity mismatches and malformed persisted metadata", function () {
    const journal = open();
    expect(() => FundedRecoveryJournal.open({
      runner: "best-execution",
      sourceCommit: COMMIT,
      chainId: 7_082_400,
      owner: `0x${"55".repeat(20)}`,
      deployment: DEPLOYMENT,
      directory,
    })).to.throw("identity mismatch");

    const parsed = JSON.parse(readFileSync(journal.path, "utf8"));
    parsed.resources = [{
      id: "pool",
      kind: "confidential-pool",
      address: RESOURCE,
      creationTransactionHash: TX1,
      recovered: false,
      metadata: { nested: { secret: true } },
    }];
    writeFileSync(journal.path, JSON.stringify(parsed));
    expect(open).to.throw("invalid resource");
  });

  it("accepts only an owner-created direct deployment bound to the journal chain", async function () {
    const journal = open();
    journal.recordBroadcast("probe deployment", TX1);
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
    const encodedResource = `0x${"00".repeat(12)}${RESOURCE.slice(2)}`;
    const journal = open();
    journal.recordBroadcast("pool creation", TX1);
    journal.recordTransaction(TX1, "mined-success", 123);
    journal.recordResource({
      id: "pool-30",
      kind: "confidential-pool",
      address: RESOURCE,
      creationTransactionHash: TX1,
      metadata: { factoryAddress: factory, feeBps: 30 },
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
          logs: [{ address: factory, topics: [TX2], data: encodedResource }],
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
          logs: [{ address: unrelatedEmitter, topics: [TX2], data: encodedResource }],
        };
      },
    }), "receipt does not identify the resource");

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
          logs: [{ address: unrelatedEmitter, topics: [TX2], data: encodedResource }],
        };
      },
    }), "created by an unbound contract");
  });
});
