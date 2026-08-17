import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";

import {
  readFundedRunEvidence,
  validateFundedRunEvidence,
  verifyFundedRunEvidence,
  type FundedEvidenceProvider,
  type FundedRunEvidence,
} from "./funded-run-evidence";
import {
  sameFundedDeploymentBinding,
  validateFundedDeploymentBinding,
  type FundedDeploymentBinding,
} from "./funded-deployment-binding";

const SCHEMA = "cipherdex.funded-suite-evidence/v2" as const;
const SOURCE_COMMIT = /^[0-9a-f]{40}$/;
const REQUIRED_RUNNERS = Object.freeze([
  "best-execution-feasibility",
  "best-execution",
  "fee-collection",
  "launchpad",
]);
const REQUIRED_RUNNER_SOURCES = Object.freeze<Record<string, string>>({
  "best-execution-feasibility": "scripts/testnet-best-execution-feasibility.ts",
  "best-execution": "scripts/testnet-best-execution.ts",
  "fee-collection": "scripts/testnet-fee-collection.ts",
  "launchpad": "scripts/testnet-launchpad.ts",
});
const execFileAsync = promisify(execFile);

export type FundedSuiteEvidence = Readonly<{
  schema: typeof SCHEMA;
  sourceCommit: string;
  chainId: number;
  generatedAt: string;
  deployment: FundedDeploymentBinding;
  runs: readonly FundedRunEvidence[];
  outcome: "passed";
}>;

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(resolve(path))).digest("hex");
}

function parseSuite(value: unknown): FundedSuiteEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("funded suite evidence is not an object");
  }
  const record = value as Partial<FundedSuiteEvidence>;
  if (
    record.schema !== SCHEMA ||
    typeof record.sourceCommit !== "string" ||
    !SOURCE_COMMIT.test(record.sourceCommit) ||
    !Number.isSafeInteger(record.chainId) ||
    Number(record.chainId) <= 0 ||
    typeof record.generatedAt !== "string" ||
    Number.isNaN(Date.parse(record.generatedAt)) ||
    !record.deployment ||
    !Array.isArray(record.runs) ||
    record.outcome !== "passed"
  ) throw new Error("funded suite evidence has invalid provenance");
  const deployment = validateFundedDeploymentBinding(record.deployment);
  if (deployment.sourceCommit !== record.sourceCommit) {
    throw new Error("funded suite deployment source mismatch");
  }

  const parsedRuns = record.runs.map(validateFundedRunEvidence);
  const runners = parsedRuns.map((run) => run.runner);
  const owners = new Set(parsedRuns.map((run) => run.owner.toLowerCase()));
  const transactionHashes = parsedRuns.flatMap((run) =>
    run.transactions.map((transaction) => transaction.hash.toLowerCase())
  );
  if (
    runners.length !== REQUIRED_RUNNERS.length ||
    new Set(runners).size !== runners.length ||
    REQUIRED_RUNNERS.some((runner) => !runners.includes(runner)) ||
    owners.size !== 1 ||
    new Set(transactionHashes).size !== transactionHashes.length ||
    parsedRuns.some((run) =>
      run.sourceCommit !== record.sourceCommit ||
      run.chainId !== record.chainId ||
      run.runnerSource !== REQUIRED_RUNNER_SOURCES[run.runner] ||
      !sameFundedDeploymentBinding(run.deployment, deployment) ||
      run.outcome !== "passed"
    )
  ) throw new Error("funded suite evidence does not contain the required source-bound runs");
  return Object.freeze({
    ...(record as FundedSuiteEvidence),
    deployment,
    runs: Object.freeze(parsedRuns),
  });
}

export function createFundedSuiteEvidence(input: Readonly<{
  sourceCommit: string;
  chainId: number;
  deployment: FundedDeploymentBinding;
  runs: readonly FundedRunEvidence[];
}>): FundedSuiteEvidence {
  return parseSuite({
    schema: SCHEMA,
    sourceCommit: input.sourceCommit,
    chainId: input.chainId,
    generatedAt: new Date().toISOString(),
    deployment: input.deployment,
    runs: input.runs,
    outcome: "passed",
  });
}

export function readFundedSuiteEvidence(path: string): FundedSuiteEvidence {
  return parseSuite(JSON.parse(readFileSync(resolve(path), "utf8")));
}

export function readRequiredFundedRuns(
  sourceCommit: string,
  directory = ".testnet-state/evidence",
): readonly FundedRunEvidence[] {
  if (!SOURCE_COMMIT.test(sourceCommit)) throw new Error("invalid funded source commit");
  return REQUIRED_RUNNERS.map((runner) =>
    readFundedRunEvidence(resolve(directory, `${runner}-${sourceCommit}.json`))
  );
}

export async function verifyFundedSuiteRuns(
  suite: FundedSuiteEvidence,
  provider: FundedEvidenceProvider,
): Promise<void> {
  const parsed = parseSuite(suite);
  for (const run of parsed.runs) await verifyFundedRunEvidence(run, provider);
}

export async function verifyFundedSuiteSources(
  suite: FundedSuiteEvidence,
  cwd = process.cwd(),
): Promise<void> {
  const parsed = parseSuite(suite);
  for (const run of parsed.runs) {
    const result = await execFileAsync(
      "git",
      ["show", `${parsed.sourceCommit}:${run.runnerSource}`],
      { cwd, encoding: "buffer", maxBuffer: 5_000_000 },
    );
    const hash = createHash("sha256").update(result.stdout).digest("hex");
    if (hash !== run.runnerSourceSha256) {
      throw new Error(`funded runner source hash changed: ${run.runner}`);
    }
  }
}
