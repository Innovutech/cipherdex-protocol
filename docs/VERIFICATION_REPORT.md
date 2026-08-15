# Verification Report

Date: 2026-08-15

## Scope and environment

- Node: `v24.16.0`
- npm: `11.13.0`
- Solidity: pinned local `solc@0.8.28`, Paris EVM
- target: COTI testnet (`7082400`) only
- install policy: `npm ci --ignore-scripts`

This report covers the public and amount-confidential CPMMs, canonical factories,
fee vault, public periphery, confidential quoting flow, private LP accounting,
locks, atomic launchpad migration, SDK surface and testnet runners. It does not
claim an external audit or mainnet readiness.

## Automated verification

- `npm audit --omit=dev --audit-level=high --json`: 0 production findings
- `npm ls --omit=dev --all`: production graph resolved cleanly
- full development audit: 46 findings (0 critical, 17 high, 10 moderate, 19 low)
- privacy-boundary check: passed
- security-boundary check: passed
- TypeScript: passed
- clean compile and TypeChain generation: passed
- full local suite: 52 passing, 1 intentionally gated integration placeholder
- deployment gas measurement: passed

No dependency version or lockfile changed in this work. Development-only
advisories and lifecycle/native-module review are recorded in
`DEPENDENCY_AUDIT_REPORT.md`; none occurs in the production dependency graph.

## Fee-economics evidence

The implementation and tests establish one advertised exact-input swap fee with
no additional native-COTI platform payment. Approved immutable v1 tiers are 5,
30 and 100 bps. One sixth of the integer-rounded total fee accrues to the
protocol and the remainder stays in the pool for LPs.

Public tests cover:

- separate token0/token1 protocol-fee counters;
- quote/execution parity and fee rounding at tiny-value thresholds;
- effective-reserve and invariant preservation in both directions;
- permissionless collection only to the immutable vault;
- unchanged price and effective reserves across collection;
- beneficiary-only vault withdrawal and public/private token-mode separation;
- malicious token callback rollback during vault collection;
- partial/full LP exits excluding protocol-owned balances;
- reinitialization while accrued protocol balances remain excluded.

Confidential construction, SDK and live-testnet checks establish encrypted
per-token accumulators with no amount getter or amount-bearing event. Collection
requires eight swaps and a one-hour pool window per selected side, then moves one
encrypted aggregate to the immutable vault. The separate vault sweep has a
24-hour per-token delay and emits no confidential amount.

## COTI testnet evidence

The preflight passed for two funded LP identities and a separate quote-service
identity against two official `PrivateERC20`-compatible assets. It validated
chain ID, gas, code, decimals, AES binding and caller-local encrypted balance
recovery. Private keys, AES keys, balances, ciphertexts and decrypted values were
not logged or persisted.

The full confidential scenario completed against fresh v1 deployments:

- fee vault: `0xB0DbEA341566E0B5B57148284C4EcDfdAD71cc93`
- canonical factory: `0x6cdcBa60053119cB1bc8df2C5533cd36f0d79f75`
- primary pool: `0xaD4E2F96c07f6ed54F3fDFc77009B25A0ee460F4`
- quote candidate: `0x8604103B36F2Cf98215574335F715021BC5478bD`

Observed behavior included arbitrary-ratio initialization, a proportional second
LP join without surplus donation, two fee-tier candidates, transactional
caller-encrypted quotes, local best-pool selection, direct swaps in both
directions, expired/slippage/replay rejection, fee-batch counter isolation,
premature collection rejection, second-LP exit, timed lock/unlock, permanent
lock and a true full exit. A representative confidential swap used approximately
6.50 million gas.

The atomic launchpad scenario also completed against fresh contracts:

- factory: `0xa145AF8e5D4Ae8fB359535A3F9D2A1252FF9c0F9`
- migrator: `0xA8d73ED84Abf119F16Bf9E1Dc20b236385fd1022`
- pool: `0x286b6D5E2D71BaBf1Da9b7D891C288B7340DdFa2`
- migration transaction:
  `0x68748b9c1643cb6191dc4209d9f3e93b0932371911b1869cd814de8c6bae3939`
- migration gas: 13,036,844

The runner proved rollback for an impossible encrypted price interval, then a
successful canonical migration using the same immutable fee policy and vault.
It rejected replay of the successful request without additional token movement.
The EIP-712 ciphertext commitment encodes COTI `ctUint128` limbs as Solidity
`uint256`; a greater-than-128-bit fixture prevents regression to the incorrect
narrow encoding.

The mature confidential fee-batch runner prepared the disposable quote pool with
eight swaps in each direction and observed the immutable one-hour window. After
the contract timestamp became eligible, it completed a full LP exit and then
collected both encrypted protocol-fee aggregates to the fixed vault:

- full LP exit transaction:
  `0x4f0022127a28c99205cbf542e12e0cb0905f6d5864cc5305d5b613688279ee68`
  (5,405,114 gas)
- encrypted fee collection transaction:
  `0x2937344fe59120d54e730f6cbd395eb28ac0d1d8781d1323c0e3b03299617cc6`
  (1,206,913 gas)

Both public batch counters were zero after collection. No confidential amount
was decrypted, returned or emitted.

## Compiler, size and gas review

| Contract | Creation bytes | Runtime bytes | Local deployment gas |
| --- | ---: | ---: | ---: |
| `CipherDEXFeeVault` | 1,917 | 1,714 | 447,550 |
| `ConfidentialCPMM` | 15,329 | 14,326 | deployed by factory |
| `ConfidentialCPMMFactory` | 32,340 | 18,677 | 6,999,610 |
| `ConfidentialLaunchpadMigrator` | 8,557 | 8,193 | 1,850,333 |
| `PublicCPMM` | 8,976 | 7,453 | deployed by factory |
| `PublicCPMMFactory` | 10,860 | 10,671 | 2,352,988 |
| `PublicCPMMRouter` | 2,096 | 1,908 | 489,742 |
| `PublicCPMMQuoter` | 816 | 640 | 193,697 |

All runtime bytecode remains below the 24,576-byte EIP-170 limit. Factory
initcode remains below the 49,152-byte EIP-3860 limit. COTI testnet runners use
an explicit gas ceiling below the observed 120,000,000 block limit because the
RPC does not support Hardhat's pending-block estimation path; receipts still
record and charge actual gas.

## Privacy conclusions

The pool never decrypts an amount. It decrypts only policy booleans needed to
accept or reject an operation. Confidential reserves, LP shares, liquidity
amounts, quote values, slippage and protocol-fee values have no public plaintext
read model. Participant addresses, direction, timing and fee-batch counts remain
public at the EVM layer.

Permissionless encrypted quoting protects a caller's individual request/result
from passive observers but does not make a deterministic public CPMM curve
unknowable to an active caller that repeatedly probes it. Fee batching similarly
prevents routine per-swap fee disclosure but cannot create unknown traffic in a
quiet pool; active differencing remains a documented residual risk.

Current COTI testnet does not execute this MPC path under `eth_call`, so the
reference integration uses a transaction that emits a caller-encrypted result.
The quote identity never receives user funds or signs user swaps.

## Remaining gates

Before any mainnet decision:

1. Operationally validate the separate 24-hour confidential vault sweep without
   shortening or bypassing its delay.
2. Exercise all three launchpad LP dispositions in separate fresh deployments;
   the underlying pool lock paths have already been exercised.
3. Obtain independent Solidity, economic and COTI MPC integration review.
4. Run longer stateful/fuzz campaigns and revalidate against the target COTI
   mainnet compiler/RPC/MPC release.
5. Replace the testnet EOA beneficiary with a reviewed multisig/governance
   boundary for any production deployment.

PoD, a generic confidential router, private multi-hop execution and a public
confidential-pool oracle are intentionally outside v1.

## Release decision

This is a reproducible COTI testnet implementation, not an audited production
release. It must not be deployed to mainnet or marketed as anonymous: amount
confidentiality does not hide participant addresses, and the documented active
probing/differencing limits remain.
