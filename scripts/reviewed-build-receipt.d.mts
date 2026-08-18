export type ReviewedBuildReceipt = Readonly<{
  schema: string;
  sourceCommit: string;
  sourceTreeSha256: string;
  packageLockSha256: string;
  nodeModulesSha256: string;
  artifactsSha256: string;
  typechainSha256: string;
  preparedAt: string;
}>;

export function recordReviewedBuild(
  repositoryRoot: string,
  sourceCommit: string,
  options?: Readonly<{
    trackedFiles?: readonly string[];
  }>,
): ReviewedBuildReceipt;

export function verifyReviewedBuild(
  repositoryRoot: string,
  sourceCommit: string,
  options?: Readonly<{
    trackedFiles?: readonly string[];
  }>,
): ReviewedBuildReceipt;
