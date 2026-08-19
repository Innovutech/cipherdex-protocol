import { expect } from "chai";

import {
  futureChainDeadline,
  MinedFailureReasonError,
  MinedTransactionStatusError,
  publicTransactionHashSuffix,
  requireMinedFailure,
  requireMinedFailureSelector,
  requireMinedSuccess,
  safeTestnetErrorSummary,
  transactionHashFromError,
  UnknownBroadcastOutcomeError,
} from "../../scripts/testnet-transaction-evidence";
import {
  validateFundedTransactionFeePolicy,
  type FundedFeePolicy,
} from "../../scripts/funded-transaction-wallet";

describe("funded testnet transaction evidence", function () {
  const hash = `0x${"12".repeat(32)}`;
  const otherHash = `0x${"34".repeat(32)}`;
  const failedReceipt = { hash, status: 0 as number | null };
  const successfulReceipt = { hash, status: 1 as number | null };

  it("derives bounded deadlines from chain time", function () {
    expect(futureChainDeadline(1_000, 3_600)).to.equal(4_600n);
    expect(() => futureChainDeadline(1_000, 0)).to.throw("must be positive");
    expect(() => futureChainDeadline(Number.NaN, 1)).to.throw("safe integers");
    expect(() => futureChainDeadline((1n << 64n) - 1n, 1n)).to.throw("exceeds uint64");
  });

  it("proves the exact selector behind an expected mined failure", async function () {
    const expectedSelector = "0x12345678";
    const transaction = {
      hash,
      from: "0x0000000000000000000000000000000000000001",
      to: "0x0000000000000000000000000000000000000002",
      data: "0xabcdef01",
      value: 0n,
    };
    let replayBlock = -1;
    expect(await requireMinedFailureSelector(
      "price-bound rejection",
      hash,
      100,
      expectedSelector,
      async () => transaction,
      async (_transaction, blockTag) => {
        replayBlock = blockTag;
        throw { info: { error: { data: `${expectedSelector}${"00".repeat(32)}` } } };
      },
    )).to.equal("matched");
    expect(replayBlock).to.equal(99);

    let captured: unknown;
    try {
      await requireMinedFailureSelector(
        "price-bound rejection",
        hash,
        100,
        expectedSelector,
        async () => transaction,
        async () => { throw { data: "0x87654321" }; },
      );
    } catch (error) {
      captured = error;
    }
    expect(captured).to.be.instanceOf(MinedFailureReasonError);
    expect(captured).to.include({
      transactionHash: hash,
      expectedSelector,
      actualSelector: "0x87654321",
    });

    expect(await requireMinedFailureSelector(
      "opaque COTI rejection",
      hash,
      100,
      expectedSelector,
      async () => transaction,
      async () => { throw { data: null }; },
      { allowUnavailable: true },
    )).to.equal("rpc-unavailable");

    let strictOpaqueFailure: unknown;
    try {
      await requireMinedFailureSelector(
        "strict opaque rejection",
        hash,
        100,
        expectedSelector,
        async () => transaction,
        async () => { throw { data: null }; },
      );
    } catch (error) {
      strictOpaqueFailure = error;
    }
    expect(strictOpaqueFailure).to.be.instanceOf(MinedFailureReasonError);
  });

  it("accepts only a mined failure receipt", async function () {
    const result = await requireMinedFailure(
      "expected rejection",
      async () => ({ hash, wait: async () => failedReceipt }),
      async () => null,
    );
    expect(result).to.deep.equal({ transactionHash: hash, receipt: failedReceipt });

    let captured: unknown;
    try {
      await requireMinedFailure(
        "expected rejection",
        async () => ({ hash, wait: async () => successfulReceipt }),
        async () => null,
      );
    } catch (error) {
      captured = error;
    }
    expect(captured).to.be.instanceOf(MinedTransactionStatusError);
    expect(captured).to.include({
      transactionHash: hash,
      expectedStatus: 0,
      actualStatus: 1,
    });
    expect((captured as Error).message).to.include(`transactionHash=${hash}`);
  });

  it("never treats an error-carried hash as evidence for the attempted operation", async function () {
    let receiptLookups = 0;
    const journaled: string[] = [];
    let captured: unknown;
    try {
      await requireMinedFailure(
        "expected rejection",
        async () => {
          throw { info: { error: { transactionHash: hash } } };
        },
        async () => {
          receiptLookups += 1;
          return failedReceipt;
        },
        (transactionHash) => {
          journaled.push(transactionHash);
        },
      );
    } catch (error) {
      captured = error;
    }
    expect(captured).to.be.instanceOf(UnknownBroadcastOutcomeError);
    expect((captured as UnknownBroadcastOutcomeError).transactionHash).to.equal(hash);
    expect(receiptLookups).to.equal(0);
    expect(journaled).to.deep.equal([hash]);
  });

  it("preserves a known hash when journaling an operation-level broadcast failure also fails", async function () {
    let captured: unknown;
    try {
      await requireMinedSuccess(
        "funded action",
        async () => { throw { cause: { transactionHash: hash } }; },
        async () => null,
        () => { throw new Error("disk unavailable"); },
      );
    } catch (error) {
      captured = error;
    }
    expect(captured).to.be.instanceOf(UnknownBroadcastOutcomeError);
    expect((captured as UnknownBroadcastOutcomeError).transactionHash).to.equal(hash);
    expect((captured as Error & { cause?: unknown }).cause).to.be.instanceOf(AggregateError);
  });

  it("fails closed on an indeterminate send or wait outcome", async function () {
    for (const { operation, expectedMessage } of [
      {
        operation: async () => { throw new Error("connection reset"); },
        expectedMessage: "expected rejection broadcast outcome is unknown; transaction hash unavailable; do not retry automatically",
      },
      {
        operation: async () => ({
          hash,
          wait: async () => { throw new Error("connection reset"); },
        }),
        expectedMessage: `expected rejection broadcast outcome is unknown; transactionHash=${hash}; do not retry automatically`,
      },
    ]) {
      let message = "";
      try {
        await requireMinedFailure("expected rejection", operation, async () => null);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).to.equal(expectedMessage);
    }
  });

  it("accepts and reconciles only a mined success receipt", async function () {
    const direct = await requireMinedSuccess(
      "funded action",
      async () => ({ hash, wait: async () => successfulReceipt }),
      async () => null,
    );
    expect(direct).to.deep.equal({ transactionHash: hash, receipt: successfulReceipt });

    const reconciled = await requireMinedSuccess(
      "funded action",
      async () => ({
        hash,
        wait: async () => { throw new Error("connection reset"); },
      }),
      async (candidate) => candidate === hash ? successfulReceipt : null,
    );
    expect(reconciled.transactionHash).to.equal(hash);

    let sendError: unknown;
    try {
      await requireMinedSuccess(
        "funded action",
        async () => { throw { cause: { transactionHash: hash } }; },
        async () => successfulReceipt,
      );
    } catch (error) {
      sendError = error;
    }
    expect(sendError).to.be.instanceOf(UnknownBroadcastOutcomeError);
    expect((sendError as UnknownBroadcastOutcomeError).transactionHash).to.equal(hash);
  });

  it("records submission before send and broadcast before receipt waiting", async function () {
    const order: string[] = [];
    const result = await requireMinedSuccess(
      "funded action",
      async () => {
        order.push("operation");
        return {
          hash,
          wait: async () => {
            order.push("wait");
            return successfulReceipt;
          },
        };
      },
      async () => null,
      (transactionHash) => {
        expect(transactionHash).to.equal(hash);
        order.push("broadcast");
      },
      () => { order.push("submission"); },
    );
    expect(result.transactionHash).to.equal(hash);
    expect(order).to.deep.equal(["submission", "operation", "broadcast", "wait"]);
  });

  it("fails closed with the known hash when broadcast journaling fails", async function () {
    let waited = false;
    let captured: unknown;
    try {
      await requireMinedSuccess(
        "funded action",
        async () => ({
          hash,
          wait: async () => {
            waited = true;
            return successfulReceipt;
          },
        }),
        async () => null,
        () => { throw new Error("disk unavailable"); },
      );
    } catch (error) {
      captured = error;
    }
    expect(waited).to.equal(false);
    expect(captured).to.be.instanceOf(UnknownBroadcastOutcomeError);
    expect((captured as UnknownBroadcastOutcomeError).transactionHash).to.equal(hash);
  });

  it("distinguishes definite failure from uncertain successful delivery", async function () {
    let definiteFailure: unknown;
    try {
      await requireMinedSuccess(
        "funded action",
        async () => ({ hash, wait: async () => failedReceipt }),
        async () => null,
      );
    } catch (error) {
      definiteFailure = error;
    }
    expect(definiteFailure).to.be.instanceOf(MinedTransactionStatusError);
    expect(definiteFailure).to.include({
      transactionHash: hash,
      expectedStatus: 1,
      actualStatus: 0,
    });
    expect(publicTransactionHashSuffix(definiteFailure)).to.equal(
      ` transactionHash=${hash}`,
    );

    for (const { operation, expectedMessage } of [
      {
        operation: async () => { throw new Error("connection reset"); },
        expectedMessage: "funded action broadcast outcome is unknown; transaction hash unavailable; do not retry automatically",
      },
      {
        operation: async () => ({
          hash,
          wait: async () => { throw new Error("connection reset"); },
        }),
        expectedMessage: `funded action broadcast outcome is unknown; transactionHash=${hash}; do not retry automatically`,
      },
    ]) {
      let message = "";
      try {
        await requireMinedSuccess("funded action", operation, async () => null);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).to.equal(expectedMessage);
    }
  });

  it("preserves a known transaction hash on every uncertain receipt path", async function () {
    for (const operation of [
      async () => { throw { cause: { transactionHash: hash } }; },
      async () => { throw { cause: { error: { info: { transactionHash: hash } } } }; },
      async () => ({
        hash,
        wait: async () => { throw new Error("connection reset"); },
      }),
    ]) {
      let captured: unknown;
      try {
        await requireMinedSuccess("funded action", operation, async () => null);
      } catch (error) {
        captured = error;
      }
      expect(captured).to.be.instanceOf(UnknownBroadcastOutcomeError);
      expect((captured as UnknownBroadcastOutcomeError).transactionHash).to.equal(hash);
      expect((captured as Error).message).to.equal(
        `funded action broadcast outcome is unknown; transactionHash=${hash}; do not retry automatically`,
      );
    }
  });

  it("rejects funded fee envelopes above reviewed per-gas and total caps", function () {
    const policy: FundedFeePolicy = {
      maxFeePerGasWei: 10n,
      maxPriorityFeePerGasWei: 2n,
      maxTransactionFeeWei: 100n,
    };
    expect(() => validateFundedTransactionFeePolicy({
      gasLimit: 10n,
      maxFeePerGas: 10n,
      maxPriorityFeePerGas: 2n,
    }, policy)).not.to.throw();
    expect(() => validateFundedTransactionFeePolicy({
      gasLimit: 10n,
      maxFeePerGas: 11n,
      maxPriorityFeePerGas: 2n,
    }, policy)).to.throw("fee per gas exceeds");
    expect(() => validateFundedTransactionFeePolicy({
      gasLimit: 11n,
      maxFeePerGas: 10n,
      maxPriorityFeePerGas: 2n,
    }, policy)).to.throw("maximum network fee exceeds");
    expect(() => validateFundedTransactionFeePolicy({
      gasLimit: 10n,
      gasPrice: 10n,
      maxFeePerGas: 10n,
      maxPriorityFeePerGas: 2n,
    }, policy)).to.throw("exactly one reviewed fee model");
  });

  it("rejects missing, partial, and excessive priority fee envelopes", function () {
    const policy: FundedFeePolicy = {
      maxFeePerGasWei: 10n,
      maxPriorityFeePerGasWei: 2n,
      maxTransactionFeeWei: 100n,
    };
    expect(() => validateFundedTransactionFeePolicy({ gasLimit: 10n }, policy))
      .to.throw("exactly one reviewed fee model");
    expect(() => validateFundedTransactionFeePolicy({
      gasLimit: 10n,
      maxFeePerGas: 10n,
    }, policy)).to.throw("requires both fee fields");
    expect(() => validateFundedTransactionFeePolicy({
      gasLimit: 10n,
      maxFeePerGas: 10n,
      maxPriorityFeePerGas: 3n,
    }, policy)).to.throw("priority fee exceeds the reviewed cap");
  });

  it("rejects a receipt whose hash does not match the returned transaction", async function () {
    let captured: unknown;
    try {
      await requireMinedSuccess(
        "funded action",
        async () => ({
          hash,
          wait: async () => ({ hash: otherHash, status: 1 }),
        }),
        async () => null,
      );
    } catch (error) {
      captured = error;
    }
    expect(captured).to.be.instanceOf(UnknownBroadcastOutcomeError);
    expect((captured as UnknownBroadcastOutcomeError).transactionHash).to.equal(hash);
  });

  it("handles cyclic error wrappers without losing a reachable hash", async function () {
    const wrapped: { cause?: unknown; context?: unknown } = {};
    wrapped.cause = wrapped;
    wrapped.context = { nested: { transactionHash: hash } };
    let captured: unknown;
    try {
      await requireMinedSuccess(
        "funded action",
        async () => { throw wrapped; },
        async () => null,
      );
    } catch (error) {
      captured = error;
    }
    expect(captured).to.be.instanceOf(UnknownBroadcastOutcomeError);
    expect((captured as UnknownBroadcastOutcomeError).transactionHash).to.equal(hash);
  });

  it("preserves hashes through deep and wide error graphs without invoking getters", async function () {
    let deep: Record<string, unknown> = { transactionHash: hash };
    for (let index = 0; index < 100; index += 1) deep = { cause: deep };

    const wide: Record<string, unknown> = {};
    for (let index = 0; index < 100; index += 1) wide[`sibling${index}`] = {};
    wide.late = { nested: { transactionHash: hash } };
    Object.defineProperty(wide, "hostile", {
      enumerable: true,
      get() {
        throw new Error("getter must not execute");
      },
    });

    for (const wrapped of [deep, wide]) {
      let captured: unknown;
      try {
        await requireMinedSuccess(
          "funded action",
          async () => { throw wrapped; },
          async () => null,
        );
      } catch (error) {
        captured = error;
      }
      expect(captured).to.be.instanceOf(UnknownBroadcastOutcomeError);
      expect((captured as UnknownBroadcastOutcomeError).transactionHash).to.equal(hash);
    }
  });

  it("extracts only validated public transaction hashes for sanitized diagnostics", function () {
    const wrapped = {
      cause: { info: { transactionHash: hash } },
      hash: "0x1234",
    };
    expect(transactionHashFromError(wrapped)).to.equal(hash);
    expect(publicTransactionHashSuffix(wrapped)).to.equal(` transactionHash=${hash}`);
    expect(transactionHashFromError({ transactionHash: "secret" })).to.equal(undefined);
    expect(publicTransactionHashSuffix({ transactionHash: "secret" })).to.equal("");
  });

  it("does not journal an uncorroborated generic hash from an operation error", async function () {
    const journaled: string[] = [];
    let captured: unknown;
    try {
      await requireMinedSuccess(
        "funded action",
        async () => { throw { cause: { receipt: { hash } } }; },
        async () => null,
        (transactionHash) => {
          journaled.push(transactionHash);
        },
      );
    } catch (error) {
      captured = error;
    }

    expect(captured).to.be.instanceOf(UnknownBroadcastOutcomeError);
    expect((captured as UnknownBroadcastOutcomeError).transactionHash).to.equal(undefined);
    expect(transactionHashFromError({ cause: { receipt: { hash } } })).to.equal(undefined);
    expect(journaled).to.deep.equal([]);
  });

  it("redacts external payloads while preserving a known transaction hash", function () {
    const error: Record<string, unknown> = {
      name: "CALL_EXCEPTION",
      code: "UNKNOWN_ERROR",
      shortMessage: `reverted data=0x${"ab".repeat(64)} amount=123456`,
      cause: { transactionHash: hash },
    };
    Object.defineProperty(error, "message", {
      get() {
        throw new Error("hostile getter must not execute");
      },
    });
    const summary = safeTestnetErrorSummary(error);
    expect(summary).to.include("[redacted-hex]");
    expect(summary).to.include("[redacted-decimal]");
    expect(summary).to.include(`transactionHash=${hash}`);
    expect(summary).not.to.include("abababab");
  });

  it("summarizes aggregate causes without evaluating hostile properties", function () {
    const nested: Record<string, unknown> = {
      name: "ValidationError",
      message: `binding mismatch data=0x${"cd".repeat(64)}`,
    };
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, "message", {
      get() {
        throw new Error("hostile aggregate getter must not execute");
      },
    });
    const summary = safeTestnetErrorSummary(
      new AggregateError([nested, hostile], "validation and recovery failed"),
    );

    expect(summary).to.include("errors=[");
    expect(summary).to.include("ValidationError");
    expect(summary).to.include("[redacted-hex]");
    expect(summary).not.to.include("cdcdcdcd");
  });
});
