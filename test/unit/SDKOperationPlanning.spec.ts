import { expect } from "chai";
import {
  CIPHERTRADE_CALL_GAS_LIMIT_CAPABILITY,
  WALLET_CALLS_VERSION,
  buildConfidentialAddLiquidityOperationPlan,
  buildConfidentialAddLiquidityQuoteOperationPlan,
  buildConfidentialLockLiquidityOperationPlan,
  buildConfidentialLockedPositionOperationPlan,
  buildConfidentialPositionOperationPlan,
  buildConfidentialQuoteOperationPlan,
  buildConfidentialRemoveLiquidityOperationPlan,
  buildConfidentialRemoveLiquidityQuoteOperationPlan,
  buildConfidentialSwapOperationPlan,
  buildWalletCapabilitiesRequest,
  buildWalletCallsStatusRequest,
  getWalletCallBatchSupport,
  normalizeWalletCallsStatus,
  parseWalletSendCallsResult,
  prepareWalletCallExecution,
} from "../../sdk/src/index";

const CHAIN_ID = 2_632_500n;
const CHAIN_HEX = `0x${CHAIN_ID.toString(16)}`;
const ACCOUNT = "0x0000000000000000000000000000000000000011";
const TOKEN = "0x0000000000000000000000000000000000000022";
const POOL = "0x0000000000000000000000000000000000000033";
const BATCH_ID = `0x${"44".repeat(32)}`;
const BLOCK_HASH = `0x${"55".repeat(32)}`;
const TX1 = `0x${"66".repeat(32)}`;
const TX2 = `0x${"77".repeat(32)}`;

function capabilities(
  status: "supported" | "ready" | "unsupported",
  callGasLimitSupported = false,
) {
  return {
    [CHAIN_HEX]: {
      atomic: { status },
      ...(callGasLimitSupported
        ? { [CIPHERTRADE_CALL_GAS_LIMIT_CAPABILITY]: { supported: true } }
        : {}),
    },
  };
}

function receipt(status: "0x0" | "0x1", transactionHash: string) {
  return {
    logs: [],
    status,
    blockHash: BLOCK_HASH,
    blockNumber: "0x10",
    gasUsed: "0x5208",
    transactionHash,
  };
}

describe("SDK confidential operation planning", function () {
  it("describes the current five-prompt private swap and four-prompt batch", function () {
    const plan = buildConfidentialSwapOperationPlan();

    expect(plan.operation).to.equal("swap");
    expect(plan.signatures.map((step) => step.purpose)).to.deep.equal([
      "token-approval",
      "amount-in",
      "minimum-out",
    ]);
    expect(plan.signatures.map((step) => step.position)).to.deep.equal([1, 2, 3]);
    expect(plan.transactions.map((step) => step.id)).to.deep.equal([
      "approve-input-token",
      "execute-swap",
    ]);
    expect(plan.transactions.every((step) => step.confidential)).to.equal(true);
    expect(plan.prompts).to.deep.equal({
      encryptedSignatures: 3,
      sequentialTransactionConfirmations: 2,
      batchedTransactionConfirmations: 1,
      sequentialTotal: 5,
      batchedTotal: 4,
    });
    expect(plan.batching).to.deep.equal({
      eligible: true,
      ordered: true,
      atomicity: "preferred",
      sequentialFallback: true,
    });
    expect(Object.isFrozen(plan)).to.equal(true);
    expect(Object.isFrozen(plan.signatures)).to.equal(true);
    expect(Object.isFrozen(plan.transactions)).to.equal(true);
    expect(Object.isFrozen(plan.transactions[1].dependsOn)).to.equal(true);
  });

  it("removes approval prompts when an allowance is already sufficient", function () {
    const plan = buildConfidentialSwapOperationPlan({
      approvalRequired: false,
      route: "best-execution",
    });

    expect(plan.route).to.equal("best-execution");
    expect(plan.transactions).to.have.length(1);
    expect(plan.batching.eligible).to.equal(false);
    expect(plan.prompts).to.deep.include({
      encryptedSignatures: 2,
      sequentialTotal: 3,
      batchedTotal: 3,
    });
  });

  it("describes ten sequential or eight batched private liquidity prompts", function () {
    const full = buildConfidentialAddLiquidityOperationPlan();
    const oneApproval = buildConfidentialAddLiquidityOperationPlan({
      token0ApprovalRequired: false,
    });
    const preapproved = buildConfidentialAddLiquidityOperationPlan({
      token0ApprovalRequired: false,
      token1ApprovalRequired: false,
    });

    expect(full.signatures).to.have.length(7);
    expect(full.transactions).to.have.length(3);
    expect(full.prompts).to.deep.include({
      sequentialTotal: 10,
      batchedTotal: 8,
    });
    expect(full.transactions[2].dependsOn).to.deep.equal([
      "approve-token0",
      "approve-token1",
    ]);
    expect(oneApproval.prompts).to.deep.include({
      encryptedSignatures: 6,
      sequentialTransactionConfirmations: 2,
      sequentialTotal: 8,
      batchedTotal: 7,
    });
    expect(preapproved.prompts).to.deep.include({
      encryptedSignatures: 5,
      sequentialTransactionConfirmations: 1,
      sequentialTotal: 6,
      batchedTotal: 6,
    });
  });

  it("covers quote, position, removal, and lock signature progress", function () {
    const quote = buildConfidentialQuoteOperationPlan();
    const splitQuote = buildConfidentialQuoteOperationPlan({
      route: "best-execution",
      candidateBatchCount: 3,
    });
    const liquidityQuote = buildConfidentialAddLiquidityQuoteOperationPlan();
    const removal = buildConfidentialRemoveLiquidityOperationPlan();
    const position = buildConfidentialPositionOperationPlan();
    const removalQuote = buildConfidentialRemoveLiquidityQuoteOperationPlan();
    const lockedPosition = buildConfidentialLockedPositionOperationPlan();
    const lock = buildConfidentialLockLiquidityOperationPlan();

    expect(quote.prompts.sequentialTotal).to.equal(2);
    expect(splitQuote.signatures).to.have.length(3);
    expect(splitQuote.transactions).to.have.length(3);
    expect(splitQuote.prompts).to.deep.include({
      sequentialTotal: 6,
      batchedTotal: 4,
    });
    expect(liquidityQuote).to.deep.include({
      operation: "add-liquidity-quote",
    });
    expect(liquidityQuote.signatures[0].purpose).to.equal("specified-amount");
    expect(liquidityQuote.prompts.sequentialTotal).to.equal(2);
    expect(removal.signatures.map((step) => step.field)).to.deep.equal([
      "shares",
      "minimumAmount0",
      "minimumAmount1",
    ]);
    expect(removal.prompts.sequentialTotal).to.equal(4);
    expect(position).to.deep.include({ operation: "position" });
    expect(position.signatures).to.deep.equal([]);
    expect(position.prompts.sequentialTotal).to.equal(1);
    expect(removalQuote).to.deep.include({ operation: "remove-liquidity-quote" });
    expect(removalQuote.signatures[0].purpose).to.equal("shares");
    expect(removalQuote.prompts.sequentialTotal).to.equal(2);
    expect(lockedPosition).to.deep.include({ operation: "locked-position" });
    expect(lockedPosition.signatures).to.deep.equal([]);
    expect(lockedPosition.prompts.sequentialTotal).to.equal(1);
    expect(lock.prompts.sequentialTotal).to.equal(2);
    expect(lock.signatures[0]).to.deep.include({
      position: 1,
      total: 1,
      sensitive: true,
    });
  });

  it("rejects invalid runtime operation options", function () {
    expect(() => buildConfidentialSwapOperationPlan({
      approvalRequired: "yes" as unknown as boolean,
    })).to.throw("Invalid private swap approval requirement");
    expect(() => buildConfidentialQuoteOperationPlan({
      route: "other" as unknown as "direct",
    })).to.throw("Invalid confidential operation route");
    expect(() => buildConfidentialQuoteOperationPlan({
      candidateBatchCount: 2,
    })).to.throw("Invalid confidential quote candidate batch count");
  });
});

describe("SDK optional wallet call batching", function () {
  it("publishes operation and batching helpers from the built SDK package", async function () {
    const published = await import("../../sdk/dist/index.js") as unknown as
      Record<string, unknown>;
    for (const name of [
      "buildConfidentialSwapOperationPlan",
      "buildConfidentialAddLiquidityOperationPlan",
      "buildConfidentialAddLiquidityQuoteOperationPlan",
      "buildWalletCapabilitiesRequest",
      "prepareWalletCallExecution",
      "normalizeWalletCallsStatus",
      "buildPublicTokenApprovalPlan",
      "classifyCipherDexExecutionError",
      "preflightCipherDexTransaction",
    ]) {
      expect(published[name], `${name} export`).to.be.a("function");
    }
  });

  it("reads chain and global EIP-5792 capabilities without invoking getters", function () {
    expect(getWalletCallBatchSupport(
      capabilities("supported"),
      CHAIN_ID,
    )).to.deep.equal({
      batchingSupported: true,
      atomicStatus: "supported",
      source: "chain",
      callGasLimitSupported: false,
      callGasLimitSource: "none",
    });
    expect(getWalletCallBatchSupport({
      "0x0": { atomic: { status: "ready" } },
    }, CHAIN_ID)).to.deep.equal({
      batchingSupported: true,
      atomicStatus: "ready",
      source: "global",
      callGasLimitSupported: false,
      callGasLimitSource: "none",
    });

    expect(getWalletCallBatchSupport({
      [CHAIN_HEX]: { atomic: { status: "unsupported" } },
      "0x0": {
        [CIPHERTRADE_CALL_GAS_LIMIT_CAPABILITY]: { supported: true },
      },
    }, CHAIN_ID)).to.deep.equal({
      batchingSupported: true,
      atomicStatus: "unsupported",
      source: "chain",
      callGasLimitSupported: true,
      callGasLimitSource: "global",
    });

    let getterInvoked = false;
    const hostile = Object.defineProperty({}, CHAIN_HEX, {
      enumerable: true,
      get() {
        getterInvoked = true;
        throw new Error("must not run");
      },
    });
    expect(getWalletCallBatchSupport(hostile, CHAIN_ID).batchingSupported)
      .to.equal(false);
    expect(getterInvoked).to.equal(false);
  });

  it("builds the scoped capability request used before optional batching", function () {
    expect(buildWalletCapabilitiesRequest(ACCOUNT, CHAIN_ID)).to.deep.equal({
      method: "wallet_getCapabilities",
      params: [ACCOUNT, [CHAIN_HEX]],
    });
  });

  it("prepares an ordered atomic wallet_sendCalls request when supported", function () {
    const operation = buildConfidentialSwapOperationPlan();
    const execution = prepareWalletCallExecution({
      chainId: CHAIN_ID,
      from: ACCOUNT,
      steps: operation.transactions,
      calls: [
        {
          stepId: "approve-input-token",
          to: TOKEN,
          data: "0x1234",
          gasLimit: 500_000n,
        },
        {
          stepId: "execute-swap",
          to: POOL,
          data: "0xabcd",
          value: 2n,
          gasLimit: 90_000_000n,
        },
      ],
      capabilities: capabilities("supported"),
      id: BATCH_ID,
    });

    expect(execution.kind).to.equal("wallet_sendCalls");
    if (execution.kind !== "wallet_sendCalls") throw new Error("unexpected plan");
    expect(execution.containsApproval).to.equal(true);
    expect(execution.request).to.deep.equal({
      method: "wallet_sendCalls",
      params: [{
        version: WALLET_CALLS_VERSION,
        id: BATCH_ID,
        from: ACCOUNT,
        chainId: CHAIN_HEX,
        atomicRequired: true,
        calls: [
          { to: TOKEN, data: "0x1234" },
          { to: POOL, data: "0xabcd", value: "0x2" },
        ],
      }],
    });
    expect(execution.calls.map((call) => call.gasLimit)).to.deep.equal([
      500_000n,
      90_000_000n,
    ]);
    expect(execution.request.params[0].calls[0]).not.to.have.property("capabilities");
    expect(execution.request.params[0].calls[1]).not.to.have.property("capabilities");
    expect(Object.isFrozen(execution.request.params[0].calls)).to.equal(true);
  });

  it("uses negotiated call gas limits only for non-atomic confidential batching", function () {
    const operation = buildConfidentialSwapOperationPlan();
    const calls = [
      {
        stepId: "approve-input-token",
        to: TOKEN,
        data: "0x1234",
        gasLimit: 500_000n,
      },
      {
        stepId: "execute-swap",
        to: POOL,
        data: "0xabcd",
        gasLimit: 30_000_000n,
      },
    ] as const;
    const execution = prepareWalletCallExecution({
      chainId: CHAIN_ID,
      from: ACCOUNT,
      steps: operation.transactions,
      calls,
      capabilities: capabilities("unsupported", true),
    });

    expect(execution.kind).to.equal("wallet_sendCalls");
    if (execution.kind !== "wallet_sendCalls") throw new Error("unexpected plan");
    expect(execution.request.params[0].atomicRequired).to.equal(false);
    expect(execution.request.params[0].calls).to.deep.equal([
      {
        to: TOKEN,
        data: "0x1234",
        capabilities: {
          [CIPHERTRADE_CALL_GAS_LIMIT_CAPABILITY]: { gasLimit: "0x7a120" },
        },
      },
      {
        to: POOL,
        data: "0xabcd",
        capabilities: {
          [CIPHERTRADE_CALL_GAS_LIMIT_CAPABILITY]: { gasLimit: "0x1c9c380" },
        },
      },
    ]);
    expect(execution.request.params[0].calls[0]).not.to.have.property("gas");
  });

  it("retains explicit confidential limits for sequential fallback", function () {
    const operation = buildConfidentialSwapOperationPlan();
    const execution = prepareWalletCallExecution({
      chainId: CHAIN_ID,
      from: ACCOUNT,
      steps: operation.transactions,
      calls: [
        {
          stepId: "approve-input-token",
          to: TOKEN,
          data: "0x1234",
          gasLimit: 500_000n,
        },
        {
          stepId: "execute-swap",
          to: POOL,
          data: "0xabcd",
          gasLimit: 30_000_000n,
        },
      ],
      capabilities: capabilities("unsupported"),
    });

    expect(execution).to.deep.include({
      kind: "sequential",
      reason: "call-gas-limit-capability-unavailable",
    });
    expect(execution.calls.map((call) => call.gasLimit)).to.deep.equal([
      500_000n,
      30_000_000n,
    ]);
  });

  it("keeps atomic-ready confidential batching interoperable without the custom capability", function () {
    const operation = buildConfidentialSwapOperationPlan();
    const execution = prepareWalletCallExecution({
      chainId: CHAIN_ID,
      from: ACCOUNT,
      steps: operation.transactions,
      calls: [
        {
          stepId: "approve-input-token",
          to: TOKEN,
          data: "0x1234",
          gasLimit: 500_000n,
        },
        {
          stepId: "execute-swap",
          to: POOL,
          data: "0xabcd",
          gasLimit: 30_000_000n,
        },
      ],
      capabilities: capabilities("ready"),
      preference: "allow-non-atomic",
    });

    expect(execution.kind).to.equal("wallet_sendCalls");
    if (execution.kind !== "wallet_sendCalls") throw new Error("unexpected plan");
    expect(execution.request.params[0].atomicRequired).to.equal(true);
    expect(execution.request.params[0].calls.every((call) => !call.capabilities))
      .to.equal(true);
  });

  it("selects non-atomic batching, sequential fallback, or unavailable safely", function () {
    const operation = buildConfidentialSwapOperationPlan();
    const input = {
      chainId: CHAIN_ID,
      from: ACCOUNT,
      steps: operation.transactions,
      calls: [
        { stepId: "approve-input-token", to: TOKEN, data: "0x1234" },
        { stepId: "execute-swap", to: POOL, data: "0xabcd" },
      ],
    } as const;
    const nonAtomic = prepareWalletCallExecution({
      ...input,
      capabilities: capabilities("unsupported"),
    });
    const fallback = prepareWalletCallExecution({
      ...input,
      capabilities: {},
    });
    const unavailable = prepareWalletCallExecution({
      ...input,
      capabilities: capabilities("unsupported"),
      preference: "require-atomic",
    });

    expect(nonAtomic.kind).to.equal("wallet_sendCalls");
    if (nonAtomic.kind !== "wallet_sendCalls") throw new Error("unexpected plan");
    expect(nonAtomic.request.params[0].atomicRequired).to.equal(false);
    expect(fallback).to.deep.include({
      kind: "sequential",
      reason: "wallet-batching-unavailable",
    });
    expect(unavailable).to.deep.include({
      kind: "unavailable",
      reason: "atomicity-unavailable",
    });
  });

  it("keeps a single call on the sequential path", function () {
    const operation = buildConfidentialSwapOperationPlan({
      approvalRequired: false,
    });
    const execution = prepareWalletCallExecution({
      chainId: CHAIN_ID,
      from: ACCOUNT,
      steps: operation.transactions,
      calls: [{ stepId: "execute-swap", to: POOL, data: "0xabcd" }],
      capabilities: capabilities("supported"),
    });

    expect(execution).to.deep.include({
      kind: "sequential",
      reason: "single-call",
    });
  });

  it("rejects reordered, malformed, and mismatched calls", function () {
    const operation = buildConfidentialSwapOperationPlan();
    const base = {
      chainId: CHAIN_ID,
      from: ACCOUNT,
      steps: operation.transactions,
      capabilities: capabilities("supported"),
    } as const;
    expect(() => prepareWalletCallExecution({
      ...base,
      calls: [
        { stepId: "execute-swap", to: POOL, data: "0xabcd" },
        { stepId: "approve-input-token", to: TOKEN, data: "0x1234" },
      ],
    })).to.throw("Wallet calls do not match the reviewed operation steps");
    expect(() => prepareWalletCallExecution({
      ...base,
      calls: [
        { stepId: "approve-input-token", to: TOKEN, data: "0x1" },
        { stepId: "execute-swap", to: POOL, data: "0xabcd" },
      ],
    })).to.throw("Invalid wallet call data");
    expect(() => prepareWalletCallExecution({
      ...base,
      calls: [
        { stepId: "approve-input-token", to: TOKEN, data: "0x1234" },
        { stepId: "execute-swap", to: POOL, data: "0xabcd" },
      ],
      preference: "sometimes" as unknown as "prefer-atomic",
    })).to.throw("Invalid wallet call batch preference");
    expect(() => prepareWalletCallExecution({
      ...base,
      calls: [
        { stepId: "approve-input-token", to: TOKEN, data: "0x1234", gasLimit: 0n },
        { stepId: "execute-swap", to: POOL, data: "0xabcd" },
      ],
    })).to.throw("Invalid wallet call gas limit");
  });

  it("parses submission IDs and creates status requests", function () {
    expect(parseWalletSendCallsResult({ id: BATCH_ID })).to.deep.equal({
      id: BATCH_ID,
    });
    expect(buildWalletCallsStatusRequest(BATCH_ID)).to.deep.equal({
      method: "wallet_getCallsStatus",
      params: [BATCH_ID],
    });
    expect(() => parseWalletSendCallsResult({ id: "" })).to.throw(
      "Invalid wallet call batch ID",
    );
  });

  it("normalizes confirmed and offchain-failed batch outcomes", function () {
    const confirmed = normalizeWalletCallsStatus({
      version: WALLET_CALLS_VERSION,
      id: BATCH_ID,
      chainId: CHAIN_HEX,
      status: 200,
      atomic: true,
      receipts: [receipt("0x1", TX1)],
    }, {
      expectedId: BATCH_ID,
      expectedChainId: CHAIN_ID,
      containsApproval: true,
    });
    const offchain = normalizeWalletCallsStatus({
      version: WALLET_CALLS_VERSION,
      id: BATCH_ID,
      chainId: CHAIN_HEX,
      status: 400,
      atomic: false,
    }, {
      expectedId: BATCH_ID,
      expectedChainId: CHAIN_ID,
      containsApproval: true,
    });

    expect(confirmed).to.deep.include({
      state: "confirmed",
      terminal: true,
      succeeded: true,
      allowanceMayBeActive: false,
    });
    expect(confirmed.transactionHashes).to.deep.equal([TX1]);
    expect(offchain).to.deep.include({
      state: "offchain-failed",
      safeForSequentialFallback: true,
      allowanceMayBeActive: false,
    });
  });

  it("flags partial or pending non-atomic approvals for recovery awareness", function () {
    const partial = normalizeWalletCallsStatus({
      version: WALLET_CALLS_VERSION,
      id: BATCH_ID,
      chainId: CHAIN_HEX,
      status: 600,
      atomic: false,
      receipts: [receipt("0x1", TX1), receipt("0x0", TX2)],
    }, {
      expectedId: BATCH_ID,
      expectedChainId: CHAIN_ID,
      containsApproval: true,
    });
    const pending = normalizeWalletCallsStatus({
      version: WALLET_CALLS_VERSION,
      id: BATCH_ID,
      chainId: CHAIN_HEX,
      status: 100,
      atomic: false,
      receipts: [receipt("0x1", TX1)],
    }, {
      expectedId: BATCH_ID,
      expectedChainId: CHAIN_ID,
      containsApproval: true,
    });

    expect(partial).to.deep.include({
      state: "partially-reverted",
      allowanceMayBeActive: true,
      requiresAllowanceReview: true,
      safeForSequentialFallback: false,
    });
    expect(pending).to.deep.include({
      state: "pending",
      terminal: false,
      allowanceMayBeActive: true,
      requiresAllowanceReview: false,
    });
  });

  it("rejects contradictory or cross-context wallet status", function () {
    const context = {
      expectedId: BATCH_ID,
      expectedChainId: CHAIN_ID,
      containsApproval: true,
    } as const;
    expect(() => normalizeWalletCallsStatus({
      version: WALLET_CALLS_VERSION,
      id: BATCH_ID,
      chainId: CHAIN_HEX,
      status: 200,
      atomic: true,
      receipts: [receipt("0x0", TX1)],
    }, context)).to.throw("Contradictory wallet call batch status");
    expect(() => normalizeWalletCallsStatus({
      version: WALLET_CALLS_VERSION,
      id: BATCH_ID,
      chainId: "0x1",
      status: 200,
      atomic: true,
      receipts: [receipt("0x1", TX1)],
    }, context)).to.throw("Invalid wallet call batch status");
    expect(() => normalizeWalletCallsStatus({
      version: "1.0.0",
      id: BATCH_ID,
      chainId: CHAIN_HEX,
      status: 200,
      atomic: true,
      receipts: [receipt("0x1", TX1)],
    }, context)).to.throw("Invalid wallet call batch status");
  });
});
