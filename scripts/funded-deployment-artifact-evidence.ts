import { getAddress } from "ethers";

import type { FundedRecoveryJournal } from "./funded-recovery-journal";

const HASH = /^0x[0-9a-fA-F]{64}$/;

type DeploymentReceiptProvider = Readonly<{
  getTransactionReceipt(hash: string): Promise<null | Readonly<{
    hash: string;
    status: number | bigint | null;
    blockNumber: number;
    contractAddress: string | null;
  }>>;
}>;

export type ConfiguredDeploymentArtifactObservation = Readonly<{
  label: string;
  address: string;
  transactionHash: string;
}>;

export async function recordConfiguredDeploymentArtifactTransactions(
  journal: Pick<FundedRecoveryJournal, "recordObservedMinedTransaction">,
  provider: DeploymentReceiptProvider,
  observations: readonly ConfiguredDeploymentArtifactObservation[],
): Promise<void> {
  if (observations.length === 0) {
    throw new Error("configured deployment evidence requires at least one artifact");
  }
  const labels = new Set<string>();
  const hashes = new Set<string>();
  for (const observation of observations) {
    if (!observation.label || !HASH.test(observation.transactionHash)) {
      throw new Error("configured deployment artifact observation is invalid");
    }
    const address = getAddress(observation.address);
    const hash = observation.transactionHash.toLowerCase();
    if (labels.has(observation.label) || hashes.has(hash)) {
      throw new Error("configured deployment artifact observations are not unique");
    }
    labels.add(observation.label);
    hashes.add(hash);
    const receipt = await provider.getTransactionReceipt(hash);
    if (
      !receipt ||
      receipt.hash.toLowerCase() !== hash ||
      BigInt(receipt.status ?? -1) !== 1n ||
      !Number.isSafeInteger(receipt.blockNumber) ||
      receipt.blockNumber < 0 ||
      receipt.contractAddress === null ||
      getAddress(receipt.contractAddress) !== address
    ) {
      throw new Error(`configured deployment artifact receipt is invalid: ${observation.label}`);
    }
    journal.recordObservedMinedTransaction(
      observation.label,
      hash,
      receipt.blockNumber,
    );
  }
}
