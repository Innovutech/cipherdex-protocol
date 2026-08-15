# Feasibility Gate

Date: 2026-08-15

## Evidence reviewed

The implementation uses the pinned official `@coti-io/coti-contracts@1.3.5`
MPC and `PrivateERC20` interfaces. `gtUint256` supports the checked arithmetic,
comparison, division, authenticated-input validation and user-specific
offboarding required by the pool. The contracts never decrypt an amount. They
decrypt only policy booleans needed to accept or reject an operation.

The real COTI testnet gate was executed with two funded LP identities, a separate
quote identity and two deployed `PrivateERC20` assets. Keys, AES material,
ciphertexts, decrypted values and private balances were neither printed nor
persisted.

## Demonstrated on COTI testnet

- arbitrary-ratio confidential initialization;
- a second proportional LP join without surplus donation;
- two canonical fee-tier candidates for the same pair;
- walletless encrypted transactional quotes and local best-pool selection;
- direct encrypted swaps in both directions;
- expired, slippage-failing and replayed-input rejection;
- per-input-token confidential fee-batch counters and premature collection
  rejection;
- mature encrypted fee collection after the immutable one-hour window, following
  a true full LP exit and with both public batch counters cleared;
- second-LP exit, timed lock/unlock, permanent lock and true full exit;
- atomic launchpad rollback for an impossible encrypted price interval;
- successful launchpad migration through the same canonical factory fee policy;
- launchpad replay rejection without additional token movement.

Current COTI testnet does not execute this MPC path under `eth_call`. The
transactional quote-result event remains encrypted for the requesting identity.
The direct `quoteExactInput` function stays available for a future compatible RPC.

## Accounting model

Confidential reserves, protocol fees and LP shares are encrypted accounting
state. Private token transfers back that state, but reserve calculations do not
derive price or liquidity from publicly readable token balances. A swap credits
the effective reserve with the encrypted input less the encrypted protocol fee;
the protocol share enters a separate encrypted per-token accumulator. Full LP
exits cannot withdraw that accumulator.

Public pools use ordinary ERC-20 balances with explicit per-token protocol-fee
counters subtracted from effective reserves. Public and confidential pools share
the immutable fee tiers and split documented in `FEE_ECONOMICS.md`.

## Hard privacy limits

The standard `PrivateERC20` interface does not hide participant addresses.
`transferGT` and `transferFromGT` contain public EVM addresses, and token events
may expose sender and recipient. CipherDEX protects amounts, slippage, reserves
and LP positions; it does not claim anonymous participants.

Repeated permissionless quotes allow an active caller to estimate the CPMM curve.
Encryption protects a specific request/result from passive public disclosure; it
does not make a publicly probeable deterministic curve information-theoretically
unknowable.

Confidential fee batches similarly reduce routine per-swap disclosure but cannot
manufacture an anonymity set in a quiet pool. A beneficiary that knows most
constituent trades may infer information from an eventual aggregate. The v1
design therefore uses pool-side count/time batching plus a delayed common vault,
and documents this residual active-differencing limit explicitly.

## PoD exclusion

PoD `PodERC20` settlement is asynchronous and callback-driven. It cannot be used
as a synchronous CPMM leg without a separate pending-state, timeout, refund and
recovery protocol. PoD support remains outside this v1 rather than being treated
as an implicit `PrivateERC20` fallback.

## Remaining gates

The testnet behavior is demonstrated, not audited. Before any mainnet decision:

1. Obtain independent contract and COTI MPC integration review.
2. Run sustained stateful/fuzz campaigns beyond the deterministic local suite.
3. Operationally validate the separate 24-hour confidential vault sweep without
   shortening or bypassing its delay.
4. Exercise launchpad creator-held, timed-lock and permanent-lock dispositions
   in separate fresh testnet deployments; the core pool lock paths themselves
   have been exercised.
5. Use a reviewed multisig/governance beneficiary instead of a testnet EOA.
6. Revalidate compiler, RPC and MPC behavior against the target mainnet release.

No external audit or mainnet readiness is claimed.
