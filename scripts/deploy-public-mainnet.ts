import { deployPublicStack } from "./deploy-public-stack";
import { safeTestnetErrorSummary } from "./testnet-transaction-evidence";

void deployPublicStack("coti-mainnet").catch((error: unknown) => {
  console.error(`COTI mainnet public deployment failed: ${safeTestnetErrorSummary(error)}`);
  process.exitCode = 1;
});
