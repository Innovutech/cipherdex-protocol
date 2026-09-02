import { expect } from "chai";
import { getAddress, type TypedDataField } from "ethers";

import { ethers } from "../../hardhat/runtime.js";

describe("disposable protected-vault authorization probe", function () {
  const types: Record<string, TypedDataField[]> = {
    VaultAuthorization: [
      { name: "factory", type: "address" },
      { name: "protocolVersion", type: "uint256" },
      { name: "privacyMode", type: "uint8" },
      { name: "poolKind", type: "uint8" },
      { name: "token0", type: "address" },
      { name: "token1", type: "address" },
      { name: "feeBps", type: "uint256" },
      { name: "protectedToken", type: "address" },
      { name: "issuer", type: "address" },
      { name: "vault", type: "address" },
      { name: "disposition", type: "uint8" },
      { name: "authorizationId", type: "bytes32" },
      { name: "deadline", type: "uint64" },
    ],
  };

  async function fixture(useContractIssuer = false) {
    const [issuerOwner, vault, secondVault, other, factory] = await ethers.getSigners();
    const issuer = useContractIssuer
      ? await (await ethers.getContractFactory("MockERC1271Wallet")).deploy(issuerOwner.address)
      : undefined;
    if (issuer) await issuer.waitForDeployment();
    const issuerAddress = issuer ? await issuer.getAddress() : issuerOwner.address;
    const protectedToken = await (
      await ethers.getContractFactory("MockPhase2ALaunchIssuerToken")
    ).deploy(issuerAddress);
    const pairedToken = await (
      await ethers.getContractFactory("MockPhase2ALaunchIssuerToken")
    ).deploy(other.address);
    await Promise.all([protectedToken.waitForDeployment(), pairedToken.waitForDeployment()]);
    const probe = await (
      await ethers.getContractFactory("ProtectedVaultAuthorizationProbe")
    ).deploy(factory.address, 2, 1);
    await probe.waitForDeployment();
    const network = await ethers.provider.getNetwork();
    const block = await ethers.provider.getBlock("latest");
    const deadline = BigInt(block!.timestamp + 3_600);
    const terms = {
      tokenA: await protectedToken.getAddress(),
      tokenB: await pairedToken.getAddress(),
      feeBps: 30n,
      protectedToken: await protectedToken.getAddress(),
      disposition: 1,
    } as const;
    return {
      issuerOwner,
      issuerAddress,
      vault,
      secondVault,
      other,
      factory,
      protectedToken,
      pairedToken,
      probe,
      network,
      deadline,
      terms,
    };
  }

  function ordered(left: string, right: string): readonly [string, string] {
    return left.toLowerCase() < right.toLowerCase()
      ? [getAddress(left), getAddress(right)]
      : [getAddress(right), getAddress(left)];
  }

  async function sign(
    context: Awaited<ReturnType<typeof fixture>>,
    authorizationId: string,
    overrides: Partial<{
      chainId: bigint;
      verifyingContract: string;
      factory: string;
      protocolVersion: bigint;
      privacyMode: number;
      poolKind: number;
      token0: string;
      token1: string;
      feeBps: bigint;
      protectedToken: string;
      issuer: string;
      vault: string;
      disposition: number;
      deadline: bigint;
    }> = {},
  ): Promise<string> {
    const [token0, token1] = ordered(context.terms.tokenA, context.terms.tokenB);
    return context.issuerOwner.signTypedData({
      name: "CipherDEX Phase2A Vault Authorization Probe",
      version: "1",
      chainId: overrides.chainId ?? context.network.chainId,
      verifyingContract: overrides.verifyingContract ?? await context.probe.getAddress(),
    }, types, {
      factory: overrides.factory ?? context.factory.address,
      protocolVersion: overrides.protocolVersion ?? 2n,
      privacyMode: overrides.privacyMode ?? 1,
      poolKind: overrides.poolKind ?? 1,
      token0: overrides.token0 ?? token0,
      token1: overrides.token1 ?? token1,
      feeBps: overrides.feeBps ?? context.terms.feeBps,
      protectedToken: overrides.protectedToken ?? context.terms.protectedToken,
      issuer: overrides.issuer ?? context.issuerAddress,
      vault: overrides.vault ?? context.vault.address,
      disposition: overrides.disposition ?? context.terms.disposition,
      authorizationId,
      deadline: overrides.deadline ?? context.deadline,
    });
  }

  async function execute(
    context: Awaited<ReturnType<typeof fixture>>,
    authorizationId: string,
    signature: string,
    failAfterConsumption = false,
  ) {
    return context.probe.connect(context.vault).authorizeVaultExecution(
      context.terms,
      context.vault.address,
      authorizationId,
      context.deadline,
      signature,
      ethers.id(`unsigned-gt:${authorizationId}`),
      failAfterConsumption,
    );
  }

  it("executes independent issuer authorizations in any order", async function () {
    const context = await fixture();
    const ids = [ethers.id("launch-a"), ethers.id("launch-b"), ethers.id("launch-c")];
    const signatures = await Promise.all(ids.map((id) => sign(context, id)));
    expect(await context.probe.consumedAuthorizationId(context.issuerAddress, ids[0])).to.equal(false);
    await execute(context, ids[2], signatures[2]!);
    await execute(context, ids[0], signatures[0]!);
    await execute(context, ids[1], signatures[1]!);
    for (const id of ids) {
      expect(await context.probe.consumedAuthorizationId(context.issuerAddress, id)).to.equal(true);
    }
    expect(await context.probe.executionCount()).to.equal(3n);
  });

  it("does not consume an authorization when atomic execution fails", async function () {
    const context = await fixture();
    const id = ethers.id("retryable-launch");
    const signature = await sign(context, id);
    await expect(execute(context, id, signature, true))
      .to.be.revertedWithCustomError(context.probe, "ExecutionFailed");
    expect(await context.probe.consumedAuthorizationId(context.issuerAddress, id)).to.equal(false);
    expect(await context.probe.executionCount()).to.equal(0n);
    await expect(execute(context, id, signature)).to.emit(context.probe, "StaticAuthorizationConsumed");
  });

  it("rejects exact replay without installing preauthorization", async function () {
    const context = await fixture();
    const id = ethers.id("one-use-launch");
    const signature = await sign(context, id);
    expect(await context.probe.consumedAuthorizationId(context.issuerAddress, id)).to.equal(false);
    await execute(context, id, signature);
    await expect(execute(context, id, signature))
      .to.be.revertedWithCustomError(context.probe, "AuthorizationAlreadyConsumed");
  });

  it("accepts an ERC-1271 issuer-selected authorization ID", async function () {
    const context = await fixture(true);
    const id = ethers.id("erc1271-launch");
    await expect(execute(context, id, await sign(context, id)))
      .to.emit(context.probe, "StaticAuthorizationConsumed");
  });

  it("binds vault, factory, mode, pair, tier, token, disposition and EIP-712 domain", async function () {
    const context = await fixture();
    const id = ethers.id("bound-launch");
    const mutations = [
      { vault: context.secondVault.address },
      { factory: context.other.address },
      { protocolVersion: 3n },
      { privacyMode: 2 },
      { poolKind: 0 },
      { token0: context.other.address },
      { token1: context.other.address },
      { feeBps: 100n },
      { protectedToken: context.terms.tokenB },
      { issuer: context.other.address },
      { disposition: 2 },
      { chainId: context.network.chainId + 1n },
      { verifyingContract: context.other.address },
    ] as const;
    for (const mutation of mutations) {
      await expect(execute(context, id, await sign(context, id, mutation)))
        .to.be.revertedWithCustomError(context.probe, "InvalidIssuerAuthorization");
    }
    expect(await context.probe.consumedAuthorizationId(context.issuerAddress, id)).to.equal(false);
  });

  it("rejects wrong caller, zero ID, expiry and protected token outside the pair", async function () {
    const context = await fixture();
    const id = ethers.id("caller-bound-launch");
    await expect(context.probe.connect(context.secondVault).authorizeVaultExecution(
      context.terms,
      context.vault.address,
      id,
      context.deadline,
      await sign(context, id),
      ethers.id("gt"),
      false,
    )).to.be.revertedWithCustomError(context.probe, "VaultOnly");
    await expect(context.probe.connect(context.vault).authorizeVaultExecution(
      context.terms,
      context.vault.address,
      ethers.ZeroHash,
      context.deadline,
      "0x",
      ethers.id("gt"),
      false,
    )).to.be.revertedWithCustomError(context.probe, "InvalidAuthorizationId");
    const block = await ethers.provider.getBlock("latest");
    const expired = BigInt(block!.timestamp - 1);
    await expect(context.probe.connect(context.vault).authorizeVaultExecution(
      context.terms,
      context.vault.address,
      id,
      expired,
      await sign(context, id, { deadline: expired }),
      ethers.id("gt"),
      false,
    )).to.be.revertedWithCustomError(context.probe, "AuthorizationExpired");

    const unrelated = await (
      await ethers.getContractFactory("MockPhase2ALaunchIssuerToken")
    ).deploy(context.issuerAddress);
    await unrelated.waitForDeployment();
    await expect(context.probe.authorizationDigest(
      { ...context.terms, protectedToken: await unrelated.getAddress() },
      context.vault.address,
      id,
      context.deadline,
    )).to.be.revertedWithCustomError(context.probe, "InvalidStaticTerms");
  });
});
