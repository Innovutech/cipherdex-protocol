import { safeTestnetErrorSummary } from "./testnet-transaction-evidence";
import { runDeploymentCommand } from "./deploy-protocol";

void runDeploymentCommand("coti-mainnet").catch((error: unknown) => {
  console.error(`COTI mainnet deployment failed: ${safeTestnetErrorSummary(error)}`);
  process.exitCode = 1;
});
