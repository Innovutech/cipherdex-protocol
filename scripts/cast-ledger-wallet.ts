import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { promisify } from "node:util";

import {
  AbstractSigner,
  Transaction,
  getAddress,
  getBigInt,
  type Provider,
  type TransactionRequest,
  type TransactionResponse,
  type TypedDataDomain,
  type TypedDataField,
} from "ethers";

import { sendPreparedFundedTransaction } from "./funded-transaction-wallet";

const execFileAsync = promisify(execFile);
export const REVIEWED_CAST_VERSION = "1.7.1";

export type ReviewedCastLedgerConfiguration = Readonly<{
  executable: string;
  executableSha256: string;
  ledgerAddress: string;
  derivationPath: string;
  rpcUrl: string;
}>;

export type ReviewedCastIdentity = Readonly<{
  executable: string;
  executableSha256: string;
  version: string;
}>;

type CastRunner = (
  executable: string,
  arguments_: readonly string[],
) => Promise<Readonly<{ stdout: string; stderr: string }>>;

const defaultCastRunner: CastRunner = async (executable, arguments_) => {
  const result = await execFileAsync(executable, arguments_, {
    env: {
      PATH: process.env.PATH,
      Path: process.env.Path,
      SystemRoot: process.env.SystemRoot,
      SYSTEMROOT: process.env.SYSTEMROOT,
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      APPDATA: process.env.APPDATA,
      LOCALAPPDATA: process.env.LOCALAPPDATA,
    },
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  return Object.freeze({ stdout: result.stdout, stderr: result.stderr });
};

function requiredHexDigest(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(normalized)) {
    throw new Error("CIPHERDEX_CAST_SHA256 must be a 64-character SHA-256 digest");
  }
  return normalized;
}

function isInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}

async function assertCastExecutableUnchanged(identity: ReviewedCastIdentity): Promise<void> {
  const original = await lstat(identity.executable);
  if (!original.isFile() || original.isSymbolicLink()) {
    throw new Error("the reviewed cast executable is no longer a regular file");
  }
  if (await realpath(identity.executable) !== identity.executable) {
    throw new Error("the reviewed cast executable path changed after review");
  }
  const digest = createHash("sha256")
    .update(await readFile(identity.executable))
    .digest("hex");
  if (digest !== identity.executableSha256) {
    throw new Error("the reviewed cast executable changed after review");
  }
}

export async function reviewCastExecutable(
  executable: string,
  expectedSha256: string,
  runner: CastRunner = defaultCastRunner,
): Promise<ReviewedCastIdentity> {
  if (!isAbsolute(executable)) {
    throw new Error("CIPHERDEX_CAST_PATH must be an absolute path");
  }
  const original = await lstat(executable);
  if (!original.isFile() || original.isSymbolicLink()) {
    throw new Error("CIPHERDEX_CAST_PATH must be a regular non-symlink file");
  }
  const canonical = await realpath(executable);
  const repositoryRoot = await realpath(process.cwd());
  const publicRepository = process.env.CIPHERDEX_PUBLIC_REPOSITORY_ROOT?.trim();
  const publicRepositoryRoot = publicRepository && isAbsolute(publicRepository)
    ? await realpath(publicRepository)
    : undefined;
  if (
    isInside(repositoryRoot, canonical) ||
    (publicRepositoryRoot !== undefined && isInside(publicRepositoryRoot, canonical))
  ) {
    throw new Error("the reviewed cast executable must remain outside the repository/runtime");
  }
  const digest = createHash("sha256").update(await readFile(canonical)).digest("hex");
  if (digest !== requiredHexDigest(expectedSha256)) {
    throw new Error("the cast executable does not match CIPHERDEX_CAST_SHA256");
  }
  const { stdout } = await runner(canonical, ["--version"]);
  const versionMatch = /^cast Version: (\d+\.\d+\.\d+)(?:[-+][^\r\n]+)?$/mu.exec(stdout.trim());
  if (!versionMatch || versionMatch[1] !== REVIEWED_CAST_VERSION) {
    throw new Error(`cast ${REVIEWED_CAST_VERSION} is required`);
  }
  return Object.freeze({
    executable: canonical,
    executableSha256: digest,
    version: REVIEWED_CAST_VERSION,
  });
}

function requiredPopulatedBigInt(value: unknown, field: string): bigint {
  if (value === undefined || value === null) {
    throw new Error(`Ledger transaction requires populated ${field}`);
  }
  return getBigInt(value as Parameters<typeof getBigInt>[0]);
}

export function buildCastLedgerMktxArguments(
  transaction: TransactionRequest,
  configuration: Pick<ReviewedCastLedgerConfiguration, "ledgerAddress" | "derivationPath" | "rpcUrl">,
): readonly string[] {
  const chainId = requiredPopulatedBigInt(transaction.chainId, "chain ID");
  const nonce = requiredPopulatedBigInt(transaction.nonce, "nonce");
  const gasLimit = requiredPopulatedBigInt(transaction.gasLimit, "gas limit");
  const value = getBigInt(transaction.value ?? 0);
  const data = String(transaction.data ?? "0x");
  if (!/^0x(?:[0-9a-f]{2})*$/iu.test(data)) {
    throw new Error("Ledger transaction calldata must be canonical hex bytes");
  }
  if (
    transaction.authorizationList !== undefined ||
    transaction.blobs !== undefined ||
    transaction.blobVersionedHashes !== undefined ||
    transaction.maxFeePerBlobGas !== undefined ||
    (transaction.accessList !== undefined && transaction.accessList !== null)
  ) {
    throw new Error("Ledger deployment does not support access-list, blob, or authorization envelopes");
  }
  const expectedType = transaction.gasPrice !== undefined && transaction.gasPrice !== null ? 0 : 2;
  if (transaction.type !== undefined && transaction.type !== null) {
    const reviewedType = Number(transaction.type);
    if (reviewedType !== expectedType) {
      throw new Error("Ledger transaction type conflicts with its reviewed fee model");
    }
  }

  const arguments_: string[] = ["mktx"];
  if (transaction.to === undefined || transaction.to === null) {
    arguments_.push("--create", data);
  } else {
    arguments_.push(String(transaction.to));
    if (data !== "0x") arguments_.push(data);
  }
  arguments_.push(
    "--rpc-url", configuration.rpcUrl,
    "--chain", chainId.toString(),
    "--ledger",
    "--from", getAddress(configuration.ledgerAddress),
    "--mnemonic-derivation-path", configuration.derivationPath,
    "--nonce", nonce.toString(),
    "--gas-limit", gasLimit.toString(),
    "--value", value.toString(),
  );

  if (transaction.gasPrice !== undefined && transaction.gasPrice !== null) {
    if (transaction.maxFeePerGas !== undefined || transaction.maxPriorityFeePerGas !== undefined) {
      throw new Error("Ledger transaction has conflicting fee models");
    }
    arguments_.push("--legacy", "--gas-price", getBigInt(transaction.gasPrice).toString());
  } else {
    arguments_.push(
      "--gas-price",
      requiredPopulatedBigInt(transaction.maxFeePerGas, "max fee per gas").toString(),
      "--priority-gas-price",
      requiredPopulatedBigInt(
        transaction.maxPriorityFeePerGas,
        "max priority fee per gas",
      ).toString(),
    );
  }
  return Object.freeze(arguments_);
}

function sameAddress(left: string | null | undefined, right: unknown): boolean {
  if (left === null || left === undefined) return right === null || right === undefined;
  return typeof right === "string" && getAddress(left) === getAddress(right);
}

export function validateCastLedgerSignedTransaction(
  signedTransaction: string,
  reviewed: TransactionRequest,
  expectedSigner: string,
): Transaction {
  const parsed = Transaction.from(signedTransaction);
  const reviewedGasPrice = reviewed.gasPrice === undefined || reviewed.gasPrice === null
    ? null
    : getBigInt(reviewed.gasPrice);
  const reviewedMaxFee = reviewed.maxFeePerGas === undefined || reviewed.maxFeePerGas === null
    ? null
    : getBigInt(reviewed.maxFeePerGas);
  const reviewedPriorityFee =
    reviewed.maxPriorityFeePerGas === undefined || reviewed.maxPriorityFeePerGas === null
      ? null
      : getBigInt(reviewed.maxPriorityFeePerGas);
  const reviewedType = reviewedGasPrice === null ? 2 : 0;
  if (
    parsed.from === null ||
    getAddress(parsed.from) !== getAddress(expectedSigner) ||
    parsed.chainId !== requiredPopulatedBigInt(reviewed.chainId, "chain ID") ||
    BigInt(parsed.nonce) !== requiredPopulatedBigInt(reviewed.nonce, "nonce") ||
    !sameAddress(parsed.to, reviewed.to) ||
    parsed.data.toLowerCase() !== String(reviewed.data ?? "0x").toLowerCase() ||
    parsed.value !== getBigInt(reviewed.value ?? 0) ||
    parsed.gasLimit !== requiredPopulatedBigInt(reviewed.gasLimit, "gas limit") ||
    parsed.type !== reviewedType ||
    parsed.gasPrice !== reviewedGasPrice ||
    parsed.maxFeePerGas !== reviewedMaxFee ||
    parsed.maxPriorityFeePerGas !== reviewedPriorityFee ||
    parsed.maxFeePerBlobGas !== null ||
    parsed.authorizationList !== null ||
    (parsed.accessList !== null && parsed.accessList.length !== 0)
  ) {
    throw new Error("Ledger signed transaction differs from the reviewed deployment request");
  }
  return parsed;
}

export class CastLedgerWallet extends AbstractSigner {
  readonly address: string;
  readonly castIdentity: ReviewedCastIdentity;
  readonly #configuration: ReviewedCastLedgerConfiguration;
  readonly #runner: CastRunner;

  private constructor(
    configuration: ReviewedCastLedgerConfiguration,
    castIdentity: ReviewedCastIdentity,
    provider: Provider,
    runner: CastRunner,
  ) {
    super(provider);
    this.address = getAddress(configuration.ledgerAddress);
    this.#configuration = configuration;
    this.castIdentity = castIdentity;
    this.#runner = runner;
  }

  static async create(
    configuration: ReviewedCastLedgerConfiguration,
    provider: Provider,
    runner: CastRunner = defaultCastRunner,
  ): Promise<CastLedgerWallet> {
    const castIdentity = await reviewCastExecutable(
      configuration.executable,
      configuration.executableSha256,
      runner,
    );
    return new CastLedgerWallet(configuration, castIdentity, provider, runner);
  }

  override connect(provider: null | Provider): CastLedgerWallet {
    if (!provider) throw new Error("Ledger deployment signer requires a provider");
    return new CastLedgerWallet(this.#configuration, this.castIdentity, provider, this.#runner);
  }

  override async getAddress(): Promise<string> {
    return this.address;
  }

  async verifyDeviceAddress(): Promise<void> {
    await assertCastExecutableUnchanged(this.castIdentity);
    const { stdout } = await this.#runner(this.castIdentity.executable, [
      "wallet",
      "address",
      "--ledger",
      "--mnemonic-derivation-path",
      this.#configuration.derivationPath,
    ]);
    const deviceAddress = stdout.trim().split(/\s+/u).find((value) => /^0x[0-9a-f]{40}$/iu.test(value));
    if (!deviceAddress || getAddress(deviceAddress) !== this.address) {
      throw new Error("connected Ledger account does not match CIPHERDEX_LEDGER_ADDRESS");
    }
  }

  override async signTransaction(transaction: TransactionRequest): Promise<string> {
    await assertCastExecutableUnchanged(this.castIdentity);
    const arguments_ = buildCastLedgerMktxArguments(transaction, this.#configuration);
    console.log("Confirm the reviewed CipherDEX deployment transaction on the Ledger device.");
    const { stdout } = await this.#runner(this.castIdentity.executable, arguments_);
    const signedTransaction = stdout.trim().split(/\s+/u).reverse().find(
      (value: string) => /^0x[0-9a-f]+$/iu.test(value),
    );
    if (!signedTransaction) throw new Error("cast did not return a signed transaction");
    validateCastLedgerSignedTransaction(signedTransaction, transaction, this.address);
    return signedTransaction;
  }

  override signMessage(): Promise<string> {
    throw new Error("Ledger deployment signer does not support message signing");
  }

  override signTypedData(
    _domain: TypedDataDomain,
    _types: Record<string, Array<TypedDataField>>,
    _value: Record<string, unknown>,
  ): Promise<string> {
    throw new Error("Ledger deployment signer does not support typed-data signing");
  }

  override sendTransaction(transaction: TransactionRequest): Promise<TransactionResponse> {
    return sendPreparedFundedTransaction(this, transaction);
  }
}
