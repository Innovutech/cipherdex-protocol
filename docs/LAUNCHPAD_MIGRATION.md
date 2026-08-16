# Confidential Launchpad Bootstrap

## Purpose

`ConfidentialLaunchpadMigrator` atomically moves a creator's final private
bonding-curve liquidity into the one canonical `ConfidentialCPMM` for the ordered
pair, approved fee tier, privacy mode, and protocol version. It has no owner,
withdrawal path, fee manager, token rescue, or alternate pool namespace.

The confidential factory binds one bootstrap adapter during deployment. That
adapter can resolve or create a canonical pool and call its one initialization
hook, but it cannot withdraw funds, change fees, replace the fee vault, or mutate
an initialized pool.

## Canonical behavior

- If no canonical pool exists, factory creation and bootstrap occur in the same
  outer migration transaction.
- If the canonical pool exists and is empty, migration reuses it.
- If it is initialized, migration rejects before MPC validation or token pulls.
- No creator-specific market is created as a fallback.
- A failed migration rolls back pool creation, encrypted-input consumption,
  token transfers, reserve state, LP state, and events.

This is a fail-closed safety boundary against front-running and malicious
pre-initialization: an attacker cannot redirect creator assets, alter the signed
launch terms, or force an alternate market. It is not a liveness reservation.
A permissionless canonical market initialized first, whether legitimate or
adversarial, is not overwritten; the launch rejects before MPC work or token
movement and must resolve that product-level conflict explicitly.

CipherDEX does not give a launch creator a privileged right to an otherwise
permissionless canonical pair. A reservation or commit/reveal mechanism would
need an explicit expiry, anti-squatting policy, and authority capable of deciding
which creator owns a pair. That governance surface is not justified for this
testnet protocol. Atomic canonical resolution plus rejection preserves custody
and market uniqueness without introducing such an administrator.

## Atomic sequence

1. The creator determines canonical token order, seed amounts, fee tier, and an
   acceptable normalized price interval.
2. The creator grants explicit encrypted allowances to the migrator on both
   `PrivateERC20` tokens.
3. The COTI SDK signs each encrypted input for the exact migrator selector.
4. The creator signs EIP-712 `Migration` data binding the creator, chain,
   migrator, pair, decimals, fee tier, deadline, LP disposition, and an ordered
   hash of all five encrypted-input commitments.
5. The migrator verifies EIP-712 authorization, resolves the canonical pool,
   validates and consumes MPC inputs, and pulls exact private amounts into its
   transaction-scoped escrow through `transferFromGT`.
6. The migrator grants the canonical pool exact encrypted allowances for both
   escrowed amounts, then calls the factory bootstrap hook.
7. The pool checks positive amounts, empty logical reserves, encrypted price
   bounds, minimum shares and LP disposition, then pulls exact balance deltas
   from the migrator before committing reserve/share state.

Compatible transfers and pool accounting are atomic. The migrator verifies that
its post-bootstrap balances return to their pre-escrow baselines. Unsolicited raw
token balances do not enter logical reserves, affect price, become LP claims or
block initialization of a precomputable pool address.

## Price and LP conventions

`priceX18` is normalized token1 per normalized token0:

`normalizedAmount1 * 1e18 / normalizedAmount0`

The inclusive `[minPriceX18,maxPriceX18]` bounds remain encrypted. Initial
shares equal the smaller normalized deposit, so any positive launch ratio is
valid while the first LP still owns 100% of issued shares.

LP disposition is part of signed public context:

- `CREATOR_HELD`: mint private LP shares to the creator;
- `TIMED_LOCK`: keep encrypted shares in a pool lock until the public unlock time;
- `PERMANENT_LOCK`: keep encrypted shares permanently inaccessible.

No administrator can release a permanent lock.

## Client requirements

The creator authorizes only the migrator. The pool's allowance is created by the
migrator from its transaction-scoped escrow and is rolled back with the entire
migration on failure. Clients must use the official COTI SDK to prepare two
encrypted creator-to-migrator approvals and five encrypted migration inputs. The
SDK exports the migrator ABI plus
`LAUNCHPAD_MIGRATOR_EIP712_DOMAIN` and
`LAUNCHPAD_MIGRATION_EIP712_TYPES`.

Input ciphertexts, signatures, plaintext amounts, bounds, AES keys, and decrypted
shares must never be logged. Rejected transactions must be reported with sanitized
stage/error metadata only.

## Testnet proof

`npm run testnet:launchpad` verifies:

- invalid encrypted price bounds roll back canonical creation and token pulls;
- a deterministic-address pre-fund cannot block bootstrap or enter reserves;
- valid arbitrary-ratio bootstrap initializes the canonical registry entry;
- factory fee policy and immutable vault are inherited;
- creator-held, timed-lock, and permanent-lock dispositions behave correctly;
- replay/pre-initialized attempts are rejected without additional token movement;
- canonical discovery remains unchanged after rejection.

This remains testnet-only and is not a mainnet-readiness or external-audit claim.
