# COTI Testnet Harness Requirements

The integration test is intentionally gated until real COTI testnet inputs are
available. It must use the official COTI SDK/COTI Ethers package and an onboarded
test account; it must not replace the MPC precompile with a plaintext mock.

The harness must:

- prepare authenticated `itUint256` values with the exact pool address and function
  selector;
- approve the pool with the official private approval flow;
- add arbitrary-ratio liquidity and decrypt only user-specific ciphertexts locally;
- add a second LP proportionally to the same canonical pool without donating
  surplus input;
- verify that current COTI testnet static simulation rejects MPC execution and
  use the encrypted transactional quote-result transport;
- execute both swap directions with a private minimum output and a short
  explicit deadline;
- verify that each successful direction increments only its encrypted
  protocol-fee batch and that collection is rejected before the immutable
  threshold;
- exercise failed slippage and replayed encrypted-input paths;
- remove liquidity and check the full-exit path;
- record gas/latency without printing amounts, AES keys, ciphertexts or signatures.

The harness should be enabled only with explicit environment variables and should
never run from CI against a funded wallet by default.

## Preflight

Run the non-mutating configuration check before deployment or the scenario:

```text
npm run testnet:preflight
```

This is a no-compile configuration and network gate, so missing environment
variables fail immediately without compiling the MPC contract graph. It verifies
the COTI testnet chain, native gas, token contract code and decimals, and the
caller-encrypted `PrivateERC20.balanceOf(address)` read/decrypt path for the
primary LP/trader and funded second LP. It also validates a distinct,
non-custodial quote-service identity without requiring that identity to hold
either token. Both LP accounts must have gas; the quote identity performs no
transaction. It does not submit transactions and does not print private
balances, ciphertexts, AES material or raw RPC payloads.
`publicAmountsEnabled` is reported for awareness only; the protocol uses the
encrypted token methods regardless of that separate token setting.

The Hardhat COTI testnet network uses `COTI_TESTNET_GAS_LIMIT` (default
`30000000`) as an explicit transaction cap. This avoids an unsupported
pending-block lookup observed during Hardhat transaction population. The cap
is below the measured testnet block limit (`120000000`) and above the largest
locally measured deployment (`6999610` gas for the confidential factory).
Receipts still charge and report only actual gas consumed.

## Full scenario runner

After the isolated quote/swap harness is reviewed, run the full scenario with:

```text
npm run testnet:scenario
```

When `COTI_POOL` is unset, it creates a permissionless factory plus two canonical
pools for the configured fee tiers. It seeds both pools at independently chosen
ratios, adds a distinct second LP to the primary pool, and verifies from that
LP's local decrypted balances that only the rounded-up proportional deposits
were accepted. A dedicated quote identity creates fresh inputs for both pools,
submits caller-encrypted quote requests, decrypts the results only in memory, and
selects the best candidate through the SDK helper. The primary wallet then
creates fresh authenticated inputs and swaps directly against that selected
pool. The quote identity never signs a transaction or receives user funds.

The scenario also executes both swap directions, failed slippage, encrypted-input
replay rejection, a complete personal exit for the second LP, a timed lock and
unlock, a permanent lock, and removal of the primary LP's remaining unlocked
shares. It logs only public addresses, selected fee tier, transaction hashes,
gas, and latency. It does not print any amount, decrypted quote, ciphertext,
signature, AES key, or raw RPC error.

The scenario requires the three private-key/AES-key pairs documented in
`.env.example`, both fee tiers, primary and quote-candidate bootstrap amounts,
second-LP offered amounts, and both swap amounts. All amount variables are in
the canonical sorted `token0`/`token1` order. The primary wallet must fund both
fresh candidate pools plus the swap inputs; the second LP must fund its own
offered deposits. Use disposable COTI testnet accounts only.

For the complete reproducible gate, leave `COTI_POOL` and `COTI_QUOTE_POOL`
unset so both candidates are fresh and arbitrary-ratio initialization can be
verified exactly. To exercise already-deployed candidates, set both addresses;
the runner validates their pair and fee tiers but cannot reconstruct historical
reserves or prove their original initialization.

## Launchpad migration runner

Run the atomic migration proof separately with:

```text
npm run testnet:launchpad
```

It deploys a fresh factory and migrator, creates exact encrypted allowances for
the migrator, derives or accepts encrypted normalized price bounds, and executes
the atomic create/select, pull and bootstrap transaction. Before the valid
migration it submits a separately authenticated request for the same
logical amounts with an impossible encrypted price interval, then proves that
the private token pulls and factory pool creation rolled back. Separate probe
ciphertexts keep the successful path independent from precompile replay
semantics. After success it replays the exact successful request and proves no
additional token movement or pool-discovery change occurred.

By default the script uses the legacy creator-held call. Set
`COTI_LAUNCHPAD_DISPOSITION=0` to exercise explicit creator-held disposition,
`=1` with a future absolute `COTI_LAUNCHPAD_UNLOCK_TIME` for a timed lock, or `=2`
for a permanent lock. Run all three explicit values against separate fresh
deployments for the complete disposition gate. The script verifies pool/lock
state and decrypts the caller-specific share result locally without printing it.
It uses the same token, decimal, primary private-key and AES variables as the
full scenario. Launchpad amounts are independent: set raw-unit
`COTI_LAUNCHPAD_AMOUNT0` and `COTI_LAUNCHPAD_AMOUNT1`, or leave them unset for
the conservative default of 0.001 token per side. The runner does not reuse the
larger general pool-scenario liquidity amounts.

The two runners are intentionally separate: use `testnet:launchpad` for the
launchpad boundary, then `testnet:scenario` with a new disposable pool for swaps,
liquidity exit and locks. Never reuse a funded production account or commit the
environment file.

## Mature confidential fee collection

Set `COTI_FEE_COLLECTION_POOL` to a disposable fee-enabled pool controlled by
the primary test identity, then run:

```text
npm run testnet:fee-collection
```

The runner uses fresh encrypted inputs to bring each token-side batch to eight
successful swaps. Defaults are 0.1 token per side for initialization and 0.01
token per swap; raw-unit overrides are available through the `COTI_FEE_TEST_*`
variables. If the immutable one-hour collection window has not elapsed, the
runner prints only the public `readyAt` timestamp and exits successfully. Rerun
after that time. It then performs a full LP exit before collecting both encrypted
fee aggregates to the pool's immutable vault, proving that LP withdrawal does
not consume protocol-owned fees. Amounts, balances, ciphertexts and keys are not
printed. The vault's separate 24-hour beneficiary sweep remains an operational
delay and must not be bypassed for testing.
