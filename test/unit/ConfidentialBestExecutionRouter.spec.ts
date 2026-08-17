import { expect } from "chai";
import { Interface } from "ethers";
import { ethers } from "hardhat";
import { deployConfidentialFactory } from "../helpers/deployConfidentialFactory";

describe("ConfidentialBestExecutionRouter canonical boundary", function () {
  const emptyInput = {
    ciphertext: { ciphertextHigh: 0n, ciphertextLow: 0n },
    signature: "0x",
  };

  async function deploy() {
    const [deployer, outsider] = await ethers.getSigners();
    const { factory, representativeTokens } = await deployConfidentialFactory();
    const router = await (
      await ethers.getContractFactory("ConfidentialBestExecutionRouter")
    ).deploy(await factory.getAddress());
    await router.waitForDeployment();
    await factory.setBestExecutionRouter(await router.getAddress());
    return {
      deployer,
      factory,
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
    expect(await router.PROTOCOL_VERSION()).to.equal(1n);

    const abi = new Interface(router.interface.fragments);
    expect(abi.getFunction("requestBestQuoteExactInput")).to.not.equal(null);
    expect(abi.getFunction("swapBestExactInput")).to.not.equal(null);
    expect(abi.getFunction("execute")).to.equal(null);
    expect(abi.getFunction("multicall")).to.equal(null);
  });

  it("rejects expired, invalid and unsupported requests before MPC work", async function () {
    const { outsider, router, token0, token1 } = await deploy();
    const token0Address = await token0.getAddress();
    const token1Address = await token1.getAddress();
    const requestId = ethers.keccak256(ethers.toUtf8Bytes("request"));

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
