# Confidential Quote and Market-Data Review

Date: 2026-08-15

## Decision

Keep permissionless encrypted exact-input quotes and remove all public
reserve-derived market data from `ConfidentialCPMM`. The confidential core does
not publish reserves, TVL, aggregate LP supply, spot price, TWAP, depth bands, or
exact quotes. Any future public oracle is optional and separate from settlement.

Walletless integration remains possible through a dedicated, non-custodial COTI
quote identity. It discovers canonical fee-tier candidates, creates fresh
authenticated encrypted inputs for each pool, performs COTI-compatible quote
requests, decrypts only its own results in memory, and selects the largest
output. On the current COTI testnet this uses an on-chain request with a
caller-encrypted result event because MPC precompiles are not executed under
`eth_call`; the direct simulation function remains available for a compatible
RPC. It never holds user funds or signs swaps. The user independently creates
fresh authenticated amount/slippage inputs and executes the selected pool
directly.

This is a testnet-only design decision, not an audit or mainnet claim.

## Evidence from the current COTI primitives

The reviewed `@coti-io/coti-contracts@1.3.5` `MpcCore` implementation and official
COTI documentation support:

- `validateCiphertext` for signed `Inputtext` bound to sender, target contract,
  selector, and encrypted value;
- `setPublic256` to introduce a public integer into protected computation;
- mixed protected arithmetic and comparisons, including checked multiplication,
  division, min/max, and boolean predicates;
- `offBoard` for network-key ciphertext storage;
- `offBoardToUser` for a result encrypted to a selected user's AES key;
- `decrypt` for intentional plaintext disclosure, with explicit official
  warnings that it must not reveal user-specific secrets publicly.

Public inputs can therefore be evaluated against confidential reserves, and a
derived result can technically be disclosed. Technical possibility does not make
that disclosure privacy-neutral. A public exact quote or accepted price predicate
is an oracle over the private curve and can be queried repeatedly.

## Current quote boundary

`quoteExactInput(itUint256,bool)` validates the caller's authenticated encrypted
input, reads both protected accounting reserves, evaluates the CPMM, and returns
only `offBoardToUser(output,msg.sender)`. It emits no quote event and does not
persist quote state. It is deliberately non-view because COTI MPC
onboarding/offboarding is not ordinary EVM-only computation.

The current COTI testnet RPC does not execute the required MPC precompiles under
`eth_call`. `requestQuoteExactInput` therefore computes the same result in a
transaction and emits it encrypted for the caller with an opaque request ID.
This creates public caller/pool/direction/timing history, but never plaintext
input or output. Integrations must prefer the non-transactional function when a
future compatible RPC can execute it faithfully; they must not silently treat an
MPC simulation failure as a zero quote.

The encryption protects a specific request and result from passive public
observation. It does not hide the caller, pool, token identities, direction,
timing, or ciphertext metadata from the RPC endpoint. It also does not prevent
the caller from decrypting and learning its own result.

## Active probing analysis

For known fee and decimals, the public formula is:

`netIn = floor(amountIn * (10000 - feeBps) / 10000)`

`retainedOut = ceil(reserveIn * reserveOut / (reserveIn + netIn))`

`amountOut = reserveOut - retainedOut`

A small quote estimates the marginal reserve ratio after fees. Multiple quote
sizes reveal curvature and therefore an effective depth range. Integer rounding,
concurrent state changes, and unknown exact reserves create uncertainty, but do
not provide a durable curve-confidentiality guarantee. A permissionless caller
that can generate and decrypt valid quotes can probe repeatedly without creating
normal transaction/event history.

Therefore:

- encrypted quoting meaningfully protects individual payload confidentiality;
- it does not make price or depth unknowable to an active quote participant;
- publishing a public spot/TWAP would widen disclosure from active participants
  to every passive observer and create a persistent historical feed;
- reserve confidentiality still matters because exact reserve/TVL state and LP
  exposure are not directly available, even if the curve can be approximated.

## Required answers

### 1. Why is the current confidential quote input/output encrypted?

To keep the requested amount and returned output out of plaintext calldata,
public RPC responses, events, errors, and storage. The pool can compute against
private reserves and re-encrypt the result for the authenticated caller.

### 2. Which privacy guarantees does that actually provide?

It protects a caller's specific quote amount/result from passive chain readers
and unrelated callers. A compatible RPC simulation avoids quote transaction
history; the current testnet transaction transport publicly reveals caller,
pool, direction, and timing. Neither transport stops the caller/RPC from
observing and analyzing requested results.

### 3. Can repeated permissionless private quotes infer price or depth?

Yes. Small probes estimate marginal price; varied sizes estimate curvature and
effective depth. Exact reserve recovery may remain uncertain due to integer
rounding and moving state, but strong curve secrecy is not a valid claim.

### 4. Can a walletless backend/API obtain a quote?

Not as an unauthenticated plaintext caller. It can operate a dedicated onboarded
COTI EOA and AES key, create authenticated inputs, and decrypt its own output.
Today it also needs enough native testnet COTI to submit transactional quote
requests; on a compatible RPC it can use `eth_call` instead. That identity is
non-custodial and must not sign user swaps.

### 5. Can COTI MPC safely support public/selective derived data?

It can technically combine public operands with confidential reserves and can
intentionally decrypt or re-encrypt a derived result. Safety depends on the
disclosure policy, not just the primitive. Releasing spot, TWAP, exact quotes, or
comparison outcomes creates an oracle that can weaken reserve-ratio/depth
confidentiality. The v1 core therefore does not expose one.

### 6. What can be public without materially weakening user privacy?

Pool address, ordered token identities, public decimals, fee tier, privacy mode,
protocol version, initialization state, participant addresses already exposed by
PrivateERC20, swap direction, lock owner/timing/disposition, transaction timing,
gas, and success/failure. Exact reserves, TVL, aggregate shares, individual LP
amounts, quote outputs, swaps, slippage, and liquidity amounts remain private.

### 7. What do integrations need to quote and route pools?

Discover candidates from factory events/registry getters; keep only matching pair,
privacy mode, protocol version, and supported fee tiers; use a dedicated quote
identity to request and decrypt one quote per candidate; compare only results for
the same opaque request ID and direction; return the selected pool and a bounded
user-facing quote; have the user create fresh pool-bound encrypted inputs and call
the pool directly. Never aggregate LP positions as separately quoted routes.

### 8. Keep, extend, or redesign?

Keep the encrypted direct-to-pool execution boundary, remove the embedded public
spot/TWAP extension, and extend only the SDK/reference integration flow for
service-local candidate selection. Do not add public reserve getters, a public
exact-quoter, or a generic confidential router. Revisit a separate oracle only
after an explicit leakage budget, manipulation model, and independent review.

## Alternative summary

| Model | Useful property | Privacy consequence | v1 decision |
| --- | --- | --- | --- |
| Encrypted caller quote | Exact executable estimate for one authenticated identity | Active caller can probe curve | Keep |
| Public exact quote | Simple aggregator integration | Universal exact curve oracle | Reject |
| Public reserves/TVL | Simple analytics and deterministic routing | Removes aggregate reserve confidentiality | Reject |
| Core spot/TWAP | Walletless persistent market history | Permanently reveals ratio/history to passive observers | Remove |
| Coarse depth buckets | Approximate route filtering | Leaks bounded reserve/depth information | Defer |
| Dedicated quote identity | Walletless integration without custody | Service learns requested outputs and needs protected key operations | Reference flow |
| Separate optional oracle | Explicit opt-in analytics policy | Depends on its own leakage/manipulation design | Future review |

## Operational requirements for a quote identity

- separate EOA/AES key from treasury, deployer, and user wallets;
- no funds beyond minimal gas if the RPC implementation unexpectedly requires it;
- no ability to sign or relay user swaps;
- no plaintext amount/output/ciphertext/AES-key logging;
- short request retention, bounded concurrency, rate limits, and RPC isolation;
- fresh authenticated input per pool because COTI input signatures bind target
  contract and selector;
- fail closed when a result cannot be decrypted or candidate identity differs;
- user execution must use fresh inputs and its own minimum-output policy.

## Official references

- https://docs.coti.io/coti-documentation/build-on-coti/tools/contracts-library/mpc-core
- https://docs.coti.io/coti-documentation/build-on-coti/guides/best-practices/careful-decrypting
- https://docs.coti.io/coti-documentation/how-coti-works/advanced-topics/aes-keys
- https://docs.coti.io/coti-documentation/build-on-coti/core-concepts/secure-data-types
- https://docs.coti.io/coti-documentation/build-on-coti/core-concepts/secure-operations-and-gas
