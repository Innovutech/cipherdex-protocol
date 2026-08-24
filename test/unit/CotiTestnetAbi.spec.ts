import { expect } from "chai";
import { Interface } from "ethers";

import {
  CONFIDENTIAL_FACTORY_TESTNET_ABI,
  CONFIDENTIAL_POOL_TESTNET_ABI,
} from "../../scripts/coti-testnet-abi";

describe("COTI testnet ABI", function () {
  it("includes every canonical factory binding validated by funded recovery", function () {
    const factory = new Interface(CONFIDENTIAL_FACTORY_TESTNET_ABI);

    expect(factory.getFunction("feeVault")).to.not.equal(null);
    expect(factory.getFunction("poolDeployer")).to.not.equal(null);
    expect(factory.getFunction("initializationStrategyRegistry")).to.not.equal(null);
  });

  it("includes every owner-encrypted position read used by the focused funded probe", function () {
    const pool = new Interface(CONFIDENTIAL_POOL_TESTNET_ABI);

    expect(pool.getFunction("myShares")).to.not.equal(null);
    expect(pool.getFunction("requestMyPosition")).to.not.equal(null);
    expect(pool.getFunction("requestRemoveLiquidityQuote")).to.not.equal(null);
    expect(pool.getFunction("requestLockedPosition")).to.not.equal(null);
    expect(pool.getEvent("ConfidentialPositionResult")).to.not.equal(null);
    expect(pool.getEvent("ConfidentialRemoveLiquidityQuoteResult")).to.not.equal(null);
    expect(pool.getEvent("ConfidentialLockedPositionResult")).to.not.equal(null);
  });
});
