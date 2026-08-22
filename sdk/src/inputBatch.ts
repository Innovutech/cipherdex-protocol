import {
  AbiCoder,
  TypedDataEncoder,
  getAddress,
  id,
  isAddress,
  keccak256,
} from "ethers";

export const CIPHERDEX_INPUT_BATCH_DOMAIN_NAME =
  "CipherDEX Confidential Inputs" as const;
export const CIPHERDEX_INPUT_BATCH_DOMAIN_VERSION = "1" as const;
export const CIPHERDEX_INPUT_BATCH_PRIMARY_TYPE = "CipherDEXInputBatch" as const;

export const CIPHERDEX_INPUT_BATCH_TYPES = {
  CipherDEXInputBatch: [
    { name: "protocolVersion", type: "uint256" },
    { name: "caller", type: "address" },
    { name: "target", type: "address" },
    { name: "selector", type: "bytes4" },
    { name: "schemaHash", type: "bytes32" },
    { name: "ciphertextsHash", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "deadline", type: "uint64" },
  ],
};
Object.freeze(CIPHERDEX_INPUT_BATCH_TYPES.CipherDEXInputBatch);
Object.freeze(CIPHERDEX_INPUT_BATCH_TYPES);

export type CipherDexBatchCiphertext = Readonly<{
  ciphertextHigh: bigint;
  ciphertextLow: bigint;
}>;

export type CipherDexInputBatchAuthorization = Readonly<{
  protocolVersion: bigint;
  schemaHash: string;
  nonce: string;
  deadline: bigint;
  signature: string;
}>;

export type CipherDexInputBatchTypedData = Readonly<{
  domain: Readonly<{
    name: typeof CIPHERDEX_INPUT_BATCH_DOMAIN_NAME;
    version: typeof CIPHERDEX_INPUT_BATCH_DOMAIN_VERSION;
    chainId: bigint;
    verifyingContract: string;
  }>;
  types: typeof CIPHERDEX_INPUT_BATCH_TYPES;
  primaryType: typeof CIPHERDEX_INPUT_BATCH_PRIMARY_TYPE;
  message: Readonly<{
    protocolVersion: bigint;
    caller: string;
    target: string;
    selector: string;
    schemaHash: string;
    ciphertextsHash: string;
    nonce: string;
    deadline: bigint;
  }>;
}>;

const UINT64_MAX = (1n << 64n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const SELECTOR = /^0x[0-9a-fA-F]{8}$/;
const SIGNATURE = /^0x(?:[0-9a-fA-F]{2})+$/;
const abi = AbiCoder.defaultAbiCoder();

export function cipherDexInputSchemaHash(schema: string): string {
  if (!/^CipherDEX\.[a-zA-Z0-9]+\([a-zA-Z0-9,]+\)$/.test(schema)) {
    throw new TypeError("Invalid CipherDEX input-batch schema");
  }
  const slots = schema.slice(schema.indexOf("(") + 1, -1).split(",");
  if (new Set(slots).size !== slots.length) {
    throw new TypeError("CipherDEX input-batch schema repeats a slot");
  }
  return id(schema);
}

export const CIPHERDEX_INPUT_BATCH_SCHEMAS = Object.freeze({
  SWAP_EXACT_INPUT: Object.freeze({
    slots: Object.freeze(["amountIn", "minimumOut"] as const),
    schema: "CipherDEX.swapExactInput(amountIn,minimumOut)",
    schemaHash: cipherDexInputSchemaHash(
      "CipherDEX.swapExactInput(amountIn,minimumOut)",
    ),
  }),
  BEST_SWAP_EXACT_INPUT: Object.freeze({
    slots: Object.freeze(["amountIn", "minimumOut"] as const),
    schema: "CipherDEX.bestSwapExactInput(amountIn,minimumOut)",
    schemaHash: cipherDexInputSchemaHash(
      "CipherDEX.bestSwapExactInput(amountIn,minimumOut)",
    ),
  }),
  ADD_LIQUIDITY: Object.freeze({
    slots: Object.freeze([
      "amount0",
      "amount1",
      "minimumShares",
      "minimumPriceX18",
      "maximumPriceX18",
    ] as const),
    schema:
      "CipherDEX.addLiquidity(amount0,amount1,minimumShares,minimumPriceX18,maximumPriceX18)",
    schemaHash: cipherDexInputSchemaHash(
      "CipherDEX.addLiquidity(amount0,amount1,minimumShares,minimumPriceX18,maximumPriceX18)",
    ),
  }),
  REMOVE_LIQUIDITY: Object.freeze({
    slots: Object.freeze([
      "shares",
      "minimumAmount0",
      "minimumAmount1",
    ] as const),
    schema:
      "CipherDEX.removeLiquidity(shares,minimumAmount0,minimumAmount1)",
    schemaHash: cipherDexInputSchemaHash(
      "CipherDEX.removeLiquidity(shares,minimumAmount0,minimumAmount1)",
    ),
  }),
  LAUNCH_MIGRATION: Object.freeze({
    slots: Object.freeze([
      "amount0",
      "amount1",
      "minimumShares",
      "minimumPriceX18",
      "maximumPriceX18",
    ] as const),
    schema:
      "CipherDEX.launchMigration(amount0,amount1,minimumShares,minimumPriceX18,maximumPriceX18)",
    schemaHash: cipherDexInputSchemaHash(
      "CipherDEX.launchMigration(amount0,amount1,minimumShares,minimumPriceX18,maximumPriceX18)",
    ),
  }),
});

export function cipherDexCiphertextCommitment(
  ciphertext: CipherDexBatchCiphertext,
): string {
  if (
    !ciphertext ||
    typeof ciphertext.ciphertextHigh !== "bigint" ||
    typeof ciphertext.ciphertextLow !== "bigint" ||
    ciphertext.ciphertextHigh < 0n ||
    ciphertext.ciphertextHigh > UINT256_MAX ||
    ciphertext.ciphertextLow < 0n ||
    ciphertext.ciphertextLow > UINT256_MAX
  ) {
    throw new TypeError("Invalid CipherDEX batch ciphertext");
  }
  return keccak256(abi.encode(
    ["uint256", "uint256"],
    [ciphertext.ciphertextHigh, ciphertext.ciphertextLow],
  ));
}

export function cipherDexCiphertextsHash(
  ciphertexts: readonly CipherDexBatchCiphertext[],
): string {
  if (ciphertexts.length === 0 || ciphertexts.length > 5) {
    throw new TypeError("Invalid CipherDEX input-batch slot count");
  }
  const commitments = ciphertexts.map(cipherDexCiphertextCommitment);
  if (new Set(commitments.map((value) => value.toLowerCase())).size !== commitments.length) {
    throw new TypeError("CipherDEX input batch repeats a ciphertext");
  }
  return keccak256(abi.encode(["bytes32[]"], [commitments]));
}

export function buildCipherDexInputBatchTypedData(input: Readonly<{
  chainId: bigint;
  protocolVersion: bigint;
  caller: string;
  target: string;
  selector: string;
  schemaHash: string;
  ciphertexts: readonly CipherDexBatchCiphertext[];
  nonce: string;
  deadline: bigint;
}>): CipherDexInputBatchTypedData {
  if (
    input.chainId <= 0n ||
    input.protocolVersion <= 0n ||
    !isAddress(input.caller) ||
    !isAddress(input.target) ||
    !SELECTOR.test(input.selector) ||
    !BYTES32.test(input.schemaHash) ||
    !BYTES32.test(input.nonce) ||
    /^0x0{64}$/i.test(input.nonce) ||
    input.deadline <= 0n ||
    input.deadline > UINT64_MAX
  ) {
    throw new TypeError("Invalid CipherDEX input-batch authorization envelope");
  }
  const target = getAddress(input.target);
  const message = Object.freeze({
    protocolVersion: input.protocolVersion,
    caller: getAddress(input.caller),
    target,
    selector: input.selector.toLowerCase(),
    schemaHash: input.schemaHash.toLowerCase(),
    ciphertextsHash: cipherDexCiphertextsHash(input.ciphertexts),
    nonce: input.nonce.toLowerCase(),
    deadline: input.deadline,
  });
  return Object.freeze({
    domain: Object.freeze({
      name: CIPHERDEX_INPUT_BATCH_DOMAIN_NAME,
      version: CIPHERDEX_INPUT_BATCH_DOMAIN_VERSION,
      chainId: input.chainId,
      verifyingContract: target,
    }),
    types: CIPHERDEX_INPUT_BATCH_TYPES,
    primaryType: CIPHERDEX_INPUT_BATCH_PRIMARY_TYPE,
    message,
  });
}

export function cipherDexInputBatchDigest(
  typedData: CipherDexInputBatchTypedData,
): string {
  return TypedDataEncoder.hash(
    typedData.domain,
    typedData.types,
    typedData.message,
  );
}

export async function signCipherDexInputBatch(
  signer: Readonly<{
    signTypedData(
      domain: CipherDexInputBatchTypedData["domain"],
      types: CipherDexInputBatchTypedData["types"],
      message: CipherDexInputBatchTypedData["message"],
    ): Promise<string>;
  }>,
  typedData: CipherDexInputBatchTypedData,
): Promise<CipherDexInputBatchAuthorization> {
  const signature = await signer.signTypedData(
    typedData.domain,
    typedData.types,
    typedData.message,
  );
  if (!SIGNATURE.test(signature)) {
    throw new TypeError("Invalid CipherDEX input-batch signature");
  }
  return Object.freeze({
    protocolVersion: typedData.message.protocolVersion,
    schemaHash: typedData.message.schemaHash,
    nonce: typedData.message.nonce,
    deadline: typedData.message.deadline,
    signature,
  });
}
