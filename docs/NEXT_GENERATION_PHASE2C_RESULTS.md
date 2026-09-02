# CipherDEX Next-Generation Phase 2C Results

## Review basis and scope

Reviewed upstream `main` at exact SHA
`b7ca9fd1ac5989133dd3687639eecb02fb4f1312`. Phase 2C changes only the
dependency-free accounting model, disposable public/private LP probes, disposable
issuer-authorization probe, focused tests, privacy checks, authenticated proof
runner and planning/results documentation. It does not add production
next-generation contracts, change SDK/deployment code, apply licenses, alter
Mainnet, implement confidential limit orders or change funded secret/recovery
architecture.

## Proven facts

### Aggregate dormant carry

The Phase 2B owner-retained policy was incomplete. A regression with 257 one-share
holders and a 256-unit fee produces zero whole claim per holder while aggregate
holder carry plus the global remainder equals 256 whole raw units. If all holders
exit under that policy, those liabilities remain dormant at zero-balance addresses.

The corrected no-loop rule is:

1. A nonzero-balance holder retains carry.
2. Transfer and burn settle whole claims before balances change.
3. If the sender ends at zero, its carry is zeroed and added to the one global
   unallocated accumulator.
4. With positive supply, divide the accumulator by supply, add the quotient to
   cumulative fractional growth and retain the remainder.
5. At zero supply, credit `floor(globalUnallocated / SCALE)` to the final holder and
   retain `globalUnallocated % SCALE`.
6. The first later mint folds the retained sub-unit value into growth over the new
   supply.

No holder loop, retired bucket, sweep recipient or launch-specific path is required.
Active reserves, protocol fees and total LP-fee liability do not change during
recycling.

After all holders are settled, exact conservation is:

`(lpFeeLiability - wholeClaimable) * SCALE = allocatedHolderCarry + globalUnallocated`

Every zero-balance holder has zero allocated carry. With positive supply,
`globalUnallocated < totalShares`; with zero supply,
`globalUnallocated < SCALE`. Repeated churn and zero-supply generations therefore
cannot accumulate an unclaimable whole-token liability.

The terminal fairness deviation is bounded to one raw unit per exit-to-zero. The
final holder can receive at most one whole raw unit assembled from unallocated
fractions, while strictly less than one raw unit can pass to the next generation.
For zero-decimal tokens, one raw unit is one whole token; for 18-decimal tokens it is
`1e-18` token.

### Branchless confidential settlement

The private probe computes the encrypted `currentFraction >= previousFraction`
predicate once. `MpcCore.mux` selects the borrow/no-borrow whole and fractional
deltas. Neither valid outcome is decrypted or used for public successful control
flow. The only decryption is an exact fail-closed guard rejecting an impossible
borrow when whole growth is zero.

The compiled privacy-AST gate now includes the disposable
`PrivateLPAccountingProbeToken` pattern in addition to all production contracts. A
future amount-derived successful decrypt branch in this pattern fails the gate.
Focused arithmetic tests prove a no-borrow settlement yielding carry `SCALE - 1`
and a subsequent borrow settlement yielding an exact three-unit whole claim with
zero carry.

### Protected disposition authorization

The candidate EIP-712 authorization now additionally signs:

- exact LP recipient;
- disposition kind;
- timed-lock `unlockTime`;
- all previously selected factory/mode/pair/tier/token/vault/domain/ID/deadline
  fields.

Direct and permanent dispositions require zero `unlockTime`; timed locks require a
future signed value. LP ownership defaults to the authorized vault. An alternate
recipient is possible only when its exact address is issuer-signed. The initializer
must consume these terms directly and cannot accept unsigned public overrides. EOA,
ERC-1271 and independent authorization-ID behavior remain unchanged. GT amounts
remain unsigned and self-funded by the named vault.

## Selected rules

- Recycle carry only when a post-operation LP balance is zero.
- Redistribute globally through cumulative growth; never iterate historical holders.
- Assign terminal whole units to the final holder and carry only a sub-unit global
  remainder into a later generation.
- Use encrypted comparison plus mux for valid confidential settlement outcomes.
- Sign every public LP-disposition parameter and consume those signed terms directly.

## Rejected alternatives

- Dormant carry at zero-balance historical addresses.
- Unbounded retired-generation arrays or buckets.
- Sweeping fractional LP value to a beneficiary or launchpad.
- Decrypting borrow/no-borrow to select a successful Solidity branch.
- Leaving timed unlock or LP recipient to unsigned vault execution values.

## Tests and funded status

- Focused Phase 2C suites: `43 passing`.
- `npm run typecheck`: passed.
- Compiled privacy boundary: passed for `79` Solidity files using fresh ASTs.
- `npm run compile`: passed.
- Full `npm run verify`: passed. It reported `422` Mocha tests (`421` active
  passing and the existing funded integration test pending), `6` passing Cotiscan
  tests, matching SDK distribution and zero production/operational audit findings.
- Focused COTI testnet lifecycle: **not run** pending a clean committed source.
- Sanitized evidence record: pending funded execution.

No funded success or gas result is inferred before the authenticated run and a
source-bound evidence record exist.

## Remaining gates

- Review the actual partner launch-token/factory source before selecting a production
  issuer ABI. Unsupported tokens remain standard-only.
- Optimize and remeasure the eventual production encrypted storage/settlement path.
- Complete production security/confidentiality review after licensed production code
  exists.
- Complete Mainnet inventory and explicit migration/deprecation decisions.
- Resolve Licensor, ownership/relicensing rights, release date, Additional Use Grant,
  Change Date and exact license wording.
- Confidential limit orders remain outside Phase 2C.
