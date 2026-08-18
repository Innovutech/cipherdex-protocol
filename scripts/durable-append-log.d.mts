export type ProcessLease = Readonly<{
  path: string;
  token: string;
  release(): void;
}>;

export function acquireProcessLease(path: string, scope: string): ProcessLease;
export function readLatestUtf8Record(path: string): string | undefined;
export function appendUtf8RecordIfUnchanged(
  path: string,
  expectedContents: string | undefined,
  contents: string,
): void;

