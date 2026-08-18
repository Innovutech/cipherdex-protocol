# Confidential Launch-Protected Bootstrap

## Purpose

CipherDEX separates the ordinary permissionless confidential pool from a
launch-protected pool. Canonical uniqueness applies to the complete key:

`ordered token pair + fee tier + privacy mode + protocol version + initialization strategy`

The standard strategy is `address(0)`. A protected pool uses one reviewed,
registry-authenticated initialization strategy. The two pools are distinct
legitimate markets and may coexist for the same pair and fee tier. No creator ID
or caller-selected pool address is part of the key.

## Components and authority

- `ConfidentialInitializationStrategyRegistry` admits at most two nonzero
  strategy classes by exact reviewed runtime codehash and interface. It binds to
  one factory and is permanently finalized before router binding.
- `ConfidentialLaunchInitializationStrategy` stores launch commitments and can
  authorize first initialization only. It receives no tokens, has no swap
  callback and has no fee, reserve, LP, rescue or withdrawal authority.
- `ConfidentialLaunchpadMigrator` performs exact encrypted escrow and atomic
  bootstrap. Its strategy pins the migrator address and runtime codehash before
  registration.
- `ConfidentialCPMMFactory` authenticates the strategy, migrator and complete
  pool key before invoking bootstrap.

There is no factory-global bootstrap adapter. Every registered strategy proves
its own reciprocal factory/migrator binding and pinned migrator codehash. This is
what permits two reviewed strategy classes to use independent migrators without
creating a second authority path.

All configuration calls are one-time. Supporting a new strategy implementation
or changed economics requires a reviewed new deployment/version rather than
mutating an existing pool.

## Commitment lifecycle

1. The launch creator and fixed launch authority agree the launch ID, canonical
   pair/decimals, approved fee tier, chain, authorization deadline and migration
   deadline.
2. Both sign the `LaunchCommitment` EIP-712 digest. Creator and authority must be
   distinct. Contracts implementing ERC-1271 may authorize without relying on a
   token `owner()` method.
3. Anyone may submit both signatures to `commitLaunch`. The strategy verifies
   every public field, its registry registration, factory/migrator bindings and
   chain before creating or resolving its empty protected pool.
4. One active launch may occupy a complete protected key. It may be canceled by
   creator or authority, or marked expired by anyone after its deadline.
5. A canceled or expired empty commitment may be safely superseded by another
   fully dual-authorized launch. The empty pool remains protected and never
   becomes permissionlessly initializable. A completed pool cannot be
   superseded.

The launch commitment exists before the final price or migration amounts are
known. This prevents an unrelated account from taking the protected pool's first
initialization slot while leaving the ordinary standard pool available.

## Atomic graduation

1. The creator grants exact encrypted allowances to the migrator on both
   `PrivateERC20` tokens.
2. The COTI SDK signs five encrypted migration inputs for the exact migrator and
   exact migration selector.
3. The creator signs the separate `Migration` EIP-712 value binding creator,
   chain, migrator, protected pool, launch ID/commitment hash, canonical pair,
   decimals, fee, deadline, LP disposition and ordered encrypted-input hashes.
4. The migrator verifies and consumes the authorization, validates the protected
   pool against the strategy commitment, validates every ciphertext, and pulls
   exact private amounts into transaction-scoped escrow.
5. The migrator grants exact encrypted allowances to the protected pool and asks
   the factory to bootstrap it.
6. The factory calls the strategy's factory-only one-shot authorization. It
   verifies migrator caller/codehash, launch status, pool, creator, commitment
   hash and deadline, then marks the launch completed inside the same transaction.
7. The pool validates empty logical reserves, positive arbitrary-ratio amounts,
   encrypted price bounds, minimum shares, LP disposition and exact token balance
   deltas before committing state.

Failure at any stage reverts launch consumption, escrow, allowances, pool state,
LP state and events together. Unsolicited token balances are excluded from
logical reserves and cannot alter initialization price or LP claims.

## Post-initialization behavior

After bootstrap the protected pool is an ordinary permissionless confidential
CPMM: anyone may swap, add proportional liquidity or remove owned shares. The
strategy cannot initialize again or influence swaps, fees, reserves, LP locks or
collection. Pool metadata retains its nonzero strategy so discovery can
distinguish it from the standard pool.

A true full LP exit clears current reserve/share state but does not erase launch
history. `protectedInitializationCompleted` remains true, allowing ordinary
permissionless liquidity to re-seed the market while permanently preventing the
consumed launch strategy from bootstrapping it again.

Initial shares equal the smaller normalized deposit, allowing any positive final
launch ratio while giving the first LP all issued shares. The atomic public LP
disposition is:

- `CREATOR_HELD`: private LP shares are minted to the creator;
- `TIMED_LOCK`: encrypted shares remain pool-locked until the public unlock time;
- `PERMANENT_LOCK`: encrypted shares are irreversibly inaccessible.

No administrator can release a permanent lock.

## SDK and discovery

Use `buildConfidentialLaunchCommitment` to canonicalize the signed value and
`LAUNCH_COMMITMENT_EIP712_TYPES` to produce both signatures. Then use
`buildConfidentialLaunchCommitCall` to snapshot immutable calldata. Migration
inputs use `LAUNCHPAD_MIGRATION_EIP712_TYPES` and the official COTI SDK.

Discovery schema version 6 exposes only public identity/configuration:
initialization strategy, strategy class, standard versus launch-protected class,
initialized state, fee tier and protocol/privacy versions. It does not expose
private seed amounts, reserves, LP supply, price bounds or accrued fees. Empty
committed and expired/canceled protected pools must be excluded from routing
until `initialized` is true.

## Testnet proof

The externally launched `scripts/testnet-launchpad.ts` target deploys a disposable complete strategy stack and
verifies dual authorization, protected-pool creation, arbitrary-ratio atomic
bootstrap, replay/preinitialized rejection, canonical provenance, exact cleanup
and a full creator-held exit followed by an ordinary re-seed and second cleanup
exit. Local unit/property tests cover cancellation,
expiry, safe supersession, wrong commitment fields, registration squatting,
factory-only one-shot authorization, timed locks and permanent locks.

This remains testnet-only and is not a mainnet-readiness or external-audit claim.
