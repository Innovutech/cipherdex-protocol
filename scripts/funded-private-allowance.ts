import { Contract, getAddress } from "ethers";

import { PRIVATE_ERC20_TESTNET_ABI } from "./coti-testnet-abi";
import { decryptPrivateValue256 } from "./coti-testnet-values";
import type { FundedRecoveryJournal } from "./funded-recovery-journal";

type AllowanceWallet = Readonly<{
  getAddress(): Promise<string>;
  encryptValue256(
    value: bigint,
    contractAddress: string,
    selector: string,
  ): Promise<unknown>;
}>;

type SubmittedTransaction = Readonly<{
  hash?: string;
  transactionHash?: string;
}>;

type Submit = (
  label: string,
  operation: () => Promise<any>,
) => Promise<SubmittedTransaction>;

function obligationId(owner: string, token: string, spender: string): string {
  return `allowance:${owner.toLowerCase()}:${token.toLowerCase()}:${spender.toLowerCase()}`;
}

function submittedHash(value: SubmittedTransaction): string {
  const hash = value.transactionHash ?? value.hash;
  if (!hash || !/^0x[0-9a-f]{64}$/i.test(hash)) {
    throw new Error("funded allowance transaction lacks its journaled hash");
  }
  return hash;
}

async function readAllowance(
  token: Contract,
  wallet: AllowanceWallet,
  owner: string,
  spender: string,
): Promise<bigint> {
  const value = await token.allowance.staticCall(owner, spender);
  return decryptPrivateValue256(wallet as any, value.ownerCiphertext);
}

export async function setRecoverablePrivateAllowance(input: Readonly<{
  journal: FundedRecoveryJournal;
  wallet: AllowanceWallet;
  token: Contract;
  tokenAddress: string;
  spender: string;
  amount: bigint;
  label: string;
  overrides: Readonly<{ gasLimit: bigint }>;
  submit: Submit;
}>): Promise<readonly string[]> {
  const owner = getAddress(await input.wallet.getAddress());
  const tokenAddress = getAddress(input.tokenAddress);
  const spender = getAddress(input.spender);
  const id = obligationId(owner, tokenAddress, spender);
  let current = await readAllowance(input.token, input.wallet, owner, spender);
  if (current > 0n || input.amount > 0n) {
    input.journal.recordAllowanceObligation({ id, owner, token: tokenAddress, spender });
  }
  const hashes: string[] = [];
  const selector = input.token.interface.getFunction("approve")?.selector;
  if (!selector) throw new Error("private token approve selector unavailable");
  if (current !== 0n && current !== input.amount) {
    const zero = await input.wallet.encryptValue256(0n, tokenAddress, selector);
    const submitted = await input.submit(
      `${input.label} reset`,
      () => input.token.approve(spender, zero, input.overrides),
    );
    hashes.push(submittedHash(submitted));
    current = 0n;
  }
  if (input.amount !== 0n && current !== input.amount) {
    const encrypted = await input.wallet.encryptValue256(input.amount, tokenAddress, selector);
    const submitted = await input.submit(
      input.label,
      () => input.token.approve(spender, encrypted, input.overrides),
    );
    hashes.push(submittedHash(submitted));
  }
  const verified = await readAllowance(input.token, input.wallet, owner, spender);
  if (verified !== input.amount) throw new Error(`${input.label} allowance verification failed`);
  if (input.amount === 0n) {
    const existing = input.journal.allowanceObligations.find((entry) => entry.id === id);
    if (existing?.active) input.journal.markAllowanceCleared(id, hashes);
  }
  return Object.freeze(hashes);
}

export async function recoverPrivateAllowanceObligations(input: Readonly<{
  journal: FundedRecoveryJournal;
  wallets: readonly AllowanceWallet[];
  overrides: Readonly<{ gasLimit: bigint }>;
  submit: Submit;
}>): Promise<void> {
  const wallets = new Map<string, AllowanceWallet>();
  for (const wallet of input.wallets) {
    wallets.set((await wallet.getAddress()).toLowerCase(), wallet);
  }
  for (const obligation of input.journal.activeAllowanceObligations) {
    const wallet = wallets.get(obligation.owner.toLowerCase());
    if (!wallet) throw new Error(`no funded signer is available to clear ${obligation.id}`);
    const token = new Contract(obligation.token, PRIVATE_ERC20_TESTNET_ABI, wallet as any);
    await setRecoverablePrivateAllowance({
      journal: input.journal,
      wallet,
      token,
      tokenAddress: obligation.token,
      spender: obligation.spender,
      amount: 0n,
      label: `recovery ${obligation.id}`,
      overrides: input.overrides,
      submit: input.submit,
    });
  }
}
