import { expect } from "chai";
import { Interface } from "ethers";
import { readFileSync } from "node:fs";

import { artifacts, ethers } from "../../hardhat/runtime.js";
import {
  deriveInitialShares,
  deriveSymmetricPriceBounds,
  FIELD_BASE,
  FIELD_BITS,
  FIELD_MASK,
  packLiquidityAmounts,
  packRemovalMinimums,
  packSwapInput,
  packUint128Pair,
  PackingTransitionModel,
  UINT256_MAX,
  unpackUint128Pair,
} from "../../scripts/phase2d-it-packing";

describe("Phase 2D fixed-layout COTI IT packing", function () {
  const request = (label: string) => ethers.id(label);

  it("round-trips zero, one, maximum and deterministic randomized fields", function () {
    const vectors: Array<readonly [bigint, bigint]> = [
      [0n, 0n],
      [1n, 1n],
      [FIELD_MASK, 0n],
      [0n, FIELD_MASK],
      [FIELD_MASK, FIELD_MASK],
    ];
    let seed = 0xC1F3D2n;
    for (let index = 0; index < 1_000; index += 1) {
      seed = (seed * 1_103_515_245n + 12_345n) & FIELD_MASK;
      const high = seed;
      seed = (seed * 1_103_515_245n + 12_345n) & FIELD_MASK;
      vectors.push([high, seed]);
    }
    for (const [high, low] of vectors) {
      expect(unpackUint128Pair(packUint128Pair(high, low))).to.deep.equal({ high, low });
    }
    expect(packUint128Pair(FIELD_MASK, FIELD_MASK)).to.equal(UINT256_MAX);
  });

  it("preserves canonical high/low order and detects swapped fields", function () {
    const amount0 = 7n;
    const amount1 = 11n;
    expect(unpackUint128Pair(packLiquidityAmounts(amount0, amount1)))
      .to.deep.equal({ high: amount0, low: amount1 });
    expect(packUint128Pair(amount0, amount1)).to.not.equal(packUint128Pair(amount1, amount0));
    expect(unpackUint128Pair(packRemovalMinimums(amount0, amount1)))
      .to.deep.equal({ high: amount0, low: amount1 });
    expect(unpackUint128Pair(packSwapInput(amount0, amount1)))
      .to.deep.equal({ high: amount0, low: amount1 });
  });

  it("rejects truncation, non-bigint and every out-of-range input", function () {
    expect(() => packUint128Pair(-1n, 0n)).to.throw("0..2^128-1");
    expect(() => packUint128Pair(FIELD_BASE, 0n)).to.throw("0..2^128-1");
    expect(() => packUint128Pair(0n, FIELD_BASE)).to.throw("0..2^128-1");
    expect(() => packUint128Pair(1 as unknown as bigint, 0n)).to.throw("bigint");
    expect(() => unpackUint128Pair(-1n)).to.throw("0..2^256-1");
    expect(() => unpackUint128Pair(UINT256_MAX + 1n)).to.throw("0..2^256-1");
  });

  it("keeps packed and separate swap/liquidity transition semantics identical", function () {
    const separate = new PackingTransitionModel();
    const packed = new PackingTransitionModel();
    expect(separate.swapSeparate(request("swap-separate"), 13n, 20n, 100n, 1n))
      .to.equal(packed.swapPacked(request("swap-packed"), packSwapInput(13n, 20n), 100n, 1n));
    expect(separate.liquiditySeparate(request("liq-separate"), 17n, 19n))
      .to.equal(packed.liquidityPacked(request("liq-packed"), packLiquidityAmounts(17n, 19n)));
    expect(separate.successfulCalls()).to.equal(packed.successfulCalls());
  });

  it("replays one packed unit once and rolls back every failed transition", function () {
    const model = new PackingTransitionModel();
    const requestId = request("atomic-request");
    expect(() => model.swapPacked(requestId, packSwapInput(1n, 3n), 100n, 1n))
      .to.throw("minimum output");
    expect(model.requestUsed(requestId)).to.equal(false);
    expect(model.successfulCalls()).to.equal(0n);
    expect(model.swapPacked(requestId, packSwapInput(2n, 3n), 100n, 1n)).to.equal(4n);
    expect(() => model.swapPacked(requestId, packSwapInput(2n, 3n), 100n, 1n))
      .to.throw("request already used");
    expect(model.successfulCalls()).to.equal(1n);
  });

  it("derives overflow-safe full-width symmetric price bounds", function () {
    const expected = (1n << 200n) + 12_345n;
    const bounds = deriveSymmetricPriceBounds(expected, 250n);
    const delta = expected / 10_000n * 250n + (expected % 10_000n * 250n) / 10_000n;
    expect(bounds).to.deep.equal({ minimum: expected - delta, maximum: expected + delta });
    expect(bounds.minimum).to.be.greaterThan(FIELD_MASK);
    expect(deriveSymmetricPriceBounds(UINT256_MAX, 10_000n))
      .to.deep.equal({ minimum: 0n, maximum: UINT256_MAX });
    expect(() => deriveSymmetricPriceBounds(1n, 10_001n)).to.throw("0..10000");
  });

  it("proves initial shares are deterministic from the packed signed amounts", function () {
    const amount0 = FIELD_MASK;
    const amount1 = FIELD_MASK - 1n;
    const packed = packLiquidityAmounts(amount0, amount1);
    const decoded = unpackUint128Pair(packed);
    const expectedShares = deriveInitialShares(amount0, amount1, 1_000_000n, 1n);
    expect(deriveInitialShares(decoded.high, decoded.low, 1_000_000n, 1n))
      .to.equal(expectedShares);
    expect(() => deriveInitialShares(0n, 1n, 1n, 1n)).to.throw("positive");
  });

  it("compiles selector-bound packed and baseline endpoints without plaintext amounts", async function () {
    const probe = await (
      await ethers.getContractFactory("PrivateITPackingProbe")
    ).deploy();
    await probe.waitForDeployment();
    const artifact = await artifacts.readArtifact("PrivateITPackingProbe");
    const contractInterface = new Interface(artifact.abi);
    for (const name of [
      "swapSeparate",
      "swapPacked",
      "liquiditySeparate",
      "liquidityPacked",
      "arithmeticSeparate",
      "arithmeticPacked",
      "decodeSeparate",
      "decodePacked",
    ]) expect(contractInterface.getFunction(name)).to.not.equal(null);
    expect((artifact.deployedBytecode.length - 2) / 2).to.be.at.most(24_576);

    const source = readFileSync(
      new URL("../../contracts/mocks/PrivateITPackingProbe.sol", import.meta.url),
      "utf8",
    );
    expect(source).to.include("MpcCore.validateCiphertext(input)");
    expect(source).to.include("address(this)");
    expect(source).to.include("msg.sender");
    expect(source).to.include("msg.sig");
    expect(source).to.include("high = MpcCore.div(packed, FIELD_BASE)");
    expect(source).to.include("low = MpcCore.rem(packed, FIELD_BASE)");
    expect(source).not.to.match(/emit\s+\w+\([^;]*MpcCore\.decrypt/isu);
  });

  it("keeps Mode 1 and Mode 2 proof endpoints on the same encrypted result shape", async function () {
    const artifact = await artifacts.readArtifact("PrivateITPackingProbe");
    const event = new Interface(artifact.abi).getEvent("PrivatePackingResult");
    expect(event).to.not.equal(null);
    expect(event!.inputs.map((input) => input.type)).to.deep.equal([
      "address",
      "bytes32",
      "uint8",
      "uint8",
      "tuple",
      "tuple",
      "tuple",
    ]);
  });
});
