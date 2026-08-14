# Feasibility Gate

## Evidence reviewed

The official `@coti-io/coti-contracts` source and package were reviewed at the
current local reference checkout and against the registry package metadata. The
official MPC contract exposes `gtUint256` operations for validation, add, subtract,
multiply, divide, comparison, min/max, checked arithmetic and user-specific
`offBoardToUser` ciphertext output. The official PrivateERC20 implementation reads
the caller's balance as a garbled value and supports `transferFromGT` and
`transferGT`.

The proof-of-concept uses those primitives directly. It does not decrypt amounts.
It decrypts only boolean policy results such as zero checks, arithmetic overflow,
proportionality/slippage checks and full-exit state. Those branches are deliberate
disclosures of transaction outcome or pool lifecycle, not amount disclosure.

## What is feasible

For synchronous COTI PrivateERC20 assets, an amount-confidential CPMM is technically
feasible:

- reserves are read as garbled values from the pool's token balances;
- the fee-adjusted invariant is calculated in MPC values;
- checked multiplication/addition/subtraction protect the invariant calculation;
- minimum output is an encrypted input and is compared privately;
- the pool transfers encrypted amounts through `transferFromGT` and `transferGT`;
- LP shares are stored as ciphertext and returned only re-encrypted to the caller.

This is implemented as a testnet proof of concept, not as a production/audit claim.

## Hard privacy limit

The requested property that the recipient remain hidden is not provided by the
standard PrivateERC20 interface. `transferGT(address to, ...)` and
`transferFromGT(address from, address to, ...)` contain public EVM addresses, and
the official token's `Transfer` event indexes `from` and `to`. A pool wrapper can
remove amount fields from its own events but cannot erase those token-level
participant disclosures.

Achieving hidden recipients would require a different settlement design, such as a
private claim/stealth-recipient mechanism or a custom token implementation. That is
outside this first CPMM and must not be implied by its name or UI.

## PoD exclusion

PoD `PodERC20` is asynchronous. Its transfer/approval operations submit a request,
pay a callback fee, and complete through inbox callbacks against a COTI-side
authoritative ledger. A synchronous constant-product swap cannot atomically compose
two arbitrary PoD operations without a pending state machine, callback ordering,
timeout/refund handling and a separate failure/recovery model.

PoD should therefore be integrated later through an explicitly asynchronous vault
or adapter. It must not be silently accepted by this synchronous pool.

## Required testnet gate before wider expansion

The following must be demonstrated on COTI testnet with real onboarded test keys and
official PrivateERC20 test tokens before adding factories, routers, launchpads or
cross-domain adapters:

1. Encrypt and sign two input values with the official COTI SDK.
2. Add balanced liquidity and decrypt only the caller-specific share result.
3. Quote through a COTI-compatible `eth_call` path and record whether MPC reads are
   supported under static simulation.
4. Execute swaps in both directions with encrypted minimum output.
5. Prove a failed slippage check leaks no amount and leaves balances unchanged.
6. Remove liquidity, including a full exit without residual reserve dust.
7. Record gas and wall-clock latency without logging private values.

The factory and launchpad contracts are now implemented as narrow, permissionless
boundaries, but they are not testnet-proven by this repository yet. Until the gate
passes, the safe product claim is “confidential amounts and private LP accounting
for COTI PrivateERC20 pools with an unverified atomic bootstrap adapter,” not fully
private trading or a production launchpad.

## Factory and launchpad boundary

The permissionless factory creates immutable pair/fee instances and records public
pool addresses. The launchpad migrator avoids the generic-router problem by being
the authenticated target for creator inputs, using explicit encrypted allowances,
and passing only already-validated MPC values to a factory-owned bootstrap hook.
The pool rechecks actual private balances and encrypted normalized price bounds.
This design still requires the real COTI testnet gate, especially proof that
`transferFromGT`, MPC validation and the bootstrap callback compose atomically on
the deployed network.
