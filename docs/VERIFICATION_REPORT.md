# Verification Report

Date: 2026-08-15

## Environment

- Node: `v24.16.0`
- npm: `11.13.0`
- install: `npm ci --ignore-scripts`
- Solidity compiler: pinned `solc@0.8.28`, loaded locally by Hardhat
- deployment target: COTI testnet only (`7082400`)

## Passed checks

- `npm audit --omit=dev --audit-level=high`: zero production findings
- `npm ls --omit=dev --all`: production graph resolved cleanly
- `npm run test:privacy-boundary`: passed
- `npm run typecheck`: passed
- `npm run compile`: passed
- `npm test`: 17 passing, 1 pending integration placeholder
- `npm run verify`: passed

The full development graph still reports 46 advisories: 17 high, 10 moderate
and 19 low. They are in Hardhat/compiler/test tooling and are documented in
`DEPENDENCY_AUDIT_REPORT.md`; they are not bundled in the production dependency
graph. The verification command intentionally keeps the production audit and
full graph visible and does not suppress those findings.

The local reference-property tests cover the fee-adjusted output formula,
ceil-rounded retained reserves, invariant preservation, monotonicity and the
output floor. Solidity construction tests also cover expired deadlines and
token-decimal metadata validation.

## Deliberately incomplete checks

The COTI testnet integration test remains pending because this repository does
not contain a private key, AES key, pool address, or funded/onboarded test
PrivateERC20 tokens. Supplying those values through `.env` and running
`npm run testnet:harness` is required before a testnet demonstration can be
claimed. Secrets must never be committed or printed.

The following must be measured on testnet before considering a production
release. The atomic launchpad migration path is compiled and locally guarded,
but has not been executed against COTI testnet in this repository:

1. Encrypted liquidity add and caller-only share decryption.
2. Both swap directions with encrypted minimum output.
3. Quote behavior through the COTI-compatible RPC.
4. Failed slippage execution with unchanged balances.
5. Partial and full liquidity removal.
6. Gas and wall-clock latency without logging private values.
7. Factory-created private LP-token mint/burn/transfer behavior and encrypted
   caller-specific share recovery.
8. Launchpad migration with canonical token ordering, explicit encrypted
   allowances, encrypted price bounds and atomic rollback on a failed bound.
9. Launchpad creator-held, timed-lock and permanent-lock dispositions on COTI
   testnet, including lock recovery and public lock metadata.

No mainnet deployment, confidential generic router, PoD adapter, or cross-chain
adapter is included in this foundation. Public pools do have a factory-gated
router/quoter. See `FEASIBILITY_GATE.md` for why the standard
PrivateERC20 interface cannot hide participant addresses and why asynchronous
PoD transfers cannot be treated as atomic CPMM legs.

## Release decision

This commit is a testnet feasibility foundation, not a production deployment.
The implementation is suitable for controlled testnet validation after an
independent contract review. It must not be presented as fully anonymous or
mainnet-ready until the remaining testnet and security gates pass.
