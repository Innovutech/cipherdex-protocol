# Feasibility Gate

Date: 2026-08-15

## Evidence reviewed

The implementation uses the pinned official `@coti-io/coti-contracts@1.3.5`
MPC and `PrivateERC20` interfaces. `gtUint256` supports the checked arithmetic,
comparison, division, authenticated-input validation and user-specific
offboarding required by the pool. The contracts never decrypt an amount. They
decrypt only policy booleans needed to accept or reject an operation.

The real COTI testnet gate was executed with two funded LP identities, a separate
MPC-call probe identity and two deployed `PrivateERC20` assets. Keys, AES material,
ciphertexts, decrypted values and private balances were neither printed nor
persisted.

## Demonstrated on COTI testnet

- arbitrary-ratio confidential initialization;
- a second proportional LP join without surplus donation;
- multiple complete-key fee/strategy candidates for the same pair;
- canonical confidential discovery and encrypted transaction quote selection
  across two fee tiers;
- transaction-scoped GT validation and reuse across multiple pool calls;
- private best-output selection with only the winning result offboarded;
- factory-derived 5/30/100 bps and reviewed strategy-class candidates selected
  through a bounded nine-bit bitmap, with absent/uninitialized/invalid candidate
  isolation and deterministic fee/class ties;
- atomic best execution with exact router escrow, selected-pool allowance,
  settlement parity, encrypted slippage rollback and no balance/allowance residue;
- direct encrypted swaps in both directions;
- expired, slippage-failing and replayed-input rejection;
- per-input-token confidential fee-batch counters and premature collection
  rejection;
- mature encrypted fee collection after the immutable one-hour window, following
  a true full LP exit and with both public batch counters cleared;
- second-LP exit, timed lock/unlock, permanent lock and true full exit;
- atomic launchpad rollback for an impossible encrypted price interval;
- successful launchpad migration into its committed protected complete key while
  retaining the same canonical factory fee policy;
- launchpad replay rejection without additional token movement;
- recoverable creator-held launchpad full exit and zero disposable pool residue.

The staged probe proves ciphertext-only user reads work under `eth_call`, while
raw stored-ciphertext `OnBoard`, authenticated validation, arithmetic,
comparison/mux and both full quote forms fail. A real transaction executes the
same MPC operations. The lower-level funded probe proved that one paid router
transaction can reuse one validated GT input across pools. Fresh funded
production-router evidence now covers mixed standard/protected candidates, all
v1 fee tiers, both directions, invalid-candidate isolation, quote/settlement
parity and full cleanup. The stable SDK exposes that paid canonical
best-quote/best-swap transport as the preferred bounded integration path, while
direct paid per-pool quotes remain supported. This enables a testnet routing path without
publishing reserves, but gas, latency and public winning-route metadata remain
product limitations rather than normal gasless quote UX.

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

Permissionless paid quotes already allow an active funded caller to estimate the
CPMM curve through repeated chosen inputs. Encryption protects each
request/result from passive public disclosure and hides losing candidate outputs,
but does not make a deterministic curve information-theoretically unknowable to
the caller.

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

## Remaining production checks

The testnet behavior is demonstrated, not externally audited. An independent
audit remains recommended and its absence must stay visible in release records,
but it is not an executable mainnet deployment gate. The operator has explicitly
accepted proceeding without that gate. Before deployment:

1. Run sustained stateful/fuzz campaigns beyond the deterministic local suite,
   including paid router quote gas/liveness at four through nine candidates.
   Atomic execution remains capped at the already measured three candidates.
2. Operationally validate the fixed-epoch confidential vault sweep after its
   real two-epoch maturity boundary without shortening or bypassing the delay.
3. Re-exercise timed-lock and permanent-lock launchpad dispositions on any final
   release candidate when operational custody of intentionally locked test
   liquidity is explicitly approved; their contract paths are covered locally,
   while the normal funded evidence runner remains creator-held and recoverable.
4. Use a reviewed multisig/governance beneficiary instead of a testnet EOA.
5. Revalidate compiler, RPC and MPC behavior against the target mainnet release.

No external audit is claimed.
