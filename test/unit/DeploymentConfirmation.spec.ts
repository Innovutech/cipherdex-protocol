import { expect } from "chai";
import type { Provider } from "ethers";

import { waitForCanonicalDeploymentConfirmation } from "../../scripts/deploy-protocol";
import {
  UnknownBroadcastOutcomeError,
} from "../../scripts/testnet-transaction-evidence";

const HASH = `0x${"12".repeat(32)}`;
const BLOCK_HASH = `0x${"34".repeat(32)}`;
const SIGNER = `0x${"56".repeat(20)}`;

function confirmationProvider(status: 0 | 1, heads: number[]): Provider {
  let headIndex = 0;
  const transaction = {
    hash: HASH,
    from: SIGNER,
    chainId: 1n,
    nonce: 7,
    blockHash: BLOCK_HASH,
    blockNumber: 10,
  };
  return {
    async getNetwork() { return { chainId: 1n }; },
    async getTransaction() { return transaction; },
    async getTransactionReceipt() {
      return {
        hash: HASH,
        transactionHash: HASH,
        blockHash: BLOCK_HASH,
        blockNumber: 10,
        status,
      };
    },
    async getBlock() { return { hash: BLOCK_HASH, number: 10 }; },
    async getBlockNumber() {
      const head = heads[Math.min(headIndex, heads.length - 1)]!;
      headIndex += 1;
      return head;
    },
  } as unknown as Provider;
}

async function expectError(
  promise: Promise<unknown>,
  expected: new (...args: never[]) => Error,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).to.be.instanceOf(expected);
    return;
  }
  expect.fail(`expected ${expected.name}`);
}

describe("deployment canonical confirmation", function () {
  it("waits for the reviewed confirmation depth before returning success", async function () {
    const confirmation = await waitForCanonicalDeploymentConfirmation(
      "deployment",
      HASH,
      { chainId: 1, signer: SIGNER },
      confirmationProvider(1, [10, 11]),
      { minimumConfirmations: 2, timeoutMs: 100, pollMs: 0 },
    );
    expect(confirmation).to.deep.equal({ status: 1, blockNumber: 10 });
  });

  it("returns a failed status only after canonical confirmation", async function () {
    const confirmation = await waitForCanonicalDeploymentConfirmation(
      "deployment",
      HASH,
      { chainId: 1, signer: SIGNER },
      confirmationProvider(0, [11]),
      { minimumConfirmations: 2, timeoutMs: 100, pollMs: 0 },
    );
    expect(confirmation).to.deep.equal({ status: 0, blockNumber: 10 });
  });

  it("keeps an unconfirmed deployment outcome uncertain", async function () {
    await expectError(waitForCanonicalDeploymentConfirmation(
      "deployment",
      HASH,
      { chainId: 1, signer: SIGNER },
      confirmationProvider(1, [10]),
      { minimumConfirmations: 2, timeoutMs: 1, pollMs: 0 },
    ), UnknownBroadcastOutcomeError);
  });
});
