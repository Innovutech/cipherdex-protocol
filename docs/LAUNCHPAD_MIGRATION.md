# Confidential Launch-Protected Bootstrap

## Purpose

CipherDEX separates an ordinary permissionless confidential pool from a
launch-protected pool. Canonical uniqueness uses the complete key:

`ordered token pair + fee tier + privacy mode + protocol version + initialization strategy`

The standard strategy is `address(0)`. A protected pool uses a reviewed,
registry-authenticated strategy. Both markets may coexist for the same pair and
fee tier. No creator ID or caller-selected pool address is part of the key.

## Components and authority

- `ConfidentialInitializationStrategyRegistry` admits at most two nonzero
  strategy classes by reviewed runtime codehash and interface, binds to one
  factory, and is permanently finalized before router binding.
- `ConfidentialLaunchInitializationStrategy` records and consumes atomic launch
  state. It receives no tokens and has no fee, reserve, LP, rescue, swap, or
  withdrawal authority.
- `ConfidentialLaunchpadMigrator` verifies one exact creator authorization,
  performs encrypted escrow, and bootstraps the pool atomically. The strategy
  creates and pins this migrator address and runtime codehash in its constructor.
- `ConfidentialCPMMFactory` authenticates the strategy, migrator, authorization
  hash, and complete pool key before invoking bootstrap.

There is no launch authority, administrator approval, factory-global migrator,
or persistent precommit. Supporting a new strategy implementation or changed
economics requires a reviewed new deployment/version rather than mutating an
existing pool.

## Atomic migration lifecycle

1. The creator selects the launch ID, pair/decimals, approved fee tier, encrypted
   seed amounts, encrypted minimum shares, encrypted price bounds, deadline, and
   LP disposition.
2. The official COTI SDK encrypts the five private values for the exact migrator
   address and exact `migrate` or `migrateWithDisposition` selector.
3. The creator signs one `Migration` EIP-712 value binding the launch ID,
   initialization strategy, creator, pair/decimals, fee tier, ordered encrypted
   input commitments, deadline, disposition, and unlock time. EOAs and ERC-1271
   contract wallets use the same authorization boundary.
4. The creator grants exact encrypted allowances to the migrator on both
   `PrivateERC20` tokens and submits the migration.
5. The migrator verifies the creator signature, then asks its pinned strategy to
   prepare the launch. The strategy rejects reused launch IDs, active/completed
   protected keys, expired deadlines, changed migrator code, and nonregistered
   strategy state. It creates or resolves the empty canonical protected pool and
   records `MIGRATING` state only inside this transaction.
6. The migrator validates each ciphertext, pulls exact private amounts into
   transaction-scoped escrow, grants exact encrypted pool allowances, and asks
   the factory to bootstrap the same canonical pool.
7. The factory invokes the strategy's factory-only one-shot authorization. The
   strategy verifies migrator identity/codehash, pool, creator, authorization
   hash, active launch ID, and deadline, then marks the launch `COMPLETED`.
8. The pool validates empty logical reserves, positive arbitrary-ratio amounts,
   encrypted price bounds, minimum shares, LP disposition, and exact token
   balance deltas before committing state.

Failure at any stage reverts launch state, pool creation, escrow, allowances,
pool state, LP state, and events together. There is no abandoned committed pool
to cancel or expire. An unrelated caller cannot take the protected first-liquidity
slot because only the strategy-created pinned migrator can prepare it, and the
migrator requires the pool creator's exact signature. The ordinary standard pool
remains permissionless and independent.

Unsolicited token balances are excluded from logical reserves and cannot alter
initialization price or LP claims.

## Post-initialization behavior

After bootstrap, the protected pool is an ordinary permissionless confidential
CPMM: anyone may swap, add proportional liquidity, or remove owned shares. The
strategy cannot initialize again or influence swaps, fees, reserves, LP locks,
or collection. Pool metadata retains its nonzero strategy for discovery.

A true full LP exit clears current reserve/share state but preserves completed
launch history. `protectedInitializationCompleted` remains true, allowing an
ordinary permissionless re-seed while permanently preventing another protected
bootstrap for that key.

Initial shares equal the smaller normalized deposit. The public LP disposition is:

- `CREATOR_HELD`: private LP shares are minted to the creator;
- `TIMED_LOCK`: encrypted shares remain pool-locked until the public unlock time;
- `PERMANENT_LOCK`: encrypted shares are irreversibly inaccessible.

No administrator can release a permanent lock.

## SDK and discovery

Integrations use `LAUNCHPAD_MIGRATION_EIP712_TYPES` and
`LAUNCHPAD_MIGRATOR_EIP712_DOMAIN` to sign the exact migration. The SDK's
operation-plan and optional EIP-5792 helpers can present encrypted-input signing,
private-token approvals, and migration submission without changing protocol
semantics. Exact and unlimited approval policy remains an explicit frontend
choice; exact is the default.

Discovery schema version 1 exposes only public identity/configuration and the
creator authorization hash: strategy class, initialized state, fee tier,
protocol/privacy versions, launch ID, creator, pool, and LP disposition. It does
not expose seed amounts, reserves, LP supply, price bounds, or accrued fees.
Uninitialized pools must be excluded from routing.

Indexers should record `PoolCreated`, `LaunchPrepared`,
`LaunchInitializationAuthorized`, `LaunchpadMigration`, and optional
`LaunchpadLockDisposition` from the same successful transaction. Use
`verifyLaunchpadMigrationMetadata` with an RPC-backed adapter before presenting
the migration as verified.

## Testnet proof

The existing `scripts/deploy-testnet.ts` deployment target remains supported.
The externally launched `scripts/testnet-launchpad.ts` target deploys a disposable
strategy stack and verifies creator authorization, atomic pool creation and
arbitrary-ratio bootstrap, failed price-bound rollback to an empty pool/launch
state, replay rejection, canonical provenance, exact cleanup, full exit, ordinary
re-seed, and second cleanup exit. Local tests cover caller/domain/input/disposition
mismatches, EOA and ERC-1271 authorization, migrator code pinning, factory-only
consumption, and independent strategies.

These tests are not a mainnet deployment or external-audit claim.
