import { expect } from "chai";
import { Interface } from "ethers";
import { ethers } from "../../hardhat/runtime.js";
import {
  configureConfidentialLaunch,
  deployConfidentialFactory,
} from "../helpers/deployConfidentialFactory";

describe("ConfidentialBestExecutionRouter canonical boundary", function () {
  const emptyInput = {
    ciphertext: { ciphertextHigh: 0n, ciphertextLow: 0n },
    signature: "0x",
  };

  async function deploy() {
    const [deployer, outsider] = await ethers.getSigners();
    const deployment = await deployConfidentialFactory();
    const { factory, representativeTokens } = deployment;
    const launch = await configureConfidentialLaunch(deployment);
    const router = await (
      await ethers.getContractFactory("ConfidentialBestExecutionRouter")
    ).deploy(await factory.getAddress());
    await router.waitForDeployment();
    expect(await (factory as any).BEST_EXECUTION_ROUTER_RUNTIME_CODEHASH()).to.equal(
      ethers.keccak256(await ethers.provider.getCode(await router.getAddress())),
    );
    await factory.setBestExecutionRouter(await router.getAddress());
    return {
      deployer,
      factory,
      launch,
      outsider,
      router,
      token0: representativeTokens[0],
      token1: representativeTokens[1],
    };
  }

  it("binds immutably to a compatible canonical confidential factory", async function () {
    const [deployer] = await ethers.getSigners();
    const routerFactory = await ethers.getContractFactory(
      "ConfidentialBestExecutionRouter",
    );
    await expect(routerFactory.deploy(deployer.address))
      .to.be.revertedWithCustomError(routerFactory, "InvalidFactory");

    const { factory, router } = await deploy();
    expect(await router.factory()).to.equal(await factory.getAddress());
    expect(await router.PROTOCOL_VERSION()).to.equal(2n);
    expect(await router.MAX_CANDIDATES()).to.equal(3n);
    expect(await router.DEFAULT_STANDARD_CANDIDATE_BITMAP()).to.equal(73n);

    const abi = new Interface(router.interface.fragments);
    expect(abi.getFunction("requestBestQuoteExactInput")).to.not.equal(null);
    expect(abi.getFunction("requestBestQuoteExactInputWithCandidates"))
      .to.not.equal(null);
    expect(abi.getFunction("swapBestExactInput")).to.not.equal(null);
    expect(abi.getFunction("swapBestExactInputWithCandidates"))
      .to.not.equal(null);
    expect(abi.getFunction("execute")).to.equal(null);
    expect(abi.getFunction("multicall")).to.equal(null);
  });

  it("rejects an interface-compatible router with unreviewed runtime code", async function () {
    const deployment = await deployConfidentialFactory();
    await configureConfidentialLaunch(deployment);
    const facade = await (
      await ethers.getContractFactory("MockBestExecutionRouterFacade")
    ).deploy(await deployment.factory.getAddress());
    await facade.waitForDeployment();

    await expect(
      deployment.factory.setBestExecutionRouter(await facade.getAddress()),
    ).to.be.revertedWithCustomError(
      deployment.factory,
      "InvalidBestExecutionRouter",
    );
  });

  it("rejects expired, invalid and unsupported requests before MPC work", async function () {
    const { outsider, router, token0, token1 } = await deploy();
    const token0Address = await token0.getAddress();
    const token1Address = await token1.getAddress();
    const requestId = ethers.keccak256(ethers.toUtf8Bytes("request"));

    await expect(
      router.requestBestQuoteExactInputWithCandidates(
        token0Address,
        token1Address,
        emptyInput,
        0,
        requestId,
        2n ** 63n,
      ),
    ).to.be.revertedWithCustomError(router, "InvalidCandidateBitmap");
    await expect(
      router.requestBestQuoteExactInputWithCandidates(
        token0Address,
        token1Address,
        emptyInput,
        0b1111,
        requestId,
        2n ** 63n,
      ),
    ).to.be.revertedWithCustomError(router, "InvalidCandidateBitmap");
    await expect(
      router.requestBestQuoteExactInput(
        token0Address,
        token1Address,
        emptyInput,
        requestId,
        0,
      ),
    ).to.be.revertedWithCustomError(router, "DeadlineExpired");
    await expect(
      router.requestBestQuoteExactInput(
        token0Address,
        token0Address,
        emptyInput,
        requestId,
        2n ** 63n,
      ),
    ).to.be.revertedWithCustomError(router, "InvalidTokenPair");
    await expect(
      router.requestBestQuoteExactInput(
        token0Address,
        outsider.address,
        emptyInput,
        requestId,
        2n ** 63n,
      ),
    ).to.be.revertedWithCustomError(router, "UnsupportedPrivateToken");
  });

  it("skips absent and uninitialized canonical tiers without consuming requests", async function () {
    const { factory, router, token0, token1 } = await deploy();
    const token0Address = await token0.getAddress();
    const token1Address = await token1.getAddress();
    const requestId = ethers.keccak256(ethers.toUtf8Bytes("no-candidate"));
    const selector = router.interface.getFunction(
      "requestBestQuoteExactInput",
    )!.selector;

    await expect(
      router.requestBestQuoteExactInput(
        token0Address,
        token1Address,
        emptyInput,
        requestId,
        2n ** 63n,
      ),
    ).to.be.revertedWithCustomError(router, "NoViablePool");
    expect(
      await router.usedRequestIds(
        await (await ethers.getSigners())[0].getAddress(),
        selector,
        requestId,
      ),
    ).to.equal(false);

    await factory.createPool(token0Address, token1Address, 18, 6, 30);
    await expect(
      router.requestBestQuoteExactInput(
        token0Address,
        token1Address,
        emptyInput,
        requestId,
        2n ** 63n,
      ),
    ).to.be.revertedWithCustomError(router, "NoViablePool");
    expect(
      await router.usedRequestIds(
        await (await ethers.getSigners())[0].getAddress(),
        selector,
        requestId,
      ),
    ).to.equal(false);
  });
});
