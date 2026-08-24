import { expect } from "chai";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { RuntimeArtifactProvenance } from "../../scripts/runtime-artifact";
import {
  listTouchedPathsAcrossCommitRange,
  verifyConfiguredTestnetDeployment,
  verifyConfiguredTestnetDeploymentForRecovery,
} from "../../scripts/testnet-deployment-provenance";
import { createFundedDeploymentBinding } from "../../scripts/funded-deployment-binding";

const execFileAsync = promisify(execFile);

describe("configured testnet deployment provenance", function () {
  const sourceCommit = "ab".repeat(20);
  const evidenceCommit = "cd".repeat(20);
  const address = `0x${"12".repeat(20)}`;
  const runtimeCodehash = `0x${"34".repeat(32)}`;
  const canonicalDeployments = Object.freeze([Object.freeze({
    key: "confidentialFactory",
    contractName: "ConfidentialCPMMFactory",
  })]);
  const artifact: RuntimeArtifactProvenance = Object.freeze({
    contractName: "ConfidentialCPMMFactory",
    sourceName: "contracts/ConfidentialCPMMFactory.sol",
    runtimeCodehash,
    compilerInputHash: `0x${"56".repeat(32)}`,
    solcVersion: "0.8.28",
    solcLongVersion: "0.8.28+commit.7893614a",
    immutableReferenceCount: 0,
    settings: Object.freeze({
      evmVersion: "cancun",
      viaIR: true,
      optimizer: Object.freeze({ enabled: true, runs: 200 }),
      metadataBytecodeHash: "ipfs",
    }),
  });

  function deploymentRecord(commit = sourceCommit): Record<string, any> {
    return {
      schemaVersion: 2,
      status: "complete",
      network: "cotiTestnet",
      chainId: "7082400",
      sourceCommit: commit,
      contracts: {
        confidentialFactory: {
          address,
          runtimeCodehash,
        },
      },
      compiler: {
        ConfidentialCPMMFactory: artifact,
      },
    };
  }

  async function fixture(
    mutate: (record: Record<string, any>) => void = () => undefined,
  ): Promise<Readonly<{ cwd: string; relativePath: string }>> {
    const cwd = await mkdtemp(join(tmpdir(), "cipherdex-provenance-"));
    await mkdir(join(cwd, "deployments"));
    const relativePath = `deployments/coti-testnet-${sourceCommit}.json`;
    const record = deploymentRecord();
    mutate(record);
    await writeFile(join(cwd, relativePath), `${JSON.stringify(record)}\n`, { mode: 0o600 });
    return Object.freeze({ cwd, relativePath });
  }

  async function verify(
    cwd: string,
    relativePath: string,
    options: Readonly<{
      dirty?: boolean;
      commit?: string;
      recordCommit?: string;
      actual?: RuntimeArtifactProvenance;
    }> = {},
  ): Promise<unknown> {
    return verifyConfiguredTestnetDeployment(
      relativePath,
      { getCode: async () => "0x00" },
      [{
        recordKey: "confidentialFactory",
        contractName: "ConfidentialCPMMFactory",
        address,
      }],
      cwd,
      {
        readSourceState: async (_cwd, recordPath) => ({
          headCommit: options.commit ?? evidenceCommit,
          recordCommit: options.recordCommit ?? options.commit ?? evidenceCommit,
          dirty: options.dirty ?? false,
          recordTracked: true,
          recordMatchesHead: true,
          sourceCommitIsAncestor: true,
          changedPathsSinceSource: [recordPath],
        }),
        readImmutableRecord: async () => readFile(join(cwd, relativePath), "utf8"),
        verifyRuntime: async () => options.actual ?? artifact,
        verifyTransactions: async () => undefined,
        canonicalDeployments,
      },
    );
  }

  it("binds a tracked evidence manifest to its source, address, artifact and codehash", async function () {
    const { cwd, relativePath } = await fixture();
    try {
      const record = await verify(cwd, relativePath) as {
        sourceCommit: string;
        evidenceCommit: string;
      };
      expect(record.sourceCommit).to.equal(sourceCommit);
      expect(record.evidenceCommit).to.equal(evidenceCommit);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("parses and binds one immutable Git-object snapshot despite working-file substitution", async function () {
    const { cwd, relativePath } = await fixture();
    try {
      const immutableRecord = await readFile(join(cwd, relativePath), "utf8");
      const expectedSha256 = createHash("sha256").update(immutableRecord, "utf8").digest("hex");
      const substituted = deploymentRecord();
      substituted.contracts.confidentialFactory.address = `0x${"99".repeat(20)}`;

      const verified = await verifyConfiguredTestnetDeployment(
        relativePath,
        { getCode: async () => "0x00" },
        [{
          recordKey: "confidentialFactory",
          contractName: "ConfidentialCPMMFactory",
          address,
        }],
        cwd,
        {
          readSourceState: async (_cwd, recordPath) => {
            await writeFile(join(cwd, relativePath), JSON.stringify(substituted), "utf8");
            return {
              headCommit: evidenceCommit,
              recordCommit: evidenceCommit,
              dirty: false,
              recordTracked: true,
              recordMatchesHead: true,
              sourceCommitIsAncestor: true,
              changedPathsSinceSource: [recordPath],
            };
          },
          readImmutableRecord: async () => immutableRecord,
          verifyRuntime: async () => artifact,
          verifyTransactions: async () => undefined,
          canonicalDeployments,
        },
      );
      expect(verified.contracts.confidentialFactory?.address).to.equal(address);
      expect(verified.recordSha256).to.equal(expectedSha256);
      expect(verified.recordPath).to.equal(relativePath);
      expect(verified.manifestCommit).to.equal(evidenceCommit);

      await writeFile(join(cwd, relativePath), "{}\n", "utf8");
      expect(await createFundedDeploymentBinding(verified)).to.deep.equal({
        recordPath: relativePath,
        recordSha256: expectedSha256,
        manifestCommit: evidenceCommit,
        sourceCommit,
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects a dirty worktree and an invalid evidence commit", async function () {
    for (const options of [{ dirty: true }, { commit: "not-a-commit" }]) {
      const { cwd, relativePath } = await fixture();
      try {
        let message = "";
        try {
          await verify(cwd, relativePath, options);
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }
        expect(message).to.match(/completely clean worktree|full Git commit/);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }
  });

  it("rejects untracked, modified, non-descendant and incomplete evidence", async function () {
    const cases = [
      {
        sourceState: {
          headCommit: evidenceCommit,
          recordCommit: evidenceCommit,
          dirty: false,
          recordTracked: false,
          recordMatchesHead: false,
          sourceCommitIsAncestor: true,
          changedPathsSinceSource: [] as string[],
        },
        expected: /Git-tracked evidence/,
      },
      {
        sourceState: {
          headCommit: evidenceCommit,
          recordCommit: evidenceCommit,
          dirty: false,
          recordTracked: true,
          recordMatchesHead: false,
          sourceCommitIsAncestor: true,
          changedPathsSinceSource: [] as string[],
        },
        expected: /Git-tracked evidence/,
      },
      {
        sourceState: {
          headCommit: evidenceCommit,
          recordCommit: evidenceCommit,
          dirty: false,
          recordTracked: true,
          recordMatchesHead: true,
          sourceCommitIsAncestor: false,
          changedPathsSinceSource: [] as string[],
        },
        expected: /not an ancestor/,
      },
      {
        sourceState: {
          headCommit: evidenceCommit,
          recordCommit: evidenceCommit,
          dirty: false,
          recordTracked: true,
          recordMatchesHead: true,
          sourceCommitIsAncestor: true,
          changedPathsSinceSource: ["docs/VERIFICATION_REPORT.md"],
        },
        expected: /not added by a post-source evidence commit/,
      },
    ];

    for (const testCase of cases) {
      const { cwd, relativePath } = await fixture();
      try {
        let message = "";
        try {
          await verifyConfiguredTestnetDeployment(
            relativePath,
            { getCode: async () => "0x00" },
            [{
              recordKey: "confidentialFactory",
              contractName: "ConfidentialCPMMFactory",
              address,
            }],
            cwd,
            {
              readSourceState: async () => testCase.sourceState,
              readImmutableRecord: async () => readFile(join(cwd, relativePath), "utf8"),
              verifyRuntime: async () => artifact,
              verifyTransactions: async () => undefined,
              canonicalDeployments,
            },
          );
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }
        expect(message).to.match(testCase.expected);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }
  });

  it("allows only the tracked manifest, exact funded evidence and verification report after source", async function () {
    const { cwd, relativePath } = await fixture();
    try {
      await verifyConfiguredTestnetDeployment(
        relativePath,
        { getCode: async () => "0x00" },
        [{
          recordKey: "confidentialFactory",
          contractName: "ConfidentialCPMMFactory",
          address,
        }],
        cwd,
        {
          readSourceState: async () => ({
            headCommit: evidenceCommit,
            recordCommit: evidenceCommit,
            dirty: false,
            recordTracked: true,
            recordMatchesHead: true,
            sourceCommitIsAncestor: true,
            changedPathsSinceSource: [
              relativePath,
              `evidence/coti-testnet-${sourceCommit}.json`,
              "docs/VERIFICATION_REPORT.md",
            ],
          }),
          readImmutableRecord: async () => readFile(join(cwd, relativePath), "utf8"),
          verifyRuntime: async () => artifact,
          verifyTransactions: async () => undefined,
          canonicalDeployments,
        },
      );

      let message = "";
      try {
        await verifyConfiguredTestnetDeployment(
          relativePath,
          { getCode: async () => "0x00" },
          [{
            recordKey: "confidentialFactory",
            contractName: "ConfidentialCPMMFactory",
            address,
          }],
          cwd,
          {
            readSourceState: async () => ({
              headCommit: evidenceCommit,
              recordCommit: evidenceCommit,
              dirty: false,
              recordTracked: true,
              recordMatchesHead: true,
              sourceCommitIsAncestor: true,
              changedPathsSinceSource: [relativePath, "scripts/testnet-harness.ts"],
            }),
            readImmutableRecord: async () => readFile(join(cwd, relativePath), "utf8"),
            verifyRuntime: async () => artifact,
            verifyTransactions: async () => undefined,
            canonicalDeployments,
          },
        );
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).to.include("post-source executable or unauthorized change");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("permits authenticated ancestor-source cleanup without weakening normal execution", async function () {
    const { cwd, relativePath } = await fixture();
    const dependencies = {
      readSourceState: async (_cwd: string, recordPath: string) => ({
        headCommit: evidenceCommit,
        recordCommit: evidenceCommit,
        dirty: false,
        recordTracked: true,
        recordMatchesHead: true,
        sourceCommitIsAncestor: true,
        changedPathsSinceSource: [recordPath, "scripts/testnet-best-execution.ts"],
      }),
      readImmutableRecord: async () => readFile(join(cwd, relativePath), "utf8"),
      verifyRuntime: async () => artifact,
      verifyTransactions: async () => undefined,
      canonicalDeployments,
    };
    try {
      const recovered = await verifyConfiguredTestnetDeploymentForRecovery(
        relativePath,
        sourceCommit,
        { getCode: async () => "0x00" },
        [{
          recordKey: "confidentialFactory",
          contractName: "ConfidentialCPMMFactory",
          address,
        }],
        cwd,
        dependencies,
      );
      expect(recovered.sourceCommit).to.equal(sourceCommit);

      let mismatch = "";
      try {
        await verifyConfiguredTestnetDeploymentForRecovery(
          relativePath,
          "ef".repeat(20),
          { getCode: async () => "0x00" },
          [{
            recordKey: "confidentialFactory",
            contractName: "ConfidentialCPMMFactory",
            address,
          }],
          cwd,
          dependencies,
        );
      } catch (error) {
        mismatch = error instanceof Error ? error.message : String(error);
      }
      expect(mismatch).to.include("does not match the deployment record");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("retains executable paths changed and reverted in intermediate commits", async function () {
    const cwd = await mkdtemp(join(tmpdir(), "cipherdex-provenance-history-"));
    try {
      await mkdir(join(cwd, "scripts"));
      const executable = join(cwd, "scripts", "runner.ts");
      await writeFile(executable, "export const reviewed = true;\n", "utf8");
      await execFileAsync("git", ["init"], { cwd });
      await execFileAsync("git", ["config", "user.email", "cipherdex-test@example.invalid"], { cwd });
      await execFileAsync("git", ["config", "user.name", "CipherDEX Test"], { cwd });
      await execFileAsync("git", ["add", "scripts/runner.ts"], { cwd });
      await execFileAsync("git", ["commit", "-m", "source"], { cwd });
      const source = (await execFileAsync(
        "git",
        ["rev-parse", "--verify", "HEAD"],
        { cwd },
      )).stdout.trim();

      await writeFile(executable, "export const reviewed = false;\n", "utf8");
      await execFileAsync("git", ["add", "scripts/runner.ts"], { cwd });
      await execFileAsync("git", ["commit", "-m", "modify executable"], { cwd });
      await writeFile(executable, "export const reviewed = true;\n", "utf8");
      await execFileAsync("git", ["add", "scripts/runner.ts"], { cwd });
      await execFileAsync("git", ["commit", "-m", "revert executable"], { cwd });

      const endpointDiff = await execFileAsync(
        "git",
        ["diff", "--name-only", `${source}..HEAD`, "--", "."],
        { cwd },
      );
      expect(endpointDiff.stdout.trim()).to.equal("");
      expect(await listTouchedPathsAcrossCommitRange(cwd, source))
        .to.deep.equal(["scripts/runner.ts"]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects an ignored working-tree manifest and accepts the same record only after an evidence commit", async function () {
    const cwd = await mkdtemp(join(tmpdir(), "cipherdex-provenance-git-"));
    try {
      await mkdir(join(cwd, "deployments"));
      await mkdir(join(cwd, "docs"));
      await writeFile(join(cwd, ".gitignore"), "deployments/*.json\n", "utf8");
      await writeFile(join(cwd, "source.txt"), "reviewed source\n", "utf8");
      await execFileAsync("git", ["init"], { cwd });
      await execFileAsync("git", ["config", "user.email", "cipherdex-test@example.invalid"], { cwd });
      await execFileAsync("git", ["config", "user.name", "CipherDEX Test"], { cwd });
      await execFileAsync("git", ["add", ".gitignore", "source.txt"], { cwd });
      await execFileAsync("git", ["commit", "-m", "source"], { cwd });
      const source = (await execFileAsync(
        "git",
        ["rev-parse", "--verify", "HEAD"],
        { cwd },
      )).stdout.trim().toLowerCase();
      const relativePath = `deployments/coti-testnet-${source}.json`;
      const recordBody = `${JSON.stringify(deploymentRecord(source), null, 2)}\n`;
      await writeFile(join(cwd, relativePath), recordBody, "utf8");

      let message = "";
      try {
        await verifyConfiguredTestnetDeployment(
          relativePath,
          { getCode: async () => "0x00" },
          [{
            recordKey: "confidentialFactory",
            contractName: "ConfidentialCPMMFactory",
            address,
          }],
          cwd,
          {
            verifyRuntime: async () => artifact,
            verifyTransactions: async () => undefined,
            canonicalDeployments,
          },
        );
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).to.include("Git-tracked evidence");

      await writeFile(
        join(cwd, "docs", "VERIFICATION_REPORT.md"),
        "# Test deployment evidence\n",
        "utf8",
      );
      await execFileAsync(
        "git",
        ["add", "-f", relativePath, "docs/VERIFICATION_REPORT.md"],
        { cwd },
      );
      await execFileAsync("git", ["commit", "-m", "evidence"], { cwd });
      const evidence = (await execFileAsync(
        "git",
        ["rev-parse", "--verify", "HEAD"],
        { cwd },
      )).stdout.trim().toLowerCase();

      const verified = await verifyConfiguredTestnetDeployment(
        relativePath,
        { getCode: async () => "0x00" },
        [{
          recordKey: "confidentialFactory",
          contractName: "ConfidentialCPMMFactory",
          address,
        }],
        cwd,
        {
          verifyRuntime: async () => artifact,
          verifyTransactions: async () => undefined,
          canonicalDeployments,
        },
      );
      expect(verified.sourceCommit).to.equal(source);
      expect(verified.evidenceCommit).to.equal(evidence);
      expect(verified.manifestCommit).to.equal(evidence);

      await mkdir(join(cwd, "evidence"));
      const fundedEvidencePath = `evidence/coti-testnet-${source}.json`;
      await writeFile(join(cwd, fundedEvidencePath), "{}\n", "utf8");
      await execFileAsync("git", ["add", fundedEvidencePath], { cwd });
      await execFileAsync("git", ["commit", "-m", "funded evidence"], { cwd });
      const fundedEvidenceCommit = (await execFileAsync(
        "git",
        ["rev-parse", "--verify", "HEAD"],
        { cwd },
      )).stdout.trim().toLowerCase();

      const verifiedAfterFundedEvidence = await verifyConfiguredTestnetDeployment(
        relativePath,
        { getCode: async () => "0x00" },
        [{
          recordKey: "confidentialFactory",
          contractName: "ConfidentialCPMMFactory",
          address,
        }],
        cwd,
        {
          verifyRuntime: async () => artifact,
          verifyTransactions: async () => undefined,
          canonicalDeployments,
        },
      );
      expect(verifiedAfterFundedEvidence.evidenceCommit).to.equal(fundedEvidenceCommit);
      expect(verifiedAfterFundedEvidence.manifestCommit).to.equal(evidence);
      expect(verifiedAfterFundedEvidence.recordSha256).to.equal(verified.recordSha256);

      await writeFile(join(cwd, relativePath), `${recordBody}\n`, "utf8");
      message = "";
      try {
        await verifyConfiguredTestnetDeployment(
          relativePath,
          { getCode: async () => "0x00" },
          [{
            recordKey: "confidentialFactory",
            contractName: "ConfidentialCPMMFactory",
            address,
          }],
          cwd,
          {
            verifyRuntime: async () => artifact,
            verifyTransactions: async () => undefined,
            canonicalDeployments,
          },
        );
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).to.match(/completely clean worktree|Git-tracked evidence/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects address, runtime and compiler provenance mismatches", async function () {
    const cases = [
      {
        mutate: (record: Record<string, any>) => {
          record.contracts.confidentialFactory.address = `0x${"99".repeat(20)}`;
        },
        actual: artifact,
        expected: /configured address/,
      },
      {
        mutate: () => undefined,
        actual: { ...artifact, runtimeCodehash: `0x${"77".repeat(32)}` },
        expected: /runtime codehash/,
      },
      {
        mutate: () => undefined,
        actual: { ...artifact, compilerInputHash: `0x${"88".repeat(32)}` },
        expected: /compiler provenance/,
      },
    ];
    for (const testCase of cases) {
      const { cwd, relativePath } = await fixture(testCase.mutate);
      try {
        let message = "";
        try {
          await verify(cwd, relativePath, { actual: testCase.actual as RuntimeArtifactProvenance });
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }
        expect(message).to.match(testCase.expected);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }
  });

  it("rejects incomplete or noncanonical record paths", async function () {
    const { cwd, relativePath } = await fixture((record) => {
      record.status = "in-progress";
    });
    try {
      let incomplete = "";
      try {
        await verify(cwd, relativePath);
      } catch (error) {
        incomplete = error instanceof Error ? error.message : String(error);
      }
      expect(incomplete).to.include("complete COTI testnet v2 manifest");

      let escaped = "";
      try {
        await verify(cwd, `../${relativePath}`);
      } catch (error) {
        escaped = error instanceof Error ? error.message : String(error);
      }
      expect(escaped).to.include("must stay under deployments");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
