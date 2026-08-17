import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { promisify } from "node:util";

import type { VerifiedTestnetDeploymentRecord } from "./testnet-deployment-provenance";
import { trustedGitExecutable } from "./trusted-git";

const execFileAsync = promisify(execFile);
const COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const RECORD_PATH = /^deployments\/coti-testnet-([0-9a-f]{40})\.json$/;

export type FundedDeploymentBinding = Readonly<{
  recordPath: string;
  recordSha256: string;
  manifestCommit: string;
  sourceCommit: string;
}>;

export function validateFundedDeploymentBinding(value: unknown): FundedDeploymentBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("funded deployment binding is not an object");
  }
  const binding = value as Partial<FundedDeploymentBinding>;
  const normalizedPath = binding.recordPath?.replaceAll("\\", "/") ?? "";
  const match = RECORD_PATH.exec(normalizedPath);
  if (
    !match ||
    typeof binding.recordSha256 !== "string" ||
    !SHA256.test(binding.recordSha256) ||
    typeof binding.manifestCommit !== "string" ||
    !COMMIT.test(binding.manifestCommit) ||
    typeof binding.sourceCommit !== "string" ||
    !COMMIT.test(binding.sourceCommit) ||
    match[1] !== binding.sourceCommit
  ) {
    throw new Error("funded deployment binding has invalid provenance");
  }
  return Object.freeze({
    recordPath: normalizedPath,
    recordSha256: binding.recordSha256,
    manifestCommit: binding.manifestCommit,
    sourceCommit: binding.sourceCommit,
  });
}

export async function createFundedDeploymentBinding(
  deployment: VerifiedTestnetDeploymentRecord,
  cwd = process.cwd(),
): Promise<FundedDeploymentBinding> {
  const recordPath = relative(resolve(cwd), resolve(deployment.path)).replaceAll("\\", "/");
  const manifest = await execFileAsync(
    trustedGitExecutable(process.env, cwd),
    ["log", "-1", "--format=%H", "--", recordPath],
    { cwd },
  );
  const manifestCommit = manifest.stdout.trim().toLowerCase();
  const recordSha256 = createHash("sha256")
    .update(readFileSync(resolve(deployment.path)))
    .digest("hex");
  return validateFundedDeploymentBinding({
    recordPath,
    recordSha256,
    manifestCommit,
    sourceCommit: deployment.sourceCommit.toLowerCase(),
  });
}

export function sameFundedDeploymentBinding(
  left: FundedDeploymentBinding,
  right: FundedDeploymentBinding,
): boolean {
  return JSON.stringify(validateFundedDeploymentBinding(left)) ===
    JSON.stringify(validateFundedDeploymentBinding(right));
}
