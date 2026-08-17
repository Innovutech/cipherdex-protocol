import { expect } from "chai";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ethers } from "hardhat";

import { FundedRecoveryJournal } from "../../scripts/funded-recovery-journal";
import {
  readFundedRunEvidence,
  validateFundedRunEvidence,
  verifyFundedRunEvidence,
  writeFundedRunEvidence,
} from "../../scripts/funded-run-evidence";

describe("funded run evidence", function () {
  let directory: string;

  beforeEach(function () {
    directory = mkdtempSync(join(tmpdir(), "cipherdex-funded-evidence-"));
  });

  afterEach(function () {
    rmSync(directory, { recursive: true, force: true });
  });

  it("binds public run evidence to source, receipts, blocks, and runtime artifacts", async function () {
    const [owner] = await ethers.getSigners();
    const factory = await ethers.getContractFactory("MockERC20");
    const contract = await factory.deploy("Evidence Token", "EVD", 18);
    const transaction = contract.deploymentTransaction();
    expect(transaction).to.not.equal(null);
    const receipt = await transaction!.wait();
    expect(receipt?.status).to.equal(1);
    const address = await contract.getAddress();
    const sourceCommit = "a".repeat(40);
    const deployment = {
      recordPath: `deployments/coti-testnet-${sourceCommit}.json`,
      recordSha256: "b".repeat(64),
      manifestCommit: "c".repeat(40),
      sourceCommit,
    } as const;
    const journal = FundedRecoveryJournal.open({
      runner: "evidence-test",
      sourceCommit,
      chainId: 31_337,
      owner: owner.address,
      deployment,
      directory,
    });
    journal.recordBroadcast("mock deployment", transaction!.hash);
    journal.recordTransaction(transaction!.hash, "mined-success", receipt!.blockNumber);
    journal.recordResource({
      id: "mock-contract",
      kind: "disposable-contract",
      address,
      creationTransactionHash: transaction!.hash,
      metadata: { contractName: "MockERC20" },
    });
    journal.markRecovered("mock-contract");
    journal.markRun("passed");

    const result = await writeFundedRunEvidence({
      journal,
      provider: ethers.provider,
      participants: [owner.address],
      configuration: {
        chainId: 31_337,
        protocolVersion: 1,
        privacyMode: "test",
      },
      artifacts: [{
        label: "mock token",
        contractName: "MockERC20",
        address,
      }],
      assertions: ["deployment mined", "resource recovered"],
      directory: join(directory, "evidence"),
    });

    const evidence = readFundedRunEvidence(result.path);
    expect(evidence.sourceCommit).to.equal(sourceCommit);
    expect(evidence.transactions).to.have.length(1);
    expect(evidence.transactions[0].blockHash).to.match(/^0x[0-9a-f]{64}$/);
    expect(evidence.artifacts[0].runtimeCodehash).to.match(/^0x[0-9a-f]{64}$/);
    expect(evidence.recoveredResources).to.deep.equal([{
      id: "mock-contract",
      kind: "disposable-contract",
      address,
      creationTransactionHash: transaction!.hash,
    }]);
    expect(JSON.parse(readFileSync(result.path, "utf8"))).to.deep.equal(evidence);
    await verifyFundedRunEvidence(evidence, ethers.provider);
  });

  it("refuses evidence while any transaction outcome remains unresolved", async function () {
    const [owner] = await ethers.getSigners();
    const journal = FundedRecoveryJournal.open({
      runner: "unresolved-test",
      sourceCommit: "b".repeat(40),
      chainId: 31_337,
      owner: owner.address,
      deployment: {
        recordPath: `deployments/coti-testnet-${"b".repeat(40)}.json`,
        recordSha256: "c".repeat(64),
        manifestCommit: "d".repeat(40),
        sourceCommit: "b".repeat(40),
      },
      directory,
    });
    journal.recordBroadcast("unknown transaction", `0x${"12".repeat(32)}`);
    journal.markRun("passed");

    let error: unknown;
    try {
      await writeFundedRunEvidence({
        journal,
        provider: ethers.provider,
        participants: [owner.address],
        configuration: { chainId: 31_337 },
        artifacts: [{
          label: "unavailable artifact",
          contractName: "MockERC20",
          address: owner.address,
        }],
        assertions: ["must not write"],
        directory: join(directory, "evidence"),
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.contain("unresolved transactions");
  });

  it("refuses evidence before the journal is passed even after recovery", async function () {
    const [owner] = await ethers.getSigners();
    const journal = FundedRecoveryJournal.open({
      runner: "evidence-test",
      sourceCommit: "d".repeat(40),
      chainId: 31_337,
      owner: owner.address,
      deployment: {
        recordPath: `deployments/coti-testnet-${"d".repeat(40)}.json`,
        recordSha256: "e".repeat(64),
        manifestCommit: "f".repeat(40),
        sourceCommit: "d".repeat(40),
      },
      directory,
    });
    let error: unknown;
    try {
      await writeFundedRunEvidence({
        journal,
        provider: ethers.provider,
        participants: [owner.address],
        configuration: { chainId: 31_337, privacyMode: "test", protocolVersion: 1 },
        artifacts: [],
        assertions: ["deployment mined", "resource recovered"],
        directory: join(directory, "evidence"),
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.contain("marked passed");
  });

  it("rejects tampered participants, targets, and semantic assertions", async function () {
    const [owner] = await ethers.getSigners();
    const factory = await ethers.getContractFactory("MockERC20");
    const contract = await factory.deploy("Evidence Token", "EVD", 18);
    const transaction = contract.deploymentTransaction()!;
    const receipt = await transaction.wait();
    const address = await contract.getAddress();
    const sourceCommit = "1".repeat(40);
    const journal = FundedRecoveryJournal.open({
      runner: "evidence-test",
      sourceCommit,
      chainId: 31_337,
      owner: owner.address,
      deployment: {
        recordPath: `deployments/coti-testnet-${sourceCommit}.json`,
        recordSha256: "2".repeat(64),
        manifestCommit: "3".repeat(40),
        sourceCommit,
      },
      directory,
    });
    journal.recordBroadcast("mock deployment", transaction.hash);
    journal.recordTransaction(transaction.hash, "mined-success", receipt!.blockNumber);
    journal.recordResource({
      id: "mock-contract",
      kind: "disposable-contract",
      address,
      creationTransactionHash: transaction.hash,
      metadata: { contractName: "MockERC20" },
    });
    journal.markRecovered("mock-contract");
    journal.markRun("passed");
    const { evidence } = await writeFundedRunEvidence({
      journal,
      provider: ethers.provider,
      participants: [owner.address],
      configuration: { chainId: 31_337, privacyMode: "test", protocolVersion: 1 },
      artifacts: [{ label: "mock token", contractName: "MockERC20", address }],
      assertions: ["deployment mined", "resource recovered"],
      directory: join(directory, "evidence"),
    });
    const clone = () => JSON.parse(JSON.stringify(evidence));

    const unreviewedSender = clone();
    unreviewedSender.transactions[0].from = `0x${"44".repeat(20)}`;
    expect(() => validateFundedRunEvidence(unreviewedSender)).to.throw(
      "sender is not a reviewed participant",
    );

    const unreviewedTarget = clone();
    unreviewedTarget.transactions[0].to = `0x${"55".repeat(20)}`;
    unreviewedTarget.transactions[0].contractAddress = null;
    expect(() => validateFundedRunEvidence(unreviewedTarget)).to.throw(
      "transaction target is not reviewed",
    );

    const assertions = clone();
    assertions.assertions = ["deployment mined", "unreviewed claim"];
    expect(() => validateFundedRunEvidence(assertions)).to.throw(
      "assertions do not match runner policy",
    );
  });
});
