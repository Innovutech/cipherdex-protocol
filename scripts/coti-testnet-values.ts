import { Wallet as CotiWallet } from "@coti-io/coti-ethers";

type Ciphertext256 = Parameters<CotiWallet["decryptValue256"]>[0];

type Ciphertext256Like = {
  ciphertextHigh: bigint | number | string;
  ciphertextLow: bigint | number | string;
};

/**
 * PrivateERC20 represents an untouched encrypted uint256 storage slot as two
 * zero limbs. That sentinel means semantic zero; it is not AES ciphertext and
 * must not be passed to the SDK decryptor.
 */
export async function decryptPrivateValue256(
  wallet: CotiWallet,
  ciphertext: Ciphertext256Like,
): Promise<bigint> {
  if (
    BigInt(ciphertext.ciphertextHigh) === 0n &&
    BigInt(ciphertext.ciphertextLow) === 0n
  ) {
    return 0n;
  }

  return wallet.decryptValue256(ciphertext as Ciphertext256);
}
