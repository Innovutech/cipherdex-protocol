import { expect } from "chai";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DeploymentRecordWriter,
  resolveNewDeploymentRecordPath,
  type DeploymentJournalTransaction,
  upsertMinedDeploymentTransaction,
} from "../../scripts/deployment-record";

describe("deployment record persistence", function () {
  const sourceCommit = "ab".repeat(20);

  it("rejects mutable, nested and escaping record names", function () {
    for (const value of [
      "deployments/coti-testnet-latest.json",
      "deployments/nested/coti-testnet-abcdef0.json",
      "../deployments/coti-testnet-abcdef0.json",
      `deployments/coti-testnet-${"cd".repeat(20)}.json`,
    ]) {
      expect(() => resolveNewDeploymentRecordPath(value, sourceCommit)).to.throw();
    }
    expect(() => resolveNewDeploymentRecordPath(
      `deployments/coti-testnet-${sourceCommit}.json`,
      "abcdef0",
    )).to.throw("full Git commit");
  });

  it("reserves a unique record before writing the completed manifest", async function () {
    const cwd = await mkdtemp(join(tmpdir(), "cipherdex-deployment-record-"));
    const output = `deployments/coti-testnet-${sourceCommit}.json`;
    try {
      const writer = await DeploymentRecordWriter.reserve(output, sourceCommit, {
        schemaVersion: 2,
        sourceCommit,
      }, cwd);
      const reserved = JSON.parse(await readFile(writer.outputPath, "utf8"));
      expect(reserved.status).to.equal("reserved");

      await writer.write({ schemaVersion: 2, status: "complete" });
      await writer.close();
      const completed = JSON.parse(await readFile(writer.outputPath, "utf8"));
      expect(completed.status).to.equal("complete");

      let duplicateRejected = false;
      try {
        await DeploymentRecordWriter.reserve(output, sourceCommit, {}, cwd);
      } catch {
        duplicateRejected = true;
      }
      expect(duplicateRejected).to.equal(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("supports a distinct commit-bound COTI mainnet record namespace", async function () {
    const cwd = await mkdtemp(join(tmpdir(), "cipherdex-mainnet-record-"));
    const output = `deployments/coti-mainnet-${sourceCommit}.json`;
    try {
      expect(() => resolveNewDeploymentRecordPath(
        output,
        sourceCommit,
        cwd,
        "coti-mainnet",
      )).not.to.throw();
      expect(() => resolveNewDeploymentRecordPath(
        `deployments/coti-testnet-${sourceCommit}.json`,
        sourceCommit,
        cwd,
        "coti-mainnet",
      )).to.throw("coti-mainnet-<commit>");
      const writer = await DeploymentRecordWriter.reserve(
        output,
        sourceCommit,
        { schemaVersion: 2, sourceCommit },
        cwd,
        "coti-mainnet",
      );
      await writer.close();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("supports isolated public replacement record namespaces", function () {
    for (const slug of [
      "coti-testnet-public",
      "coti-mainnet-public",
      "coti-mainnet-observable-confidential",
    ]) {
      const output = `deployments/${slug}-${sourceCommit}.json`;
      expect(() => resolveNewDeploymentRecordPath(
        output,
        sourceCommit,
        process.cwd(),
        slug,
      )).not.to.throw();
      expect(() => resolveNewDeploymentRecordPath(
        `deployments/coti-testnet-${sourceCommit}.json`,
        sourceCommit,
        process.cwd(),
        slug,
      )).to.throw(`${slug}-<commit>`);
    }
  });

  it("durably replaces partial checkpoints with terminal evidence", async function () {
    const cwd = await mkdtemp(join(tmpdir(), "cipherdex-deployment-journal-"));
    const output = `deployments/coti-testnet-${sourceCommit}.json`;
    try {
      const writer = await DeploymentRecordWriter.reserve(output, sourceCommit, {
        schemaVersion: 2,
        sourceCommit,
      }, cwd);
      const transactionHash = `0x${"12".repeat(32)}`;
      await writer.write({
        schemaVersion: 2,
        status: "in-progress",
        stage: "factory deployment",
        transactions: [{ transactionHash, outcome: "mined-success" }],
      });
      let checkpoint = JSON.parse(await readFile(writer.outputPath, "utf8"));
      expect(checkpoint.transactions).to.deep.equal([
        { transactionHash, outcome: "mined-success" },
      ]);

      await writer.write({
        schemaVersion: 2,
        status: "failed",
        stage: "factory runtime verification",
        transactions: [{ transactionHash, outcome: "mined-success" }],
        failure: { classification: "post-mined-error", transactionHash },
      });
      await writer.close();
      checkpoint = JSON.parse(await readFile(writer.outputPath, "utf8"));
      expect(checkpoint.status).to.equal("failed");
      expect(checkpoint.failure).to.deep.equal({
        classification: "post-mined-error",
        transactionHash,
      });
      expect(checkpoint.transactions).to.have.length(1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("journals a mined hash before contract recovery and enriches it without duplication", function () {
    const transactionHash = `0x${"34".repeat(32)}`;
    const transactions: DeploymentJournalTransaction[] = [];

    upsertMinedDeploymentTransaction(transactions, {
      label: "factory deployment",
      transactionHash,
      gasUsed: "12345",
    });
    expect(transactions).to.deep.equal([{
      label: "factory deployment",
      transactionHash,
      outcome: "mined-success",
      gasUsed: "12345",
    }]);

    const contractAddress = `0x${"56".repeat(20)}`;
    upsertMinedDeploymentTransaction(transactions, {
      label: "factory deployment",
      address: contractAddress,
      transactionHash: transactionHash.toUpperCase().replace("0X", "0x"),
      gasUsed: "12345",
    });
    expect(transactions).to.have.length(1);
    expect(transactions[0]).to.deep.equal({
      label: "factory deployment",
      transactionHash,
      outcome: "mined-success",
      gasUsed: "12345",
      contractAddress,
    });
    expect(Object.isFrozen(transactions[0])).to.equal(true);
  });
});
