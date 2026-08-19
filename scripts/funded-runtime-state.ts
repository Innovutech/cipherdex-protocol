import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";

export function requiredFundedRecoveryDirectory(): string {
  if (process.env.CIPHERDEX_OPERATOR_LAUNCHER_ACTIVE !== "1") {
    throw new Error("funded recovery state requires the authenticated operator launcher");
  }
  const configured = process.env.CIPHERDEX_FUNDED_STATE_ROOT?.trim();
  if (!configured || !isAbsolute(configured)) {
    throw new Error("funded recovery state requires an absolute durable directory");
  }
  const stat = lstatSync(configured);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("funded recovery state must be a real directory");
  }
  return realpathSync(configured);
}
