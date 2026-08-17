import { expect } from "chai";

import {
  FeeCollectionPendingError,
  requireFeeCollectionMature,
} from "../../scripts/testnet-fee-collection-readiness";

describe("funded fee-collection readiness", function () {
  it("rejects an immature batch instead of returning successful evidence", function () {
    expect(() => requireFeeCollectionMature(3_599n, 3_600n))
      .to.throw(FeeCollectionPendingError, "rerun after readyAt");
  });

  it("accepts the maturity boundary and later timestamps", function () {
    expect(() => requireFeeCollectionMature(3_600n, 3_600n)).not.to.throw();
    expect(() => requireFeeCollectionMature(3_601n, 3_600n)).not.to.throw();
  });

  it("rejects malformed negative timestamp evidence", function () {
    expect(() => requireFeeCollectionMature(-1n, 0n)).to.throw("non-negative");
    expect(() => requireFeeCollectionMature(0n, -1n)).to.throw("non-negative");
  });
});
