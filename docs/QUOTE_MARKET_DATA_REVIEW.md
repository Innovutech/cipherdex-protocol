# Confidential Quote and Market-Data Review

Date: 2026-08-15

## Decision

Keep confidential settlement, encrypted exact-input quotes and the absence of
public reserve-derived state. On the current COTI testnet runtime, exact private
quotes use an explicitly labelled encrypted transaction/event fallback because
fresh MPC operations cannot execute under `eth_call`.

The fallback is functional, not ideal UX. A non-custodial quote identity can
discover factory-proven canonical fee-tier pools, create a fresh authenticated
input for each candidate, submit each request, decrypt only its own result and
select the largest output. It pays gas, waits for inclusion and creates public
caller/pool/direction/timing history. The user independently creates fresh
pool-bound inputs and swaps directly against the selected pool.

No public reserve, TVL, spot-price, TWAP, depth ladder or quote state is added.
This is a testnet feasibility boundary, not a mainnet-readiness claim.

## Isolated runtime evidence

`MpcQuoteCallProbe` creates reusable ciphertext in a deployment transaction and
then tests every relevant read stage independently:

| Stage under `eth_call` | Result |
| --- | --- |
| Read ciphertext already encrypted for the caller | Supported |
| `SetPublic` plus plaintext `Decrypt` | Rejected |
| Raw `SetPublic` precompile call | Returns failure |
| Raw stored-ciphertext `OnBoard` | Returns failure |
| Stored `OnBoard` plus `OffBoardToUser` | Rejected |
| `ValidateCiphertext` plus `OffBoardToUser` | Rejected |
| Stored add plus user offboarding | Rejected |
| Stored multiply/divide plus user offboarding | Rejected |
| Stored comparison/mux plus user offboarding | Rejected |
| Plaintext-input full CPMM quote | Rejected |
| Plaintext-input full CPMM quote using deployment-time encrypted constants | Rejected |
| Authenticated-input full CPMM quote | Rejected |

The same `SetPublic`/`Decrypt` control succeeds in a mined transaction. The raw
precompile probe identifies `OnBoard` itself as the first failing operation under
`eth_call`: it returns failure even for ciphertext created and stored during the
probe deployment. Pre-creating encrypted zero, one, fee-denominator and net-fee
constants removes `SetPublic` from the quote, but still cannot avoid onboarding
the stored reserves and constants, so that complete path also reverts. This
isolates the boundary to fresh MPC precompile execution during `eth_call`, not
AES setup, authenticated input binding, CPMM arithmetic, gas limit or reserve
initialization.

Gasless private-token reads are consistent with this evidence.
`PrivateERC20.balanceOf(address)` returns caller-encrypted ciphertext already
stored by the token. It performs no `OnBoard`, arithmetic or new offboarding.
CipherDEX must onboard confidential reserves and compute a new result.

## Privacy properties

### Individual activity

The authenticated quote input and caller-encrypted result keep the requested
amount and output out of plaintext calldata, events, storage and errors. Swap,
liquidity, LP-share and slippage amounts remain confidential. Participant
addresses, pool, token pair, direction, timing, gas and success remain public
under the standard COTI PrivateERC20/EVM boundary.

### Aggregate pool state

Exact reserves, TVL and aggregate private LP supply remain ciphertext and are not
reencrypted to a privileged API. Protocol fee balances are separate encrypted
accounting and remain excluded from effective reserves.

### Active probing

For known fee and decimals:

`netIn = floor(amountIn * (10000 - feeBps) / 10000)`

`newReserveIn = reserveIn + netIn`

`retainedOut = ceil(reserveIn * reserveOut / newReserveIn)`

`amountOut = reserveOut - retainedOut`

A caller that obtains exact results for chosen inputs can estimate marginal
price from small probes and curve depth from varied probes. Multiple observations
can substantially constrain or recover effective reserves despite integer
rounding and concurrent state changes. Encryption protects each payload from
passive observers; it does not make a deterministic CPMM curve unknowable to the
party receiving exact quotes.

That weakness does not justify public reserves. Publishing every reserve update
would let all passive observers compare state transitions and infer individual
swap or liquidity deltas. Permissionless exact quoting and strong curve secrecy
are fundamentally in tension; the protocol documents that limitation rather than
claiming otherwise.

## Required answers

### 1. Why is quote input/output encrypted?

To compute against confidential reserves without publishing the caller's chosen
amount or result. The transaction fallback emits only a result encrypted for the
requesting identity.

### 2. Which guarantees does that provide?

It protects the numeric request and output from passive chain readers and
unrelated callers. It does not hide public transaction metadata, the request from
the chosen RPC operator, or the output from its intended recipient.

### 3. Can repeated quotes infer price or depth?

Yes. Exact chosen-input access reveals marginal price and curvature. Strong
reserve secrecy against an active funded quote operator is not a valid claim.

### 4. Can a walletless backend quote?

Yes, by operating a dedicated onboarded COTI EOA/AES quote identity and paying
for the encrypted request transactions. It cannot obtain a fresh MPC quote with
a gas-free `eth_call` on the tested runtime. The identity is non-custodial and
must never receive user funds or sign user swaps.

### 5. Can COTI MPC selectively disclose derived data?

Yes in transaction execution: public or authenticated values can participate in
MPC and a derived result can be reencrypted or deliberately decrypted. The
current testnet node refuses those fresh MPC operations under `eth_call`.
Disclosure safety remains a policy question, not merely a primitive capability.

### 6. What can be public without materially weakening amount privacy?

Canonical pool address, ordered token identities, decimals, approved fee tier,
privacy mode, protocol version, initialization status, factory provenance,
participant addresses already exposed by token interfaces, direction, timing and
public lock metadata. Reserves, TVL, aggregate shares, LP amounts, swap amounts,
outputs, slippage and liquidity amounts stay private.

### 7. What do integrations need?

Public pools need only factory discovery and read-only quoting. Confidential
integrations need:

1. a pinned factory, fee vault, protocol version and approved fee tiers;
2. factory and canonical-key verification for every candidate;
3. a separate protected quote EOA/AES key with minimal gas funds;
4. one fresh target/selector-bound input and transaction per candidate;
5. strict event correlation by caller, request ID and direction;
6. in-memory decryption and deterministic best-output selection;
7. fresh user-bound input and nonzero minimum output for direct pool execution;
8. no plaintext amount, result, ciphertext or key logging.

### 8. Keep, extend or redesign?

Keep the settlement privacy boundary and extend the integration surface with the
evidence-backed transaction fallback. Do not add public reserve-derived state or
a forwarding private router. Re-test gasless encrypted and plaintext-input paths
when the COTI runtime changes; if full MPC `eth_call` succeeds, replace only the
quote transport after parity and security review.

## Alternatives

| Model | Benefit | Cost or privacy consequence | Decision |
| --- | --- | --- | --- |
| MPC `eth_call` | Exact, gasless, no quote transaction history | Unsupported by tested runtime | Preferred future transport |
| Encrypted quote transaction | Exact and amount-confidential | Gas, latency, public metadata | Current explicit fallback |
| Public exact reserves | Simple universal routing | Reveals aggregate state and per-change deltas | Rejected |
| Public exact quote | Simple universal routing | Public active oracle over curve | Rejected |
| Public spot/TWAP | Analytics and rough routing | Persistent ratio/history disclosure; insufficient for slippage | Not embedded |
| Reencrypt reserves to one API | Cheap exact backend quotes | API learns reserves/deltas; centralized confidentiality trust | Rejected |
| Coarse or delayed snapshots | Lower-cost route filtering | Staleness, manipulation and explicit leakage budget | Future separate review |
| Generic confidential router | One execution surface | Breaks authenticated sender/target/selector binding | Rejected without official delegation |

## Operational boundary

- Use a quote identity distinct from deployer, treasury, LPs and users.
- Fund it only for bounded testnet quote gas.
- Rate-limit and serialize request handling; never reuse signed ciphertext.
- Keep decrypted outputs in memory only and use opaque correlation IDs.
- Do not retry an uncertain transaction blindly.
- Show cost and pending status honestly to any testnet client.
- Re-run `npm run testnet:quote-call-probe` against every target RPC/runtime.
- Treat any changed failure or newly successful primitive as a review trigger.

## Official references

- https://docs.coti.io/coti-documentation/how-coti-works/advanced-topics/precompiles
- https://docs.coti.io/coti-documentation/build-on-coti/tools/contracts-library/mpc-core
- https://docs.coti.io/coti-documentation/build-on-coti/guides/best-practices/careful-decrypting
- https://docs.coti.io/coti-documentation/build-on-coti/tools/contracts-library/tokens/private-erc20
