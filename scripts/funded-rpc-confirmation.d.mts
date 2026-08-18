export type FundedRpcTransactionIdentity = Readonly<{
  chainId: number;
  signer: string;
  nonce: number;
  hash: string;
}>;

export type FundedRpcConfirmationProvider = Readonly<{
  getNetwork(): Promise<Readonly<{ chainId: number | bigint }>>;
  getTransaction(hash: string): Promise<null | Readonly<{
    hash: string;
    from: string;
    nonce: number;
    chainId: number | bigint;
    blockHash: string | null;
    blockNumber: number | null;
  }>>;
  getTransactionReceipt(hash: string): Promise<null | Readonly<{
    hash?: string;
    transactionHash?: string;
    status: number | bigint | null;
    blockHash: string;
    blockNumber: number;
  }>>;
  getBlock(blockNumber: number): Promise<null | Readonly<{ hash: string | null; number: number }>>;
  getBlockNumber(): Promise<number>;
}>;

export type FundedRpcInspection =
  | Readonly<{ state: "absent" | "pending" }>
  | Readonly<{
      state: "mined-unconfirmed" | "confirmed";
      status: 0 | 1;
      blockNumber: number;
      blockHash: string;
      confirmations: number;
    }>;

export function assertFundedRpcTransactionIdentity(
  transaction: unknown,
  expected: FundedRpcTransactionIdentity,
): FundedRpcTransactionIdentity;

export function inspectFundedTransaction(
  provider: FundedRpcConfirmationProvider,
  expected: FundedRpcTransactionIdentity,
  options?: Readonly<{ minimumConfirmations?: number }>,
): Promise<FundedRpcInspection>;

export const FUNDED_TRANSACTION_MINIMUM_CONFIRMATIONS: number;
