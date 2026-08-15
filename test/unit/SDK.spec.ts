import { expect } from "chai";
import { Interface } from "ethers";
import {
  CONFIDENTIAL_CPMM_ABI,
  CONFIDENTIAL_CPMM_FACTORY_ABI,
  CONFIDENTIAL_LAUNCHPAD_MIGRATOR_ABI,
  DISCLOSURE_SCHEMA_VERSION,
  PRIVATE_LP_TOKEN_ABI,
  PUBLIC_CPMM_ABI,
  PUBLIC_CPMM_FACTORY_ABI,
  PUBLIC_CPMM_QUOTER_ABI,
  PUBLIC_CPMM_ROUTER_ABI,
  isConfidentialPoolDiscovery,
  isPublicPoolDiscovery,
} from "../../sdk/src/index";

describe("stable SDK surface", function () {
  it("parses the published pool and factory ABI fragments", function () {
    const pool = new Interface(CONFIDENTIAL_CPMM_ABI);
    const factory = new Interface(CONFIDENTIAL_CPMM_FACTORY_ABI);
    const launchpad = new Interface(CONFIDENTIAL_LAUNCHPAD_MIGRATOR_ABI);
    const privateLpToken = new Interface(PRIVATE_LP_TOKEN_ABI);
    const publicPool = new Interface(PUBLIC_CPMM_ABI);
    const publicFactory = new Interface(PUBLIC_CPMM_FACTORY_ABI);
    const publicQuoter = new Interface(PUBLIC_CPMM_QUOTER_ABI);
    const publicRouter = new Interface(PUBLIC_CPMM_ROUTER_ABI);
    expect(pool.getFunction("swapExactInput")).to.not.equal(null);
    expect(pool.getFunction("removeLiquidity")).to.not.equal(null);
    expect(pool.getFunction("bootstrapLiquidity")).to.not.equal(null);
    expect(factory.getFunction("createPool")).to.not.equal(null);
    expect(factory.getFunction("bootstrapPool")).to.not.equal(null);
    expect(factory.getEvent("PoolCreated")).to.not.equal(null);
    expect(factory.getEvent("PrivateLPTokenCreated")).to.not.equal(null);
    expect(privateLpToken.getFunction("pool")).to.not.equal(null);
    expect(privateLpToken.getFunction("balanceOf")).to.not.equal(null);
    expect(launchpad.getFunction("migrate")).to.not.equal(null);
    expect(launchpad.getEvent("LaunchpadMigration")).to.not.equal(null);
    expect(publicPool.getFunction("swapExactInput")).to.not.equal(null);
    expect(publicFactory.getFunction("createPool")).to.not.equal(null);
    expect(publicQuoter.getFunction("quoteExactInput")).to.not.equal(null);
    expect(publicRouter.getFunction("swapExactInput")).to.not.equal(null);
  });

  it("accepts only the public privacy-minimal discovery shape", function () {
    expect(
      isConfidentialPoolDiscovery({
        disclosureSchemaVersion: DISCLOSURE_SCHEMA_VERSION,
        protocolVersion: 1,
        pool: "0x0000000000000000000000000000000000000001",
        token0: "0x0000000000000000000000000000000000000002",
        token1: "0x0000000000000000000000000000000000000003",
        token0Decimals: 18,
        token1Decimals: 6,
        feeBps: 30,
        poolKind: "private-erc20-cpmm-v1",
      }),
    ).to.equal(true);
    expect(
      isConfidentialPoolDiscovery({
        disclosureSchemaVersion: DISCLOSURE_SCHEMA_VERSION,
        poolKind: "private-erc20-cpmm-v1",
      }),
    ).to.equal(false);
    expect(
      isPublicPoolDiscovery({
        disclosureSchemaVersion: DISCLOSURE_SCHEMA_VERSION,
        protocolVersion: 1,
        pool: "0x0000000000000000000000000000000000000001",
        token0: "0x0000000000000000000000000000000000000002",
        token1: "0x0000000000000000000000000000000000000003",
        token0Decimals: 18,
        token1Decimals: 6,
        feeBps: 30,
        poolKind: "public-erc20-cpmm-v1",
      }),
    ).to.equal(true);
  });
});
