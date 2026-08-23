import { FileHandle, lstat, mkdir, open, realpath } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";

const SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}$/i;

export type DeploymentJournalTransaction = Readonly<{
  label: string;
  transactionHash: string;
  outcome:
    | "mined-success"
    | "mined-failure"
    | "outcome-unknown"
    | "post-mined-error"
    | "local-failure";
  gasUsed: string | null;
  contractAddress?: string;
}>;

export type MinedDeploymentEvidence = Readonly<{
  label: string;
  address?: string;
  transactionHash: string;
  gasUsed: string | null;
}>;

export function upsertMinedDeploymentTransaction(
  transactions: DeploymentJournalTransaction[],
  evidence: MinedDeploymentEvidence,
): void {
  const index = transactions.findIndex(
    (entry) => entry.transactionHash.toLowerCase() === evidence.transactionHash.toLowerCase(),
  );
  const existing = index >= 0 ? transactions[index] : undefined;
  const next = Object.freeze({
    label: existing?.label ?? evidence.label,
    transactionHash: existing?.transactionHash ?? evidence.transactionHash,
    outcome: "mined-success" as const,
    gasUsed: existing?.gasUsed ?? evidence.gasUsed,
    ...(existing?.contractAddress || evidence.address
      ? { contractAddress: existing?.contractAddress ?? evidence.address }
      : {}),
  });
  if (index >= 0) {
    transactions[index] = next;
  } else {
    transactions.push(next);
  }
}

export function resolveNewDeploymentRecordPath(
  outputPath: string,
  sourceCommit: string,
  cwd = process.cwd(),
  networkSlug = "coti-testnet",
): Readonly<{ deploymentRoot: string; resolvedOutput: string }> {
  if (!SOURCE_COMMIT_PATTERN.test(sourceCommit)) {
    throw new Error("deployment record source commit must be a full Git commit");
  }
  const normalizedPath = outputPath.replaceAll("\\", "/");
  if (!normalizedPath.startsWith("deployments/")) {
    throw new Error("COTI_DEPLOYMENT_RECORD must stay under deployments/");
  }

  const deploymentRoot = resolve(cwd, "deployments");
  const resolvedOutput = resolve(cwd, outputPath);
  const relativeOutput = relative(deploymentRoot, resolvedOutput).replaceAll("\\", "/");
  if (!/^[a-z0-9-]+$/u.test(networkSlug)) {
    throw new Error("deployment record network slug is invalid");
  }
  if (
    relativeOutput.includes("/") ||
    basename(relativeOutput).toLowerCase() !== `${networkSlug}-${sourceCommit.toLowerCase()}.json` ||
    dirname(resolvedOutput) !== deploymentRoot
  ) {
    throw new Error(
      `COTI_DEPLOYMENT_RECORD must be a unique deployments/${networkSlug}-<commit>.json file`,
    );
  }
  return Object.freeze({ deploymentRoot, resolvedOutput });
}

export class DeploymentRecordWriter {
  readonly outputPath: string;
  readonly #handle: FileHandle;
  #closed = false;

  private constructor(outputPath: string, handle: FileHandle) {
    this.outputPath = outputPath;
    this.#handle = handle;
  }

  static async reserve(
    outputPath: string,
    sourceCommit: string,
    reservation: Record<string, unknown>,
    cwd = process.cwd(),
    networkSlug = "coti-testnet",
  ): Promise<DeploymentRecordWriter> {
    const resolved = resolveNewDeploymentRecordPath(
      outputPath,
      sourceCommit,
      cwd,
      networkSlug,
    );
    await mkdir(resolved.deploymentRoot, { recursive: true });
    const rootStat = await lstat(resolved.deploymentRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error("deployments path must be a real directory");
    }
    const [realRoot, realParent] = await Promise.all([
      realpath(resolved.deploymentRoot),
      realpath(dirname(resolved.resolvedOutput)),
    ]);
    if (realRoot !== realParent) {
      throw new Error("deployment record parent escaped the deployments directory");
    }

    let handle: FileHandle;
    try {
      handle = await open(resolved.resolvedOutput, "wx", 0o600);
    } catch (error) {
      throw new Error("deployment record already exists or cannot be reserved", {
        cause: error,
      });
    }
    const writer = new DeploymentRecordWriter(resolved.resolvedOutput, handle);
    try {
      await writer.write({ ...reservation, status: "reserved" });
      return writer;
    } catch (error) {
      await writer.close();
      throw error;
    }
  }

  async write(record: Record<string, unknown>): Promise<void> {
    if (this.#closed) throw new Error("deployment record writer is closed");
    const body = `${JSON.stringify(record, null, 2)}\n`;
    await this.#handle.write(body, 0, "utf8");
    await this.#handle.truncate(Buffer.byteLength(body));
    await this.#handle.sync();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#handle.close();
  }
}
