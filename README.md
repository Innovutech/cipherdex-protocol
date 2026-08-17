# CipherDEX Protocol

Independent COTI-native AMM protocol work for the CipherDEX ecosystem.

This repository is separate from CipherTrade and CipherTools. The first phase is a
testnet-only feasibility implementation for public/public ordinary ERC-20 pools
and an amount-confidential constant-product pool over COTI `PrivateERC20` assets.
It is not a mainnet deployment and has not received an external audit.

## Current boundary

`ConfidentialCPMM` keeps swap inputs/outputs, pool reserves, private LP shares and
slippage values in COTI MPC values. It exposes only public pair metadata, fee tier,
participant addresses and swap direction. The standard COTI `PrivateERC20` transfer
interface still takes public recipient addresses and emits public participant
addresses, so this phase does not claim anonymous or hidden-recipient execution.

`ConfidentialLaunchpadMigrator` is the first atomic integration boundary. A creator
signs inputs for the migrator, grants it explicit encrypted allowances, and can
resolve or create and seed the one canonical pair/fee/privacy/version pool in one
transaction. An existing empty canonical pool is reused; an initialized pool is
rejected before MPC validation or token movement, and no creator-specific parallel
market is created. Encrypted price bounds preserve a bonding-curve final price
without exposing the ratio. The migrator has no withdrawal authority.

`PublicCPMM` and `PublicCPMMFactory` are a separate public/public mode. Their
public amount events and share accounting are not reused by the confidential
mode. A public/private mode will only be added where COTI MPC can settle the
private leg without decrypting it inside the contract.

Both modes use the immutable CipherDEX v1 fee policy. The advertised fee is
charged once from the swap input, one sixth of that fee accrues to the protocol,
and the remainder grows LP value. There is no extra native-COTI swap payment.
Protocol balances are excluded from effective reserves and collect only to a
fixed fee vault. Confidential fees remain encrypted and are collected in
pool time/count batches, then combined by token across canonical pools in fixed
daily vault epochs. Full LP exits deposit sub-threshold terminal fee batches
before clearing pool state. See
[docs/FEE_ECONOMICS.md](docs/FEE_ECONOMICS.md).

Factory-created confidential pools bind a dedicated `PrivateLPToken` to the pool.
The canonical factory pins the exact reviewed helper runtime codehash, and both
the pool and SDK require the helper's exact `(pool, token, factory)` issuance
attestation before trusting that LP token.
Its balances and transfers use the official encrypted `PrivateERC20` paths; only
the pool can mint or burn shares when liquidity is added, removed, or locked.
Directly deployed pools cannot enter an operational lifecycle. Every usable pool
must bind the factory-issued private LP token before liquidity, swaps, locks or
fee accrual can begin. Direct user execution against canonical pools remains
available. The launchpad migrator preserves creator-held shares by default and also exposes an
atomic timed-lock or permanent-lock disposition.

Public pools expose a factory-gated exact-input router and gasless quoter.
Confidential pools retain direct execution and additionally expose a
factory-bound `ConfidentialBestExecutionRouter`. Users encrypt inputs for that
router and exact function selector. The router reuses the validated MPC value
across only the factory's canonical 5, 30 and 100 bps pools, privately selects
the largest valid output and offboards only the winner. It can either return a
paid encrypted best quote or atomically escrow and settle the selected pool.

The current testnet execution contracts use protocol version 2 and the launchpad
migrator uses version 3. Previous testnet artifacts are disposable and are not a
supported discovery or liquidity-migration surface.

PoD assets are not accepted by this synchronous pool. PoD transfer and approval
operations are asynchronous cross-chain callback workflows and require a separate
adapter/state machine; treating them as ordinary ERC-20 calls would be incorrect.

Confidential pools deliberately expose no public reserve-derived market data:
no reserves, TVL, aggregate LP supply, spot price or TWAP. The current COTI
testnet RPC permits ciphertext-only storage reads but rejects `OnBoard` and every
tested fresh MPC path under `eth_call`. The currently recorded v2 deployment has
only the proven paid per-pool quote, so that remains its primary quote path. This
working version adds one paid router transaction across all canonical fee tiers;
only after final verification and fresh deployment does that become preferred and
the per-pool request become the compatibility fallback. Both transports cost gas
and wait for inclusion, so this is a testnet runtime limitation rather than normal
gasless DEX quote UX. Read
[docs/QUOTE_MARKET_DATA_REVIEW.md](docs/QUOTE_MARKET_DATA_REVIEW.md),
[docs/FEE_ECONOMICS.md](docs/FEE_ECONOMICS.md),
[docs/FEASIBILITY_GATE.md](docs/FEASIBILITY_GATE.md) and
[docs/LAUNCHPAD_MIGRATION.md](docs/LAUNCHPAD_MIGRATION.md) before extending the
protocol.

## Commands

```text
npm ci --ignore-scripts
npm run verify
npm run testnet:preflight
npm run deploy:testnet
# Review and commit only the generated deployment record and verification report.
npm run testnet:best-execution-feasibility
npm run testnet:best-execution
```

`deploy:testnet` requires a clean, committed source tree and a commit-named
`COTI_DEPLOYMENT_RECORD`. Both funded best-execution gates run only after the
reviewed record is committed in a separate evidence commit; they reject dirty,
untracked or executable post-deployment changes and token instances absent from
the reviewed record. See
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the exact sequence.

`testnet:preflight` requires explicit local `.env` values for two funded,
already-onboarded COTI testnet LP wallets, a separate MPC-call probe identity,
their AES keys, and two official PrivateERC20-compatible token addresses. It
validates isolated private balance access without printing balances,
ciphertexts, keys or raw RPC payloads.

## Monorepo boundaries

- `contracts/`: protocol pools, factories, private LP token and public
  periphery contracts;
- `periphery/`: routing/adapter boundary and integration notes;
- `sdk/`: stable dependency-free ABI and discovery types;
- `deployments/`: sanitized public deployment-record boundary;
- `scripts/`: explicit testnet deployment and COTI scenario runners;
- `test/`: local security/property tests and the gated real-COTI integration
  placeholder;
- `docs/`: feasibility, privacy, threat, dependency and operational records.

The deployment script requires explicit COTI testnet token addresses and never
contains a mainnet network or private key fallback.
