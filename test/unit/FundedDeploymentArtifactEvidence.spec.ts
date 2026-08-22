import { expect } from "chai";

import { recordConfiguredDeploymentArtifactTransactions } from "../../scripts/funded-deployment-artifact-evidence";

const HASH_A = `0x${"11".repeat(32)}`;
const HASH_B = `0x${"22".repeat(32)}`;
const ADDRESS_A = `0x${"33".repeat(20)}`;
const ADDRESS_B = `0x${"44".repeat(20)}`;

async function expectRejection(promise: Promise<unknown>, message: string): Promise<void> {
  let rejected: unknown;
  try {
    await promise;
  } catch (error) {
    rejected = error;
  }
  expect(rejected).to.be.instanceOf(Error);
  expect((rejected as Error).message).to.include(message);
}

describe("configured funded deployment artifact evidence", function () {
  it("records unique successful contract creations", async function () {
    const recorded: unknown[] = [];
    const receipts = new Map([
      [HASH_A, { hash: HASH_A, status: 1, blockNumber: 10, contractAddress: ADDRESS_A }],
      [HASH_B, { hash: HASH_B, status: 1n, blockNumber: 11, contractAddress: ADDRESS_B }],
    ]);
    await recordConfiguredDeploymentArtifactTransactions(
      {
        recordObservedMinedTransaction(label, hash, blockNumber) {
          recorded.push({ label, hash, blockNumber });
        },
      },
      { getTransactionReceipt: async (hash) => receipts.get(hash) ?? null },
      [
        { label: "factory deployment", address: ADDRESS_A, transactionHash: HASH_A },
        { label: "router deployment", address: ADDRESS_B, transactionHash: HASH_B },
      ],
    );
    expect(recorded).to.deep.equal([
      { label: "factory deployment", hash: HASH_A, blockNumber: 10 },
      { label: "router deployment", hash: HASH_B, blockNumber: 11 },
    ]);
  });

  it("rejects duplicate observations", async function () {
    await expectRejection(recordConfiguredDeploymentArtifactTransactions(
      { recordObservedMinedTransaction() {} },
      {
        getTransactionReceipt: async () => ({
          hash: HASH_A,
          status: 1,
          blockNumber: 10,
          contractAddress: ADDRESS_A,
        }),
      },
      [
        { label: "factory deployment", address: ADDRESS_A, transactionHash: HASH_A },
        { label: "factory deployment", address: ADDRESS_B, transactionHash: HASH_B },
      ],
    ), "configured deployment artifact observations are not unique");
  });

  it("rejects absent, failed, or mismatched creation receipts", async function () {
    const observation = [
      { label: "factory deployment", address: ADDRESS_A, transactionHash: HASH_A },
    ];
    for (const receipt of [
      null,
      { hash: HASH_A, status: 0, blockNumber: 10, contractAddress: ADDRESS_A },
      { hash: HASH_A, status: 1, blockNumber: 10, contractAddress: ADDRESS_B },
    ]) {
      await expectRejection(recordConfiguredDeploymentArtifactTransactions(
        { recordObservedMinedTransaction() {} },
        { getTransactionReceipt: async () => receipt },
        observation,
      ), "configured deployment artifact receipt is invalid");
    }
  });
});
