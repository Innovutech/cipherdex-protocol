import { expect } from "chai";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RuntimeArtifactProvenance } from "../../scripts/runtime-artifact";
import { verifyConfiguredTestnetDeployment } from "../../scripts/testnet-deployment-provenance";

describe("configured testnet deployment provenance", function () {
  const sourceCommit = "ab".repeat(20);
  const address = `0x${"12".repeat(20)}`;
  const runtimeCodehash = `0x${"34".repeat(32)}`;
  const artifact: RuntimeArtifactProvenance = Object.freeze({
    contractName: "ConfidentialCPMMFactory",
    sourceName: "contracts/ConfidentialCPMMFactory.sol",
    runtimeCodehash,
    compilerInputHash: `0x${"56".repeat(32)}`,
    solcVersion: "0.8.28",
    solcLongVersion: "0.8.28+commit.7893614a",
    settings: Object.freeze({
      evmVersion: "cancun",
      viaIR: true,
      optimizer: Object.freeze({ enabled: true, runs: 200 }),
      metadataBytecodeHash: "ipfs",
    }),
  });

  async function fixture(
    mutate: (record: Record<string, any>) => void = () => undefined,
  ): Promise<Readonly<{ cwd: string; relativePath: string }>> {
    const cwd = await mkdtemp(join(tmpdir(), "cipherdex-provenance-"));
    await mkdir(join(cwd, "deployments"));
    const relativePath = `deployments/coti-testnet-${sourceCommit}.json`;
    const record: Record<string, any> = {
      schemaVersion: 2,
      status: "complete",
      network: "cotiTestnet",
      chainId: "7082400",
      sourceCommit,
      contracts: {
        confidentialFactory: { address, runtimeCodehash },
      },
      compiler: {
        ConfidentialCPMMFactory: artifact,
      },
    };
    mutate(record);
    await writeFile(join(cwd, relativePath), `${JSON.stringify(record)}\n`, { mode: 0o600 });
    return Object.freeze({ cwd, relativePath });
  }

  async function verify(
    cwd: string,
    relativePath: string,
    options: Readonly<{ dirty?: boolean; commit?: string; actual?: RuntimeArtifactProvenance }> = {},
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
        readSourceState: async () => ({
          commit: options.commit ?? sourceCommit,
          dirty: options.dirty ?? false,
        }),
        verifyRuntime: async () => options.actual ?? artifact,
      },
    );
  }

  it("binds a complete manifest to clean source, configured address, artifact and codehash", async function () {
    const { cwd, relativePath } = await fixture();
    try {
      const record = await verify(cwd, relativePath) as { sourceCommit: string };
      expect(record.sourceCommit).to.equal(sourceCommit);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects dirty source and a different current commit", async function () {
    for (const options of [{ dirty: true }, { commit: "cd".repeat(20) }]) {
      const { cwd, relativePath } = await fixture();
      try {
        let message = "";
        try {
          await verify(cwd, relativePath, options);
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }
        expect(message).to.match(/clean source worktree|current HEAD/);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
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
