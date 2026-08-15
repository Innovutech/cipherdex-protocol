# CipherDEX Security Upgrade To Protocol 2

## Scope

Protocol 2 fixes public initial-price, donation, proportional-join and
fee-on-transfer settlement defects; isolates launchpad pools by creator; and
requires on-chain SDK provenance before confidential quote selection. The
launchpad migrator reports version 3.

All affected contracts are immutable. This release does not upgrade or mutate
already-deployed bytecode and introduces no proxy, owner bypass, rescue path or
administrator-controlled liquidity migration.

## Required redeployment

Deploy and publish new addresses for:

- `CipherDEXFeeVault` with the reviewed beneficiary;
- `ConfidentialCPMMFactory` and its internally created LP-token factory;
- `ConfidentialLaunchpadMigrator`, followed by the one-time adapter binding;
- `PublicCPMMFactory`, `PublicCPMMQuoter`, and `PublicCPMMRouter`.

New factories deploy protocol-2 pools. Do not register an old factory, router or
pool as protocol 2. Verify bytecode, constructor arguments, one-time adapter
binding, fee vault, chain ID and deployment transaction before activation.

## Integration cutover

1. Index the new factory addresses from their deployment blocks in parallel
   with legacy history.
2. Mark version-1 pools as legacy and remove them from new quote, route, launch
   and liquidity-entry selection. Read-only history and user exits may remain.
3. Configure quote services with the exact expected protocol-2 factory and fee
   vault. Run `verifyConfidentialPoolDiscovery` before requesting or comparing a
   confidential quote.
4. Index `PoolCreated` for all new pools and `LaunchpadPoolCreated` for creator
   provenance. Resolve launch migrations through `getLaunchPool` and
   `launchPoolKey`, never the manual `getPool` namespace. Treat each launch key
   as one-shot even if its pool is later fully exited.
5. Point public execution only to the protocol-2 router/quoter/factory set.
6. Re-run the testnet preflight, deployment, launchpad, scenario and fee
   collection checks before production allowlisting.

## Liquidity migration

There is no privileged bulk migration.

- Public LPs withdraw from a legacy pool and add liquidity to a protocol-2 pool
  using reviewed minima and current market ratios.
- Confidential LPs use their own authenticated encrypted withdrawal inputs,
  receive their private assets, and create fresh authenticated inputs for the
  protocol-2 pool.
- Pending launchpad creators revoke obsolete encrypted allowances where
  supported, approve only the new migrator, and sign a fresh EIP-712 request for
  its new address. Old ciphertexts and authorizations are not reusable.
- Permanent locks cannot be migrated or administratively released. Legacy
  locked liquidity remains governed by the old immutable contract.

## Rollback

Activate new addresses only after an empty-pool smoke test. If validation fails,
remove the new addresses from execution allowlists and investigate before users
deposit. A rollback cannot reverse deployed bytecode or user transactions. Do
not relabel version-1 contracts as patched; retain only the minimum legacy
read/exit interface needed by existing LPs.
