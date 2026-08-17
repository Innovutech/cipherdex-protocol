import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { ethers } from "hardhat";

import {
  createFundedSuiteEvidence,
  readRequiredFundedRuns,
  verifyFundedSuiteRuns,
  verifyFundedSuiteSources,
} from "./funded-suite-evidence";
import { createFundedDeploymentBinding } from "./funded-deployment-binding";
import {
  requiredTestnetDeploymentRecordPath,
  verifyConfiguredTestnetDeployment,
} from "./testnet-deployment-provenance";

function recordAddress(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("deployment record fee vault is unavailable");
  }
  const address = (value as Record<string, unknown>).address;
  if (typeof address !== "string" || !ethers.isAddress(address)) {
    throw new Error("deployment record fee vault address is invalid");
  }
  return ethers.getAddress(address);
}

async function main(): Promise<void> {
  const configuredPath = requiredTestnetDeploymentRecordPath();
  const rawRecord = JSON.parse(readFileSync(resolve(configuredPath), "utf8")) as Record<string, unknown>;
  const contracts = rawRecord.contracts as Record<string, unknown> | undefined;
  const feeVaultAddress = recordAddress(contracts?.feeVault);
  const deployment = await verifyConfiguredTestnetDeployment(
    configuredPath,
    ethers.provider,
    [{
      recordKey: "feeVault",
      contractName: "CipherDEXFeeVault",
      address: feeVaultAddress,
    }],
  );
  const sourceCommit = deployment.sourceCommit;
  const runs = readRequiredFundedRuns(sourceCommit);
  const suite = createFundedSuiteEvidence({
    sourceCommit,
    chainId: Number(deployment.chainId),
    deployment: await createFundedDeploymentBinding(deployment),
    runs,
  });
  await verifyFundedSuiteRuns(suite, ethers.provider);
  await verifyFundedSuiteSources(suite);

  const path = resolve("evidence", `coti-testnet-${sourceCommit}.json`);
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(suite, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporaryPath, path);
  console.log(`Final funded suite evidence written to ${path}`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "funded evidence finalization failed");
  process.exitCode = 1;
});
