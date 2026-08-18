import { CotiNetwork, Wallet as CotiWallet } from "@coti-io/coti-ethers";
import { Contract, JsonRpcProvider } from "ethers";
import { ethers } from "../hardhat/runtime.js";
import { PRIVATE_ERC20_TESTNET_ABI } from "./coti-testnet-abi";

const COTI_TESTNET_CHAIN_ID = 7_082_400n;

function requiredAddress(name: string): string {
  const value = process.env[name]?.trim();
  if (!value || !ethers.isAddress(value)) throw new Error(`missing or invalid ${name}`);
  return value;
}

function requiredPrivateKey(name: string): string {
  const value = process.env[name]?.trim();
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`missing or invalid ${name}`);
  }
  return value;
}

function requiredDecimals(name: string): number {
  const value = process.env[name]?.trim();
  if (!value || !/^\d+$/.test(value)) throw new Error(`missing or invalid ${name}`);
  const decimals = Number(value);
  if (!Number.isInteger(decimals) || decimals > 18) throw new Error(`invalid ${name}`);
  return decimals;
}

function isZeroCiphertext(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const tuple = value as { 0?: unknown; 1?: unknown; ciphertextHigh?: unknown; ciphertextLow?: unknown };
  const high = tuple.ciphertextHigh ?? tuple[0];
  const low = tuple.ciphertextLow ?? tuple[1];
  try {
    return BigInt(String(high)) === 0n && BigInt(String(low)) === 0n;
  } catch {
    return false;
  }
}

let stage = "configuration";

async function main(): Promise<void> {
  const privateKey = requiredPrivateKey("COTI_TESTNET_PRIVATE_KEY");
  const aesKey = process.env.COTI_AES_KEY?.trim();
  if (!aesKey) throw new Error("missing COTI_AES_KEY");
  const secondPrivateKey = requiredPrivateKey("COTI_SECOND_LP_PRIVATE_KEY");
  const secondAesKey = process.env.COTI_SECOND_LP_AES_KEY?.trim();
  if (!secondAesKey) throw new Error("missing COTI_SECOND_LP_AES_KEY");
  const quotePrivateKey = requiredPrivateKey("COTI_QUOTE_PRIVATE_KEY");
  const quoteAesKey = process.env.COTI_QUOTE_AES_KEY?.trim();
  if (!quoteAesKey) throw new Error("missing COTI_QUOTE_AES_KEY");

  const tokenAddresses = [requiredAddress("COTI_TOKEN0"), requiredAddress("COTI_TOKEN1")];
  if (tokenAddresses[0].toLowerCase() === tokenAddresses[1].toLowerCase()) {
    throw new Error("COTI_TOKEN0 and COTI_TOKEN1 must be different");
  }
  const expectedDecimals = [
    requiredDecimals("COTI_TOKEN0_DECIMALS"),
    requiredDecimals("COTI_TOKEN1_DECIMALS"),
  ];

  stage = "COTI testnet RPC and chain validation";
  const provider = new JsonRpcProvider(
    process.env.COTI_TESTNET_RPC_URL?.trim() || CotiNetwork.Testnet,
    Number(COTI_TESTNET_CHAIN_ID),
  );
  const network = await provider.getNetwork();
  if (network.chainId !== COTI_TESTNET_CHAIN_ID) {
    throw new Error(`unexpected COTI testnet chain id: ${network.chainId}`);
  }

  const identities = [
    {
      role: "primary LP",
      privateKey,
      aesKey,
      requiresGas: true,
      requiresTokenBalances: true,
    },
    {
      role: "second LP",
      privateKey: secondPrivateKey,
      aesKey: secondAesKey,
      requiresGas: true,
      requiresTokenBalances: true,
    },
    {
      role: "quote service",
      privateKey: quotePrivateKey,
      aesKey: quoteAesKey,
      // Current COTI testnet rejects fresh MPC execution under eth_call, so the
      // currently proven encrypted quote path is a transaction and needs gas.
      requiresGas: true,
      requiresTokenBalances: false,
    },
  ];
  const addresses = new Set<string>();

  for (const identity of identities) {
    const wallet = new CotiWallet(identity.privateKey, provider, { aesKey: identity.aesKey });
    wallet.setAesKey(identity.aesKey);
    const walletAddress = await wallet.getAddress();
    const normalizedAddress = walletAddress.toLowerCase();
    if (addresses.has(normalizedAddress)) throw new Error("testnet identities must be distinct");
    addresses.add(normalizedAddress);

    if (identity.requiresGas) {
      stage = `${identity.role} native COTI gas validation`;
      const nativeBalance = await provider.getBalance(walletAddress);
      if (nativeBalance === 0n) {
        throw new Error(`${identity.role} has no native COTI testnet gas`);
      }
    }

    for (let index = 0; index < tokenAddresses.length; index += 1) {
      const address = tokenAddresses[index];

      stage = `${identity.role} private token ${index} bytecode validation`;
      const code = await provider.getCode(address);
      if (code === "0x") throw new Error(`token ${index} has no deployed contract code`);

      const token = new Contract(address, PRIVATE_ERC20_TESTNET_ABI, wallet);

      stage = `${identity.role} private token ${index} decimals validation`;
      const actualDecimals = Number(await token.decimals());
      if (actualDecimals !== expectedDecimals[index]) {
        throw new Error(`token ${index} decimals do not match configuration`);
      }

      if (identity.requiresTokenBalances) {
        stage = `${identity.role} private token ${index} encryption-address binding`;
        const configuredEncryptionAddress = String(
          await token.accountEncryptionAddress(walletAddress),
        ).toLowerCase();
        // PrivateERC20 defaults an unset EOA mapping to the account itself.
        if (
          configuredEncryptionAddress !== ethers.ZeroAddress &&
          configuredEncryptionAddress !== normalizedAddress
        ) {
          throw new Error(`${identity.role} token ${index} uses a different encryption address`);
        }

        // The private amount is decrypted only in memory and never logged.
        stage = `${identity.role} private token ${index} encrypted balance read`;
        const encryptedBalance = await token.balanceOf.staticCall(walletAddress);

        stage = `${identity.role} private token ${index} encrypted balance initialization`;
        if (isZeroCiphertext(encryptedBalance)) {
          throw new Error(`${identity.role} private token ${index} balance is not initialized`);
        }

        stage = `${identity.role} private token ${index} encrypted balance decryption`;
        const balance = await wallet.decryptValue256(encryptedBalance);
        if (balance === 0n) {
          throw new Error(`${identity.role} has no private token ${index} balance`);
        }
      }

      stage = `${identity.role} private token ${index} public-amount policy validation`;
      const publicAmountsEnabled = Boolean(await token.publicAmountsEnabled());
      console.log(
        `${identity.role} token ${index} accessible: address=${address} ` +
          `decimals=${actualDecimals} ` +
          `privateBalanceRead=${identity.requiresTokenBalances ? "ok" : "not-required"} ` +
          `publicAmountsEnabled=${publicAmountsEnabled}`,
      );
    }

    console.log(`${identity.role} identity accessible with nonzero required balances: ${walletAddress}`);
  }

  console.log(
    "COTI testnet access preflight passed; each funded runner must still enforce its exact gas and token budget",
  );
}

void main().catch(() => {
  // Keep private keys, AES material, ciphertexts, balances and raw RPC payloads
  // out of deployment logs while retaining enough context for local diagnosis.
  console.error(`COTI testnet preflight failed during ${stage}`);
  process.exitCode = 1;
});
