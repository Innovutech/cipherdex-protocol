import { expect } from "chai";
import { Wallet as CotiWallet } from "@coti-io/coti-ethers";
import { decryptPrivateValue256 } from "../../scripts/coti-testnet-values";
import {
  deriveFundedTestAmount,
  fundedScenarioCap,
} from "../../scripts/funded-balance-budget";
import { assertCompatiblePrivateTokens } from "../../scripts/private-token-compatibility";

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

describe("private-token structural compatibility policy", function () {
  const tokenA = "0x0000000000000000000000000000000000000011";
  const tokenB = "0x0000000000000000000000000000000000000022";

  it("accepts every address the canonical factory reports as compatible", async function () {
    const observed: string[] = [];
    await assertCompatiblePrivateTokens({
      isCompatiblePrivateToken: async (token: string) => {
        observed.push(token);
        return true;
      },
    }, [tokenA, tokenB]);
    expect(observed).to.deep.equal([tokenA, tokenB]);
  });

  it("fails closed for invalid addresses and factory-reported incompatibility", async function () {
    await expectRejected(
      assertCompatiblePrivateTokens({ isCompatiblePrivateToken: async () => true }, []),
      "requires deployed token addresses",
    );
    await expectRejected(
      assertCompatiblePrivateTokens(
        { isCompatiblePrivateToken: async () => true },
        ["invalid"],
      ),
      "requires deployed token addresses",
    );
    await expectRejected(
      assertCompatiblePrivateTokens(
        { isCompatiblePrivateToken: async (token: string) => token !== tokenB },
        [tokenA, tokenB],
      ),
      "not technically compatible",
    );
  });
});

describe("funded private-balance budgeting", function () {
  it("prefers one basis point and never exceeds one tenth of one percent", function () {
    const budget = deriveFundedTestAmount(10_000_000n, 1n);
    expect(budget.amount).to.equal(1_000n);
    expect(budget.cap).to.equal(10_000n);
    expect(fundedScenarioCap(10_000_000n)).to.equal(10_000n);
  });

  it("uses the smallest safe minimum only while it remains inside the cap", function () {
    expect(deriveFundedTestAmount(10_000_000n, 2_000n).amount).to.equal(2_000n);
    expect(() => deriveFundedTestAmount(10_000_000n, 10_001n))
      .to.throw("within the 0.1% cap");
  });
});
