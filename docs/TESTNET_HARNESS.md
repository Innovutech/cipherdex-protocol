# COTI Testnet Harness

The testnet harness uses the pinned official COTI SDK and real MPC precompiles.
It never substitutes plaintext mocks for network evidence. Test identities must
be disposable and explicitly funded; no funded-network script runs in CI.

The scripts never print private balances, decrypted values, AES keys,
ciphertexts, signatures or raw RPC payloads.

## Preflight

Run the non-mutating network and identity gate through the externally installed,
exact-commit launcher documented in `docs/DEPLOYMENT.md`:

```text
--target scripts/testnet-preflight.ts -- --network cotiTestnet
```

It verifies the configured chain, native gas, token contract code and decimals,
and caller-encrypted `PrivateERC20.balanceOf(address)` read/decrypt behavior for
the two LP identities. It also validates the separate MPC-call probe identity.
Preflight submits no transaction.

The Hardhat network uses `COTI_TESTNET_GAS_LIMIT` (default `30000000`) as an
explicit transaction cap. Receipts charge only actual gas used.

The three-candidate confidential router runner uses
`COTI_BEST_EXECUTION_GAS_LIMIT` (default `60000000`). Its additional encrypted
candidate validation and selected-pool settlement exceed the general 30M test
cap, while remaining below the currently verified COTI testnet block limit.
Always use receipt `gasUsed`, not this safety cap, for benchmarks.

The basic `testnet:harness` first submits the proven paid per-pool encrypted
quote, decrypts only the caller result locally, and creates a fresh swap-bound
minimum using `COTI_TESTNET_SLIPPAGE_BPS` (default 100 bps). It never substitutes
a zero swap minimum or the unsupported MPC `eth_call` path.

## MPC `eth_call` probe

Run the isolated runtime capability test through that launcher:

```text
--target scripts/testnet-quote-call-probe.ts -- --network cotiTestnet
```

The probe first mines a control transaction, then independently tests a stored
user ciphertext read, raw `SetPublic`, raw stored-ciphertext `OnBoard`,
authenticated validation, add, multiply/divide, compare/mux, user offboarding,
and complete public-input and encrypted-input quote paths. One full public-input
path uses deployment-time encrypted zero, one, denominator and fee constants to
remove `SetPublic` from quote execution. The storage-only read works; raw
`OnBoard` and every complete path requiring fresh MPC execution fail under
`eth_call`. The same MPC control succeeds in a transaction.

This matrix is the evidence for retaining the encrypted transaction/event quote
transport. It must be rerun when the RPC/runtime changes; a different failure may
not be normalized to this known boundary.

## Confidential best execution

Run the funded production-router gate through that launcher:

```text
--target scripts/testnet-best-execution.ts -- --network cotiTestnet
```

The runner first verifies the complete commit-bound deployment provenance,
on-chain bindings and reviewed private-token instances from
`COTI_DEPLOYMENT_RECORD`. It does not mutate those configured contracts. It then
deploys runtime-verified disposable instances of the same fee vault, LP-token
factory, pool deployer, initialization-strategy registry, launch strategy,
migrator, confidential factory and production `ConfidentialBestExecutionRouter`.
It binds them exactly as the deployment runner does. Its bounded candidate set
contains a standard 5 bps pool, a dual-authorized launch-protected 30 bps pool,
and a standard 100 bps pool in that disposable factory. The deployment record
must already be reviewed and tracked in a separate evidence commit, and the
worktree must be completely clean. It validates:

- signed launch commitment, exact protected initialization and completed
  one-shot launch state;
- explicit 9-bit candidate selection across standard and protected classes;
- two- and three-candidate GT reuse, private comparison and deterministic ties;
- absent, uninitialized and encrypted-invalid candidate isolation;
- paid quote-only pool-state immutability and no token/pool logs;
- request-ID, ciphertext, deadline and caller-binding rejection;
- encrypted slippage failure with complete rollback;
- exact input escrow, selected-pool-only allowance and settlement parity;
- zero router residue and zero candidate allowances after success;
- both directions, every approved v1 tier, and successful protected-candidate
  selection and settlement;
- true full exits from every candidate, zero pool balances/allowances/shares and
  only the modeled protocol-fee delta remaining outside the test identity.

The runner prints only public contract, transaction, candidate-class and gas
data. Gas observations are not fixed promises and must come from the final
freshly deployed source; old standard-only benchmarks are not evidence for this
mixed-class implementation.

The `scripts/testnet-best-execution-feasibility.ts` launcher target remains the lower-level disposable
probe proving transaction-scoped GT lifetime across contracts. It is not a
deployable router or a substitute for the production gate. Because the probe
moves funded private assets, it runs only after the clean source deployment and
separate evidence commit. It verifies the complete tracked deployment and exact
reviewed token instances before constructing token contracts or deploying probes.

## Launchpad bootstrap

Run the atomic canonical bootstrap proof separately through that launcher:

```text
--target scripts/testnet-launchpad.ts -- --network cotiTestnet
```

It first verifies the tracked deployment, clean source/evidence state, and exact
reviewed token instances. It then deploys and runtime-verifies a disposable fresh
pool deployer, strategy registry, factory, dual-authorized launch strategy and
migrator. The commitment creates the protected complete pool key before any
assets move. Exact encrypted creator allowances and normalized price bounds are
consumed only by the migrator's atomic initialization. An impossible price
interval proves that token pulls and initialization roll back without changing
the committed pool. A valid migration completes the one-shot launch, replay
proves there is no additional movement or discovery change, and a full
creator-held LP exit proves the completed protected pool can be re-seeded through
ordinary permissionless liquidity addition. A second full exit plus allowance
cleanup then returns all disposable private balances and allowances to zero.

The funded recovery/evidence gate requires `COTI_LAUNCHPAD_DISPOSITION=0` (or
unset). Timed-lock and permanent-lock dispositions remain production features
covered by local unit, property and integration tests, but are not used in a
funded disposable run because they intentionally prevent immediate complete
asset recovery. Deliberate deterministic-address pre-funding is likewise kept
out of this runner; donation accounting is tested locally without sacrificing a
funded private-token unit.

## Mature confidential fee collection

```text
--target scripts/testnet-fee-collection.ts -- --network cotiTestnet
```

The runner verifies the reviewed deployment, then creates and runtime-verifies a
separate disposable fee vault, LP-token factory, confidential factory and
100-bps pool. It never mutates the reviewed deployment. The runner brings each
token-side batch to eight successful swaps. If the
immutable one-hour window has not elapsed, it reports only the public `readyAt`
time and exits with a dedicated retry status while retaining the source-bound
recovery journal. Before pausing, the runner submits the same two-sided
collection call and requires it to mine with failure before `readyAt`; the
evidence verifier then requires that rejection to precede a successful identical
collection at or after `readyAt`. A later run deposits both mature
encrypted aggregates into the fixed vault, then performs one new token0 swap and
a full LP exit. The exit must deposit that one-swap terminal encrypted fee into
the same vault epoch before clearing counters, proving that LP withdrawal cannot
consume protocol-owned fees and sub-threshold fees cannot be stranded. Vault
sweeping remains separately gated by fixed 24-hour epochs, two-epoch maturity and
an eight-swap aggregate minimum.
Each swap minimum is derived from a fresh paid encrypted quote using
`COTI_TESTNET_SLIPPAGE_BPS`; the full-exit minima are derived from the
source-bound modeled disposable scenario and must remain positive.

All funded runners use the v7 encrypted append-only recovery journal. They derive
the transaction hash from the locally signed payload and durably record both
before RPC submission. The external authenticated launcher places these journals
in a stable owner-only, repository-scoped directory outside each disposable
checkout. Runtime deletion after success, failure, or process interruption cannot
delete replay protection, evidence-pending state, or cleanup obligations.
Before deleting a completed runtime, the launcher promotes only the expected
schema-valid sanitized run record into the stable private recovery evidence
directory. Finalization stages those immutable source-bound records back into a
fresh authenticated runtime. A transaction-free rematerializer can regenerate
them from terminal journals when recovering runs completed before that promotion
boundary.
An ambiguous provider response therefore retains a deterministic hash and exact
payload for explicit receipt reconciliation or identical rebroadcast; it never
causes a blind re-sign. Signed payloads remain private local recovery material
and are omitted from committed evidence. Resource recovery also records the exact
successful cleanup transaction and verifies terminal state onchain before a run
can pass.
Completed paid execution enters a durable `evidence-pending` phase. Evidence
generation failures resume from that phase and cannot reset the journal or
repeat paid operations. Public evidence is signed by the funded owner; private
balance and encrypted-zero claims remain operator attestations, while hashes,
receipts, contract provenance, targets, selectors and public calldata semantics
are independently checked against the chain.

Journal records are authenticated, encrypted, hash chained and fsynced before a
signed payload can be broadcast. Repository-wide and signer/chain execution
leases reject concurrent funded runners; a dead-owner lease is quarantined and
recovered only after every nonterminal local transaction hash has been checked
for a receipt. Signer-global nonce reservations coordinate deployment and all
funded scenarios, while their coordinator persists only transaction hash, nonce
and status. Replayable signed bytes exist only inside the authenticated encrypted
recovery journal. Private-token allowances are separate durable recovery
obligations and evidence cannot finalize until each obligation is verified zero.
This prevents accidental concurrent runners and ordinary crash rollback. It does
not claim freshness against a malicious host administrator who can restore an
old journal snapshot: the funded private keys and AES keys are on that same
trusted test host, so such an attacker is already outside the runner's security
boundary. After restoring host backups, operators must reconcile all known
transaction hashes and must not automatically re-sign a funded operation.
