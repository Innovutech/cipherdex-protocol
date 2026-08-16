# Privacy Model

## Confidential

- swap input and output amounts;
- pool reserves and invariant calculations;
- fee-adjusted amount and price impact;
- minimum output/slippage values;
- provider LP share balances and aggregate share supply;
- amounts held in timed/permanent LP locks;
- amounts in the pool's own events and errors.
- per-token accrued confidential protocol-fee amounts.

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
- confidential protocol-fee collection token, destination, aggregate swap count,
  and collection-window timing (but not the accumulated amount).

The core confidential pool exposes no public reserve-derived market data. Pool
identity, token metadata, fee tier, protocol version and privacy mode are public;
reserves, TVL, aggregate LP supply, spot price, TWAP and exact quote outputs are
not. Any future oracle is an optional, separately reviewed disclosure component.

## Allowed boolean disclosures

The contract decrypts only boolean predicates needed to enforce safety: positive
amount, arithmetic overflow/underflow, sufficient private shares, proportionality,
minimum-output checks and full-exit state. A caller can already learn whether its
transaction succeeded or reverted. Amounts are never passed to `MpcCore.decrypt`,
logs, custom errors or deployment output.

Repeated private quotes can still allow an active caller to estimate price and
depth from the public CPMM formula. Encrypted quotes protect a particular
request/result from passive public disclosure; they are not an
information-theoretic curve-hiding mechanism. A dedicated quote service learns
the outputs it requests and must not persist or publish them as protocol market
data.

Confidential protocol-fee collection has a related but narrower inference
boundary. Pool-side count/time batching and a delayed vault sweep prevent routine
per-swap disclosure. A beneficiary that already knows most trades in a quiet
window may still infer information about the remainder from a later aggregate
balance change. The protocol does not claim that batching manufactures unknown
traffic or an information-theoretic anonymity set.

## Trust assumptions

The design relies on COTI's MPC precompile, consensus, operator/key-management
model, reviewed token implementations admitted by the factory's immutable
runtime-codehash policy, client-side AES key handling and the COTI SDK's
authenticated encrypted-input format. Interface and exact-balance checks reduce
integration mistakes but do not prove the behavior of an approved implementation.
Mutable proxy and metamorphic implementations are unsupported. These are trust
assumptions, not cryptographic proofs produced by this repository.
