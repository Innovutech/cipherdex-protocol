import { CotiNetwork, Wallet as CotiWallet } from "@coti-io/coti-ethers";
import { Contract, JsonRpcProvider } from "ethers";

async function main(): Promise<void> {
  const poolAddress = process.env.COTI_POOL?.trim();
  const privateKey = process.env.COTI_TESTNET_PRIVATE_KEY?.trim();
  const aesKey = process.env.COTI_AES_KEY?.trim();
  const amountIn = process.env.COTI_TEST_AMOUNT_IN?.trim();

  if (!poolAddress || !privateKey || !aesKey || !amountIn) {
    throw new Error(
      "Set COTI_POOL, COTI_TESTNET_PRIVATE_KEY, COTI_AES_KEY and COTI_TEST_AMOUNT_IN explicitly.",
    );
  }

  const provider = new JsonRpcProvider(
    process.env.COTI_TESTNET_RPC_URL ?? CotiNetwork.Testnet,
    7082400,
  );
  const wallet = new CotiWallet(privateKey, provider, { aesKey });
  wallet.setAesKey(aesKey);

  const abi = [
    "function quoteExactInput((uint256,uint256,bytes),bool) returns ((uint256,uint256))",
    "function swapExactInput((uint256,uint256,bytes),(uint256,uint256,bytes),bool) returns ((uint256,uint256))",
  ];
  const pool = new Contract(poolAddress, abi, wallet);
  const swapSelector = pool.interface.getFunction("swapExactInput")?.selector;
  if (!swapSelector) throw new Error("swapExactInput selector is unavailable");

  const encryptedAmount = await wallet.encryptValue256(BigInt(amountIn), poolAddress, swapSelector);
  const encryptedZero = await wallet.encryptValue256(0n, poolAddress, swapSelector);
  const started = Date.now();
  const quoted = await pool.quoteExactInput(encryptedAmount, true);
  const quoteElapsedMs = Date.now() - started;
  const decryptedQuote = await wallet.decryptValue256(quoted);

  // Do not print the encrypted or decrypted amount. The harness only reports timing
  // and transaction identity; values stay in the user's local process.
  console.log(`COTI testnet quote completed in ${quoteElapsedMs}ms`);
  void decryptedQuote;

  const tx = await pool.swapExactInput(encryptedAmount, encryptedZero, true);
  const receipt = await tx.wait();
  console.log(`COTI testnet swap submitted: ${receipt?.hash ?? tx.hash}`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "COTI testnet harness failed");
  process.exitCode = 1;
});
