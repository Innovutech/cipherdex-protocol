import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import { ethers } from "hardhat";

import {
  readFundedSuiteEvidence,
  verifyFundedSuiteRuns,
  verifyFundedSuiteSources,
} from "./funded-suite-evidence";
import {
  createFundedDeploymentBinding,
  sameFundedDeploymentBinding,
} from "./funded-deployment-binding";
import {
  requiredTestnetDeploymentRecordPath,
  verifyConfiguredTestnetDeployment,
} from "./testnet-deployment-provenance";

function requiredEvidencePath(): string {
  const value = process.env.CIPHERDEX_FUNDED_EVIDENCE_RECORD?.trim();
  if (!value || !/^evidence[\\/]coti-testnet-[0-9a-f]{40}\.json$/.test(value)) {
    throw new Error(
      "CIPHERDEX_FUNDED_EVIDENCE_RECORD must be evidence/coti-testnet-<commit>.json",
    );
  }
  return value;
}

async function main(): Promise<void> {
  const suitePath = resolve(requiredEvidencePath());
  const suite = readFundedSuiteEvidence(suitePath);
  const configuredPath = requiredTestnetDeploymentRecordPath();
  if (relative(process.cwd(), resolve(configuredPath)).replaceAll("\\", "/") !==
      suite.deployment.recordPath) {
    throw new Error("funded suite points to a different deployment manifest");
  }
  const rawRecord = JSON.parse(readFileSync(resolve(configuredPath), "utf8")) as Record<string, unknown>;
  const contracts = rawRecord.contracts as Record<string, unknown> | undefined;
  const feeVault = contracts?.feeVault as Record<string, unknown> | undefined;
  const address = feeVault?.address;
  if (typeof address !== "string" || !ethers.isAddress(address)) {
    throw new Error("deployment record fee vault address is invalid");
  }
  const deployment = await verifyConfiguredTestnetDeployment(
    configuredPath,
    ethers.provider,
    [{
      recordKey: "feeVault",
      contractName: "CipherDEXFeeVault",
      address,
    }],
  );
  if (
    deployment.sourceCommit !== suite.sourceCommit ||
    Number(deployment.chainId) !== suite.chainId ||
    !sameFundedDeploymentBinding(
      await createFundedDeploymentBinding(deployment),
      suite.deployment,
    )
  ) throw new Error("funded suite deployment provenance does not match the tracked manifest");
  await verifyFundedSuiteRuns(suite, ethers.provider);
  await verifyFundedSuiteSources(suite);
  console.log(`Funded suite evidence verified: ${suitePath}`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "funded evidence verification failed");
  process.exitCode = 1;
});
