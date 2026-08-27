import { expect } from "chai";
import {
  CIPHERDEX_EXECUTION_ISSUE_CODE,
  CIPHERDEX_TRANSFER_AMOUNT_MISMATCH_SELECTOR,
  classifyCipherDexExecutionError,
  preflightCipherDexTransaction,
} from "../../sdk/src/index";

const ACCOUNT = "0x0000000000000000000000000000000000000011";
const ROUTER = "0x0000000000000000000000000000000000000022";
const TOKEN = "0x0000000000000000000000000000000000000033";

describe("SDK execution error classification", function () {
  it("classifies direct and nested transfer amount mismatches", function () {
    const context = {
      operation: "public-native-create-or-add-liquidity" as const,
      tokenAddress: TOKEN,
    };
    const direct = classifyCipherDexExecutionError({
      data: CIPHERDEX_TRANSFER_AMOUNT_MISMATCH_SELECTOR,
    }, context);
    const nested = classifyCipherDexExecutionError({
      info: {
        error: {
          data: `${CIPHERDEX_TRANSFER_AMOUNT_MISMATCH_SELECTOR}${"00".repeat(32)}`,
        },
      },
    }, context);

    expect(direct).to.deep.equal({
      code: CIPHERDEX_EXECUTION_ISSUE_CODE.TOKEN_TRANSFER_AMOUNT_MISMATCH,
      kind: "token-transfer-semantics",
      selector: CIPHERDEX_TRANSFER_AMOUNT_MISMATCH_SELECTOR,
      operation: "public-native-create-or-add-liquidity",
      stage: "execution",
      tokenAddress: TOKEN,
      retryableWithSameState: false,
      compatibilityMayChange: true,
    });
    expect(nested).to.deep.equal(direct);
    expect(Object.isFrozen(direct)).to.equal(true);
  });

  it("does not misclassify unrelated failures or invoke hostile getters", function () {
    let getterInvoked = false;
    const hostile = Object.defineProperty({}, "data", {
      enumerable: true,
      get() {
        getterInvoked = true;
        return CIPHERDEX_TRANSFER_AMOUNT_MISMATCH_SELECTOR;
      },
    });
    const context = { operation: "public-swap" as const };

    expect(classifyCipherDexExecutionError({ data: "0x12345678" }, context))
      .to.equal(null);
    expect(classifyCipherDexExecutionError(hostile, context)).to.equal(null);
    expect(getterInvoked).to.equal(false);
  });

  it("returns a structured preflight gate while preserving transaction context", async function () {
    let reviewedTransaction: unknown;
    const result = await preflightCipherDexTransaction({
      adapter: {
        async estimateGas(transaction) {
          reviewedTransaction = transaction;
          throw {
            error: { data: CIPHERDEX_TRANSFER_AMOUNT_MISMATCH_SELECTOR },
          };
        },
      },
      transaction: {
        from: ACCOUNT,
        to: ROUTER,
        data: "0x1234",
        value: 1n,
        gasLimit: 30_000_000n,
      },
      context: {
        operation: "public-native-create-or-add-liquidity",
        tokenAddress: TOKEN,
      },
    });

    expect(Object.isFrozen(reviewedTransaction)).to.equal(true);
    expect(result.ok).to.equal(false);
    if (result.ok) throw new Error("unexpected successful preflight");
    expect(result.issue).to.deep.include({
      code: "token-transfer-amount-mismatch",
      stage: "preflight",
      tokenAddress: TOKEN,
    });
  });

  it("returns successful gas estimates and preserves unknown failures", async function () {
    const success = await preflightCipherDexTransaction({
      adapter: {
        async estimateGas() {
          return 123_456n;
        },
      },
      transaction: {
        from: ACCOUNT,
        to: ROUTER,
        data: "0x",
      },
      context: { operation: "public-swap" },
    });
    expect(success).to.deep.equal({ ok: true, gasEstimate: 123_456n });

    const original = new Error("RPC unavailable");
    let caught: unknown;
    try {
      await preflightCipherDexTransaction({
        adapter: {
          async estimateGas() {
            throw original;
          },
        },
        transaction: {
          from: ACCOUNT,
          to: ROUTER,
          data: "0x",
        },
        context: { operation: "public-swap" },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).to.be.instanceOf(TypeError);
    expect((caught as Error).message).to.equal("Unable to preflight CipherDEX transaction");
    expect((caught as Error).cause).to.equal(original);
  });

  it("rejects malformed preflight requests and execution context", async function () {
    expect(() => classifyCipherDexExecutionError(
      { data: CIPHERDEX_TRANSFER_AMOUNT_MISMATCH_SELECTOR },
      { operation: "other" as "public-swap" },
    )).to.throw("Invalid CipherDEX execution operation");

    let caught: unknown;
    try {
      await preflightCipherDexTransaction({
        adapter: { async estimateGas() { return 1n; } },
        transaction: {
          from: ACCOUNT,
          to: ROUTER,
          data: "0x1",
        },
        context: { operation: "public-swap" },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).to.be.instanceOf(TypeError);
    expect((caught as Error).message).to.equal("Invalid CipherDEX preflight data");
  });
});
