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
create/select and seed an empty factory pool in one transaction. Encrypted price
bounds let a launchpad preserve a bonding-curve final price without exposing the
ratio. The migrator is permissionless and has no withdrawal authority.

`PublicCPMM` and `PublicCPMMFactory` are a separate public/public mode. Their
public amount events and share accounting are not reused by the confidential
mode. A public/private mode will only be added where COTI MPC can settle the
private leg without decrypting it inside the contract.

Factory-created confidential pools bind a dedicated `PrivateLPToken` to the pool.
Its balances and transfers use the official encrypted `PrivateERC20` paths; only
the pool can mint or burn shares when liquidity is added, removed, or locked.
Directly deployed pools keep the original internal share ledger for compatibility.

Public pools additionally expose a factory-gated exact-input router and quoter.
Confidential pools are called directly because their encrypted input signatures
bind the caller and target pool.

PoD assets are not accepted by this synchronous pool. PoD transfer and approval
operations are asynchronous cross-chain callback workflows and require a separate
adapter/state machine; treating them as ordinary ERC-20 calls would be incorrect.

Read [docs/FEASIBILITY_GATE.md](docs/FEASIBILITY_GATE.md) and
[docs/LAUNCHPAD_MIGRATION.md](docs/LAUNCHPAD_MIGRATION.md) before extending the
protocol.

## Commands

```text
npm ci --ignore-scripts
npm run verify
npm run deploy:testnet
```

The deployment script requires explicit COTI testnet token addresses and never
contains a mainnet network or private key fallback.
