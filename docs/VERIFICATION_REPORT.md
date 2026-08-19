# Verification Report

Date: 2026-08-18

## Status

This report tracks the complete-key and launch-protected confidential-pool
refactor. The contract, SDK, runner and documentation changes have passed the
complete local verification cycle after the latest security remediations. Both
the post-remediation diff scan and final full-repository Codex Security scan are
complete with zero findings. Fresh COTI testnet deployment and funded evidence
remain pending until the reviewed source tree is sealed and committed.

Historical testnet addresses, transaction hashes and gas observations from the
previous pool identity are not evidence for this source and are deliberately not
carried forward. This is a testnet implementation, not a mainnet-readiness or
external-audit claim.

## Environment

- Node: required `24.16.x`
- npm: required `11.13.x`
- Solidity: pinned local `solc@0.8.28`
- EVM target: Paris
- target chain: COTI testnet (`7082400`)
- dependency policy: locked install, reviewed lifecycle scripts, no forced audit
  fixes or advisory suppression

No dependency was added for this refactor.

## Current local evidence

- production dependency audit: passed with zero advisories at every severity
- production dependency graph: passed with no missing required dependency
- clean privacy-boundary build: passed, 29 Solidity files, 72 typings and 42
  compiler-AST privacy checks
- normal Solidity compile and TypeChain generation: passed, 29 Solidity files
  and 72 typings
- TypeScript: passed
- source-boundary lexer tests: passed
- supplemental security-boundary checks: passed
- full local suite: 199 passing, 1 intentionally gated funded-network
  integration placeholder
- diff whitespace validation: passed

Deployment gas measurement remains intentionally deferred until the reviewed
source is committed, so the resulting gas report is bound to the exact source
commit used for deployment.

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

The launch strategy is an initialization-only authority. A protected launch
requires independent creator and fixed launch-authority EIP-712 signatures over
the complete pair, decimals, fee, privacy/version identity, factory, migrator,
strategy, chain, launch ID and deadlines. The strategy creates the protected
pool when the launch is committed and records one active commitment for the
complete key. Existing-key resolution revalidates token ordering, both decimals,
fee, protocol/privacy versions and strategy against that exact canonical pool.

At graduation, the creator separately authorizes the five encrypted migration
inputs for the exact migrator and selector. The migrator performs exact private
escrow and allowances. The factory consumes the strategy's factory-only,
one-shot initialization authorization in the same transaction as protected-pool
bootstrap. Failed migration rolls back authorization consumption, token pulls,
allowances, LP state and pool state.
Each strategy owns a distinct pinned migrator/codehash binding. The obsolete
factory-global launch-adapter surface is absent, so a second reviewed strategy is
not forced through the first strategy's migrator. EOA and ERC-1271 creator
authorizations are accepted consistently by both commitment and migration
verification.

Cancellation and expiry never make a protected pool permissionlessly
initializable. An inactive empty launch may be superseded only by another fully
authorized commitment. A completed pool cannot be superseded or reinitialized.
The strategy receives no tokens and has no post-initialization swap callback,
fee, reserve, LP, lock, rescue or withdrawal authority.
A completed protected pool that later reaches a true full exit retains its
completed-initialization marker. Anyone may re-seed it through ordinary
liquidity addition, while the consumed strategy remains unable to bootstrap it
again.

## Routing boundary

The router accepts no candidate addresses. Its nine-bit namespace represents
the three approved fee tiers multiplied by standard class zero plus at most two
reviewed, finalized strategy classes. It rejects unknown bits and more than
three selected candidates, derives every candidate through the factory's
complete key, verifies canonical metadata, and skips absent or uninitialized
variants.

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
deployment-time encrypted-constant design. Therefore paid per-pool encrypted
quote transactions remain the only proven primary quote path. The paid bounded
best-quote router is implemented but is not gasless and is not promoted until
fresh funded evidence succeeds. Retaining the direct paid quote is not evidence
of a separate gasless main path.

Exact permissionless quotes also permit active curve probing: encryption hides
the request/result from passive observers, but a caller can query and decrypt
its own deterministic outputs. The protocol therefore does not claim
information-theoretic reserve secrecy from an active funded quote operator.

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
   A suppressed launch-authority candidate was retained as an explicit trust
   assumption: authority compromise can occupy an unused protected namespace
   with a self-controlled creator, but cannot spend an honest creator's assets.
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
ciphertexts, signatures, private balances, quotes and decrypted values must not
be printed or stored.

Fresh addresses, transactions, measured gas, scan identifiers and final command
results will replace this pending section only after all gates pass.

### Fresh COTI testnet deployment

Source commit `e774287e565411952da8a29337cb055bcae3bf44` was deployed to
COTI testnet chain `7082400`. The complete 17-transaction deployment and binding
record is `deployments/coti-testnet-e774287e565411952da8a29337cb055bcae3bf44.json`.
The deployment runner independently matched current artifacts, constructor
arguments, runtime codehashes and post-deployment bindings before publishing the
record.

- Fee vault: `0x698b663E8Ed8587C6dbac7A8Df490fB6083752cd`
  (`0x5dc7e648a8b69ba9ce58af362a258f00e7e5c7ca762f039dfc959053f3140036`,
  gas `1841820`).
- Private LP-token factory: `0xbc5AEd1E90d5479dc41e9400E3797B3E9f2B5891`
  (`0x54d7ec62ac56bea6c1f47d04d097c1e034f1e8a22894759b994f500c0394990a`,
  gas `2991054`).
- Initialization-strategy registry:
  `0xb0E206D2F290Fd549309154B9600Aa4d0E180983`
  (`0x3c18b867bac11670a387ea91a7f736f957a68ad573d0e3feaa0c0dd2f2ce8f88`,
  gas `1091793`).
- Canonical confidential pool deployer:
  `0x0E07Da34BD4d46FBaa3Bf45eAb09c4c9Afe0DBb8`
  (`0x8faad1e361d9a661993c679844e8a8aae12c9997229b4f699ce009f192fd8dfe`,
  gas `4429890`).
- Confidential factory: `0x07e2864F2976441c8b47334df5EDf31A109c6282`
  (`0xb0ad359b68618f5b4b699c9c4ca21bd639934736e84719e43c88dceb66592d74`,
  gas `2253877`).
- Launch initialization strategy:
  `0xBfAdf74a3007bF77fDe32270Da2dBc46CAfAd985`
  (`0x2ae037272d2ba4909ef700d945d70612b99f44e3f18fa6548dce01ec1f0e1754`,
  gas `4286449`). Its constructor-created migrator is
  `0x9fbd2c7A361f2252d41F87A3a6a31142AC2376B3`.
- Confidential best-execution router:
  `0x83986ff7e1faA52F388663be84cD0f09eDd1828b`
  (`0x5e3b4f9c2f4e94fbd5ac75c242b58076de0dbe16416b52d920a7ec78b4688b8d`,
  gas `2182489`).
- Public factory: `0x08EcbD216820c3611D809Cc213f5d4C70FB9865d`
  (`0xd6a932b77985a3c6829f4b0896baa7c3abe276f0631cd9ad94f59069fc958ff9`,
  gas `3037572`).
- Public quoter: `0x09F42f993f15a466266a49C8617AD00698855E72`
  (`0xcec46ddb816cdbc2da7d984716c0bd6c64651b64a988b6e0e22b2c5cf7f0f2f4`,
  gas `193643`).
- Public router: `0xd38EAF09f19D2beCCB12875dc4a8C76801B7cB8D`
  (`0xdb3190ad8a0bfa59a6145cf9d8447cd07123b83bebfa7853c2f37866c0ed3434`,
  gas `719795`).

The fee-vault, pool-deployer, strategy-registry, strategy registration,
registry finalization and best-execution-router bindings were mined and verified
against current state. Funded pool, routing, fee-collection, launchpad and MPC
quote-capability evidence remains pending and must be committed separately from
this source-bound deployment evidence.
