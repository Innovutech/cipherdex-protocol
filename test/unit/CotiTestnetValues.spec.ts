import { expect } from "chai";
import { ethers } from "hardhat";
import { Wallet as CotiWallet } from "@coti-io/coti-ethers";
import { decryptPrivateValue256 } from "../../scripts/coti-testnet-values";
import { resolvePrivateTokenCodehashes } from "../../scripts/private-token-codehashes";

async function expectRejected(promise: Promise<unknown>, message: string): Promise<void> {
  let observed: unknown;
  try {
    await promise;
  } catch (error) {
    observed = error;
  }
  expect(observed).to.be.instanceOf(Error);
  expect((observed as Error).message).to.include(message);
}

describe("COTI testnet encrypted-value normalization", function () {
  it("treats the canonical empty ciphertext as zero without invoking AES decryption", async function () {
    let decryptCalled = false;
    const wallet = {
      decryptValue256: async () => {
        decryptCalled = true;
        return 99n;
      },
    } as unknown as CotiWallet;

    expect(await decryptPrivateValue256(wallet, {
      ciphertextHigh: 0n,
      ciphertextLow: 0n,
    })).to.equal(0n);
    expect(decryptCalled).to.equal(false);
  });

  it("delegates non-empty ciphertexts to the configured wallet", async function () {
    let observed: unknown;
    const wallet = {
      decryptValue256: async (ciphertext: unknown) => {
        observed = ciphertext;
        return 7n;
      },
    } as unknown as CotiWallet;
    const ciphertext = { ciphertextHigh: 1n, ciphertextLow: 2n };

    expect(await decryptPrivateValue256(wallet, ciphertext)).to.equal(7n);
    expect(observed).to.equal(ciphertext);
  });
});

describe("private-token runtime-codehash policy", function () {
  const tokenA = "0x0000000000000000000000000000000000000011";
  const tokenB = "0x0000000000000000000000000000000000000022";
  const originalPolicy = process.env.CIPHERDEX_PRIVATE_TOKEN_CODEHASHES;

  afterEach(function () {
    if (originalPolicy === undefined) {
      delete process.env.CIPHERDEX_PRIVATE_TOKEN_CODEHASHES;
    } else {
      process.env.CIPHERDEX_PRIVATE_TOKEN_CODEHASHES = originalPolicy;
    }
  });

  it("derives sorted unique hashes from reviewed deployed runtime code", async function () {
    delete process.env.CIPHERDEX_PRIVATE_TOKEN_CODEHASHES;
    const code = "0x60006000";
    const expected = ethers.keccak256(code).toLowerCase();
    const result = await resolvePrivateTokenCodehashes(
      { getCode: async () => code },
      [tokenA, tokenB],
    );
    expect(result).to.deep.equal([expected]);
  });

  it("requires explicit policy to include every reviewed token implementation", async function () {
    const codeA = "0x60006000";
    const codeB = "0x60016000";
    const hashA = ethers.keccak256(codeA).toLowerCase();
    const hashB = ethers.keccak256(codeB).toLowerCase();
    process.env.CIPHERDEX_PRIVATE_TOKEN_CODEHASHES = hashA;
    const provider = {
      getCode: async (address: string) => address === tokenA ? codeA : codeB,
    };
    await expectRejected(
      resolvePrivateTokenCodehashes(provider, [tokenA, tokenB]),
      "excludes a reviewed token",
    );

    process.env.CIPHERDEX_PRIVATE_TOKEN_CODEHASHES = `${hashB},${hashA},${hashB}`;
    expect(await resolvePrivateTokenCodehashes(provider, [tokenA, tokenB]))
      .to.deep.equal([hashA, hashB].sort());
  });

  it("fails closed for invalid addresses and missing deployed code", async function () {
    delete process.env.CIPHERDEX_PRIVATE_TOKEN_CODEHASHES;
    await expectRejected(
      resolvePrivateTokenCodehashes({ getCode: async () => "0x" }, []),
      "at least one reviewed private token",
    );
    await expectRejected(
      resolvePrivateTokenCodehashes({ getCode: async () => "0x" }, ["invalid"]),
      "invalid private token address",
    );
    await expectRejected(
      resolvePrivateTokenCodehashes({ getCode: async () => "0x" }, [tokenA]),
      "no deployed bytecode",
    );
  });
});
