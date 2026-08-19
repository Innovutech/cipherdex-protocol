import { expect } from "chai";
import { Interface } from "ethers";

import { CONFIDENTIAL_FACTORY_TESTNET_ABI } from "../../scripts/coti-testnet-abi";

describe("COTI testnet ABI", function () {
  it("includes every canonical factory binding validated by funded recovery", function () {
    const factory = new Interface(CONFIDENTIAL_FACTORY_TESTNET_ABI);

    expect(factory.getFunction("feeVault")).to.not.equal(null);
    expect(factory.getFunction("poolDeployer")).to.not.equal(null);
    expect(factory.getFunction("initializationStrategyRegistry")).to.not.equal(null);
  });
});
