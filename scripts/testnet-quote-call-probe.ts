import { Wallet as CotiWallet } from "@coti-io/coti-ethers";
import { TransactionReceipt } from "ethers";
import { ethers } from "hardhat";
import {
  requireMinedSuccess,
  safeTestnetErrorSummary,
} from "./testnet-transaction-evidence";

const RESERVE0 = 1_000_000n;
const RESERVE1 = 2_000_000n;
const INPUT = 10_000n;
const FEE_BPS = 30n;
const CALL_GAS_LIMIT = 30_000_000n;
let stage = "configuration";

type ProbeResult = {
  name: string;
  supported: boolean;
  reason?: string;
};

function requiredPrivateKey(name: string): string {
  const value = process.env[name]?.trim();
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${name} must be a 32-byte 0x-prefixed private key`);
  }
  return value;
}

function requiredAesKey(name: string): string {
  const value = process.env[name]?.trim();
  if (!value || !/^[0-9a-fA-F]{32}$/.test(value)) {
    throw new Error(`${name} must be a 16-byte hexadecimal AES key`);
  }
  return value;
}

async function submit(
  label: string,
  operation: () => Promise<{
    hash: string;
    wait(): Promise<TransactionReceipt | null>;
  }>,
): Promise<Readonly<{ transactionHash: string; receipt: TransactionReceipt }>> {
  stage = label;
  return requireMinedSuccess(
    label,
    operation,
    (hash) => ethers.provider.getTransactionReceipt(hash),
  );
}

async function main(): Promise<void> {
  stage = "quote identity initialization";
  const quoteKey = requiredPrivateKey("COTI_QUOTE_PRIVATE_KEY");
  const quoteAesKey = requiredAesKey("COTI_QUOTE_AES_KEY");
  const quoteWallet = new CotiWallet(quoteKey, ethers.provider, { aesKey: quoteAesKey });
  quoteWallet.setAesKey(quoteAesKey);
  const quoteAddress = await quoteWallet.getAddress();

  stage = "probe deployment";
  const factory = await ethers.getContractFactory("MpcQuoteCallProbe");
  let probe: any;
  await submit("probe deployment", async () => {
    probe = await factory.deploy(RESERVE0, RESERVE1, quoteAddress, {
      gasLimit: 10_000_000n,
    });
    const transaction = probe.deploymentTransaction();
    if (!transaction) throw new Error("probe deployment transaction unavailable");
    return transaction;
  });
  if (!probe) {
    throw new Error("probe deployment mined without a contract handle; do not retry automatically");
  }
  const probeAddress = await probe.getAddress();
  const quoteProbe = probe.connect(quoteWallet);
  console.log(`MPC quote-call probe deployed: ${probeAddress}`);

  stage = "transactional MPC control";
  const controlEvidence = await submit(
    "transactional MPC control",
    () => probe.publicDecryptRoundTrip(7n, { gasLimit: CALL_GAS_LIMIT }),
  );
  console.log(
    `SetPublic + Decrypt transaction control: supported tx=${controlEvidence.transactionHash} ` +
      `gas=${controlEvidence.receipt.gasUsed.toString()}`,
  );

  const results: ProbeResult[] = [];
  async function check(
    name: string,
    operation: () => Promise<void>,
  ): Promise<boolean> {
    stage = name;
    try {
      await operation();
      results.push({ name, supported: true });
      console.log(`${name}: supported`);
      return true;
    } catch (error: unknown) {
      const reason = safeTestnetErrorSummary(error);
      results.push({ name, supported: false, reason });
      console.log(`${name}: unavailable (${reason})`);
      return false;
    }
  }

  async function expectDecrypted(
    ciphertext: unknown,
    expected: bigint,
  ): Promise<void> {
    const actual = await quoteWallet.decryptValue256(ciphertext as never);
    if (actual !== expected) throw new Error("decrypted probe value mismatch");
  }

  await check("stored user ciphertext read", async () => {
    await expectDecrypted(
      await quoteProbe.storedUserCiphertext.staticCall(),
      RESERVE0,
    );
  });

  await check("SetPublic + Decrypt eth_call", async () => {
    const value = await quoteProbe.publicDecryptRoundTrip.staticCall(7n, {
      gasLimit: CALL_GAS_LIMIT,
    });
    if (value !== 7n) throw new Error("public round-trip mismatch");
  });

  await check("raw SetPublic precompile eth_call", async () => {
    const result = await quoteProbe.rawSetPublic.staticCall(7n, {
      gasLimit: CALL_GAS_LIMIT,
    });
    if (!result.ok || ethers.getBytes(result.data).length === 0) {
      throw new Error("SetPublic precompile call returned false");
    }
  });

  await check("raw stored OnBoard precompile eth_call", async () => {
    const result = await quoteProbe.rawStoredOnBoard.staticCall({
      gasLimit: CALL_GAS_LIMIT,
    });
    if (!result.ok || ethers.getBytes(result.data).length === 0) {
      throw new Error("OnBoard precompile call returned false");
    }
  });

  await check("stored OnBoard + OffBoardToUser eth_call", async () => {
    await expectDecrypted(
      await quoteProbe.storedRoundTrip.staticCall({ gasLimit: CALL_GAS_LIMIT }),
      RESERVE0,
    );
  });

  const validatedSelector = quoteProbe.interface.getFunction("validatedRoundTrip")!.selector;
  const validatedInput = await quoteWallet.encryptValue256(
    INPUT,
    probeAddress,
    validatedSelector,
  );
  await check("ValidateCiphertext + OffBoardToUser eth_call", async () => {
    await expectDecrypted(
      await quoteProbe.validatedRoundTrip.staticCall(validatedInput, {
        gasLimit: CALL_GAS_LIMIT,
      }),
      INPUT,
    );
  });

  await check("stored Add + OffBoardToUser eth_call", async () => {
    await expectDecrypted(
      await quoteProbe.storedAddRoundTrip.staticCall({ gasLimit: CALL_GAS_LIMIT }),
      RESERVE0 + RESERVE1,
    );
  });

  await check("stored Mul/Div + OffBoardToUser eth_call", async () => {
    await expectDecrypted(
      await quoteProbe.storedMulDivRoundTrip.staticCall({ gasLimit: CALL_GAS_LIMIT }),
      RESERVE1,
    );
  });

  await check("stored Compare/Mux + OffBoardToUser eth_call", async () => {
    await expectDecrypted(
      await quoteProbe.storedCompareMuxRoundTrip.staticCall({ gasLimit: CALL_GAS_LIMIT }),
      RESERVE1,
    );
  });

  const netInput = (INPUT * (10_000n - FEE_BPS)) / 10_000n;
  const invariant = RESERVE0 * RESERVE1;
  const denominator = RESERVE0 + netInput;
  const expectedOutput = RESERVE1 - ((invariant + denominator - 1n) / denominator);

  const publicQuoteSupported = await check(
    "public input confidential-reserve quote eth_call",
    async () => {
      await expectDecrypted(
        await quoteProbe.quoteExactInputPublic.staticCall(INPUT, true, {
          gasLimit: CALL_GAS_LIMIT,
        }),
        expectedOutput,
      );
    },
  );

  const storedConstantQuoteSupported = await check(
    "public input stored-constant confidential-reserve quote eth_call",
    async () => {
      await expectDecrypted(
        await quoteProbe.quoteExactInputStoredConstants.staticCall(INPUT, true, {
          gasLimit: CALL_GAS_LIMIT,
        }),
        expectedOutput,
      );
    },
  );

  const encryptedSelector = quoteProbe.interface.getFunction(
    "quoteExactInputEncrypted",
  )!.selector;
  const encryptedInput = await quoteWallet.encryptValue256(
    INPUT,
    probeAddress,
    encryptedSelector,
  );
  const encryptedQuoteSupported = await check(
    "authenticated input confidential-reserve quote eth_call",
    async () => {
      await expectDecrypted(
        await quoteProbe.quoteExactInputEncrypted.staticCall(encryptedInput, true, {
          gasLimit: CALL_GAS_LIMIT,
        }),
        expectedOutput,
      );
    },
  );

  const ciphertextReadSupported = results.find(
    (result) => result.name === "stored user ciphertext read",
  )?.supported;
  if (!ciphertextReadSupported) {
    throw new Error("ciphertext-only storage reads unexpectedly failed");
  }

  if (publicQuoteSupported || storedConstantQuoteSupported || encryptedQuoteSupported) {
    console.log(
      "COTI testnet probe passed: at least one gasless confidential quote path is viable",
    );
  } else {
    console.log(
      "COTI testnet probe passed: ciphertext storage reads work, but the isolated MPC quote paths are unavailable under eth_call",
    );
  }
}

void main().catch((error: unknown) => {
  console.error(
    `COTI testnet MPC eth_call quote probe failed: stage=${stage} ` +
      safeTestnetErrorSummary(error),
  );
  process.exitCode = 1;
});
