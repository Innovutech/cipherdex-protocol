import { ethers } from "../hardhat/runtime.js";

import {
  createFundedSuiteEvidence,
  readRequiredFundedRuns,
  verifyFundedSuiteRuns,
  verifyFundedSuiteSources,
} from "./funded-suite-evidence";
import { createFundedDeploymentBinding } from "./funded-deployment-binding";
import { fundedSuiteOutputPath } from "./funded-suite-output";
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
  const runs = readRequiredFundedRuns(sourceCommit);
  const suite = createFundedSuiteEvidence({
    sourceCommit,
    chainId: Number(deployment.chainId),
    deployment: await createFundedDeploymentBinding(deployment),
    runs,
  });
  await verifyFundedSuiteRuns(suite, ethers.provider);
  await verifyFundedSuiteSources(suite);

  const publicRepositoryRoot = process.env.CIPHERDEX_PUBLIC_REPOSITORY_ROOT?.trim();
  if (!publicRepositoryRoot) {
    throw new Error("funded finalization requires the public repository root");
  }
  const path = fundedSuiteOutputPath(publicRepositoryRoot, sourceCommit);
  writeUtf8FileAtomic(path, `${JSON.stringify(suite, null, 2)}\n`);
  console.log(`Final funded suite evidence written to evidence/coti-testnet-${sourceCommit}.json`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "funded evidence finalization failed");
  process.exitCode = 1;
});
