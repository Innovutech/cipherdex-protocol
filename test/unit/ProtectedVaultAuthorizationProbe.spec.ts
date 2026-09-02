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
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint64" },
    ],
  };

  async function fixture(useContractIssuer = false) {
    const [issuerOwner, vault, other, factory] = await ethers.getSigners();
    const issuer = useContractIssuer
      ? await (await ethers.getContractFactory("MockERC1271Wallet"))
        .deploy(issuerOwner.address)
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
      nonce: bigint;
      deadline: bigint;
    }> = {},
  ): Promise<string> {
    const [token0, token1] = ordered(context.terms.tokenA, context.terms.tokenB);
    const domain = {
      name: "CipherDEX Phase2A Vault Authorization Probe",
      version: "1",
      chainId: overrides.chainId ?? context.network.chainId,
      verifyingContract: overrides.verifyingContract ?? await context.probe.getAddress(),
    };
    const value = {
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
      nonce: overrides.nonce ?? 0n,
      deadline: overrides.deadline ?? context.deadline,
    };
    return context.issuerOwner.signTypedData(domain, types, value);
  }

  it("accepts EOA issuer authorization while leaving execution values unsigned", async function () {
    const context = await fixture();
    const signature = await sign(context);
    const firstTag = ethers.id("transaction-scoped-gt-values-a");
    const secondTag = ethers.id("transaction-scoped-gt-values-b");

    await expect(context.probe.connect(context.vault).authorizeVaultExecution(
      context.terms,
      context.vault.address,
      0,
      context.deadline,
      signature,
      firstTag,
      true,
    )).to.be.revertedWithCustomError(context.probe, "ExecutionFailed");
    expect(await context.probe.nextNonce(context.issuerAddress)).to.equal(0n);
    expect(await context.probe.executionCount()).to.equal(0n);

    await expect(context.probe.connect(context.vault).authorizeVaultExecution(
      context.terms,
      context.vault.address,
      0,
      context.deadline,
      signature,
      secondTag,
      false,
    )).to.emit(context.probe, "StaticAuthorizationConsumed");
    expect(await context.probe.nextNonce(context.issuerAddress)).to.equal(1n);
    expect(await context.probe.executionCount()).to.equal(1n);
  });

  it("accepts ERC-1271 issuer authorization of one vault", async function () {
    const context = await fixture(true);
    const signature = await sign(context);
    await expect(context.probe.connect(context.vault).authorizeVaultExecution(
      context.terms,
      context.vault.address,
      0,
      context.deadline,
      signature,
      ethers.id("vault-funded-gt"),
      false,
    )).to.emit(context.probe, "StaticAuthorizationConsumed")
      .withArgs(
        context.issuerAddress,
        context.vault.address,
        context.terms.protectedToken,
        0,
      );
  });

  it("rejects replay, wrong caller and expired authorization", async function () {
    const context = await fixture();
    const signature = await sign(context);
    const call = () => context.probe.connect(context.vault).authorizeVaultExecution(
      context.terms,
      context.vault.address,
      0,
      context.deadline,
      signature,
      ethers.id("gt"),
      false,
    );
    await call();
    await expect(call()).to.be.revertedWithCustomError(context.probe, "InvalidNonce");
    await expect(context.probe.connect(context.other).authorizeVaultExecution(
      context.terms,
      context.vault.address,
      1,
      context.deadline,
      await sign(context, { nonce: 1n }),
      ethers.id("gt"),
      false,
    )).to.be.revertedWithCustomError(context.probe, "VaultOnly");

    const block = await ethers.provider.getBlock("latest");
    const expired = BigInt(block!.timestamp - 1);
    await expect(context.probe.connect(context.vault).authorizeVaultExecution(
      context.terms,
      context.vault.address,
      1,
      expired,
      await sign(context, { nonce: 1n, deadline: expired }),
      ethers.id("gt"),
      false,
    )).to.be.revertedWithCustomError(context.probe, "AuthorizationExpired");
  });

  it("binds every static factory/mode/pair/token/fee/disposition field", async function () {
    const context = await fixture();
    const [token0, token1] = ordered(context.terms.tokenA, context.terms.tokenB);
    const mutations = [
      { factory: context.other.address },
      { protocolVersion: 3n },
      { privacyMode: 2 },
      { poolKind: 0 },
      { token0: context.other.address },
      { token1: context.other.address },
      { feeBps: 100n },
      { protectedToken: context.terms.tokenB },
      { issuer: context.other.address },
      { vault: context.other.address },
      { disposition: 2 },
      { chainId: context.network.chainId + 1n },
      { verifyingContract: context.other.address },
    ] as const;

    for (const mutation of mutations) {
      const signature = await sign(context, mutation);
      await expect(context.probe.connect(context.vault).authorizeVaultExecution(
        context.terms,
        context.vault.address,
        0,
        context.deadline,
        signature,
        ethers.id(`gt:${JSON.stringify(mutation, (_, value) =>
          typeof value === "bigint" ? value.toString() : value)}`),
        false,
      )).to.be.revertedWithCustomError(context.probe, "InvalidIssuerAuthorization");
    }

    expect(token0).to.not.equal(token1);
    expect(await context.probe.nextNonce(context.issuerAddress)).to.equal(0n);
  });

  it("requires the explicit protected token to be in the pair", async function () {
    const context = await fixture();
    const unrelated = await (
      await ethers.getContractFactory("MockPhase2ALaunchIssuerToken")
    ).deploy(context.issuerAddress);
    await unrelated.waitForDeployment();
    const invalidTerms = {
      ...context.terms,
      protectedToken: await unrelated.getAddress(),
    };
    await expect(context.probe.authorizationDigest(
      invalidTerms,
      context.vault.address,
      0,
      context.deadline,
    )).to.be.revertedWithCustomError(context.probe, "InvalidStaticTerms");
  });
});
