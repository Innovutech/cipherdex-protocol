# Privacy Model

## Confidential

- swap input and output amounts;
- pool reserves and invariant calculations;
- fee-adjusted amount and price impact;
- minimum output/slippage values;
- provider LP share balances and aggregate share supply;
- amounts held in timed/permanent LP locks;
- amounts in the pool's own events and errors.

Factory-created LP shares are represented by the pool-bound `PrivateLPToken`.
Its standard transfer and approval events still reveal participant addresses, but
not the encrypted amount. The token's public metadata and pool address are
discoverable by design.

## Public

- pool and token contract addresses;
- fee tier and token decimal metadata;
- pool initialization state;
- caller/provider addresses and swap direction;
- transaction timing, gas use and success/failure;
- participant addresses in the underlying standard PrivateERC20 `Transfer` event.

## Allowed boolean disclosures

The contract decrypts only boolean predicates needed to enforce safety: positive
amount, arithmetic overflow/underflow, sufficient private shares, proportionality,
minimum-output checks and full-exit state. A caller can already learn whether its
transaction succeeded or reverted. Amounts are never passed to `MpcCore.decrypt`,
logs, custom errors or deployment output.

## Trust assumptions

The design relies on COTI's MPC precompile, consensus, operator/key-management
model, official token implementation, client-side AES key handling and the COTI
SDK's authenticated encrypted-input format. These are trust assumptions, not
cryptographic proofs produced by this repository.
