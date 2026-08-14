# Architecture

## Layers

- `contracts/ConfidentialCPMM.sol`: immutable pair, fee policy, private reserve
  math, swap execution and private LP share accounting.
- `contracts/ConfidentialCPMMFactory.sol`: permissionless deterministic pool
  creation and public pool discovery.
- `contracts/interfaces/`: stable ABI surface for clients and future factory/router
  work.
- `scripts/`: explicit COTI testnet deployment only.
- `test/`: construction/ABI guards plus a clearly gated COTI integration harness.
- `docs/`: privacy, threat, dependency and operational constraints.

## Pool model

The pool is a non-custodial pair of official COTI PrivateERC20-compatible assets.
It reads actual pool balances as MPC values rather than maintaining a second public
reserve ledger. This avoids a public duplicate of confidential reserves.

The swap formula is:

`netIn = floor(amountIn * (10000 - feeBps) / 10000)`

`newReserveOut = floor(reserveIn * reserveOut / (reserveIn + netIn))`

`amountOut = reserveOut - newReserveOut`

Every intermediate value is an MPC value. Checked operations reject overflow or
underflow via boolean outcomes; no amount is decrypted for validation.

## LP accounting

LP shares are ciphertext stored per provider and in aggregate. Initial liquidity is
required to be balanced after decimal normalization. Subsequent deposits mint the
minimum proportional share and transfer only the exact proportional amounts, so
surplus input is not silently donated. Full exits withdraw the full private reserve
values to avoid rounding dust.

The share formula is intentionally conservative and should not be treated as a
finished economic design until testnet benchmarks and independent review confirm
its rounding and fairness properties.

LP shares can be moved into a pool-enforced timelock or irreversible permanent
lock. Lock metadata is public, but the locked share amount remains ciphertext. A
permanent lock is excluded from provider balances and cannot be released by an
administrator or the original provider.

## Explicit non-goals

- no concentrated liquidity in the first protocol version;
- no COTI PoD assets in the synchronous pool;
- no mainnet deployment;
- no admin withdrawal or mutable fee authority;
- no dependency on CipherTools, CipherTrade, a centralized API or an indexer;
- no promise of hidden recipient addresses under the standard PrivateERC20 events.

## Router boundary

The first pool is intentionally called directly. COTI authenticated `itUint256`
inputs bind the sender, target contract and function selector. A generic router
that simply forwards an input would change `msg.sender` at the pool and invalidate
the signature; a router that accepts the original user as an unchecked parameter
would weaken that binding. A future router therefore needs an official, reviewed
delegation primitive, not a forwarding wrapper.
