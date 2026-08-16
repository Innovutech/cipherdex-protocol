# Verification Report

Date: 2026-08-16

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
- privacy-boundary check: passed for 25 Solidity files
- security-boundary check: passed
- TypeScript: passed
- clean compile and TypeChain generation: 17 Solidity files, 40 typings
- full local suite: 75 passing, 1 intentionally gated integration placeholder
- deployment gas measurement: passed
- `git diff --check`: passed before final evidence updates

No dependency or lockfile changed. Development-only advisories and lifecycle
script review are recorded in `DEPENDENCY_AUDIT_REPORT.md`; none is present in
the production dependency graph. No forced upgrade, override or advisory
suppression was used.

## Security review

The earlier repository scan's confirmed findings were mapped to and closed by
the current implementation: confidential price-race and arithmetic bounds,
safe full exits, LP burn authority, private-token implementation provenance,
exact token deltas, public negative-rebase handling, taxed fee collection,
public and confidential SDK provenance, quote-domain separation, funded-runner
provenance, and zero-accrual confidential dust.

Two independent read-only reviews of the final worktree found no confirmed
Solidity vulnerability. The SDK/script review found three integration issues,
all remediated and regression-tested:

- deployment now rejects a dirty Git worktree before network access and records
  every deployed runtime codehash with the exact source commit;
- confidential quote candidates must share the exact process-local `amountIn`,
  request ID, direction, factory, vault, pair and protocol domain;
- quote-probe credentials are shape-validated and scrubbed from error output.

The Codex Security workbench could not seal a final working-tree diff scan
because its launcher rejected the otherwise valid non-bare worktree as lacking
a resolvable `HEAD`. This is a tooling coverage gap, not a passing scan, and is
not hidden by the successful independent reviews.

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
`0x28EBb6a2cc593fb692bb5a9827D65F0e07D3C92D`. A transactional `SetPublic` plus
`Decrypt` control succeeded in transaction
`0x3bdf340c09ec95a6b637015c03fe43b270787e7113c0818d38df98208ad69b30`
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

Therefore the preferred gasless design is technically specified but not
supported by the tested runtime. The paid `requestQuoteExactInput` transaction
remains an explicit diagnostic/integration fallback, not acceptable normal
gasless DEX quote UX. No public reserve, TVL, spot-price or TWAP state was added.
The complete privacy and active curve-probing analysis is in
`QUOTE_MARKET_DATA_REVIEW.md`.

## COTI testnet scenario

Preflight passed for two funded LP identities and a separate quote identity
against two deployed COTI PrivateERC20-compatible assets. It validated chain
identity, native gas, code, decimals, AES binding and caller-local encrypted
balance recovery without logging keys, ciphertexts, balances or decrypted
values.

The fresh canonical scenario used:

- fee vault: `0x9842B39B89c7975Ef6d8EE65dCe27E443Bc1dBD5`
- private LP-token factory: `0x987bd06e276ACf5c4FB0C5D41F00286cb2c7B766`
- confidential factory: `0x756c2Aba39B731b6Dc59fcAa46884507914b8665`
- primary 30-bps pool: `0x44165c9dB80fEEBF41A06F2e22DEC008537cc512`
- 100-bps quote candidate: `0x07FB8742C35a7F6e7c7Bf0349d210bebdd58078d`

The runner proved arbitrary-ratio initialization, proportional second-LP entry
without donation, canonical fee-tier discovery, two caller-encrypted quote
transactions, process-local best-pool selection, direct swaps in both
directions, replay/deadline/slippage rejection, premature fee-collection
rejection, second-LP exit, timed and permanent locks, and true full exit. Each
quote used 4,393,044 gas. The 100-bps pool produced the best output for the
tested amount and was selected without exposing the quote or reserve values.

## Launchpad dispositions

All three launchpad LP dispositions completed in separate fresh deployments.
Each run first pre-funded the predicted CREATE2 pool by one raw unit per token,
proved that migration failed atomically without moving creator funds, removed
the test donation, then completed the authorized canonical migration:

| Disposition | Factory | Migrator | Pool | Gas |
| --- | --- | --- | --- | ---: |
| Creator-held | `0x2fBB3A7d8CB4726cBcdBF62c1aC23C6FE68CA2Cb` | `0xd8dcDAe8D5F9116EFc55Ded75c0056C1B8AE8f9a` | `0x905b20eA1633A2404CDe8A995bE49cF879DdC03E` | 21,340,020 |
| Timed lock | `0xaa3d1977bD62Ef6ccaB0555baEBa8bE709Ea3B8e` | `0x85d4B68ef815b85ad1aD0aa75776c99C8E3f855D` | `0xb327dFe5eDadC4Ed895Cd6208746ce41307C33d3` | 20,896,329 |
| Permanent lock | `0x2c47ec2ec62FF559fD02618691051b3AC1Cd8d90` | `0x0283f9102737a33A96072652bAC166F3C2C96f85` | `0x18288962D5028CCa202ee37574eD490ED17A80AE` | 20,896,255 |

Replay, caller, domain, ciphertext-commitment, bounds and disposition mismatches
were rejected without additional private-token movement.

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
| `CipherDEXFeeVault` | 1,917 | 1,714 | 447,550 |
| `PrivateLPToken` | 12,976 | 11,453 | factory-created |
| `PrivateLPTokenFactory` | 13,196 | 13,169 | 2,896,829 |
| `ConfidentialCPMM` | 15,922 | 14,671 | factory-created |
| `ConfidentialCPMMFactory` | 20,526 | 19,912 | 4,469,604 |
| `ConfidentialLaunchpadMigrator` | 8,488 | 8,123 | 1,838,032 |
| `PublicCPMM` | 11,757 | 10,164 | factory-created |
| `PublicCPMMFactory` | 13,649 | 13,460 | 2,951,737 |
| `PublicCPMMQuoter` | 816 | 640 | 193,697 |
| `PublicCPMMRouter` | 2,748 | 2,560 | 630,523 |

The confidential factory pool-creation measurement was 5,591,910 gas and is
exercised separately from factory deployment. All runtime bytecode is below the
24,576-byte EIP-170 limit and all initcode is below the 49,152-byte EIP-3860
limit.

## Authoritative COTI testnet deployment

The reviewed clean source commit
`206840f986162f02fadd29211fb0b5e39ce7a5b1` was deployed to COTI testnet
(`7082400`). The deployment script re-read that commit before network access,
recorded each observed runtime codehash and verified all immutable bindings after
confirmation. The sanitized machine-readable record is
`deployments/coti-testnet-latest.json`.

| Component | Address | Deployment transaction |
| --- | --- | --- |
| Fee vault | `0x28968cc36779Dfb5Fc49BFa7944279C193f39981` | `0x9c87db4eb337f88d9cfc6571a3fc6355b75664b0e98f1b1ca5c06f6a642f2086` |
| Private LP-token factory | `0x26e3c623ff29F09C2E1D7eec930292Cc31EC28E3` | `0x83a4fd8632007e9c9a07eeb72f9412790ee61eadcefe652728d38f7a29a0e1b5` |
| Confidential factory | `0x999dC50F453D00866e038A9465D59FebF46FaBbc` | `0x6efd9913dbb8bfea2d7415136a6be73546c0c061dc9d285b10364811e6479710` |
| Launchpad migrator | `0x00A48a4a334E994112f26f5037caE9541834583b` | `0x05bbd7c06ead1840be3339a8bab09321c42500dca91da10c28e98c9c0609fb75` |
| Public factory | `0x519AE4dCebFFC674306C818Dae7dD2aFE7453578` | `0x831570a1c17eb2bde236fdc63bfd357347ef76dd3dbc7d076a25fdb260b88f80` |
| Public quoter | `0x81107C379aFA15bCAf03017b08BD91E159029160` | `0x16eb188921e75d4d1633200ac934b9105d34fb07bfcfc84b67804a76277b774b` |
| Public router | `0x9021e12D41aB83eeAf6950eE8A62DC835A69802D` | `0xca9ca9711f776712f0054ad3a814a1299c3ad8421d83d3216f8ede3c68d24e12` |

The confidential factory bootstrap adapter was bound to the launchpad migrator
in transaction
`0xc3616675cc665369ee5ea83a0351162eef837cf76c008f594366f138db2f77d7`.
The fee vault's immutable beneficiary is
`0x6214f0397e4351dCD0Ec6f3D13bC680Df7cFa4ff`. This deployment created no pools,
onboarded no wallet, and moved no user or private-token assets.

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

PoD, a generic confidential router, private multi-hop execution, public
confidential-pool analytics and legacy-liquidity migration are outside this
version.

## Release decision

This is a COTI testnet implementation, not an audited production release. It
must not be deployed to mainnet or marketed as anonymous: amount
confidentiality does not hide participant addresses, transaction timing or
active curve-probing and fee-differencing limits.
