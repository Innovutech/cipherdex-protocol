import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { ethers } from "../hardhat/runtime.js";

import {
  createFundedSuiteEvidence,
  readRequiredFundedRuns,
  verifyFundedSuiteRuns,
  verifyFundedSuiteSources,
} from "./funded-suite-evidence";
import { createFundedDeploymentBinding } from "./funded-deployment-binding";
import { requiredFundedRecoveryDirectory } from "./funded-runtime-state";
import {
  requiredTestnetDeploymentRecordPath,
  verifyConfiguredTestnetDeployment,
} from "./testnet-deployment-provenance";
import { writeUtf8FileAtomic } from "./secure-atomic-file";

async function main(): Promise<void> {
  const configuredPath = requiredTestnetDeploymentRecordPath();
  const deployment = await verifyConfiguredTestnetDeployment(
    configuredPath,
    ethers.provider,
    [{
      recordKey: "feeVault",
      contractName: "CipherDEXFeeVault",
    }],
  );
  const sourceCommit = deployment.sourceCommit;
  const runs = readRequiredFundedRuns(
    sourceCommit,
    resolve(requiredFundedRecoveryDirectory(), "evidence"),
  );
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
  writeUtf8FileAtomic(path, `${JSON.stringify(suite, null, 2)}\n`);
  console.log(`Final funded suite evidence written to ${path}`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "funded evidence finalization failed");
  process.exitCode = 1;
});
