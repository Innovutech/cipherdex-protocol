export declare const EVM_NATIVE_ASSET_ADDRESS: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
export declare const WRAPPED_NATIVE_TOKEN_ABI: readonly ["function name() view returns (string)", "function symbol() view returns (string)", "function decimals() view returns (uint8)", "function totalSupply() view returns (uint256)", "function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function deposit() payable", "function withdraw(uint256)", "event Deposit(address indexed account,uint256 amount)", "event Withdrawal(address indexed account,uint256 amount)"];
export declare const PUBLIC_CPMM_NATIVE_ROUTER_ABI: readonly ["function PROTOCOL_VERSION() view returns (uint256)", "function factory() view returns (address)", "function publicRouter() view returns (address)", "function publicLiquidityRouter() view returns (address)", "function wrappedNative() view returns (address)", "function swapExactNativeForToken(address,uint256,uint64,address) payable returns (uint256)", "function swapExactTokenForNative(address,uint256,uint256,uint64,address) returns (uint256)", "function createOrAddLiquidityNative(address,uint8,uint256,uint256,uint256,uint256,uint256,uint64,address) payable returns (address,uint256,uint256,uint256)", "function removeLiquidityNative(address,uint256,uint256,uint256,uint64,address) returns (uint256,uint256)", "function removeLiquidityNativeWithPermit(address,uint256,uint256,uint256,uint64,address,uint256,uint8,bytes32,bytes32) returns (uint256,uint256)", "event NativeSwapRouted(address indexed trader,address indexed recipient,address indexed pool,address inputToken,address outputToken,uint256 amountIn,uint256 amountOut)"];
export declare const PUBLIC_LP_PERMIT_EIP712_TYPES: Readonly<{
    Permit: readonly (Readonly<{
        name: "owner";
        type: "address";
    }> | Readonly<{
        name: "spender";
        type: "address";
    }> | Readonly<{
        name: "value";
        type: "uint256";
    }> | Readonly<{
        name: "nonce";
        type: "uint256";
    }> | Readonly<{
        name: "deadline";
        type: "uint256";
    }>)[];
}>;
export declare function isEvmNativeAssetAddress(value: string): boolean;
/** Resolves the UI/RPC native sentinel to the ERC-20 address used by pools. */
export declare function resolvePublicAmmTokenAddress(token: string, wrappedNative: string): string;
export type PublicExactInputSwapExecution = Readonly<{
    kind: "token-to-token" | "native-to-token" | "token-to-native";
    to: string;
    functionName: "swapExactInput" | "swapExactNativeForToken" | "swapExactTokenForNative";
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
export declare function buildPublicExactInputSwapExecution(input: Readonly<{
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
}>): PublicExactInputSwapExecution;
export declare function buildWrapNativeCall(input: Readonly<{
    wrappedNative: string;
    amount: bigint;
}>): Readonly<{
    to: string;
    functionName: "deposit";
    args: readonly [];
    value: bigint;
}>;
export declare function buildUnwrapNativeCall(input: Readonly<{
    wrappedNative: string;
    amount: bigint;
}>): Readonly<{
    to: string;
    functionName: "withdraw";
    args: readonly [bigint];
    value: 0n;
}>;
export type PublicNativeLiquidityAddExecution = Readonly<{
    kind: "native-liquidity-add";
    to: string;
    functionName: "createOrAddLiquidityNative";
    args: readonly [string, number, bigint, bigint, bigint, bigint, bigint, bigint, string];
    value: bigint;
    tokenApprovalSpender: string;
}>;
export declare function buildPublicNativeLiquidityAddExecution(input: Readonly<{
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
}>): PublicNativeLiquidityAddExecution;
export type PublicLiquidityRemovalExecution = Readonly<{
    kind: "token-liquidity-remove" | "native-liquidity-remove";
    to: string;
    functionName: "removeLiquidity" | "removeLiquidityWithPermit" | "removeLiquidityNative" | "removeLiquidityNativeWithPermit";
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
export declare function buildPublicLiquidityRemovalExecution(input: Readonly<{
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
}>): PublicLiquidityRemovalExecution;
export declare function buildPublicLpPermitTypedData(input: Readonly<{
    chainId: number | bigint;
    lpToken: string;
    owner: string;
    spender: string;
    value: bigint;
    nonce: bigint;
    deadline: bigint;
}>): Readonly<{
    domain: Readonly<{
        name: "CipherDEX Public LP Share";
        version: "1";
        chainId: bigint;
        verifyingContract: string;
    }>;
    types: Readonly<{
        Permit: readonly (Readonly<{
            name: "owner";
            type: "address";
        }> | Readonly<{
            name: "spender";
            type: "address";
        }> | Readonly<{
            name: "value";
            type: "uint256";
        }> | Readonly<{
            name: "nonce";
            type: "uint256";
        }> | Readonly<{
            name: "deadline";
            type: "uint256";
        }>)[];
    }>;
    primaryType: "Permit";
    message: Readonly<{
        owner: string;
        spender: string;
        value: bigint;
        nonce: bigint;
        deadline: bigint;
    }>;
}>;
