# CipherDEX Protocol

Independent COTI-native confidential AMM protocol work for the CipherDEX ecosystem.

This repository is separate from CipherTrade and CipherTools. The first phase is a
testnet-only feasibility implementation for an amount-confidential constant-product
pool over COTI `PrivateERC20` assets. It is not a mainnet deployment and has not
received an external audit.

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
