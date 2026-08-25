export const EVM_NATIVE_ASSET_ADDRESS =
  "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as const;

export const WRAPPED_NATIVE_TOKEN_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function deposit() payable",
  "function withdraw(uint256)",
  "event Deposit(address indexed account,uint256 amount)",
  "event Withdrawal(address indexed account,uint256 amount)",
] as const;

export const PUBLIC_CPMM_NATIVE_ROUTER_ABI = [
  "function PROTOCOL_VERSION() view returns (uint256)",
  "function factory() view returns (address)",
  "function publicRouter() view returns (address)",
  "function publicLiquidityRouter() view returns (address)",
  "function wrappedNative() view returns (address)",
  "function swapExactNativeForToken(address,uint256,uint64,address) payable returns (uint256)",
  "function swapExactTokenForNative(address,uint256,uint256,uint64,address) returns (uint256)",
  "function createOrAddLiquidityNative(address,uint8,uint256,uint256,uint256,uint256,uint256,uint64,address) payable returns (address,uint256,uint256,uint256)",
  "function removeLiquidityNative(address,uint256,uint256,uint256,uint64,address) returns (uint256,uint256)",
  "function removeLiquidityNativeWithPermit(address,uint256,uint256,uint256,uint64,address,uint256,uint8,bytes32,bytes32) returns (uint256,uint256)",
  "event NativeSwapRouted(address indexed trader,address indexed recipient,address indexed pool,address inputToken,address outputToken,uint256 amountIn,uint256 amountOut)",
  "event NativeLiquidityAdded(address indexed provider,address indexed recipient,address indexed pool,address pairedToken,uint256 nativeAmount,uint256 tokenAmount,uint256 shares)",
  "event NativeLiquidityRemoved(address indexed provider,address indexed recipient,address indexed pool,address pairedToken,uint256 nativeAmount,uint256 tokenAmount,uint256 shares)",
] as const;

export const PUBLIC_LP_PERMIT_EIP712_TYPES = Object.freeze({
  Permit: Object.freeze([
    Object.freeze({ name: "owner", type: "address" }),
    Object.freeze({ name: "spender", type: "address" }),
    Object.freeze({ name: "value", type: "uint256" }),
    Object.freeze({ name: "nonce", type: "uint256" }),
    Object.freeze({ name: "deadline", type: "uint256" }),
  ]),
});

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = /^0x0{40}$/i;
const UINT64_MAX = (1n << 64n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;

function assertContractAddress(value: string, label: string): void {
  if (!ADDRESS.test(value) || ZERO_ADDRESS.test(value) || isEvmNativeAssetAddress(value)) {
    throw new TypeError(`Invalid ${label} address`);
  }
}

function assertRecipient(value: string): void {
  if (!ADDRESS.test(value) || ZERO_ADDRESS.test(value)) {
    throw new TypeError("Invalid native swap recipient address");
  }
}

function assertUint256(value: bigint, label: string, allowZero = false): void {
  if (
    typeof value !== "bigint" ||
    value < (allowZero ? 0n : 1n) ||
    value > UINT256_MAX
  ) {
    throw new TypeError(`Invalid ${label}`);
  }
}

export function isEvmNativeAssetAddress(value: string): boolean {
  return value.toLowerCase() === EVM_NATIVE_ASSET_ADDRESS.toLowerCase();
}

/** Resolves the UI/RPC native sentinel to the ERC-20 address used by pools. */
export function resolvePublicAmmTokenAddress(
  token: string,
  wrappedNative: string,
): string {
  assertContractAddress(wrappedNative, "wrapped native token");
  if (isEvmNativeAssetAddress(token)) return wrappedNative;
  assertContractAddress(token, "public AMM token");
  return token;
}

export type PublicExactInputSwapExecution = Readonly<{
  kind: "token-to-token" | "native-to-token" | "token-to-native";
  to: string;
  functionName:
    | "swapExactInput"
    | "swapExactNativeForToken"
    | "swapExactTokenForNative";
  args: readonly unknown[];
  value: bigint;
  approvalSpender: string | null;
  resolvedTokenIn: string;
  resolvedTokenOut: string;
  zeroForOne: boolean;
}>;

/**
 * Selects the correct immutable public periphery for an exact-input swap.
 * Native assets are represented at the application boundary by the standard
 * 0xEeee... sentinel, while pool matching always uses wrapped-native ERC-20.
 */
export function buildPublicExactInputSwapExecution(input: Readonly<{
  pool: string;
  poolToken0: string;
  poolToken1: string;
  tokenIn: string;
  tokenOut: string;
  wrappedNative: string;
  publicRouter: string;
  nativeRouter: string;
  amountIn: bigint;
  minAmountOut: bigint;
  deadline: bigint;
  recipient: string;
}>): PublicExactInputSwapExecution {
  assertContractAddress(input.pool, "public pool");
  assertContractAddress(input.poolToken0, "pool token0");
  assertContractAddress(input.poolToken1, "pool token1");
  assertContractAddress(input.wrappedNative, "wrapped native token");
  assertContractAddress(input.publicRouter, "public router");
  assertContractAddress(input.nativeRouter, "native router");
  assertRecipient(input.recipient);
  assertUint256(input.amountIn, "public swap amount");
  assertUint256(input.minAmountOut, "public swap minimum output", true);
  if (typeof input.deadline !== "bigint" || input.deadline <= 0n || input.deadline > UINT64_MAX) {
    throw new TypeError("Invalid public swap deadline");
  }
  if (input.poolToken0.toLowerCase() === input.poolToken1.toLowerCase()) {
    throw new TypeError("Invalid public pool token pair");
  }

  const nativeInput = isEvmNativeAssetAddress(input.tokenIn);
  const nativeOutput = isEvmNativeAssetAddress(input.tokenOut);
  if (nativeInput && nativeOutput) {
    throw new TypeError("Native-to-native public swaps are not supported");
  }
  const resolvedTokenIn = resolvePublicAmmTokenAddress(
    input.tokenIn,
    input.wrappedNative,
  );
  const resolvedTokenOut = resolvePublicAmmTokenAddress(
    input.tokenOut,
    input.wrappedNative,
  );
  if (resolvedTokenIn.toLowerCase() === resolvedTokenOut.toLowerCase()) {
    throw new TypeError("Public swap tokens must differ");
  }

  const poolToken0 = input.poolToken0.toLowerCase();
  const poolToken1 = input.poolToken1.toLowerCase();
  const resolvedIn = resolvedTokenIn.toLowerCase();
  const resolvedOut = resolvedTokenOut.toLowerCase();
  const zeroForOne = resolvedIn === poolToken0 && resolvedOut === poolToken1;
  const oneForZero = resolvedIn === poolToken1 && resolvedOut === poolToken0;
  if (!zeroForOne && !oneForZero) {
    throw new TypeError("Public swap tokens do not match the selected pool");
  }

  if (nativeInput) {
    return Object.freeze({
      kind: "native-to-token" as const,
      to: input.nativeRouter,
      functionName: "swapExactNativeForToken" as const,
      args: Object.freeze([
        input.pool,
        input.minAmountOut,
        input.deadline,
        input.recipient,
      ]),
      value: input.amountIn,
      approvalSpender: null,
      resolvedTokenIn,
      resolvedTokenOut,
      zeroForOne,
    });
  }
  if (nativeOutput) {
    return Object.freeze({
      kind: "token-to-native" as const,
      to: input.nativeRouter,
      functionName: "swapExactTokenForNative" as const,
      args: Object.freeze([
        input.pool,
        input.amountIn,
        input.minAmountOut,
        input.deadline,
        input.recipient,
      ]),
      value: 0n,
      approvalSpender: input.nativeRouter,
      resolvedTokenIn,
      resolvedTokenOut,
      zeroForOne,
    });
  }
  return Object.freeze({
    kind: "token-to-token" as const,
    to: input.publicRouter,
    functionName: "swapExactInput" as const,
    args: Object.freeze([
      input.pool,
      input.amountIn,
      input.minAmountOut,
      zeroForOne,
      input.deadline,
    ]),
    value: 0n,
    approvalSpender: input.publicRouter,
    resolvedTokenIn,
    resolvedTokenOut,
    zeroForOne,
  });
}

export function buildWrapNativeCall(input: Readonly<{
  wrappedNative: string;
  amount: bigint;
}>): Readonly<{
  to: string;
  functionName: "deposit";
  args: readonly [];
  value: bigint;
}> {
  assertContractAddress(input.wrappedNative, "wrapped native token");
  assertUint256(input.amount, "native wrap amount");
  return Object.freeze({
    to: input.wrappedNative,
    functionName: "deposit" as const,
    args: Object.freeze([] as const),
    value: input.amount,
  });
}

export function buildUnwrapNativeCall(input: Readonly<{
  wrappedNative: string;
  amount: bigint;
}>): Readonly<{
  to: string;
  functionName: "withdraw";
  args: readonly [bigint];
  value: 0n;
}> {
  assertContractAddress(input.wrappedNative, "wrapped native token");
  assertUint256(input.amount, "native unwrap amount");
  return Object.freeze({
    to: input.wrappedNative,
    functionName: "withdraw" as const,
    args: Object.freeze([input.amount] as const),
    value: 0n,
  });
}

export type PublicNativeLiquidityAddExecution = Readonly<{
  kind: "native-liquidity-add";
  to: string;
  functionName: "createOrAddLiquidityNative";
  args: readonly [string, number, bigint, bigint, bigint, bigint, bigint, bigint, string];
  value: bigint;
  tokenApprovalSpender: string;
}>;

export function buildPublicNativeLiquidityAddExecution(input: Readonly<{
  nativeRouter: string;
  pairedToken: string;
  pairedTokenDecimals: number;
  feeBps: bigint;
  nativeAmountDesired: bigint;
  tokenAmountDesired: bigint;
  minShares: bigint;
  minPriceX18: bigint;
  maxPriceX18: bigint;
  deadline: bigint;
  recipient: string;
}>): PublicNativeLiquidityAddExecution {
  assertContractAddress(input.nativeRouter, "native router");
  assertContractAddress(input.pairedToken, "paired token");
  assertRecipient(input.recipient);
  if (
    !Number.isInteger(input.pairedTokenDecimals) ||
    input.pairedTokenDecimals < 0 ||
    input.pairedTokenDecimals > 18
  ) throw new TypeError("Invalid paired token decimals");
  assertUint256(input.feeBps, "public liquidity fee");
  assertUint256(input.nativeAmountDesired, "native liquidity amount");
  assertUint256(input.tokenAmountDesired, "paired liquidity amount");
  assertUint256(input.minShares, "minimum LP shares", true);
  assertUint256(input.minPriceX18, "minimum public liquidity price", true);
  assertUint256(input.maxPriceX18, "maximum public liquidity price", true);
  if (input.minPriceX18 > input.maxPriceX18) {
    throw new TypeError("Invalid public liquidity price bounds");
  }
  if (input.deadline <= 0n || input.deadline > UINT64_MAX) {
    throw new TypeError("Invalid public liquidity deadline");
  }
  return Object.freeze({
    kind: "native-liquidity-add" as const,
    to: input.nativeRouter,
    functionName: "createOrAddLiquidityNative" as const,
    args: Object.freeze([
      input.pairedToken,
      input.pairedTokenDecimals,
      input.feeBps,
      input.tokenAmountDesired,
      input.minShares,
      input.minPriceX18,
      input.maxPriceX18,
      input.deadline,
      input.recipient,
    ] as const),
    value: input.nativeAmountDesired,
    tokenApprovalSpender: input.nativeRouter,
  });
}

export type PublicLiquidityRemovalExecution = Readonly<{
  kind: "token-liquidity-remove" | "native-liquidity-remove";
  to: string;
  functionName:
    | "removeLiquidity"
    | "removeLiquidityWithPermit"
    | "removeLiquidityNative"
    | "removeLiquidityNativeWithPermit";
  args: readonly unknown[];
  value: 0n;
  lpApprovalSpender: string | null;
}>;

export type PublicLpPermitSignature = Readonly<{
  deadline: bigint;
  v: number;
  r: string;
  s: string;
}>;

function assertPermitSignature(signature: PublicLpPermitSignature): void {
  if (
    signature.deadline <= 0n ||
    signature.deadline > UINT256_MAX ||
    (signature.v !== 27 && signature.v !== 28) ||
    !/^0x[0-9a-fA-F]{64}$/.test(signature.r) ||
    !/^0x[0-9a-fA-F]{64}$/.test(signature.s)
  ) throw new TypeError("Invalid public LP permit signature");
}

export function buildPublicLiquidityRemovalExecution(input: Readonly<{
  pool: string;
  liquidityRouter: string;
  nativeRouter: string;
  shareAmount: bigint;
  minAmount0: bigint;
  minAmount1: bigint;
  deadline: bigint;
  recipient: string;
  unwrapNative: boolean;
  wrappedNativeIsToken0?: boolean;
  permit?: PublicLpPermitSignature;
}>): PublicLiquidityRemovalExecution {
  assertContractAddress(input.pool, "public pool");
  assertContractAddress(input.liquidityRouter, "public liquidity router");
  assertContractAddress(input.nativeRouter, "native router");
  assertRecipient(input.recipient);
  assertUint256(input.shareAmount, "public LP share amount");
  assertUint256(input.minAmount0, "minimum token0 amount", true);
  assertUint256(input.minAmount1, "minimum token1 amount", true);
  if (input.deadline <= 0n || input.deadline > UINT64_MAX) {
    throw new TypeError("Invalid public liquidity deadline");
  }
  if (input.permit) assertPermitSignature(input.permit);

  if (input.unwrapNative) {
    if (typeof input.wrappedNativeIsToken0 !== "boolean") {
      throw new TypeError("Wrapped-native pool side is required");
    }
    const minNative = input.wrappedNativeIsToken0
      ? input.minAmount0
      : input.minAmount1;
    const minToken = input.wrappedNativeIsToken0
      ? input.minAmount1
      : input.minAmount0;
    const args: unknown[] = [
      input.pool,
      input.shareAmount,
      minToken,
      minNative,
      input.deadline,
      input.recipient,
    ];
    if (input.permit) {
      args.push(
        input.permit.deadline,
        input.permit.v,
        input.permit.r,
        input.permit.s,
      );
    }
    return Object.freeze({
      kind: "native-liquidity-remove" as const,
      to: input.nativeRouter,
      functionName: input.permit
        ? "removeLiquidityNativeWithPermit" as const
        : "removeLiquidityNative" as const,
      args: Object.freeze(args),
      value: 0n,
      lpApprovalSpender: input.permit ? null : input.nativeRouter,
    });
  }

  const args: unknown[] = [
    input.pool,
    input.shareAmount,
    input.minAmount0,
    input.minAmount1,
    input.deadline,
    input.recipient,
  ];
  if (input.permit) {
    args.push(
      input.permit.deadline,
      input.permit.v,
      input.permit.r,
      input.permit.s,
    );
  }
  return Object.freeze({
    kind: "token-liquidity-remove" as const,
    to: input.liquidityRouter,
    functionName: input.permit
      ? "removeLiquidityWithPermit" as const
      : "removeLiquidity" as const,
    args: Object.freeze(args),
    value: 0n,
    lpApprovalSpender: input.permit ? null : input.liquidityRouter,
  });
}

export function buildPublicLpPermitTypedData(input: Readonly<{
  chainId: number | bigint;
  lpToken: string;
  owner: string;
  spender: string;
  value: bigint;
  nonce: bigint;
  deadline: bigint;
}>) {
  assertContractAddress(input.lpToken, "public LP token");
  assertContractAddress(input.owner, "public LP owner");
  assertContractAddress(input.spender, "public LP spender");
  assertUint256(input.value, "public LP permit amount");
  assertUint256(input.nonce, "public LP permit nonce", true);
  assertUint256(input.deadline, "public LP permit deadline");
  const chainId = typeof input.chainId === "number"
    ? BigInt(input.chainId)
    : input.chainId;
  if (chainId <= 0n || chainId > UINT256_MAX) {
    throw new TypeError("Invalid public LP permit chain ID");
  }
  return Object.freeze({
    domain: Object.freeze({
      name: "CipherDEX Public LP Share",
      version: "1",
      chainId,
      verifyingContract: input.lpToken,
    }),
    types: PUBLIC_LP_PERMIT_EIP712_TYPES,
    primaryType: "Permit" as const,
    message: Object.freeze({
      owner: input.owner,
      spender: input.spender,
      value: input.value,
      nonce: input.nonce,
      deadline: input.deadline,
    }),
  });
}
