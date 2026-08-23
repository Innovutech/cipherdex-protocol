import { expect } from "chai";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonRpcProvider, Wallet, type TransactionRequest } from "ethers";

import {
  buildCastLedgerMktxArguments,
  CastLedgerWallet,
  reviewCastExecutable,
  validateCastLedgerSignedTransaction,
} from "../../scripts/cast-ledger-wallet";

const wallet = new Wallet(`0x${"11".repeat(32)}`);
const recipient = `0x${"22".repeat(20)}`;
const configuration = Object.freeze({
  ledgerAddress: wallet.address,
  derivationPath: "m/44'/60'/0'/0/0",
  rpcUrl: "https://mainnet.coti.io/rpc",
});

describe("reviewed cast Ledger signer", function () {
  it("pins an external regular cast binary by digest and reviewed version", async function () {
    const directory = await mkdtemp(join(tmpdir(), "cipherdex-cast-review-"));
    const executable = join(directory, process.platform === "win32" ? "cast.exe" : "cast");
    try {
      const bytes = Buffer.from("reviewed-cast-fixture", "utf8");
      await writeFile(executable, bytes);
      const digest = createHash("sha256").update(bytes).digest("hex");
      const identity = await reviewCastExecutable(
        executable,
        digest,
        async () => ({ stdout: "cast Version: 1.7.1\n", stderr: "" }),
      );
      expect(identity.executableSha256).to.equal(digest);
      expect(identity.version).to.equal("1.7.1");
      let rejected = false;
      try {
        await reviewCastExecutable(
          executable,
          "00".repeat(32),
          async () => ({ stdout: "cast Version: 1.7.1\n", stderr: "" }),
        );
      } catch (error) {
        rejected = error instanceof Error && error.message.includes("does not match");
      }
      expect(rejected).to.equal(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("builds a fully populated EIP-1559 Ledger signing request", function () {
    const arguments_ = buildCastLedgerMktxArguments({
      chainId: 2_632_500,
      type: 2,
      nonce: 7,
      to: recipient,
      data: "0x1234",
      value: 9n,
      gasLimit: 123_456n,
      maxFeePerGas: 80n,
      maxPriorityFeePerGas: 10n,
    }, configuration);
    expect(arguments_.slice(0, 3)).to.deep.equal(["mktx", recipient, "0x1234"]);
    expect(arguments_).to.include.members([
      "--ledger",
      "--chain",
      "2632500",
      "--nonce",
      "7",
      "--gas-limit",
      "123456",
      "--gas-price",
      "80",
      "--priority-gas-price",
      "10",
    ]);
    expect(arguments_).not.to.include("--legacy");
  });

  it("rechecks the reviewed executable before touching the Ledger", async function () {
    const directory = await mkdtemp(join(tmpdir(), "cipherdex-cast-mutation-"));
    const executable = join(directory, process.platform === "win32" ? "cast.exe" : "cast");
    const provider = new JsonRpcProvider("http://127.0.0.1:1", 2_632_500, {
      staticNetwork: true,
    });
    try {
      const bytes = Buffer.from("reviewed-cast-fixture", "utf8");
      await writeFile(executable, bytes);
      const digest = createHash("sha256").update(bytes).digest("hex");
      const ledger = await CastLedgerWallet.create({
        ...configuration,
        executable,
        executableSha256: digest,
      }, provider, async (_path, arguments_) => ({
        stdout: arguments_[0] === "--version"
          ? "cast Version: 1.7.1\n"
          : `${wallet.address}\n`,
        stderr: "",
      }));
      await writeFile(executable, "changed-after-review", "utf8");
      let rejected = false;
      try {
        await ledger.verifyDeviceAddress();
      } catch (error) {
        rejected = error instanceof Error && error.message.includes("changed after review");
      }
      expect(rejected).to.equal(true);
    } finally {
      provider.destroy();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("supports contract creation and rejects unreviewed envelope fields", function () {
    const creation: TransactionRequest = {
      chainId: 2_632_500,
      type: 0,
      nonce: 0,
      data: "0x60006000",
      value: 0,
      gasLimit: 500_000,
      gasPrice: 1,
    };
    expect(buildCastLedgerMktxArguments(creation, configuration).slice(0, 3))
      .to.deep.equal(["mktx", "--create", "0x60006000"]);
    expect(() => buildCastLedgerMktxArguments(
      { ...creation, accessList: [] },
      configuration,
    )).to.throw("does not support");
    expect(() => buildCastLedgerMktxArguments(
      { ...creation, type: 2 },
      configuration,
    )).to.throw("type conflicts");
  });

  it("accepts only a signed transaction identical to the reviewed request", async function () {
    const reviewed: TransactionRequest = {
      chainId: 2_632_500,
      type: 2,
      nonce: 3,
      to: recipient,
      data: "0x1234",
      value: 5n,
      gasLimit: 100_000n,
      maxFeePerGas: 90n,
      maxPriorityFeePerGas: 11n,
    };
    const signed = await wallet.signTransaction(reviewed);
    expect(validateCastLedgerSignedTransaction(signed, reviewed, wallet.address).from)
      .to.equal(wallet.address);
    expect(() => validateCastLedgerSignedTransaction(
      signed,
      { ...reviewed, value: 6n },
      wallet.address,
    )).to.throw("differs");
    expect(() => validateCastLedgerSignedTransaction(
      signed,
      reviewed,
      `0x${"33".repeat(20)}`,
    )).to.throw("differs");
  });
});
