# Privacy Model

## Confidential

- swap input and output amounts;
- pool reserves and invariant calculations;
- fee-adjusted amount and price impact;
- minimum output/slippage values;
- provider LP share balances and aggregate share supply;
- amounts held in timed/permanent LP locks;
- amounts in the pool's own events and errors.
- per-token accrued confidential protocol-fee amounts.
- per-token/per-epoch confidential fee-vault amounts.
- losing fee-tier quote outputs and their relative ordering.
- amounts held temporarily in best-execution router escrow and allowances.

Factory-created LP shares are represented by the pool-bound `PrivateLPToken`.
Its standard transfer and approval events still reveal participant addresses, but
not the encrypted amount. The token's public metadata and pool address are
discoverable by design.

## Public

- pool and token contract addresses;
- fee tier and token decimal metadata;
- initialization strategy, strategy class and standard/launch-protected class;
- pool initialization state;
- caller/provider addresses and swap direction;
- transaction timing, gas use and success/failure;
- participant addresses in the underlying standard PrivateERC20 `Transfer` event.
- confidential protocol-fee collection token, destination, aggregate swap count,
  and collection-window timing (but not the accumulated amount).
- launch ID, creator, protected pool, creator authorization hash, migration
  deadline, completion status and public LP disposition;
- best-quote/best-swap caller, request ID, selected canonical pool, fee tier and
  initialization strategy, direction, transaction timing, gas and
  success/failure.
- liquidity-preview caller, request ID, selected side, pool, transaction timing,
  gas and success/failure. The accepted amount, counterpart and expected shares
  remain caller-encrypted.
- position-read caller, request ID, pool, transaction timing and success/failure;
  locked-position reads additionally reveal the already-public lock ID. Shares,
  current claims and normalized price remain caller-encrypted.

The core confidential pool exposes no public reserve-derived market data. Pool
identity, token metadata, fee tier, protocol version and privacy mode are public;
reserves, TVL, aggregate LP supply, spot price, TWAP and exact quote outputs are
not. Any future oracle is an optional, separately reviewed disclosure component.

## Allowed boolean disclosures

The contract decrypts only boolean predicates needed to enforce safety: positive
amount, arithmetic overflow/underflow, sufficient private shares, proportionality,
minimum-output checks and full-exit state. A caller can already learn whether its
transaction succeeded or reverted. Amounts are never passed to `MpcCore.decrypt`,
logs, custom errors or deployment output.

Repeated private quotes can still allow an active caller to estimate price and
depth from the public CPMM formula. Encrypted quotes protect a particular
request/result from passive public disclosure; they are not an
information-theoretic curve-hiding mechanism. The best-quote router improves
cross-tier privacy by offboarding only the winner, but the caller learns that
winner and its exact output and can probe repeatedly. A dedicated quote service
must not persist or publish those outputs as protocol market data.

The paid proportional-liquidity preview has the same active-caller boundary. A
caller that decrypts accepted-side, counterpart and share outputs can infer the
current ratio and estimate depth through repeated chosen inputs. It still keeps
the LP's proposed amount and result out of public plaintext logs and prevents a
passive observer from learning the ratio directly. Charging gas raises probing
cost; it does not create an information-theoretic reserve-secrecy guarantee.

The position and removal-preview paths intentionally disclose a provider's
own current claim to that provider. The locked-position path requires the public
lock owner to be the caller and rejects released locks. An LP can infer current
pool ratio from its own claim, so this does not promise aggregate curve secrecy
against active liquidity providers. It does preserve amount confidentiality from
passive observers and unrelated wallets. Protocol-fee accumulators remain
excluded from LP claims and have no owner-read endpoint.

Confidential protocol-fee collection has a related but narrower inference
boundary. Pool-side count/time batching, canonical encrypted vault deposits,
fixed daily cross-pool epochs, a minimum eight-swap matured sweep, and terminal
full-exit deposits prevent routine per-swap amount disclosure. Deposit events do
reveal pool, token, epoch and public aggregate swap count. A beneficiary that
already knows most trades in a quiet window may still infer information about
the remainder from a later aggregate balance change. The protocol does not claim
that batching manufactures unknown traffic or an information-theoretic anonymity
set.

## Trust assumptions

The design relies on COTI's MPC precompile, consensus, operator/key-management
model, external private-token semantics, the reviewed LP-token helper runtime
and its on-chain issuance attestations, client-side AES key handling and the
COTI SDK's authenticated encrypted-input format. The factory admits any deployed
token that reports the official `IPrivateERC20` interface and valid decimals.
Those structural checks do not prove honest token behavior. Exact encrypted
balance-delta validation limits accounting drift, but malicious or broken token
implementations remain a token/pool trust risk. These are trust assumptions, not
cryptographic proofs produced by this repository.

Launch privacy does not hide that a launch-protected market was committed or
initialized. Dual EIP-712 authorization protects who may claim and consume the
initialization slot; it does not hide launch identity. Encrypted seed amounts,
final-price bounds and LP share amounts remain confidential. After bootstrap the
strategy receives no swap callback or privileged market information.

## Observable-price confidentiality

Privacy mode 2 intentionally weakens aggregate price secrecy, not private asset
custody or exact amount confidentiality. Public observers learn a quantized price in
the same successful swap that crosses a 50-bps bucket and the number of swaps since
the prior public observation.
They do not receive exact reserves, depth, TVL, amount volume, LP balances, liquidity
amounts, swap inputs or outputs, slippage values, or exact quote results.

Immediate publication deliberately allows a bucket-crossing event to be attributed to
its swap. An attacker who knows or probes pool depth can use consecutive buckets to
estimate a range for that trade's amount. Quantization prevents the event from directly
disclosing an exact amount, but it does not create information-theoretic anonymity and
must not be described as hiding approximate flow.

Price quantization occurs inside MPC before public decryption. The quantum is fixed
by the prior public bucket for each update, and confidential movement is bounded before
rounding. Publishing exact reserves or continuously precise shadow reserves remains
out of scope. Mode 1 is unchanged and has no public observation functions.

The initialization reference is intentionally public but is not accepted during
empty pool creation. It is committed atomically with the first confidential reserve
deposit (or signed launch migration), and the actual confidential ratio must lie in
the reviewed range around it. This discloses an indicative launch price without
disclosing either reserve amount.

Public buckets support walletless discovery and approximate charts. They do not reveal
price impact because depth remains private, so they cannot replace paid encrypted
quotes or produce authoritative minimum output.
