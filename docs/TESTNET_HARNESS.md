# COTI Testnet Harness

The testnet harness uses the pinned official COTI SDK and real MPC precompiles.
It never substitutes plaintext mocks for network evidence. Test identities must
be disposable and explicitly funded; no funded-network script runs in CI.

The scripts never print private balances, decrypted values, AES keys,
ciphertexts, signatures or raw RPC payloads.

## Preflight

Run the non-mutating network and identity gate:

```text
npm run testnet:preflight
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

Run the isolated runtime capability test:

```text
npm run testnet:quote-call-probe
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

Run the funded production-router gate:

```text
npm run testnet:best-execution
```

The runner deploys a fresh fee vault, private LP-token factory, confidential
factory and production `ConfidentialBestExecutionRouter`, binds the router once,
and creates canonical 5, 30 and 100 bps pools. It validates:

- two- and three-candidate GT reuse, private comparison and deterministic ties;
- absent, uninitialized and encrypted-invalid candidate isolation;
- paid quote-only pool-state immutability and no token/pool logs;
- request-ID, ciphertext, deadline and caller-binding rejection;
- encrypted slippage failure with complete rollback;
- exact input escrow, selected-pool-only allowance and settlement parity;
- zero router residue and zero candidate allowances after success;
- both directions and every approved v1 tier.

The validated COTI testnet benchmark was 16,872,645 gas for a two-candidate paid
best quote and 29,530,376 gas for quote-plus-swap; three candidates used
25,247,841 and 38,236,748 gas respectively. The reverse three-candidate swap
used 37,903,897 gas. These are testnet observations, not fixed gas promises.
The runner prints only public contract/transaction/gas data.

`npm run testnet:best-execution-feasibility` remains the lower-level disposable
probe proving transaction-scoped GT lifetime across contracts. It is not a
deployable router or a substitute for the production gate.

## Full confidential scenario

Run:

```text
npm run testnet:scenario
```

Leave `COTI_POOL` and `COTI_QUOTE_POOL` unset for the reproducible gate. The
runner deploys a fresh fee vault and confidential factory, creates two canonical
fee-tier pools for the same pair, and initializes both at independently supplied
ratios. The second LP joins the primary pool proportionally, and local decrypted
balance checks prove that only rounded-up proportional deposits were accepted.

This regression scenario deliberately exercises the currently proven paid
per-pool quote path: a separate quote EOA/AES identity submits one encrypted
transaction per canonical fee-tier candidate, verifies discovery provenance,
decrypts its own results and selects the largest output. The user then creates
fresh pool-bound inputs and executes directly. This proves the primary path on
deployments without the finalized router and the direct compatibility path
after router deployment. No decrypted value is printed or persisted.

The runner exercises:

- discovery provenance and best-output selection across canonical fee tiers;
- direct encrypted swaps in both directions;
- expiry, slippage and encrypted-input replay rejection;
- per-input-token protocol-fee batch accounting and premature collection
  rejection;
- a second-LP full personal exit;
- timed and permanent LP locks;
- the primary LP's remaining unlocked exit;
- a true full exit from the independent second fee-tier pool.

The primary and second LP identities need private token balances and native gas.
The separate quote identity needs native gas for the paid per-pool quote
transactions but never receives user assets or signs settlement. Raw swap inputs
must be large enough for the one-sixth protocol share to remain nonzero after
integer rounding. The runner validates this before any RPC or deployment work
and reports the exact minimum for every configured fee tier.

Every LP removal also requires explicit positive encrypted limits:
`COTI_SECOND_LP_REMOVE_MIN0/1`, `COTI_PERSONAL_REMOVE_MIN0/1`, and
`COTI_FULL_EXIT_MIN0/1`. These values must be reviewed against the disposable
scenario inputs. They are not derived from public reserve state because the
protocol intentionally discloses none.

## Launchpad bootstrap

Run the atomic canonical bootstrap proof separately:

```text
npm run testnet:launchpad
```

It deploys a fresh factory and migrator, sends one encrypted raw token unit to
the predicted CREATE2 pool address before deployment, creates exact encrypted
creator allowances and normalized price bounds, then executes canonical pool
resolution, migrator escrow, pool allowances, exact pool pulls and bootstrap
atomically. The valid migration must deploy at that pre-funded address, proving
an unsolicited raw balance cannot block bootstrap or change canonical discovery.
An impossible price interval first proves that token pulls and new canonical
pool creation roll back. A valid migration then succeeds, and replay proves
there is no additional movement or discovery change.

Set `COTI_LAUNCHPAD_DISPOSITION=0` for creator-held shares, `=1` with a future
`COTI_LAUNCHPAD_UNLOCK_TIME` for a timed lock, or `=2` for a permanent lock. Run
the three modes against separate fresh deployments for the complete gate.

## Mature confidential fee collection

Set `COTI_FEE_COLLECTION_POOL` to a disposable fee-enabled pool controlled by
the primary identity, then run:

```text
npm run testnet:fee-collection
```

The runner brings each token-side batch to eight successful swaps. If the
immutable one-hour window has not elapsed, it reports only the public `readyAt`
time and exits. A later run performs a full LP exit before collecting both
encrypted fee aggregates, proving that LP withdrawal cannot consume
protocol-owned fees. The vault's separate 24-hour sweep delay remains intact.
Each swap minimum is derived from a fresh paid encrypted quote using
`COTI_TESTNET_SLIPPAGE_BPS`; the eventual full exit requires explicit positive
`COTI_FEE_TEST_REMOVE_MIN0/1` values.
