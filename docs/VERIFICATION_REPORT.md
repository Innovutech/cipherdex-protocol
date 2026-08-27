# Verification Report

Date: 2026-08-28

## Current COTI mainnet deployment

Source commit `b99c41abc031754990d4efcaaf1baa6754b3bb1e` was deployed as one
unified COTI mainnet (`2632500`) stack through the authenticated external
launcher. Its authoritative record is
`deployments/coti-mainnet-b99c41abc031754990d4efcaaf1baa6754b3bb1e.json`.
All 20 deployment and binding transactions are recorded as mined-success with
no uncertain broadcasts. The single fee vault has both factory slots consumed;
there is no remaining factory-configuration authority.

- fee vault: `0x81B9B4CDAcE3E4024F8792CEfDbFD281Fa20681f`
- immutable beneficiary: `0x3FEAa730727608Bb78a9B1b76fC7b85617317DAe`
- confidential LP-token factory: `0x8FbA3756f791a9f31EcfeAb5bD1394fc34C4DD89`
- confidential strategy registry: `0x736995b1B440aEa4BdCa62c6302484DBb08A0E33`
- confidential pool deployer: `0x5866ee30942B9CE87d5a5A18F8FC11fe8Ef3076e`
- confidential factory: `0xAF3Fb0A4f60C1b057C0c9cD8e563Df5F5b93ac03`
- confidential launch strategy: `0xeF11D8a5Af5eBFBd85C37948C78fB3bCedcF5433`
- launchpad migrator: `0x1BDdBF040fC06c42e0FBe1b52174611964A9909E`
- confidential best-execution router: `0x658feF87C5ACDfe57a37b7951695F4ef22137Bcc`
- public factory: `0x9c70596514De7C8DaF108f558E2d4a97E0C44E49`
- public LP-token factory: `0xf2AA9D05E5FF15525361450C53bd952F37200090`
- public quoter: `0x7f4226172D29D00Ff7c6aF0A6A15082864cA925C`
- public swap router: `0x026e969cE27Ae65c7609cD976FA8B646b684DbbE`
- public liquidity router: `0xea7129359a83538bC9Bba4f4Ec903A04F89B8a38`
- wrapped COTI: `0xE180548963Fc30329e15BC104d753f82a8C18865`
- public native router: `0x6165B5007a3CBFaE1c81EbAE09222CB5a85C225A`

Post-deployment RPC checks proved both vault bindings, zero public and
confidential pool counts, zero initial WCOTI supply, and the hardened WCOTI
self-transfer rejection selector. WCOTI burns before native callbacks; focused
tests prove valid nested withdrawal remains exactly backed and overdrawn
reentry rolls back atomically.

The records for source commits `03ee787585961b06033bb22421d720abc2e687ec`
and `b0d0ce87ac7a2cb72545a6d9ae2335a6e91cd9be` are superseded. Their five
public pools have zero shares/reserves, the temporary public factory has no
pools, and the one preceding confidential pool is uninitialized, so no position
or liquidity migration is required.

The public CPMM prices and mints against stored reserves. Positive external
balance deltas are fixed-vault surplus and cannot change pool price or LP share
ratios; losses reconcile protocol claims before LP reserves. There is no upward
reserve-sync method. Focused Codex Security scan
`d24c93db-210f-4e5b-9c9c-ef53c1a35e60` completed with zero findings.

Exact Cotiscan dry-runs passed for all 13 direct deployments. Their authenticated
Standard JSON inputs are retained under
`deployments/compiler-inputs/b99c41abc031754990d4efcaaf1baa6754b3bb1e/`.
No source has yet been submitted to Cotiscan.

This records deployment and on-chain binding evidence only. It is not a claim
of explorer source-code verification or external audit.

## Historical focused public testnet evidence

The same source commit was deployed to COTI testnet (`7082400`) through
`deployments/coti-testnet-public-b0d0ce87ac7a2cb72545a6d9ae2335a6e91cd9be.json`.
The record contains 24 mined-success transactions. Its focused mixed-decimal
WCOTI/6-decimal-token smoke passed pool creation and seeding, donation isolation,
fixed-vault surplus sweeping, proportional liquidity/refunds, both native swap
directions, both protocol-fee sides, fee collection and full zero-residue
cleanup. This is disposable test evidence, not a supported testnet release.

## Historical testnet status

This is retired historical evidence for disposable pre-v1 testnet iterations.
It is not a release record or a supported deployment manifest. Current source
uses one v1 protocol/schema identity without development compatibility layers.

This report tracks the complete-key and launch-protected confidential-pool
refactor. That preceding contract, SDK, runner and documentation source passed
the complete local verification cycle after its security remediations. Its
post-remediation diff scan and final full-repository Codex Security scan
completed with zero findings. The runner-only fee-recovery change, the testnet
factory-ABI fix, the launchpad deadline/revert-evidence hardening and the
deployment-evidence provenance handoff passed the complete local suite and
focused Codex Security diff reviews with zero findings.
Each executable change was correctly rejected by the preceding deployment's
source-provenance gate. All disposable resources from the intervening funded
runs were recovered. Source commit
`4f435f9cc96b41895604335d838287a60a25a3b3` then passed the feasibility and
expanded best-execution scenarios, including the reviewed nine-candidate quote,
and fully recovered every private and public test pool. Its final evidence step
failed closed because the factory-created disposable public pool had not been
represented as a reviewed nested artifact. No paid execution was repeated.
Source commit `1a50f192c467dbb36a1dacbe18661b94fea2a5d5` contains the final
evidence-classification and aggregate-publication fixes and has now been deployed
through a new commit-bound public manifest. Its deployment provenance and
immutable bindings are verified. Its funded feasibility, expanded best execution,
mature fee collection and launchpad migration all passed, and their sanitized
source-bound records were assembled into one passing suite record. Every
disposable private and public resource was recovered with zero residue. The
independent evidence verifier then passed from exact evidence commit
`3f89343976cd609b6f86eaa2952a0bf9f268376c`, sealing this deployment as the
current supported testnet integration surface.

The current source additionally removes the confidential factory's external-token
runtime-codehash admission list. Standard and launch-protected pool creation now
share one structural compatibility rule: deployed code, the official COTI
`IPrivateERC20` ERC-165 identifier, supported decimals and exact supplied/on-chain
decimal agreement. The factory constructor, SDK and deployment manifest schema
no longer carry external-token approvals. This policy change passed the focused
59-case factory/router/launchpad/SDK/provenance suite and the complete local test
suite. The protocol version remains 3 because pool identity, math and execution
ABI are unchanged; the separately published SDK package moves to 4.0.0 because
its verification-adapter method is intentionally renamed from approval to
compatibility semantics. Existing testnet factories still implement their
immutable historical admission policy and are disposable; no migration or
current-source deployment claim is made here.

Historical testnet addresses, transaction hashes and gas observations from
superseded pool identities are diagnostic only and are not evidence for this
source. This is a testnet implementation, not a mainnet-readiness or
external-audit claim.

## Environment

- Node: required `24.16.x`
- npm: required `11.13.x`
- Solidity: pinned local `solc@0.8.28`
- EVM target: Paris
- target chain: COTI mainnet (`2632500`); focused COTI testnet evidence is
  retained only as historical validation
- dependency policy: locked install, reviewed lifecycle scripts, no forced audit
  fixes or advisory suppression

No dependency was added for this refactor.

## Historical local evidence

- production dependency audit: passed with zero advisories at every severity
- production dependency graph: passed with no missing required dependency
- clean privacy-boundary build: passed, 32 Solidity compilation units and 46
  compiler-AST privacy checks
- normal Solidity compile and TypeChain generation: passed, 32 Solidity
  compilation units
- TypeScript: passed
- source-boundary lexer tests: passed
- supplemental security-boundary checks: passed
- full local suite: 257 passing, 1 intentionally gated funded-network
  integration placeholder; the Hardhat aggregate reported 258 Mocha cases
- focused admission-policy suite: 59 passing
- diff whitespace validation: passed

Fresh deployment gas was measured against the source-commit-bound testnet
manifest recorded below. Feasibility, best-execution, fee-collection and
launchpad evidence for that deployment passed and was aggregated into the public
suite record described below. Independent exact-commit verification also passed.

## Complete pool identity

Public pools retain one canonical pool per ordered pair and fee tier.
Confidential canonical uniqueness now applies to:

`ordered pair + fee tier + privacy mode + protocol version + initialization strategy`

`address(0)` identifies the ordinary standard pool. A reviewed nonzero strategy
identifies a launch-protected pool. Standard and protected pools can coexist for
the same pair and fee while duplicate complete keys remain impossible. Token
decimals are verified immutable metadata, not a caller-controlled namespace.

The confidential pool/factory protocol version is 3. The best-execution router
is version 2, the launchpad migrator is version 4, and the pool deployer,
strategy registry and launch strategy are version 1. Previous testnet versions
are disposable and unsupported by current discovery.

## Launch authorization boundary

The launch strategy is an initialization-only policy callable only by its
constructor-created, runtime-codehash-pinned migrator. A protected launch uses
one creator EIP-712 authorization over the launch ID, strategy, creator,
pair/decimals, fee tier, ordered encrypted migration inputs, deadline and LP
disposition. There is no fixed launch authority or persistent precommit.

The migrator verifies that signature before asking the strategy to prepare the
canonical protected pool inside the same transaction. It then performs exact
private escrow and allowances. The factory consumes the strategy's factory-only,
one-shot authorization in the same transaction as protected-pool bootstrap.
Failed migration rolls back launch state, pool creation, authorization
consumption, token pulls, allowances, LP state and pool state.
Each strategy owns a distinct pinned migrator/codehash binding. The obsolete
factory-global launch-adapter surface is absent, so a second reviewed strategy is
not forced through the first strategy's migrator. EOA and ERC-1271 creator
authorizations are accepted consistently by migration verification.

Failed or expired migration attempts leave no protected pool or active launch
record. A completed pool cannot be superseded or reinitialized.
The strategy receives no tokens and has no post-initialization swap callback,
fee, reserve, LP, lock, rescue or withdrawal authority.
A completed protected pool that later reaches a true full exit retains its
completed-initialization marker. Anyone may re-seed it through ordinary
liquidity addition, while the consumed strategy remains unable to bootstrap it
again.

## Routing boundary

The router accepts no candidate addresses. Its nine-bit namespace represents
the three approved fee tiers multiplied by standard class zero plus at most two
reviewed, finalized strategy classes. It rejects unknown bits. Paid quote calls
accept up to all nine slots; atomic swap calls reject more than three selected
candidates. Both derive every candidate through the factory's complete key,
verify canonical metadata, and skip absent or uninitialized variants.

Iteration is fee-first and class-second. Equal encrypted outputs retain the
first candidate, so the lower fee wins and standard wins within the same fee.
The default bitmap remains the three standard tiers. Candidate-aware calls let
integrators choose a bounded mix of reviewed standard/protected classes without
injecting contracts.

The final funded runner uses standard 5 bps, launch-protected 30 bps and
standard 100 bps candidates. It must prove that the signed protected launch is
initialized, selected after the deterministic tie phase, and settled through
the same escrow/allowance/parity boundary before the router is described as a
preferred integration path.

## Quote and privacy boundary

Confidential pools expose no public reserves, TVL, aggregate LP supply, spot
price, TWAP, depth ladder or plaintext quote. Swap amounts, liquidity amounts,
reserves, LP balances, slippage, price bounds, protocol-fee amounts, losing
route outputs and temporary escrow remain confidential under the documented
COTI model. Pool/participant identity, selected winner, fee tier, direction,
timing, gas and success/failure remain public.

The tested COTI runtime permits ciphertext storage reads under `eth_call` but
rejects fresh MPC execution at stored-ciphertext `OnBoard`, including the
deployment-time encrypted-constant design. Fresh funded evidence proves both
paid per-pool exact quoting and the paid bounded best-quote router. The router is
the preferred bounded integration path; direct pool quoting remains supported.
Neither is gasless, and retaining the direct paid quote is not evidence of a
separate gasless main path.

Exact permissionless quotes also permit active curve probing: encryption hides
the request/result from passive observers, but a caller can query and decrypt
its own deterministic outputs. The protocol therefore does not claim
information-theoretic reserve secrecy from an active funded quote operator.

The current deployed source extends paid quote-only selection from three to
the complete nine-slot canonical v1 namespace while retaining the three-candidate
atomic execution cap. Unit and invariant tests prove bitmap bounds, canonical
candidate derivation, deterministic grouping and quote/swap cap separation.
This checkpoint is not yet funded evidence that a nine-candidate request fits
the live COTI block limit. The funded gate must measure the exact deployed
artifact; the
SDK provides deterministic multi-request grouping with fresh ciphertext when a
larger set cannot fit.

The current deployed source also adds an atomic public create-or-add liquidity
router and a paid confidential proportional-liquidity preview. Local tests cover
atomic rollback, proportional refunds, zero router residue/allowance, both
private preview directions, rounding and tiny-input rejection. No document in
this report claims funded COTI execution for those new paths until a fresh
source-bound deployment and funded suite record it.

## Fee and LP parity

Approved immutable total-fee tiers remain 5, 30 and 100 bps. The fee is charged
once from the input asset. One sixth of the integer-rounded fee accrues to the
protocol and five sixths remains with LPs. There is no additional native-COTI
swap fee. Protocol fees remain outside effective reserves and confidential fees
retain encrypted batch collection and terminal full-exit deposit behavior.

Standard and protected pools use identical post-initialization swap, liquidity,
LP-share, lock, fee and privacy economics. The first launch liquidity may set an
arbitrary positive encrypted ratio; it is not forced to 1:1.

## Security review gate

The review sequence and current results are:

1. Initial full scan `b804b3dc-16e5-400d-9920-f0c882475129` reported seven
   candidates: one medium and six low. Independent discovery produced a
   duplicate of the decimal-binding issue; validation consolidated duplicates
   before remediation. The confirmed classes covered decimal binding on reused
   protected pools, ERC-1271 graduation parity, stale deployment authority and
   migration/evidence-runner assumptions. All were fixed and covered by focused
   tests.
2. Intermediate remediation diff scan
   `1718f2c2-7d3b-4075-b939-1214d577d2fc` identified four additional runner
   hardening issues: wallet/AES environment inheritance by Git helpers, ambient
   environment precedence over reviewed `.env` deployment policy, missing
   uncertain-broadcast recovery in the basic harness, and treating a receipt
   with unknown status as a definite failure. All were fixed and covered by
   focused tests.
3. Remediation diff scan `843cee30-3989-436a-b939-97df821f0c92` completed with
   zero findings. Its source snapshot digest is
   `codex-security-snapshot/v1:sha256:795b85fd0ee3d479a92c5fa946822fa51dede9d83e9bc9ad9d88c96b8e53990e`.
4. A later complete-tree scan `13cafad2-6eed-4e54-aaff-0d3a37bef752`
   identified seven additional issues: two high-severity mutable/lookalike
   strategy-router provenance boundaries; two medium-severity funded broadcast
   and terminal-recovery evidence gaps; and three low-severity public fee-claim,
   quote-capability and preflight-ordering defects. The reviewed runtime is now
   pinned exactly, every launch strategy creates its exact migrator in its own
   constructor, public claims reconcile external loss, quote capabilities remain
   mode-specific, preflight occurs before funded writes, transaction hashes are
   derived and journaled before RPC submission, and recovery requires exact
   mined cleanup plus live terminal-state proof.
5. The complete local verification cycle passed after those remediations. The
   latest cycle contains 199 passing tests and one intentionally gated funded
   integration placeholder.
6. Working-tree diff scan `dacf719a-9a9a-4417-8808-bf1678df60c9` reviewed all
   34 inventory rows across the 137-file change set and completed with zero
   reportable findings. Its source snapshot digest is
   `codex-security-snapshot/v1:sha256:a31b1563df3e62ed926b79db0b828cee3c7d76ff7ce98da08f6712469aaa1917`.
   That scan evaluated the now-superseded fixed launch-authority model. The
   current atomic creator-authorized design removes that authority and its
   namespace-occupation/liveness trust assumption.
7. Complete-tree scan `f07e531a-4c0e-4825-bed7-f29428632db8` reviewed all 149
   registered files and reported seven high-severity funded-runtime,
   filesystem, secret and RPC-reconciliation issues plus one medium-severity
   SDK parser issue. The funded launcher now authenticates an exact commit
   before install/build, creates a fresh owner-only runtime with a locked
   script-disabled install, rejects repository-local secrets and unsafe
   descendants/ACLs, publishes evidence atomically, retains uncertain
   transactions until canonical multi-confirmation evidence exists, and bounds
   every untrusted SDK evidence parser. Focused regression tests cover each
   remediation.
8. Post-remediation working-tree diff scan
   `fba17088-1c23-41e9-8a41-137c49265f90` reviewed all 45 authoritative changed
   source rows and completed with zero findings. Its source snapshot digest is
   `codex-security-snapshot/v1:sha256:1a11ddafb5bb3b79d1f6566b21a5464227265e607d24ec7d278c5a07b049f8e4`.
9. Final full-repository scan `e0adcfb7-bdf6-4e60-9538-bafc6d42cb30` reviewed
   all 154 registered files across eight security surfaces and completed with
   zero Critical, High, Medium or Low findings. Its source snapshot digest is
   `codex-security-snapshot/v1:sha256:5d7b4ea0a2bd0472a81e16a064e497c02a84f7593d118c0f20d6a94105edc0c5`.
   The scan used the parent fallback because delegated desktop workers had
   reproducibly exhausted local disk with multi-gigabyte session logs; full
   source coverage was retained. Token-usage measurement was unavailable from
   the scan workbench. No executable source change is permitted after this scan
   without repeating the appropriate scan.
10. Focused working-tree diff scan
    `3b7afb72-60e4-4156-a844-de92411348db` reviewed the three-file launcher
    compatibility patch that binds Git `safe.directory` to the exact canonical
    repository path for the launcher process. It completed with full coverage
    and zero findings. Its source snapshot digest is
    `codex-security-snapshot/v1:sha256:e19616d3ecdab145bf316e659411074a03a122829ecd8836c30daf92304ecdac`.
    Global/system Git configuration, hooks, fsmonitor, replacement objects,
    prompts and wildcard directory trust remain disabled.
11. Follow-up focused diff scan `3476067b-218f-4b4a-9729-09fff8430d63`
    reviewed the Git-for-Windows separator normalization required for that exact
    canonical path. It covered all three changed files and completed with zero
    findings. Its source snapshot digest is
    `codex-security-snapshot/v1:sha256:0281900efde9be8a4e3650184f632326ca85e6e34dd8db23e905ff08b8919472`.
    An elevated sanitized reproduction confirmed that the backslash form is
    rejected by Git ownership validation and the slash-normalized form resolves
    the reviewed commit without broadening the trusted directory.
12. Focused diff scan `32d0907d-d063-404a-9fc5-10da6a58692e` reviewed the
    authenticated Hardhat 3 CLI resolver and both funded launcher stages. It
    covered all five changed files and completed with zero findings. Its source
    snapshot digest is
    `codex-security-snapshot/v1:sha256:95e77922d94f738343df6d42cdb3623f75c3b2b5d46095d6bec8680fbcc7c3f9`.
    The resolver reads the pinned package's exported manifest, rejects linked or
    non-regular manifest/CLI files, and requires the real CLI path to remain
    inside the authenticated Hardhat package.
13. Focused diff scan `9bf7562b-54d0-499f-9d66-2789c9e980a0` reviewed the
    explicit reviewed-build receipt-root handoff between the launcher and
    private runner. It completed with full changed-source coverage and zero
    findings. Its source snapshot digest is
    `codex-security-snapshot/v1:sha256:f34a4066fdf3fa9c636051e4bccb4bffd0ad1e15d67debd7ca9f1c9facbedafe`.
    The runner requires the canonical receipt directory to be a strict private
    runtime subdirectory and uses that explicit root for both pre- and
    post-execution build verification. The targeted 32-case funded recovery
    suite passed.
14. Focused diff scan `47d6c28a-5469-4286-b662-b297631635a8` reviewed the
    final receipt-journal placement at the dedicated private-runtime Git
    metadata path `.git/cipherdex-receipts`. It covered all three changed files
    and completed with zero findings. Its source snapshot digest is
    `codex-security-snapshot/v1:sha256:3ccd9478eca963005fd66c826f46a80bb190e1a586020a1728c66959ecb892d1`.
    The location remains inside the owner-only authenticated runtime and the
    runner's strict containment boundary, does not overlap Git configuration,
    hooks, refs, objects, replacement objects or index state, and leaves the
    reviewed source worktree clean after receipt writes.
15. Focused diff scan `7c0f5a69-aea6-48d6-9b6d-b94fad6d33b0` reviewed the
    compiler-setting alignment for the strategy-created launchpad migrator and
    completed with zero findings. Its source snapshot digest is
    `codex-security-snapshot/v1:sha256:a607147f077aca14ec79bc126aac88de4451588df4e763e0e7a7de9be01f3d30`.
    A funded deployment exposed that Hardhat had compiled the migrator with
    optimizer runs 203 as a standalone artifact but runs 1 when embedded in the
    launch strategy's constructor. Both jobs now use runs 1 and produce the same
    12,330-byte runtime with 26 immutable references. A regression test deploys
    the real constructor child and verifies its exact normalized runtime and
    compiler provenance. The complete verifier passed with zero production or
    operational advisories and 201 passing tests; one funded integration test
    remains intentionally gated.
16. Focused diff scan `a522af2b-55de-4ccd-a28f-30b39dd4a5b3` reviewed the
    durable funded-recovery refactor, including the owner-only recovery root,
    authenticated launcher handoff and fail-closed runner validation. It
    completed with full changed-source coverage and zero findings.
17. Final full-repository scan `e9fb1ef7-1f7f-4e7c-912c-b3179b358a45`
    reviewed the complete repository across eight security surfaces and
    completed with zero Critical, High, Medium or Low findings. The subsequent
    two-line launcher-marker handoff changed no contract or protocol source and
    was covered by a static source-boundary regression plus the complete local
    verification cycle: zero production or operational advisories, 29 Solidity
    files compiled, 202 passing tests and one intentionally gated funded test.
18. Focused working-tree diff scan `510640ff-1446-4163-8c58-0e555042fdad`
    reviewed the shared feasibility transaction-label fix across the funded
    runner, evidence policy and directly related regression test. Exact status,
    selector, canonical artifact target, calldata, event, ordering and live-state
    checks remain mandatory. The scan completed with full coverage and zero
    findings. The complete verifier then passed with zero advisories, 29
    Solidity files compiled, 203 passing tests and one intentionally gated
    funded test.
19. Focused working-tree diff scan `d055a5e6-32ec-4606-812d-5c555d7b7a34`
    reviewed the contextual runtime-artifact resolver, its source-boundary
    enforcement and the real factory-created pool regression. It completed with
    full changed-source coverage and zero findings. The verifier fails closed on
    missing or ambiguous child outputs, retains exact runtime-length and
    immutable-normalized byte equality, and records compiler provenance from the
    `ConfidentialCPMMDeployer` optimizer-runs-1 build that actually embeds the
    pool creation code. The complete verifier passed with zero production or
    operational advisories, 29 Solidity files compiled, 204 passing tests and
    one intentionally gated funded test.
20. Focused working-tree diff scan `09bd275d-cd16-47a0-bbdc-f9cdf1d012f1`
    reviewed the launchpad funded runner's chain-derived deadline, minimum live
    submission window and exact mined-revert proof. Historical replay is bound
    to the exact mined transaction and pre-transaction block, extracts only
    known own-data error fields and fails closed when the transaction, archive
    state or expected custom-error selector is unavailable. The scan completed
    with full changed-source coverage and zero findings. The complete verifier
    then passed with zero production or operational advisories, 29 Solidity
    files compiled, 208 passing tests and one intentionally gated funded test.
21. Focused working-tree diff scan `cbca3b2f-ced7-4b4e-89a6-80302427f93f`
    reviewed the funded quote-call runner's deployment-evidence provenance
    handoff. The runner now authenticates the clean evidence HEAD while binding
    its journal and public evidence to the immutable deployment-source commit
    recorded by the tracked manifest. Static source/security checks reject the
    former circular requirement that the post-deployment evidence HEAD equal
    the pre-deployment source commit. The scan covered all three changed files
    and the supporting provenance boundary with zero findings. The complete
    verifier passed with zero production or operational advisories, 29 Solidity
    files compiled, 208 passing tests and one intentionally gated funded test.
22. Pre-publication full-repository scan
    `cf3b2338-0822-4c47-992f-ae6135168e75` reviewed commit
    `0130124510de657224015bb6d87d2f00c4152ff3` across all eight security
    surfaces and completed with zero Critical, High, Medium or Low findings.
    The scan covered 169 registered files, including the complete public and
    confidential accounting paths, canonical factories, best execution,
    launch migration, fee custody, SDK, deployment provenance and funded
    recovery/evidence boundary. The parent-only review requirement was retained;
    no delegated workers or private operator material were used.

Funded execution is available only through an externally installed,
operator-owned launcher. It authenticates the exact reviewed Git commit before
loading runtime secrets, performs a locked `npm ci --ignore-scripts` and
secretless compilation in a fresh owner-only private runtime, records source,
lockfile, full dependency-tree, artifact and generated-type hashes, and refuses
repository-local, linked or oversized funded environment files. The private
funded runner verifies that receipt and executes Hardhat with `--no-compile`.
Repository-wide and
signer/chain leases coordinate every funded runner, while a signer-global durable
transaction record prevents nonce reuse and requires receipt reconciliation for
every nonterminal hash. Funded transactions, including deployments and binding
calls, are populated and signed locally and persisted before RPC submission.
Private-token allowances are durable recovery obligations that must be verified
zero before public evidence can finalize. Indeterminate submissions permit only
receipt reconciliation or identical-payload rebroadcast; they never trigger a
blind re-sign. Public evidence excludes signed payloads and requires mined
cleanup provenance plus live terminal-state proof.

Codex Security is an internal automated review, not an external audit.

## Fresh testnet evidence gate

After reviewed source is committed, the deployment must publish a
source-commit-bound manifest containing the fee vault, private LP factory, pool
deployer and codehash, finalized strategy registry and codehash, registered
launch strategy and codehash, launchpad migrator, confidential factory,
best-execution router, versions, constructor inputs, binding transactions and
runtime hashes.

Funded evidence must then cover preflight, direct pool behavior, launch
migration, mixed standard/protected best execution, protocol-fee collection,
recovery and final evidence verification. Only public addresses, transaction
hashes, block provenance, gas and assertions may be persisted. Keys, AES keys,
ciphertexts, encrypted-input signatures, private balances, quotes and decrypted
values must not be printed or stored. The evidence record's EIP-191 attestation
signature is public integrity metadata over the sanitized record, not a private
operation signature or secret.

The most recently completed funded scenario suite is recorded below. Historical
deployment narratives are retained only to explain superseded testnet artifacts;
they are not the supported integration surface.

### Current supported exact-source deployment with verified funded suite

Source commit `1a50f192c467dbb36a1dacbe18661b94fea2a5d5` was deployed to
COTI testnet chain `7082400` through the authenticated exact-commit launcher.
The complete 18-transaction deployment and binding record is
`deployments/coti-testnet-1a50f192c467dbb36a1dacbe18661b94fea2a5d5.json`.
All transactions succeeded, consumed `24726981` gas in total, and the deployment
runner independently verified creation bytecode, constructor inputs, runtime
codehashes and every immutable post-deployment relationship. Deployment created
no pools and moved no private token.

- Fee vault: `0xD1A9Bc0FC7f0a9c71b59E03B7Ed3a65efe2D1286`.
- Private LP-token factory: `0x63433743022cceAa08D9B3DbC231360838691E78`.
- Initialization-strategy registry:
  `0x7E2108643DabC120Bd7e7DE9161e641253faf9c6`.
- Confidential pool deployer:
  `0x8E3241d8468172d8f56BC25E6c979B58E2D76c64`.
- Confidential factory: `0x55453D844E7f74D1D48AD554D366B82c92bb3aD6`.
- Launch initialization strategy:
  `0xD84E92629aC30c5D4938c5202439F2c6a54A4a5a`.
- Launchpad migrator: `0xeCa8F62C316f2f5755d326b70f3AF22EbFfd43A4`.
- Confidential best-execution router:
  `0x142633bE930d7c720e221BF5bf26F328896ECCf8`.
- Public factory: `0x2f01e4f6ee208DcAc8e05f3919Cb0963e63A6B2b`.
- Public quoter: `0x7C99086504890A532Cd4Fbb449D17c6FeE19CcE5`.
- Public swap router: `0xFE9D53204E9a584E8c7A2A7127996d3a31FaC55a`.
- Public liquidity router: `0x1e264A771bfb0A5bF46FBE69A922586031A85B3D`.

This deployment contains the reviewed `90000000` funded quote envelope while
retaining the protocol and SDK limits of nine quote-only candidates and three
atomic candidates. The complete funded suite was run from evidence commit
`237075540431e421d8ab803b3ac9e645f55e4f09` and assembled at
`evidence/coti-testnet-1a50f192c467dbb36a1dacbe18661b94fea2a5d5.json` with
outcome `passed`. Its four EIP-191-attested scenario records contain 186 reviewed
transaction outcomes in total and bind the same source commit, chain, owner and
deployment manifest.

The feasibility gate privately selected a winning encrypted output, executed the
selected pool atomically, cleared temporary allowances and closed all three
disposable probes. Expanded best execution exercised standard and
launch-protected pools at every v1 fee tier, both directions, deterministic
tie-breaking, invalid and uninitialized candidate isolation, replay/caller/
deadline guards and quote/settlement parity. Populated four-, six- and
nine-candidate quote requests succeeded; the nine-candidate quote consumed
`75450787` gas under the reviewed envelope. Confidential proportional-liquidity
preview consumed `4931739` and `4931746` gas by direction, and its preview-bound
settlement consumed `17622993` gas. Public atomic create-and-seed rollback,
successful creation, proportional refund and full exit also passed.

The fee runner accrued eight swaps per input token, proved collection failed
before the immutable maturity time, resumed the same journaled pool after
maturity, deposited both encrypted aggregates into the fixed vault, then proved
that a new sub-threshold fee was deposited during full LP exit rather than paid
to LPs or stranded. The launchpad runner proved failed price bounds roll back,
creator-authorized migration initializes atomically, replay is rejected, direct
private quote/swap and partial/full exits work, and a fully exited protected pool
can be permissionlessly re-seeded. Both runners finished with zero pool residue
and cleared owner allowances. The independent verifier ran from commit
`3f89343976cd609b6f86eaa2952a0bf9f268376c`, recompiled the exact 32-unit
Solidity source, revalidated the live deployment relationship and accepted the
complete aggregate evidence record with exit code zero.

### Previous exact-source deployment with complete execution but failed evidence

Source commit `2f95de47324dab936a8bafbd6e5419b24c6571c6` was deployed through
the authenticated launcher and recorded at
`deployments/coti-testnet-2f95de47324dab936a8bafbd6e5419b24c6571c6.json`.
Its feasibility, expanded best-execution, mature fee-collection and launchpad
scenarios all completed on-chain. The nine-candidate private quote used
`75450799` gas under the reviewed `90000000` envelope. Both confidential fee
batches matured and were collected, the terminal sub-threshold fee was deposited
on full exit, and every disposable private and public pool was fully recovered.

Final evidence failed closed because five protected-pool migration bindings were
classified under the launchpad runner instead of best execution. Transaction-free
rematerialization then proved the paid journals were complete, but aggregate
publication exposed a separate disposable-runtime output-boundary defect. Commits
`4348267a7bd86ddab66070747cedb472127594af` and
`1a50f192c467dbb36a1dacbe18661b94fea2a5d5` correct those evidence-only
boundaries and add regression coverage. The source-provenance gate correctly
rejected using modified executable evidence code with the old deployment, so the
paid operations were not presented as final evidence and the current fresh
exact-source deployment was required.

### Previous exact-source deployment with completed paid scenarios

Source commit `4f435f9cc96b41895604335d838287a60a25a3b3` was deployed through
the exact-commit launcher and recorded at
`deployments/coti-testnet-4f435f9cc96b41895604335d838287a60a25a3b3.json`.
Its deployment used `24726933` gas and passed immutable-binding verification.
The source-bound feasibility run passed. The expanded best-execution run then
passed two- and three-candidate quote and settlement, four-, six- and
nine-candidate quote selection, confidential proportional-liquidity preview and
settlement, and public atomic creation plus proportional liquidity. The
nine-candidate quote used `75450799` gas under the reviewed `90000000` envelope
and the COTI testnet block limit. Every confidential test pool was fully exited,
and the disposable public pool was fully cleaned.

The final public-evidence generator subsequently rejected the public cleanup
transaction because that factory-created pool was not included in its reviewed
nested-artifact set. This was an evidence-model defect, not a failed on-chain
cleanup. The runner correctly refused to repeat paid execution. Commit
`2f95de47324dab936a8bafbd6e5419b24c6571c6` adds the event-bound disposable
public pool artifact and exact cleanup selector/target checks; a fresh
exact-source deployment and full suite are required for promotion.

### Previous exact-source deployment with exhausted runner envelope

Source commit `019769db8b994d84971769435d1d4a35158b3621` was deployed to
COTI testnet chain `7082400` through the authenticated exact-commit launcher.
The complete 18-transaction deployment and binding record is
`deployments/coti-testnet-019769db8b994d84971769435d1d4a35158b3621.json`.
All transactions succeeded, consumed `24726981` gas in total, and the deployment
runner independently verified creation bytecode, constructor inputs, runtime
codehashes and every immutable post-deployment relationship. Deployment created
no pools and moved no private token.

- Fee vault: `0x807020279AEd4341fFEDf19cE3Bcc1309c85d1A9`.
- Private LP-token factory: `0xb0Af1314bbb9da6B7AAb3Fc2F5C2a3070bd2BE76`.
- Initialization-strategy registry:
  `0xFcF41423F9730604c571c8A4A4E98A2D79863017`.
- Confidential pool deployer:
  `0x6a05E4113E141757533E38547166e6bfc8E49609`.
- Confidential factory: `0x5Ed6BEE456Ea0E57CBC3577ae6eaAEf78C91b6f1`.
- Launch initialization strategy:
  `0xCFaefBA480391B8f1326eceA5031e710520c4Ba3`.
- Launchpad migrator: `0x0Bfd5b61CBc7c2D031bEb2b08EDe9Efca432B966`.
- Confidential best-execution router:
  `0x500EE697Cb4b12723D4A67c0373Bb0b9224E14aa`.
- Public factory: `0xA7176ffef4fE29f7DB32A5A6727C66DFb7d7bBD7`.
- Public quoter: `0x662c96Ecb88C963AEBba07DA94B9C3Af991Bae8d`.
- Public swap router: `0xBd3d92DCb954bcc379C453AE92a435DD8E6221cd`.
- Public liquidity router: `0x00a96F796E665f88D14Bb81216b7dF979801FD59`.

Promotion requires the complete source-bound funded suite and final independent
evidence verification described above.

The source-bound feasibility gate passed against this deployment. Quote-only
transaction
`0x7464711b58616868c1bdeb105f4afae04d72c812aaeaceb22cf65e66447fea3d`
used `1728873` gas and quote-plus-swap transaction
`0x81adfc655b76272bd33731fe4d81b77731c3681d06b2383db376290c66de8cf2`
used `5774409` gas; all three disposable probe contracts were permanently closed
and every private asset was recovered.

The expanded funded runner then passed the standard and launch-protected 5, 30
and 100 bps lifecycle, absent/uninitialized/invalid candidate isolation,
request/deadline/caller binding, both swap directions, deterministic selection,
three-candidate settlement, and populated four- and six-candidate quote-only
calls. Four candidates used `33696881` gas and six used `50439672` gas. The
nine-candidate quote transaction
`0x4248a80978bae233168e0a1a7ad7af63c07b67c6462b685b2f5e8786d3a73657`
mined with failure after consuming `59976156` gas, proving exhaustion of the
runner's former `60000000` envelope. Its containing block exposed a
`120000000` gas limit. All nine disposable pools were subsequently closed with
address-scoped cleanup identities; the journal reached zero active resources
and zero active allowance obligations without an unknown transaction outcome.

The next source raises only the funded runner's reviewed envelope to
`90000000`, retaining 30M block headroom. Contract and SDK limits remain nine
quote-only candidates and three atomic candidates. Because the runner is an
executable provenance path and this run is terminal, a fresh exact-source
deployment and complete funded suite are required rather than replaying the
failed operation.

### Recovered source-bound deployment with failed funded gate

Corrected source commit `cac3da94bfa4a2bcfd7b0c8548f4f8768bdde635`
was deployed to COTI testnet chain `7082400` through the authenticated
exact-commit launcher. The complete 18-transaction deployment and binding
record is
`deployments/coti-testnet-cac3da94bfa4a2bcfd7b0c8548f4f8768bdde635.json`.
All transactions succeeded, consumed `24726981` gas in total, and the deployment
runner independently verified creation bytecode, constructor inputs, runtime
codehashes and every immutable post-deployment relationship. Deployment created
no pools and moved no private token.

- Fee vault: `0xb91863568b7A382BC0C3FB0258b43A5ce78bC81c`.
- Private LP-token factory: `0x15f9F35D99d79BE63bD8ec1DBd2727171fCa056E`.
- Initialization-strategy registry:
  `0x22f8aA7dE6E847E4D271E2AD283db7F921C4ab70`.
- Confidential pool deployer:
  `0x5d8c6E2e3b87B11f8aC03497a99731cf3aEFb561`.
- Confidential factory: `0x7e272f110fD896FA0b10E1F344a1A5b8344f03eD`.
- Launch initialization strategy:
  `0xB00FccC058B6298D07399238Ac53319f29e0E2b0`.
- Launchpad migrator: `0x295a51E5a6EFc0201916b8aFA196F33aE3C356F3`.
- Confidential best-execution router:
  `0xe1f7821E8e597710d687461525f34CF9dcaf18F5`.
- Public factory: `0x74b420518dAfee25E01c9ee7A0169E2E6190551d`.
- Public quoter: `0x147CD1436AAf5292B1fa22131Bc28560E0c1C49f`.
- Public swap router: `0x5D54F9eFcdF0d94656AF677096C746efa2E66584`.
- Public liquidity router: `0xa7fb97D53e51De5aA2e5AC93c82EB86142Ffbd0E`.

This deployment crossed the runner point that failed for the preceding source:
the disposable strategy and public-token operations now use distinct durable
identities. Promotion still requires the complete source-bound funded suite and
final independent evidence verification described above.

The expanded funded best-execution run then exercised the standard and
launch-protected 5, 30 and 100 bps candidates, absent and uninitialized
candidate skipping, request replay/deadline/caller isolation, two- and
three-candidate quote-and-swap selection, deterministic tie-breaking, invalid
encrypted-candidate isolation and reverse-direction routing. The measured
three-candidate quote consumed `25291008` gas, while the corresponding
quote-and-swap consumed `38282486` gas. The run stopped before broadcast when a
second protected-pool token approval reused the first protected pool's durable
logical-operation label. No unknown transaction hash was produced.

An exact-source recovery rerun first closed three active disposable pools. The
sanitized diagnostic retained the transaction prefixes `0xfbe217`, `0x441810`
and `0xfe727c`, with respective gas use of `11809855`, `11889855` and
`13447967`; the durable authenticated journal, rather than these prefixes, is
the recovery authority.
Recovery then stopped before its next broadcast because the cleanup operation
label had the same fee-tier-only identity defect. Source commit
`019769db8b994d84971769435d1d4a35158b3621` binds pool approvals and cleanup
operations to the complete disposable-resource identity, classifies duplicate
operation identities as definite pre-broadcast failures, and adds an
authenticated cleanup-only path that may open the original journal only when
its supplied recovery source commit exactly matches this deployment manifest.

That cleanup-only path subsequently closed the remaining disposable pools
through transactions
`0x6b1f60612707128c8eb0ffecff75a9f3748fda9a2c0d2693928b4531646175f7`
(`10241274` gas),
`0x7ac0f5b0a3fc7b27516e5c4b737fc219766db49bcd03e66e0ca7dda907e0f496`
(`10241322` gas), and
`0x2ca9b0e3c0bcf29e8ea28d33e2e3f4e5923af8e483ab99e2b4bf58e484c13a49`
(`10241346` gas). The authenticated journal reached zero active resources and
zero allowance obligations and was terminalized without an unknown transaction
outcome. A fresh source-bound deployment and funded promotion are still
required for commit `019769db8b994d84971769435d1d4a35158b3621`.

### Superseded source-bound deployment with failed funded gate

Source commit `900c4449cc6cb880faf08b6576fc3306fc0d6d22` was deployed to COTI
testnet chain `7082400` through the authenticated exact-commit launcher. The
complete 18-transaction deployment and binding record is
`deployments/coti-testnet-900c4449cc6cb880faf08b6576fc3306fc0d6d22.json`.
All transactions succeeded, consumed `24726981` gas in total, and the deployment
runner independently verified creation bytecode, constructor inputs, runtime
codehashes and every immutable post-deployment relationship. Deployment created
no pools and moved no private token.

- Fee vault: `0x2daDb58b61f852E4e7cea65Cb723E6E6F252633e`.
- Private LP-token factory: `0xE993ea49763791D05982301C599463c0b969E918`.
- Initialization-strategy registry:
  `0xA5601352Fb881eD85A95Acf16cf66869C75fB37A`.
- Confidential pool deployer:
  `0xf09D0E114D1Fd51dB4931b70E189de9BFC4683df`.
- Confidential factory: `0x8B739C73bBaDa7b524b8C9A26D5c08b1FF9d3931`.
- Launch initialization strategy:
  `0xc8A8C78705A60ee1FBCd960F98EA5b65BF44111a`.
- Launchpad migrator: `0x569fC6aFf505FDE23190c0773123dCE7aFECeE05`.
- Confidential best-execution router:
  `0x2462ea6116B59386dC6a64ACFcBEFE846fb9D128`.
- Public factory: `0x6C1689d90E1A4B15914849c8e0c4FecaC5E1f7c9`.
- Public quoter: `0x49F00241036F77ec1D3fac4f6C7F1D44C3299D47`.
- Public swap router: `0x6e9e958108D84343E8d74923ADf2CadAcac7FCA6`.
- Public liquidity router: `0xafa67648dF56A7B87493cDA6De58D018f226CBBE`.

The feasibility runner passed with exact private-asset recovery, and the
configured-token compatibility branch passed with full pool cleanup. The full
best-execution runner then stopped before pool creation, private-token approval
or private-token movement: its first disposable launch strategy deployed, while
the second strategy correctly failed closed because both deployments had the
same durable logical-operation label. The source now gives both strategy
deployments and both disposable public token deployments unique reviewed labels,
with a mandatory static regression guard. Because that is an executable source
change, this deployment is diagnostic and cannot be retried or promoted as the
supported integration surface. A new exact-source deployment and complete
funded suite are required.

### Fresh COTI testnet deployment

Source commit `e7be24fa6b53fc1181b2c87440a47b2c6dafda57` is the supported
COTI testnet deployment for the permissionless private-token compatibility
model. The complete 17-transaction deployment and binding record is
`deployments/coti-testnet-e7be24fa6b53fc1181b2c87440a47b2c6dafda57.json`.
All transactions succeeded and consumed `23448875` gas in total. The
confidential factory constructor has six arguments and the manifest contains
neither `reviewedPrivateTokens` nor `approvedPrivateTokenCodehashes`.

- Fee vault: `0x742be5fa9A518760b7147632324e6A07c78CB7A1`.
- Private LP-token factory: `0x85cd7727867ceA45216d3a4Cc3551CaC08b18fcb`.
- Initialization-strategy registry:
  `0xD6d6C03B9B7B6156FdD51654A462c19FFC971230`.
- Confidential pool deployer:
  `0x056678e7cE7D175C6D5728f486D7987c43243703`.
- Confidential factory: `0xE5BF8a12D922589819eFE6bc7f80926Dea9b7434`.
- Launch initialization strategy:
  `0x1d964b2aB2548BE27872737184a5382D0F78aD79`.
- Launchpad migrator: `0xbfD4983c13746275e7C2B1665df957cBC9c8184A`.
- Confidential best-execution router:
  `0x93775fc40311E655E386D04Fbb73D4304923e386`.
- Public factory: `0xc5666f11Edc2d90D4DD8D7f880F3Fee1D7AE3a92`.
- Public quoter: `0x236c94020d4EF4fCcB17B8d4273B612197F885Ff`.
- Public router: `0xEC239e7447F1840CfCCBbB7dc0cD6873A3346Edf`.

The two EIP-191-attested sanitized funded records are published together at
`evidence/coti-testnet-e7be24fa6b53fc1181b2c87440a47b2c6dafda57.json`
(SHA-256 `2592828f07b77f10f1312db2ccc04de20b4ba1b9b445d339ba48b9d1efe97c0c`).
The records contain no private keys, AES keys, ciphertexts, signed transaction
payloads, private balances or decrypted values.

The configured compatibility record proves the old p.COTI reference runtime
codehash `0xcd4b4b3329cd64190c49fdfbe7feb3b2a81cfcb50c36f50d4d603c76906589b2`
alongside distinct, previously unknown p.gCOTI and p.WETH runtime codehashes
`0xc20a798d468089168d3a741d9ebd87877c86200c66615fa2232bbaee8caa115e`
and `0x4d0e1851f5ad83578a9b502ea2adc88f9a96fe3ab4bccf92a94befa97d458ec9`.
Structural compatibility and canonical pool creation succeeded without token
registration or bytecode approval. Principal transactions were:

- Canonical 30 bps pool creation:
  `0xf65bec3a66133f2466f1cb70fd1ec32e0643846807800d01ba86cdb41e4a1655`.
- Arbitrary-ratio initialization:
  `0xcba6a6da451f8e85a25acd44f022e1e5887cdc0d5f901d5281ec33fb1155b716`.
- Configured router quote:
  `0x88d3f1e519cf4f70e0d5219f54732ec1003345a8880512fec7903570fa4c63b0`.
- Atomic best swap:
  `0xb22376e797e206687d7d39edd9ea4dca1e2950782c6c0d2eac6c6f613d20ce4a`.
- Full cleanup exit:
  `0xee86e4f57c05eebd7d68f3b984cd2a95c7f8c05270aafca3dcc0c792aab7d900`.

The configured launchpad record uses the same two unregistered differing
runtimes and proves commitment, protected-pool creation, atomic graduation,
private quote/swap, partial/full LP disposition, ordinary re-seeding after a
full exit, replay rejection and final cleanup. Principal transactions were:

- Launch commitment:
  `0x4db6efceb710b4c64b5a3701d99c2c47100b7279a4591dc67938bf334e55ac93`.
- Atomic migration:
  `0x7a27c5ce990138213d8682dab210fc5e4ab09c56eed3caba315551163d89bbe8`.
- Direct private quote and swap:
  `0x6676047009b05ce1ba8c536cff99a34ec7e8e33568aaeb921f6f35c5f34380f6`
  and `0xa13da4c8a939ac0c44169081c8855e75f32470bdb42eff26da2fc685c433fdf8`.
- Partial and first full exits:
  `0xd2102f5e037517f61a86c91de3f1dc8ac06cc22bdc674dc11ee6a701425a0468`
  and `0x23f9c4e86eb42ed72cebed25b0911defd3da865aad0081949101620be2622f48`.
- Ordinary re-seed and terminal full exit:
  `0x5e4b9b7e6fdad34758d0f5fa25ee526de54e29bc94f4e35ab7d86f117e4f53b1`
  and `0x6169ba60cfd536c99f8338bb15c398b321877b175ffa55877ea294417d11f8f3`.

Both records enforce a maximum funded amount of ten balance basis points,
prove exact balance-delta and quote/settlement invariants, and finish with zero
router escrow, zero relevant allowances and zero protocol-owned test residue.
p.USDT was considered but skipped before broadcast because its 6-decimal
minimum safe input could not fit inside the hard balance cap; the runner did not
increase the amount and did not print the balance. Earlier compatibility
deployments and configured runs are diagnostic artifacts only and are not the
supported integration surface.

### Previous complete-key COTI testnet deployment

Final reviewed source commit `ce11f2ed4b6f42d5eb656ea69c0dfb84d7206484`
was deployed to COTI testnet chain `7082400`. The complete 17-transaction
deployment and binding record is
`deployments/coti-testnet-ce11f2ed4b6f42d5eb656ea69c0dfb84d7206484.json`.
The deployment runner matched reviewed creation bytecode, constructor arguments,
runtime codehashes and all post-deployment bindings before publication.

- Fee vault: `0x52635eDB35c2A41C2DfE60C587b731776F236fC2`.
- Private LP-token factory: `0x379160bB671b5256FE9e960464Ae2968Acf1A981`.
- Initialization-strategy registry:
  `0x6bfF02Ad5d8fA2B5c0a2176DD56Fa54EC76f8cEb`.
- Canonical confidential pool deployer:
  `0x87d4C40f8A50ea908F13678948f170bBE1843870`.
- Confidential factory: `0x9e3Ac92646Bf3E0fcE5EE4fb39c20e71F4bE30d4`.
- Launch initialization strategy:
  `0x3B3c633BcE36F993De839909a8F721b3084e9DB9`.
- Launchpad migrator: `0xe0661C6e10DB11BAD8e2A0620D39bD47c184af05`.
- Confidential best-execution router:
  `0xaBA86B669966E9a1583D4E4C34DED504E6d0ED32`.
- Public factory: `0x233D3F71Ad7DFb2088cA652F8fc41095637bB139`.
- Public quoter: `0x44e7Fe7D3c70106503E7aff6638238fB6ed84e27`.
- Public router: `0x22c7A05dAC6f15502AFe1662aAeB157Ed80F4D07`.

All 17 deployment and binding transactions succeeded and consumed `23510678`
gas in total. The source-bound funded suite is sealed at
`evidence/coti-testnet-ce11f2ed4b6f42d5eb656ea69c0dfb84d7206484.json`.
Its four records contain 136 reconciled scenario transactions and passed an
independent read-only verifier in an isolated evidence-only checkout:

- feasibility: 13 transactions and 6 assertions, including cross-pool GT reuse,
  private winner selection, atomic settlement and zero-residue cleanup;
- best execution: 51 transactions and 15 assertions, covering mixed standard and
  protected candidates, all v1 fee tiers, both directions, deterministic ties,
  invalid candidate isolation, authorization guards, rollback, exact escrow,
  quote parity and full exits;
- fee collection: 50 transactions and 8 assertions, covering both input tokens,
  premature collection rejection, mature aggregation, terminal sub-threshold
  deposit, reserve exclusion, exact vault deposits and full cleanup;
- launchpad: 22 transactions and 9 assertions, covering dual authorization,
  price-bound rejection, atomic migration, canonical protected identity, replay
  rejection, full exit, ordinary reseeding and final zero residue.

The funded MPC-call probe separately confirmed that ciphertext-only storage reads
work under `eth_call`, while `SetPublic`, stored-ciphertext `OnBoard`, fresh
offboarding, arithmetic, comparison/mux and both complete quote forms revert.
This includes the deployment-time stored-encrypted-constant design. The paid
per-pool quote and paid bounded best-quote router are therefore the proven exact
transports on this runtime; the router is preferred for bounded integration
routing, but neither is gasless.

### Superseded COTI testnet deployment history

Final reviewed source commit `c10b23e7b1c871a95e5d258e26b961cbf4c14a3d` was deployed to
COTI testnet chain `7082400`. The complete 17-transaction deployment and binding
record is `deployments/coti-testnet-c10b23e7b1c871a95e5d258e26b961cbf4c14a3d.json`.
The deployment runner independently matched current artifacts, constructor
arguments, runtime codehashes and post-deployment bindings before publishing the
record.

- Fee vault: `0xfCeE820a22F69b3765B07E41fefB57CdF984D6D9`
  (`0x6fbe61cf639bdcdbd8621321cc02f9fd20bcf1cb33408c8c0dbc62deb711933c`,
  gas `1841820`).
- Private LP-token factory: `0x4dcee5c653279083aA466B93928bBE62123621Cb`
  (`0xa6a88bcc6bba27c1280c934e80e60c93f34910af20106bb64fba202a8b832c53`,
  gas `2991054`).
- Initialization-strategy registry:
  `0x04a5f0EeDCA92847043ebe57Ec975306429210E7`
  (`0x91dc3a2764061a5765bdc751cd55eae30d79e7677101289739c6a5e08bf7f0fb`,
  gas `1091793`).
- Canonical confidential pool deployer:
  `0x092852E1dA2AcC09Ed5B977aA7ea5A8261eD0fD7`
  (`0x29e1a9730d9c0699d955c904084f56a2565dd41acdd646de795afc02bb5b6237`,
  gas `4429890`).
- Confidential factory: `0x6d34bcf1A55b9939A2517bE194353404C2Ce7882`
  (`0x8b577f232cbc0c1dd5d64fc909827d4623e6822affb1594d650f64816bad1ec8`,
  gas `2253901`).
- Launch initialization strategy:
  `0xf795419eA9654371A30576Ab5FBDc50C90856E92`
  (`0xac245e7055901292a95de482ae228970a9af872ad549e25dee9c96b191eaafbc`,
  gas `4286461`). Its constructor-created migrator is
  `0xEb72dF1EFF25bd72431f4D27aad5045d6fd97DC4`.
- Confidential best-execution router:
  `0xaa47EC7C1d5492a4286d5De9EBAd2010A5770961`
  (`0x11b52db734cb67cf0c7af701eae05aad553bca4c9ed77abf4b2fa5376db0d8f1`,
  gas `2182489`).
- Public factory: `0x415Fd23a4Ae5d3Ba73DF5b3319B3AF4cCD271FFe`
  (`0x2dea7d1ca7892987b2cdda0a51559644721abda345925f81cf5bccc159b38928`,
  gas `3037572`).
- Public quoter: `0xcf23524facA6B74A55800857465e8eF3fa08ac78`
  (`0xfe6aba657daf42c2efb28c4fbcfaf924350cf63d09b28d2eac34dc36188e40fd`,
  gas `193643`).
- Public router: `0x81E8487F8F25F2a73bb9f8af02a9B23ed99DD535`
  (`0x87939caeec5152c6c8ab3c1702e4c2329e28f73dc903a3580c2f7c0ea6fe2352`,
  gas `719795`).

The fee-vault, pool-deployer, strategy-registry, strategy registration,
registry finalization and best-execution-router bindings were mined and verified
against current state. All 17 transactions were mined successfully and consumed
`23510678` gas in total.

The preceding source-bound deployment at commit
`7153eed3950862af5b3d79d42e01e66a482467f1` remains diagnostic evidence only.
Its first funded feasibility run stopped before creating a pool or transferring
private assets because the isolated checkout was pinned to the deployment source
and therefore could not contain its necessarily later evidence manifest. The
quote-call runner also incorrectly required the evidence HEAD to equal the
deployment source. The corrected boundary authenticates the tracked evidence
HEAD, proves the deployment source is its ancestor with no unauthorized
post-source executable changes, and binds funded journals to the deployment
source. A fresh deployment was required rather than weakening that provenance
gate or injecting an untracked manifest.

The superseded `2ba7e9e0baddefb5de22be0e45a27ab84956e480`
deployment remains diagnostic evidence only. Its launchpad price-bound and
migration transactions reverted after their shared ten-minute authorization
deadline had expired: the former was mined 5 seconds late and the latter 45
seconds late. The old runner accepted any status-zero receipt for the negative
probe, so deadline expiry could masquerade as the intended price-bound failure.
The reviewed runner now derives a one-hour deadline from chain time after the
disposable stack is finalized, requires at least five minutes before migration
submission, proves `PriceOutsideBounds()` and `InvalidLaunchCommitment()` by
historically replaying the exact mined transactions, and fails closed when that
reason evidence is unavailable.

The superseded deployment at commit
`ae10fe31270e49962e383faf9308f651db5ae01f` reached its fee-collection
disposable-pool creation transaction
`0x61210300af6ecfb8204f0d4e87235efb18b91fc8394a879a247706a947c3bd83`
before a client-side ABI omission prevented the runner from reading the
factory's immutable pool-deployer and strategy-registry getters. The failure
occurred before liquidity, approvals, swaps or other private-token operations.
The shared testnet ABI now includes the existing view getters, its regression
test is mandatory in the unit suite, and the focused security diff scan reported
zero findings. The strict source boundary requires the current replacement
deployment instead of retrying the superseded pool with modified executable
code.

The immediately preceding source-bound deployment at commit
`a46dadbf239e2a632dda02dcfb27c552d69378f8` remains diagnostic evidence. Its
fresh feasibility scenario passed on-chain. The
quote-only transaction
`0x920b8cf353e6c9335812adb669df48bf9203a6c4fafa13600a80d7859fdf0d79`
used `1728897` gas. The quote-plus-swap transaction
`0x7986c369e330cb23c12c378008581b21a09b2d79dc059986aceb197dcd48d5e6`
used `5774373` gas. Its three disposable pools were permanently closed through
`0x9c777f50a423600232ed7379966680dab3dc0df3bc9c88b351c27d9537dd2d63`,
`0xda3b44064d0bb777ce844e922830230a2606007e6f4ad0cd47ff91f53df07ad4`
and `0xff1be5a574982fdf583241869a1366b4e28fa575bd5156a0862358552d6a4664`.
All private assets were recovered exactly.

The fresh production best-execution scenario passed canonical discovery,
paid quote-only execution, mixed standard/protected selection, deterministic
tier tie-breaking, both directions, all v1 fee tiers, invalid-candidate
isolation, caller/replay/deadline protection, slippage rollback, exact escrow,
quote parity, full LP exits and zero-residue cleanup. The protected launch was
committed in
`0x723b721568bb98c1117fb49d6006a2ca25faf0392fb14326641e522db00196be`
and initialized in
`0xa1abd5519023c8d0e57d407b30d2aea9be9d3bcdb1dc87131f06477b906e74bf`.
The three-candidate quote and swap transactions were respectively
`0x0f90033bb8fec5e77730e73960208eb6914fa1b0212d3d354327f4779c284a6e`
and `0x28c9a42c389a045eb2f16883656d090ae39f84b790e5e479fd8567532a91e90f`;
the reverse quote and swap were
`0xd8a7149d8510f1759db8a22fbbd8a60d2895368e2fe442b0ca42107125f0a892`
and `0x06f9cc285b822e7536d3637460a7d7ba52ffc1e3badd50079b8863ac431f04b5`.
Two-candidate quote/swap execution consumed `16913089`/`29573337` gas and
three-candidate quote/swap execution consumed `25291060`/`38282426` gas. Full
exits for the 5, 30 and 100 bps pools were mined in
`0xc3f49c664d47f14f3784bed4a744e029f5a8b8bc98f3f6b990a8cc524dfedb55`,
`0xe2d25687a5ce30f0dbf2a5bc33e67c03bd90512aaf939cbe7c69a0b739c6ebfc`
and `0xe05891e92d0a15f958f9d7beb3a4baa025a604a2e11d9385c56f5b89b0547a7d`.

The first fresh fee-collection attempt successfully deployed and bound its
disposable stack and created its pool in
`0xca7be742dc658302b66c4f847efefffc1f294c6b4524d09d1f54f85b2a109c1c`.
Validation then failed before initialization. Read-only provenance checks proved
that every deployment and binding receipt succeeded, the factory, pool, vault,
deployer and registry bindings were canonical, the pool parameters and approved
private-token codehashes matched, and the factory-created pool had the expected
17,882-byte contextual runtime. The failure exposed two runner defects rather
than a protocol or deployment defect: aggregate causes were not included in the
sanitized diagnostic, and recovery attempted to decrypt LP shares before an
uninitialized pool had an LP token. The corrected runner preserves fail-closed
validation, emits at most four getter-free redacted aggregate causes, and marks
the uninitialized disposable resource recovered only after live zero-balance
and zero-allowance checks backed by the mined creation receipt. No paid action
was blindly repeated.

The earlier source-bound deployment at commit
`b5c72f49520ea31584bd7a5e09e5269a03a19fbb` is retained only as diagnostic
evidence. Its on-chain feasibility operations passed and all three disposable
probes were permanently closed with exact private-asset recovery, but public
evidence finalization failed closed because two valid router-binding operations
used runner journal labels that no longer matched the verifier. The shared label
contract was corrected and regression-tested before this replacement deployment;
the paid operation from the superseded deployment will not be repeated.
