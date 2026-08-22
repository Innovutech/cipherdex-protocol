import { expect } from "chai";
import { ethers } from "../../hardhat/runtime.js";

import {
  buildCipherDexInputBatchTypedData,
  cipherDexInputBatchDigest,
  cipherDexInputSchemaHash,
  signCipherDexInputBatch,
  type CipherDexBatchCiphertext,
} from "../../sdk/src/inputBatch";

const PROTOCOL_VERSION = 7n;
const SCHEMA = "CipherDEX.harness(first,second)";
const SCHEMA_HASH = cipherDexInputSchemaHash(SCHEMA);

const ciphertexts: CipherDexBatchCiphertext[] = [
  Object.freeze({ ciphertextHigh: 11n, ciphertextLow: 12n }),
  Object.freeze({ ciphertextHigh: 21n, ciphertextLow: 22n }),
];

describe("CipherDEX function-scoped input batch authorization", function () {
  async function expectFailure(promise: Promise<unknown>): Promise<void> {
    let failed = false;
    try {
      await promise;
    } catch {
      failed = true;
    }
    expect(failed).to.equal(true);
  }

  async function setup() {
    const [owner, outsider] = await ethers.getSigners();
    const factory = await ethers.getContractFactory("BatchAuthorizationHarness");
    const harness = await factory.deploy();
    const otherHarness = await factory.deploy();
    const walletFactory = await ethers.getContractFactory("MockERC1271Wallet");
    const contractWallet = await walletFactory.deploy(owner.address);
    const network = await ethers.provider.getNetwork();
    const block = await ethers.provider.getBlock("latest");
    if (!block) throw new Error("latest block unavailable");
    return {
      owner,
      outsider,
      harness,
      otherHarness,
      contractWallet,
      chainId: network.chainId,
      deadline: BigInt(block.timestamp + 3_600),
    };
  }

  async function authorization(input: Readonly<{
    signer: Awaited<ReturnType<typeof ethers.getSigners>>[number];
    caller: string;
    target: string;
    selector: string;
    chainId: bigint;
    deadline: bigint;
    nonce?: string;
    schemaHash?: string;
    protocolVersion?: bigint;
    values?: readonly CipherDexBatchCiphertext[];
  }>) {
    const typedData = buildCipherDexInputBatchTypedData({
      chainId: input.chainId,
      protocolVersion: input.protocolVersion ?? PROTOCOL_VERSION,
      caller: input.caller,
      target: input.target,
      selector: input.selector,
      schemaHash: input.schemaHash ?? SCHEMA_HASH,
      ciphertexts: input.values ?? ciphertexts,
      nonce: input.nonce ?? ethers.keccak256(ethers.randomBytes(32)),
      deadline: input.deadline,
    });
    return {
      typedData,
      authorization: await signCipherDexInputBatch(input.signer, typedData),
    };
  }

  it("matches the SDK digest and consumes one EOA nonce", async function () {
    const { owner, harness, chainId, deadline } = await setup();
    const target = await harness.getAddress();
    const selector = harness.interface.getFunction("authorize")!.selector;
    const built = await authorization({
      signer: owner,
      caller: owner.address,
      target,
      selector,
      chainId,
      deadline,
    });
    expect(await harness.inputBatchAuthorizationDigest(
      owner.address,
      selector,
      ciphertexts,
      PROTOCOL_VERSION,
      SCHEMA_HASH,
      built.authorization.nonce,
      deadline,
    )).to.equal(cipherDexInputBatchDigest(built.typedData));
    await expect(harness.authorize(ciphertexts, built.authorization))
      .to.emit(harness, "ConfidentialInputBatchAuthorized");
    expect(await harness.inputBatchNonceUsed(owner.address, built.authorization.nonce))
      .to.equal(true);
    await expect(harness.authorize(ciphertexts, built.authorization))
      .to.be.revertedWithCustomError(harness, "InputBatchNonceAlreadyUsed");
  });

  it("rejects slot mutation, reordering, missing and duplicate slots", async function () {
    const { owner, harness, chainId, deadline } = await setup();
    const target = await harness.getAddress();
    const selector = harness.interface.getFunction("authorize")!.selector;
    const built = await authorization({
      signer: owner,
      caller: owner.address,
      target,
      selector,
      chainId,
      deadline,
    });
    const modified = [ciphertexts[0], { ciphertextHigh: 21n, ciphertextLow: 23n }];
    await expect(harness.authorize(modified, built.authorization))
      .to.be.revertedWithCustomError(harness, "InvalidInputBatchAuthorization");
    await expect(harness.authorize([...ciphertexts].reverse(), built.authorization))
      .to.be.revertedWithCustomError(harness, "InvalidInputBatchAuthorization");
    await expect(harness.authorize([ciphertexts[0]], built.authorization))
      .to.be.revertedWithCustomError(harness, "InvalidInputBatchCount");
    const duplicated = [ciphertexts[0], ciphertexts[0]];
    const duplicatedTyped = buildCipherDexInputBatchTypedData;
    expect(() => duplicatedTyped({
      chainId,
      protocolVersion: PROTOCOL_VERSION,
      caller: owner.address,
      target,
      selector,
      schemaHash: SCHEMA_HASH,
      ciphertexts: duplicated,
      nonce: ethers.keccak256(ethers.randomBytes(32)),
      deadline,
    })).to.throw("repeats a ciphertext");
    await expect(harness.authorize(duplicated, built.authorization))
      .to.be.revertedWithCustomError(harness, "DuplicateInputBatchCiphertext");
  });

  it("rejects wrong caller, chain, target, selector, schema, version and expiry", async function () {
    const { owner, outsider, harness, otherHarness, chainId, deadline } = await setup();
    const target = await harness.getAddress();
    const selector = harness.interface.getFunction("authorize")!.selector;
    const wrongCases = [
      { caller: outsider.address },
      { chainId: chainId + 1n },
      { target: await otherHarness.getAddress() },
      { selector: harness.interface.getFunction("authorizeAlternate")!.selector },
      { schemaHash: ethers.id("CipherDEX.harness(second,first)") },
      { protocolVersion: PROTOCOL_VERSION + 1n },
    ];
    for (const override of wrongCases) {
      const built = await authorization({
        signer: owner,
        caller: override.caller ?? owner.address,
        target: override.target ?? target,
        selector: override.selector ?? selector,
        chainId: override.chainId ?? chainId,
        deadline,
        schemaHash: override.schemaHash,
        protocolVersion: override.protocolVersion,
      });
      await expectFailure(harness.authorize(ciphertexts, built.authorization));
    }
    const expired = await authorization({
      signer: owner,
      caller: owner.address,
      target,
      selector,
      chainId,
      deadline: 1n,
    });
    await expect(harness.authorize(ciphertexts, expired.authorization))
      .to.be.revertedWithCustomError(harness, "InputBatchDeadlineExpired");
  });

  it("prevents nonce reuse across functions", async function () {
    const { owner, harness, chainId, deadline } = await setup();
    const target = await harness.getAddress();
    const nonce = ethers.keccak256(ethers.randomBytes(32));
    const first = await authorization({
      signer: owner,
      caller: owner.address,
      target,
      selector: harness.interface.getFunction("authorize")!.selector,
      chainId,
      deadline,
      nonce,
    });
    await harness.authorize(ciphertexts, first.authorization);
    const alternate = await authorization({
      signer: owner,
      caller: owner.address,
      target,
      selector: harness.interface.getFunction("authorizeAlternate")!.selector,
      chainId,
      deadline,
      nonce,
    });
    await expect(harness.authorizeAlternate(ciphertexts, alternate.authorization))
      .to.be.revertedWithCustomError(harness, "InputBatchNonceAlreadyUsed");
  });

  it("accepts ERC-1271 authorization from the calling contract wallet", async function () {
    const { owner, harness, contractWallet, chainId, deadline } = await setup();
    const target = await harness.getAddress();
    const caller = await contractWallet.getAddress();
    const selector = harness.interface.getFunction("authorize")!.selector;
    const built = await authorization({
      signer: owner,
      caller,
      target,
      selector,
      chainId,
      deadline,
    });
    const data = (await harness.authorize.populateTransaction(
      ciphertexts,
      built.authorization,
    )).data;
    await (await contractWallet.execute(target, data)).wait();
    expect(await harness.inputBatchNonceUsed(caller, built.authorization.nonce))
      .to.equal(true);
  });
});
