# CipherDEX Next-Generation Phase 2D Results

## Review basis and scope

Reviewed upstream `main` at exact SHA
`6e90567f8c7c1fa9d229634033ba49518eef46db`. Phase 2D changes only a disposable
private packing probe, dependency-free reference encoder/model, focused tests,
privacy checks, authenticated funded runner and planning/results documentation. It
does not add production pools, factories, routers, LP tokens, SDK exports,
deployment code, licenses, Mainnet changes or confidential limit orders. Funded
secret and recovery architecture is unchanged.

## Canonical layout

All pair packing uses:

`FIELD_BITS = 128`

`FIELD_MASK = 2^128 - 1`

`packed = highField * 2^128 + lowField`

The contract validates one ordinary selector/caller/contract-bound COTI
`itUint256`, then computes `high = packed / 2^128` and
`low = packed % 2^128` entirely in MPC. Neither field is decrypted. The reference
encoder rejects non-bigint, negative or greater-than-mask fields instead of
truncating them.

## Decision table

| Operation | Current IT | Proven minimum IT | Proposed fixed layout | Trade-off/status | Funded gas difference |
| --- | ---: | ---: | --- | --- | ---: |
| Exact-input swap | 2 | 1 | `amountIn[255:128] | minimumOut[127:0]` | Accepted; both operands are bounded to 128 bits. | Pending |
| Remove liquidity | 3 | 2 | `shares` plus `minimumAmount0[255:128] | minimumAmount1[127:0]` | Accepted; preserves both independent minimums and full-exit/lock checks. | Pending |
| Existing-pool add | 5 | 4 | packed amount maxima, `minimumShares`, full-width encrypted `minimumPriceX18`, full-width encrypted `maximumPriceX18` | Accepted compatibility-preserving minimum. | Pending |
| Existing-pool add, symmetric endpoint | 5 | 3 | packed amount maxima, `minimumShares`, full-width encrypted `expectedPriceX18`; public `maximumDeviationBps` | Safe only as an additional constrained API; cannot express arbitrary asymmetric/one-sided bounds. | Not funded in this phase |
| Standard first initialization | 5 | 1 | `amount0[255:128] | amount1[127:0]` | Accepted for atomic proven-uninitialized initialization. | Packing primitive covered |
| Protected first initialization | 5 | 1 | same packed amount pair | Accepted; issuer authorization is separate and GT amounts remain vault-funded. | Packing primitive covered |
| Exact-input quote | 1 | 1 | unchanged amount IT | No redesign. | N/A |
| Add-liquidity quote | 1 | 1 | unchanged specified-amount IT | No redesign. | N/A |
| LP-share lock | 1 | 1 | unchanged share IT | No redesign. | N/A |
| Owner reads / fee claims | 0 new amount IT | 0 | no caller-supplied amount | No redesign. | N/A |

## Endpoint verdicts

### Swap: one IT accepted

The high field is `amountIn`; the low field is `minimumOut`. Validate and consume the
packed value once, unpack in MPC, require positive input, then call the same strict
GT swap transition used by the GT endpoint. Deadline, exact deltas, reserve/fee/LP
liability caps, encrypted minimum comparison and mode disclosure rules are unchanged.

Direct pool and best router require different exact selectors. A router validates
its packed IT at the router endpoint and forwards only unpacked GT to the selected
bound pool. A pool-signed input cannot be reused at the router or vice versa.

### Removal: two IT accepted

Shares remain one IT and must satisfy the selected 128-bit LP bound. The second IT
packs both 128-bit token minimums. The existing full-exit, locked-principal,
fee-claim, exact transfer and two independent minimum checks consume the unpacked GT.

### Existing addition: four IT accepted

The two 128-bit amount maxima pack into one IT. `minimumShares` remains separate.
Both price bounds remain independent full-width IT values because price must not be
assumed to fit in 128 bits. This preserves the current arbitrary asymmetric bounds.

### Symmetric existing addition: optional three IT

An optional endpoint may replace the two absolute price bounds with one encrypted
full-width `expectedPriceX18` and public `maximumDeviationBps <= 10_000`. It derives:

`delta = floor(expectedPriceX18 * maximumDeviationBps / 10_000)`

`minimum = expectedPriceX18 - delta`

`maximum = min(2^256 - 1, expectedPriceX18 + delta)`

The reference implementation avoids `expected * bps` overflow by quotient/remainder
decomposition. The expected price is user-provided encrypted input, not derived from
the pool state being checked, so the limit is meaningful. Only the public tolerance
is disclosed in Mode 1. The loss is material: asymmetric, one-sided and independently
rounded absolute bounds cannot be expressed. Therefore this is safe as a distinct
future endpoint, not a replacement for the four-IT endpoint.

### First initialization: one IT accepted

For a factory-proven uninitialized pool created and initialized atomically, the two
positive signed amounts establish the exact initial ratio. Fixed token order and
decimals deterministically derive initial shares as
`min(amount0 * scale0, amount1 * scale1)`. Exact transfer deltas and operational
bounds remain authoritative. If another initialization wins, the uninitialized-state
guard reverts the whole transaction. A separate minimum-share or price bound would
only re-check values fully determined by the same signed amounts and immutable
metadata.

Standard and protected IT initialization therefore each require one packed IT.
Protected initialization still requires its separate issuer/vault authorization.
GT initialization remains two unpacked contract-to-contract amounts and converges on
the same internal initialization transition.

## Replay and privacy

Every production candidate eventually requires its own exact selector. Standard
COTI validation remains bound to caller, contract and selector. The packed ciphertext
is consumed as one replay unit; unpacked fields do not receive separate replay state.
No unsigned ciphertext, direct caller ciphertext onboarding or custom signature
scheme is introduced.

The disposable probe emits only caller-encrypted fields/results. Mode 1 and Mode 2
use the same private result shape; Mode 2's separate observation policy is unaffected.
All decrypted predicates in the pattern are exact fail-closed revert guards.

## Proposed future SDK surface

These names are documentation only and are not exported in Phase 2D:

- `packCipherDEXUint128Pair({ high, low }): bigint`
- `packCipherDEXSwapInput({ amountIn, minimumOut }): bigint`
- `packCipherDEXLiquidityAmounts({ amount0Maximum, amount1Maximum }): bigint`
- `packCipherDEXRemovalMinimums({ minimumAmount0, minimumAmount1 }): bigint`
- `buildCipherDEXSymmetricPriceBounds({ expectedPriceX18, maximumDeviationBps })`

Every helper accepts raw-unit `bigint` fields and rejects out-of-range input before
wallet encryption.

## Local proof status

- Focused Phase 2D tests: `9 passing`.
- `npm run typecheck`: passed.
- `npm run compile`: passed.
- Compiled privacy boundary: passed for `80` Solidity files using fresh ASTs.
- Full `npm run verify`: passed. It reported `431` Mocha tests (`430` active
  passing and the existing funded integration test pending), `6` passing Cotiscan
  tests, matching SDK distribution and zero production/operational audit findings.
- Funded COTI testnet proof: **not run** pending a clean committed source.
- Sanitized evidence: pending funded execution.

No funded pass or gas saving is inferred before authenticated execution and a
source-bound evidence record.

## Remaining gates

- Freeze production endpoint names/selectors only during production implementation.
- Decide whether the optional symmetric three-IT addition endpoint is worth its API
  surface; four IT remains the required compatibility endpoint.
- Review actual issuer source, optimize production MPC/storage gas, complete
  production security review, Mainnet inventory and licensing decisions.
