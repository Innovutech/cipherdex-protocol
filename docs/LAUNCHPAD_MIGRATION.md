# Confidential Launchpad Migration

## Purpose

`ConfidentialLaunchpadMigrator` is a permissionless integration boundary for a
launchpad that must migrate a creator's final bonding-curve liquidity into a new
or empty `ConfidentialCPMM` pool. It is separate from CipherTools and has no admin,
withdrawal, fee-manager or token-rescue authority.

The confidential factory accepts bootstrap calls only from the migrator address
bound once by `setBootstrapAdapter` during deployment. This prevents a third party
from front-running a deterministic empty pool with an unsolicited donation and
initializing it before the intended migration. The binding cannot be changed
after configuration and does not grant withdrawal or fee-management authority.

## Atomic sequence

1. The creator determines the canonical pool token order, final seed amounts and
   acceptable normalized price interval off-chain.
2. The creator grants the migrator encrypted allowances on both PrivateERC20
   tokens. These are explicit, separate user approvals.
3. The creator signs `amount0`, `amount1`, `minShares`, `minPriceX18` and
   `maxPriceX18` for the migrator address and the exact `migrate` selector using
   the official COTI SDK.
4. The creator calls `migrate` before its deadline.
5. The migrator validates every input, creates or selects the deterministic empty
   factory pool, pulls the exact MPC amounts with `transferFromGT`, and calls the
   factory bootstrap hook.
6. The pool confirms that its private balances contain at least the transferred
   values, checks the encrypted price interval, and applies the requested LP
   disposition. Creator-held shares are minted to the creator; timed-lock shares
   remain in the pool lock record until unlock; permanent-lock shares are never
   minted to a holder. The result remains creator-encrypted.

Any revert rolls back pool creation, token pulls and share state in the same EVM
transaction.

## Price convention

`priceX18` means normalized token1 units per normalized token0 unit:

`normalizedAmount1 * 1e18 / normalizedAmount0`

The pool checks the ratio against the encrypted inclusive `[minPriceX18,
maxPriceX18]` interval without decrypting amounts or emitting the ratio. Bounds
must be prepared for the canonical token order and selected to account for the
launchpad's bonding-curve rounding policy.

## Required approvals and SDK calls

The migrator is the spender, not the pool. A client must therefore prepare the
official encrypted `approve(migrator, amount)` inputs for each token and then
prepare the five `migrate` inputs for the migrator target. Reusing a ciphertext in
the same slot is rejected by the migrator's local digest guard.

The stable SDK exports `CONFIDENTIAL_LAUNCHPAD_MIGRATOR_ABI` and the pool/factory
bootstrap fragments. It intentionally does not expose plaintext reserve, amount,
price or LP-share fields as public discovery metadata.

`migrate` preserves the original creator-held behavior. `migrateWithDisposition`
adds the explicit `CREATOR_HELD`, `TIMED_LOCK`, or `PERMANENT_LOCK` mode and a
public unlock timestamp for timed locks. The lock event exposes only the public
lock identifier, owner, mode and time; the locked amount remains encrypted.

## Current limits

- This is an amount-confidential migration path, not anonymous settlement.
- It does not implement an arbitrary router or permit a launchpad to mutate an
  initialized pool.
- The final price guarantee is an encrypted interval check supplied by the caller;
  the launchpad must independently calculate the interval from its bonding curve.
- Real COTI testnet execution, gas/latency measurement, and independent review are
  still required before a launchpad or mainnet deployment relies on this contract.
