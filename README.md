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

`ConfidentialLaunchInitializationStrategy` and
`ConfidentialLaunchpadMigrator` form the atomic launch boundary. A launch is
committed before graduation by both its creator and the fixed launch authority.
The commitment binds the ordered pair, fee tier, privacy mode, confidential
protocol version, factory, strategy, migrator, chain and deadlines. The strategy
reserves a distinct launch-protected pool identity; it does not reserve or alter
the ordinary standard pool. At graduation the migrator consumes that commitment,
pulls exact encrypted allowances, initializes the protected pool at the encrypted
final-price ratio and applies the selected LP disposition atomically. The strategy
is initialization-only and the migrator has no withdrawal authority. Each
reviewed strategy pins and authenticates its own migrator; the factory has no
global launch adapter or shared migrator authority. Both EOA and ERC-1271 launch
creators use the same end-to-end authorization boundary.

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
After a completed protected pool later reaches a true full exit, ordinary
permissionless `addLiquidity` may re-seed it. The consumed launch commitment and
strategy can never bootstrap it again.

Public pools expose a factory-gated exact-input router and gasless quoter.
Confidential pools retain direct execution and additionally expose a
factory-bound `ConfidentialBestExecutionRouter`. Users encrypt inputs for that
router and exact function selector. The router reuses the validated MPC value
across at most three factory-derived candidates selected from the approved 5,
30 and 100 bps tiers and the finalized standard/protected strategy classes. It
privately selects the largest valid output and offboards only the winner. It can
either return a paid encrypted best quote or atomically escrow and settle the
selected pool.

The current source defines public pools/factory version 2, confidential
pools/factory version 3, best-execution router version 2, launchpad migrator
version 4, and initialization strategy/registry/deployer version 1. Previous
testnet artifacts are disposable and are not a supported discovery or
liquidity-migration surface.

PoD assets are not accepted by this synchronous pool. PoD transfer and approval
operations are asynchronous cross-chain callback workflows and require a separate
adapter/state machine; treating them as ordinary ERC-20 calls would be incorrect.

Confidential pools deliberately expose no public reserve-derived market data:
no reserves, TVL, aggregate LP supply, spot price or TWAP. The current COTI
testnet RPC permits ciphertext-only storage reads but rejects `OnBoard` and every
tested fresh MPC path under `eth_call`, including the stored-encrypted-constant
design. Paid per-pool encrypted quote transactions are therefore the only proven
primary quote transport. This source also supports one paid best-quote transaction
over a bounded, factory-derived strategy/fee bitmap, but that route is not a
gasless replacement and is not described as primary until fresh funded deployment
evidence proves it. Both transports cost gas and wait for inclusion, so this is a
testnet runtime limitation rather than normal gasless DEX quote UX. Read
[docs/QUOTE_MARKET_DATA_REVIEW.md](docs/QUOTE_MARKET_DATA_REVIEW.md),
[docs/FEE_ECONOMICS.md](docs/FEE_ECONOMICS.md),
[docs/FEASIBILITY_GATE.md](docs/FEASIBILITY_GATE.md) and
[docs/LAUNCHPAD_MIGRATION.md](docs/LAUNCHPAD_MIGRATION.md) before extending the
protocol.

## Commands

```text
npm ci --ignore-scripts
npm run verify
npm run gas:measure
```

Funded configuration must be stored in a regular file outside this repository
inside a dedicated owner-only directory. Repository-local `.env` files and
repository-local funded commands are refused. Install
`scripts/operator-funded-launcher.mjs` from the exact approved Git commit into
owner-only storage, then invoke that external file with explicit `--repository`,
`--commit`, `--environment` and `--target` arguments. The launcher authenticates
the full commit with trusted system Git before importing repository code, creates
a fresh private checkout, performs a locked script-disabled install and
secretless build, records the source/dependency/artifact measurement, reads the
external environment only after authentication, executes Hardhat with
`--no-compile`, atomically publishes allowed JSON, and removes the private runtime.

The `scripts/deploy-testnet.ts` target requires a committed source tree and a commit-named
`COTI_DEPLOYMENT_RECORD`. All four funded gates run only after the reviewed
record is committed in a separate evidence commit; they reject dirty, untracked
or executable post-deployment changes and token instances absent from the
reviewed record. Every disposable asset-holding resource is journaled before use,
recovered to zero residue, and bound to its owner-created on-chain transaction.
The finalizer accepts exactly the four source/deployment-bound run records and
the verifier rechecks their transactions, blocks and runtime artifacts. See
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the exact sequence.

The `scripts/testnet-preflight.ts` target requires explicit values in the external reviewed environment
file for two funded,
already-onboarded COTI testnet LP wallets, a separate MPC-call probe identity,
their AES keys, and two official PrivateERC20-compatible token addresses. It
validates isolated private balance access without printing balances,
ciphertexts, keys or raw RPC payloads.

## Monorepo boundaries

- `contracts/`: protocol pools, complete-key factories, reviewed initialization
  strategy boundary, private LP token and public periphery contracts;
- `periphery/`: routing/adapter boundary and integration notes;
- `sdk/`: stable dependency-free ABI and discovery types;
- `deployments/`: sanitized public deployment-record boundary;
- `scripts/`: explicit testnet deployment and COTI scenario runners;
- `test/`: local security/property tests and the gated real-COTI integration
  placeholder;
- `docs/`: feasibility, privacy, threat, dependency and operational records.

The deployment script requires explicit COTI testnet token addresses and never
contains a mainnet network or private key fallback.
