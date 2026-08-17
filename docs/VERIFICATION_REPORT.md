# Verification Report

Date: 2026-08-17

## Scope and environment

- Node: `v24.16.0`
- npm: `11.13.0`
- Solidity: pinned local `solc@0.8.28`, Paris EVM
- target: COTI testnet (`7082400`) only
- install policy: `npm ci --ignore-scripts`

This report covers the transparent and amount-confidential CPMMs, canonical
factories, immutable fee vault, public periphery, private LP accounting,
confidential quoting boundary, encrypted protocol-fee batching, atomic
launchpad migration, SDK surface and funded testnet runners. It does not claim
an external audit or mainnet readiness.

## Automated verification

- `npm audit --omit=dev --audit-level=high --json`: 0 production findings
- `npm ls --omit=dev --all`: production graph resolved cleanly
- full development audit: 46 findings (0 critical, 17 high, 10 moderate, 19 low)
- privacy-boundary check: passed for 33 Solidity files
- security-boundary check: passed
- TypeScript: passed
- clean compile and TypeChain generation: 22 Solidity files, 60 typings
- full local suite: 157 passing, 1 intentionally gated funded integration placeholder
- deployment gas measurement: passed
- `git diff --check`: passed before fresh deployment evidence

No dependency was added. The redundant direct `dotenv` dependency was removed;
the lockfile changed only for that root declaration and the pinned Node/npm
engine policy, while the resolved production graph remained unchanged.
Development-only advisories and lifecycle-script review are recorded in
`DEPENDENCY_AUDIT_REPORT.md`; none is present in the production dependency
graph. No forced upgrade, override or advisory suppression was used.

## Security review

The earlier repository scan's confirmed findings were mapped to and closed by
the current implementation: confidential price-race and arithmetic bounds,
safe full exits, LP burn authority, private-token implementation provenance,
exact token deltas, public negative-rebase handling, taxed fee collection,
public and confidential SDK provenance, quote-domain separation, funded-runner
provenance, and zero-accrual confidential dust.

Independent read-only contract, SDK/configuration and funded-runner reviews
found and closed the earlier implementation and evidence defects. The
remediations cover confidential arithmetic and price bounds, full exits, LP burn
authority, private-token runtime provenance, exact token deltas, public
negative-rebase and taxed-token handling, quote-domain separation, funded-run
provenance, zero-accrual dust, stale-artifact execution, mined-transaction
journaling and source-bound evidence. Every supported `--no-compile` command now
runs clean, compile and target execution in separate blocking processes through
an exact target/argument allowlist. In-script freshness checks remain as defense
in depth.

The funded-runner review repeated five earlier deployment-evidence candidates.
The actual current tree closes them with focused regression evidence:

- mined status errors retain a validated public transaction hash while external
  payloads and secret-shaped values remain redacted;
- deployment journals every mined transaction before handle recovery or
  artifact validation and records terminal `failed` or `outcome-unknown` state;
- configured funded runners require a complete commit-bound deployment record,
  clean matching source and current runtime artifact/codehash provenance;
- canonical runner process isolation guarantees target module loading happens
  only after a successful clean compile, while the supplemental source boundary
  rejects reviewed eager module-scope artifact/network patterns;
- immature confidential fee batches fail the verification command instead of
  returning successful evidence.

Twenty focused evidence/provenance tests and both source/security boundary gates
passed after those controls were inspected. The gas-evidence and process-runner
fixes passed TypeScript, both boundary gates and a full process-isolated clean
gas-measurement run. Focused Codex Security diff rechecks of the later source-
provenance and funded deployment-cap changes found no findings.

The final Codex Security Standard scan
`d692182e-0a8e-4bfb-b398-19b2e2b1a62b` covered all 121 tracked files and seven
security surfaces at revision
`f19957bd585a4f34bb267ca54997287c3e65c828`. It completed with zero Critical,
High, Medium or Low findings. Token-usage measurement was unavailable from the
workbench. This is an internal automated review, not an external audit.

## Protocol and fee evidence

Both pool modes use one canonical pool per ordered pair, fee tier, privacy mode
and protocol version. The first LP may establish any non-zero initial price;
later LPs deposit proportionally, transfer only accepted maxima and do not
donate surplus. Canonical launchpad migration uses the same registry and cannot
create a creator-specific parallel market.

Approved immutable v1 total-fee tiers are 5, 30 and 100 bps. The total fee is
charged once from the input asset. One sixth of the integer-rounded fee accrues
to the protocol and five sixths remains with LPs. No additional native-COTI swap
fee exists. Public and confidential tests cover both directions, rounding,
tiny inputs, invariant preservation, fee exclusion from effective reserves,
partial and full exits, malicious callbacks, short-credit tokens and collection
only to the immutable vault.

Confidential swaps reject an input whose protocol share rounds to zero. The SDK
publishes the exact raw-unit threshold for each approved tier: 10,001 at 5 bps,
1,667 at 30 bps, and 501 at 100 bps. Funded runners validate this before RPC or
deployment work.

## Gasless quote investigation

The current runner deployed `MpcQuoteCallProbe` at
`0xB7b996D1Ea549b8692D4A2D7D1632639cfc366D9`. A transactional `SetPublic` plus
`Decrypt` control succeeded in transaction
`0x2074722fde98e391c1be10409949dc482060ea13d718dd6b44aec2ea4df35e92`
using 46,446 gas.

On the configured COTI testnet RPC:

- ciphertext-only storage reads succeeded under `eth_call`;
- `SetPublic` failed under `eth_call`;
- raw stored-ciphertext `OnBoard` returned failure and is the first isolated
  failing primitive;
- stored `OnBoard` plus offboarding, authenticated validation, addition,
  multiplication/division, compare/mux and both complete plaintext-input and
  encrypted-input CPMM quote paths all failed under `eth_call`;
- deployment-time encrypted constants did not help because they still require
  stored ciphertext onboarding.

Therefore the preferred stored-constant gasless design is technically specified
but not supported by the tested runtime. There is no separate gasless main quote
path. On the final deployment, the canonical paid best-quote router is the
preferred exact quote transport, while the paid per-pool
`requestQuoteExactInput` transaction remains a supported direct diagnostic and
compatibility path. Both require gas and inclusion, so neither is normal gasless
DEX quote UX. No public reserve, TVL, spot-price or TWAP state was added. The
complete privacy and active curve-probing analysis is in
`QUOTE_MARKET_DATA_REVIEW.md`.

## Confidential best execution

The lower-level feasibility deployment proved one router can validate a
caller-bound encrypted input, reuse the GT value across two contracts, compare
the encrypted outputs, offboard only the winner, and perform exact encrypted
escrow/allowance/settlement in the same transaction. On the final source, the
quote-only transaction used 1,728,873 gas and quote-plus-swap used 5,774,373
gas.

A fresh funded run of the production `ConfidentialBestExecutionRouter` then
passed against three canonical confidential fee tiers:

- confidential factory: `0x9c54438f6918d01A0707F371e30F0D549472a76d`
- best-execution router: `0x53C61928E7E01F39ACd7adEb0cC1b59EEA658034`
- 5 bps pool: `0xD42E81c3aD4b83dc2132B99d6ba5be7Ce0d79FE1`
- 30 bps pool: `0x5aA14b7B8BeC76F89fF2AdE29D4b27254481a48d`
- 100 bps pool: `0x0576886c4Dd458709169aB11b8bB4b72F2D5a14c`

The run covered absent and uninitialized tiers, encrypted-invalid candidate
isolation, request/ciphertext replay, deadline and caller binding, quote-only
pool-state immutability, both swap directions, every tier, encrypted slippage
rollback, exact escrow and allowance cleanup, and quote/settlement parity. Gas:

| Candidate count | Paid best quote | Quote plus swap |
| ---: | ---: | ---: |
| 2 | 16,873,051 | 29,531,211 |
| 3 | 25,248,305 | 38,237,605 |

The reverse three-candidate quote-plus-swap used 37,904,757 gas. The runner's
60M transaction cap is a safety ceiling; receipts above are actual gas charged.

These are disposable COTI testnet validation contracts, not the final canonical
deployment record. No key, ciphertext, private balance, quote or decrypted
amount was printed or persisted.

## COTI testnet scenario

Preflight passed for two funded LP identities and a separate quote identity
against two deployed COTI PrivateERC20-compatible assets. It validated chain
identity, native gas, code, decimals, AES binding and caller-local encrypted
balance recovery without logging keys, ciphertexts, balances or decrypted
values.

The fresh canonical scenario used:

- fee vault: `0x011009FF188C3E9BD75c7cEf35Cc1dA90d784158`
- private LP-token factory: `0x96E6A46235C5fc5dc7f8A50b7193Bc48F5415d08`
- confidential factory: `0x772aCbda00f9E1cC8C0aCE0cf2c1f9A30de166dc`
- primary 30-bps pool: `0x4304105Ec12E3c7e86045269B073f73af4bA07b6`
- 100-bps quote candidate: `0x92836192434277ee8aD8A74428354dF3A442b7EB`

The runner proved arbitrary-ratio initialization, proportional second-LP entry
without donation, canonical fee-tier discovery, two caller-encrypted quote
transactions, process-local best-pool selection, direct swaps in both
directions, replay/deadline/slippage rejection, premature fee-collection
rejection, second-LP exit, timed and permanent locks, and true full exit. Each
quote used 4,393,044 gas. The 100-bps pool produced the best output for the
tested amount and was selected without exposing the quote or reserve values.

## Launchpad migration

The final-source funded creator-held launchpad path used a disposable factory at
`0xa2dA12D44155933ed59e60bf1ed3BC69a1d819Ca`, migrator at
`0x07f240886b2FFcE5f47f281D00A8361e35dAC9EE` and canonical pool at
`0x808f55382e3eCA5aF6fdC37F51176529dc16E4D1`. An impossible-price probe reverted
atomically after 19,014,661 gas. The valid canonical migration used 21,895,615
gas, a replay probe reverted after 77,365 gas, and the true full exit used
10,239,767 gas. All disposable private balances and allowances were recovered
with zero pool residue.

Creator-held, timed-lock and permanent-lock dispositions remain covered by local
unit, property and integration tests. The funded recovery run intentionally uses
creator-held shares so it can prove complete recovery without creating an
irreversible testnet lock. Caller, domain, ciphertext-commitment, bounds,
disposition and replay mismatches are rejected before additional private-token
movement.

## Confidential fee collection

The disposable 100-bps quote-candidate pool reached eight protocol-fee-bearing
swaps in each direction. Its immutable collection window matured at Unix time
`1786842952` (2026-08-16 01:15:52 UTC); the delay was not shortened or bypassed.
The runner then completed a true full LP exit before collecting both encrypted
fee aggregates to the fixed vault:

- full LP exit:
  `0xb554ccbe3de2b5b97a2cb24bf999eb4a53af66bf8a1005c73a822d3c022d14cc`
  (3,638,851 gas)
- encrypted aggregate collection:
  `0x45ed14a5ac76c4e7a704292984ab61874f3a7400c55fca189ad6ba4536db0caa`
  (1,650,381 gas)

Both public batch counters were zero after collection. No confidential amount
was decrypted, returned or emitted.

## Compiler size and local gas

| Contract | Creation bytes | Runtime bytes | Local deployment gas |
| --- | ---: | ---: | ---: |
| `CipherDEXFeeVault` | 8,186 | 7,961 | 1,797,662 |
| `PrivateLPToken` | 12,976 | 11,453 | factory-created |
| `PrivateLPTokenFactory` | 13,636 | 13,609 | 2,991,908 |
| `ConfidentialCPMM` | 19,010 | 17,696 | factory-created |
| `ConfidentialCPMMFactory` | 24,360 | 23,706 | 5,286,752 |
| `ConfidentialBestExecutionRouter` | 7,773 | 7,347 | 1,672,947 |
| `ConfidentialLaunchpadMigrator` | 8,481 | 8,116 | 1,836,520 |
| `PublicCPMM` | 12,201 | 10,615 | factory-created |
| `PublicCPMMFactory` | 14,093 | 13,904 | 3,047,980 |
| `PublicCPMMQuoter` | 816 | 640 | 193,697 |
| `PublicCPMMRouter` | 3,162 | 2,974 | 719,995 |

The confidential factory pool-creation measurement was 6,252,309 gas and is
exercised separately from factory deployment. All runtime bytecode is below the
24,576-byte EIP-170 limit and all initcode is below the 49,152-byte EIP-3860
limit.

## Authoritative COTI testnet deployment

The clean source commit
`6f42ea6e8cfb4ace255abd75373769f74b9dec14` was deployed to COTI testnet
(`7082400`). The complete public manifest is
`deployments/coti-testnet-6f42ea6e8cfb4ace255abd75373769f74b9dec14.json`.
It records 12 unique successful deployment and one-time binding transactions,
their receipts and gas use, exact constructor or binding inputs, compiler
settings, runtime codehashes and the resulting immutable relationships.

| Component | Address |
| --- | --- |
| CipherDEX fee vault | `0x2C25eb4FA72140563d526494e7012d174d6ecb4f` |
| Confidential LP-token factory | `0xD136bBf345a37a19A723140d9CC4cE1dc6db0734` |
| Confidential CPMM factory | `0xEBDf156Df675A92Ba86A65d70305F032E2F81ce5` |
| Confidential best-execution router | `0x10ee264a6d79bA3cf626d6F2Dc5A8C402EF7FAe3` |
| Confidential launchpad migrator | `0x6fE3A527e1D6215b17a17EB04556FB18fBC4e5c2` |
| Public CPMM factory | `0x70Ec153a4bd491a3A14C84b9bccc80d70e410b52` |
| Public CPMM quoter | `0xdf27c70c8198c9fE119C47A28e6Ea6931386a44C` |
| Public CPMM router | `0x0DcAa92F7eb60B373c6D3970638B9A00136922E8` |

Post-deployment checks confirmed the confidential and public factory bindings
to the fixed fee vault, the confidential factory binding to the best-execution
router and launchpad migrator, and every deployed runtime against the fresh
reviewed artifact. The immutable fee-vault beneficiary is
`0x6214f0397e4351dCD0Ec6f3D13bC680Df7cFa4ff`. Historical addresses elsewhere in
this report remain disposable feasibility or regression evidence. The funded
end-to-end suite is recorded separately after this deployment manifest and
report are committed as evidence-only changes.

## Residual assumptions and remaining gates

- COTI MPC precompile semantics remain an external trust boundary and must be
  revalidated against every target runtime release.
- Approved private-token runtime codehashes must identify immutable reviewed
  implementations; mutable proxies and metamorphic code are not made safe by an
  allowlist.
- Permissionless canonical creation preserves custody but cannot guarantee
  launch liveness if another participant initializes the pair first.
- Confidential batching reduces routine per-swap disclosure but cannot prevent
  a beneficiary or colluding trader from isolating traffic in a quiet pool.
- The separate 24-hour fee-vault sweep remains an operational test because its
  real delay is intentionally not bypassed.
- Mainnet requires independent Solidity, economic and COTI MPC review, longer
  stateful/fuzz campaigns, and a reviewed multisig/governance beneficiary.

PoD, caller-supplied or unchecked routing, private multi-hop execution, public
confidential-pool analytics and legacy-liquidity migration are outside this
version.

## Release decision

This is a COTI testnet implementation, not an audited production release. It
must not be deployed to mainnet or marketed as anonymous: amount
confidentiality does not hide participant addresses, transaction timing or
active curve-probing and fee-differencing limits.
