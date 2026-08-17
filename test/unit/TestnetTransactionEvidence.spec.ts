import { expect } from "chai";

import {
  MinedTransactionStatusError,
  publicTransactionHashSuffix,
  requireMinedFailure,
  requireMinedSuccess,
  safeTestnetErrorSummary,
  transactionHashFromError,
  UnknownBroadcastOutcomeError,
} from "../../scripts/testnet-transaction-evidence";

describe("funded testnet transaction evidence", function () {
  const failedReceipt = { status: 0 as number | null };
  const successfulReceipt = { status: 1 as number | null };
  const hash = `0x${"12".repeat(32)}`;

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

  it("reconciles an error-carried hash before classifying the outcome", async function () {
    const result = await requireMinedFailure(
      "expected rejection",
      async () => {
        throw { info: { error: { transactionHash: hash } } };
      },
      async (candidate) => candidate === hash ? failedReceipt : null,
    );
    expect(result.transactionHash).to.equal(hash);
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

    const sendReconciled = await requireMinedSuccess(
      "funded action",
      async () => { throw { cause: { transactionHash: hash } }; },
      async (candidate) => candidate === hash ? successfulReceipt : null,
    );
    expect(sendReconciled.transactionHash).to.equal(hash);
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
});
