export type HeldSignerLease = Readonly<{
  chainId: number;
  signer: string;
  leasePath: string;
  statePath: string;
  token: string;
  release(): void;
}>;

export const ACTIVE_SIGNER_LEASES_ENVIRONMENT: string;
export function acquireRepositoryExecutionLease(repositoryRoot: string): Readonly<{
  path: string;
  token: string;
  release(): void;
}>;
export function acquireSignerExecutionLeases(
  chainId: number,
  signers: readonly string[],
): readonly HeldSignerLease[];
export function signerLeaseEnvironment(leases: readonly HeldSignerLease[]): string;
export function assertSoleRecoverableSignerTransaction(
  leases: readonly HeldSignerLease[],
  expectedHash: string,
): void;
export function reconcileSignerExecutionLeases(
  leases: readonly HeldSignerLease[],
  inspectTransaction: (
    lease: HeldSignerLease,
    transaction: Readonly<{
      hash: string;
      nonce: number;
      status: "prepared" | "broadcast" | "outcome-unknown";
      blockNumber?: number;
      updatedAt: string;
    }>,
  ) => Promise<
    | Readonly<{ state: "absent" | "pending" }>
    | Readonly<{
        state: "mined-unconfirmed" | "confirmed";
        status: 0 | 1;
        blockNumber: number;
        blockHash: string;
        confirmations: number;
      }>
  >,
): Promise<void>;
export function recordPreparedSignerTransaction(input: Readonly<{
  chainId: number;
  signer: string;
  nonce: number;
  hash: string;
}>): void;
export function recordSignerTransactionStatus(
  chainId: number,
  signer: string,
  hash: string,
  status: "prepared" | "broadcast" | "outcome-unknown" | "mined-success" | "mined-failure",
  blockNumber?: number,
): void;
export function recordPreparedSignerTransactionAbandoned(
  chainId: number,
  signer: string,
  hash: string,
): void;
export function readSignerTransactionState(chainId: number, signer: string): Readonly<{
  schema: string;
  chainId: number;
  signer: string;
  transactions: readonly Readonly<{
    hash: string;
    nonce: number;
    status:
      | "prepared"
      | "broadcast"
      | "outcome-unknown"
      | "abandoned-prebroadcast"
      | "mined-success"
      | "mined-failure";
    blockNumber?: number;
    updatedAt: string;
  }>[];
}>;
