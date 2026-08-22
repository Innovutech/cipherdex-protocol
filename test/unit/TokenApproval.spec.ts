import { expect } from "chai";
import { Interface } from "ethers";
import {
  DEFAULT_TOKEN_APPROVAL_MODE,
  MAX_TOKEN_APPROVAL,
  PUBLIC_ERC20_APPROVAL_ABI,
  TOKEN_APPROVAL_MODE,
  buildPublicTokenApprovalPlan,
  resolveTokenApprovalAmount,
} from "../../sdk/src/index";

const TOKEN = "0x0000000000000000000000000000000000000011";
const SPENDER = "0x0000000000000000000000000000000000000022";

describe("SDK token approval policy", function () {
  it("defaults to an exact approval plan", function () {
    const plan = buildPublicTokenApprovalPlan({
      token: TOKEN,
      spender: SPENDER,
      requiredAmount: 125n,
      currentAllowance: 0n,
    });

    expect(DEFAULT_TOKEN_APPROVAL_MODE).to.equal(TOKEN_APPROVAL_MODE.EXACT);
    expect(plan).to.deep.include({
      mode: "exact",
      requiredAmount: 125n,
      currentAllowance: 0n,
      targetAllowance: 125n,
      requiresZeroReset: false,
    });
    expect(plan.calls).to.deep.equal([{
      to: TOKEN,
      functionName: "approve",
      args: [SPENDER, 125n],
    }]);
    expect(Object.isFrozen(plan)).to.equal(true);
    expect(Object.isFrozen(plan.calls)).to.equal(true);
    expect(Object.isFrozen(plan.calls[0])).to.equal(true);
    expect(Object.isFrozen(plan.calls[0].args)).to.equal(true);
  });

  it("requires an explicit unlimited mode", function () {
    const plan = buildPublicTokenApprovalPlan({
      token: TOKEN,
      spender: SPENDER,
      requiredAmount: 125n,
      currentAllowance: 0n,
      mode: TOKEN_APPROVAL_MODE.UNLIMITED,
    });

    expect(plan.mode).to.equal("unlimited");
    expect(plan.targetAllowance).to.equal(MAX_TOKEN_APPROVAL);
    expect(plan.calls[0].args[1]).to.equal(MAX_TOKEN_APPROVAL);
    expect(resolveTokenApprovalAmount(125n, "unlimited")).to.equal(
      (1n << 256n) - 1n,
    );
  });

  it("does not submit a redundant approval at the selected target", function () {
    const exact = buildPublicTokenApprovalPlan({
      token: TOKEN,
      spender: SPENDER,
      requiredAmount: 125n,
      currentAllowance: 125n,
    });
    const unlimited = buildPublicTokenApprovalPlan({
      token: TOKEN,
      spender: SPENDER,
      requiredAmount: 125n,
      currentAllowance: MAX_TOKEN_APPROVAL,
      mode: "unlimited",
    });

    expect(exact.calls).to.deep.equal([]);
    expect(unlimited.calls).to.deep.equal([]);
  });

  it("removes a residual unlimited allowance before applying exact approval", function () {
    const plan = buildPublicTokenApprovalPlan({
      token: TOKEN,
      spender: SPENDER,
      requiredAmount: 125n,
      currentAllowance: MAX_TOKEN_APPROVAL,
    });

    expect(plan.requiresZeroReset).to.equal(true);
    expect(plan.calls).to.deep.equal([
      { to: TOKEN, functionName: "approve", args: [SPENDER, 0n] },
      { to: TOKEN, functionName: "approve", args: [SPENDER, 125n] },
    ]);
  });

  it("uses a zero reset for nonzero-to-nonzero unlimited changes", function () {
    const plan = buildPublicTokenApprovalPlan({
      token: TOKEN,
      spender: SPENDER,
      requiredAmount: 125n,
      currentAllowance: 10n,
      mode: "unlimited",
    });

    expect(plan.requiresZeroReset).to.equal(true);
    expect(plan.calls.map((call) => call.args[1])).to.deep.equal([
      0n,
      MAX_TOKEN_APPROVAL,
    ]);
  });

  it("rejects malformed policy inputs", function () {
    expect(() => buildPublicTokenApprovalPlan({
      token: "0x0000000000000000000000000000000000000000",
      spender: SPENDER,
      requiredAmount: 1n,
      currentAllowance: 0n,
    })).to.throw("Invalid token address");
    expect(() => buildPublicTokenApprovalPlan({
      token: TOKEN,
      spender: "0x0000000000000000000000000000000000000000",
      requiredAmount: 1n,
      currentAllowance: 0n,
    })).to.throw("Invalid spender address");
    expect(() => resolveTokenApprovalAmount(0n)).to.throw(
      "Invalid required token approval amount",
    );
    expect(() => resolveTokenApprovalAmount(MAX_TOKEN_APPROVAL + 1n)).to.throw(
      "Invalid required token approval amount",
    );
    expect(() => resolveTokenApprovalAmount(
      1n,
      "max" as unknown as "exact",
    )).to.throw("Invalid token approval mode");
    expect(() => buildPublicTokenApprovalPlan({
      token: TOKEN,
      spender: SPENDER,
      requiredAmount: 1n,
      currentAllowance: MAX_TOKEN_APPROVAL + 1n,
    })).to.throw("Invalid current token allowance");
  });

  it("publishes parseable standard allowance and approval ABI fragments", function () {
    const erc20 = new Interface(PUBLIC_ERC20_APPROVAL_ABI);
    expect(erc20.getFunction("allowance")).to.not.equal(null);
    expect(erc20.getFunction("approve")).to.not.equal(null);
  });
});
