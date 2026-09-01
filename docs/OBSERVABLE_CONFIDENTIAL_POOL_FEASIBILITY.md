# Observable Confidential Pool Feasibility

Status: isolated testnet experiment; not a production protocol design.

## Boundary

The deployed privacy-mode-1 contracts remain unchanged. This study evaluates a
separate future privacy mode that intentionally publishes a quantized price while
retaining confidential reserves, depth, token amounts, LP positions and exact
quotes.

The baseline design is permissionless and entirely in-pool. No keeper or funded
updater is required. A state-changing pool operation increments a public activity
counter. Once both an immutable time interval and minimum activity count are met,
that operation derives and quantizes the normalized reserve ratio inside MPC and
publishes only the bucket. The paid encrypted exact-quote path remains authoritative
for execution.

An optional updater may be studied later, but it is not part of the baseline and
must never be required for pool liveness.

## Experiment

`MpcObservablePriceProbe` is a disposable testnet-only contract. It implements the
same net-input fee calculation and ceiling-rounded retained-reserve CPMM transition
as `ConfidentialCPMM`, but it does not transfer or custody tokens. This isolates the
incremental MPC and storage cost of market-data publication from private-token
transfer costs.

The funded runner measures:

1. a baseline confidential swap-like transition with observations disabled;
2. lazy non-closing transitions;
3. an immediate closing transition that decrypts the current quantized bucket;
4. a delayed first close that stores an encrypted pending bucket;
5. a delayed later close that publishes the prior bucket and stores the next one.

Quantization is performed before public decryption. The experiment uses a fixed
per-pool quantum to measure the minimum viable MPC path. A production design must
resolve how bucket resolution behaves across large long-term price movements before
deployment.

## Threat Model

Quantization does not make deterministic market state secret. The inference model
assumes a strong attacker who already knows exact opening reserves, knows the public
swap direction, and observes one closing bucket. This is stronger than a passive
observer but realistic for a launch participant or an active exact-quote prober.

Minimum activity prevents a bucket from being directly attributed to one ordinary
operation, but it does not hide aggregate same-direction flow. Sparse activity,
attacker-created probe swaps, known LP actions, and a dominant trade inside an epoch
can materially improve inference. A one-epoch delay separates timing but does not
remove that information.

## Decision Gate

No production implementation should proceed until the testnet evidence establishes:

- ordinary non-closing overhead;
- immediate and delayed closing overhead;
- correct MPC-side quantization and delayed publication;
- acceptable bucket precision and cadence under the inference model;
- bounded manipulation behavior and explicit chart/TWAP semantics.

The final recommendation must distinguish public indicative market data from exact
execution quotes and must not claim that individual trade amounts are impossible to
infer in every activity pattern.

## COTI Testnet Results

Run date: 2026-09-01

Source commit: `6e389901ba6045e3440534d940cbb7b9d75f87da`

Chain ID: `7082400`

The authenticated runner compiled the exact clean commit, deployed three disposable
no-token probes, validated immediate and delayed buckets against the reference CPMM
model, closed every probe, and completed its recovery journal.

| Transition | Gas used | Increment over baseline |
| --- | ---: | ---: |
| Baseline confidential transition | 3,212,861 | - |
| Lazy immediate, non-closing 1 | 3,218,009 | 5,148 |
| Lazy immediate, non-closing 2 | 3,217,985 | 5,124 |
| Lazy immediate, closing | 6,878,024 | 3,665,163 |
| Delayed first close, store pending | 6,950,814 | 3,737,953 |
| Delayed later close, publish prior | 7,054,133 | 3,841,272 |

Transaction evidence:

- baseline: `0x00466a013887bfbf64f1ed353d947447c8959b573d7a696866e9285d478eab82`
- immediate non-closing 1: `0x24f6e9f805a6b94ef93981b4c21df559bb7809456afaf4ef86d68a11491ab094`
- immediate non-closing 2: `0x7c668c30a4dd3a3890b9260f09fe7ef13d253215fe56d749e033b0471db2d3fe`
- immediate closing: `0x7bdeeac183e1af5c9afa30a5f829d0f2333c5473e9e3c7ace8bfc4923f376135`
- delayed first close: `0x88bba08dae48a8cc21f7d720e9fbe4fd9adfa5f64e51076a310622d81bebe99f`
- delayed publishing close: `0x985f2e63124c05908587903b4b307f1ec43d56c4317ceeb2f61c3a1b2a2c5d5a`

The non-closing overhead is about 0.16% of this arithmetic-only baseline. Immediate
publication adds about 3.67 million gas. Delayed publication adds about 3.84 million
gas when it both reveals the prior bucket and seals the next one. These totals exclude
private-token transfers and other complete-pool settlement work, so they establish the
absolute publication increment rather than a final production-swap percentage.

The validated immediate bucket was `1.87e18`; the delayed publication correctly
revealed the prior epoch's `1.94e18` bucket instead of the current state.

## Inference Results

The deterministic model used 1,000,000 token0 units, 2,000,000 token1 units, a
30-bps fee, known opening reserves and public same-direction swaps. Bucket widths are
relative to the initial price.

| Bucket | Operations | Actual aggregate input | Candidate aggregate range | Range width vs input |
| ---: | ---: | ---: | ---: | ---: |
| 25 bps | 1 | 3,000 | 2,518-3,783 | 42.16% |
| 25 bps | 3 | 15,000 | 14,084-15,393 | 8.72% |
| 25 bps | 5 | 39,000 | 38,465-39,870 | 3.60% |
| 50 bps | 1 | 3,000 | 2,518-5,053 | 84.50% |
| 50 bps | 3 | 15,000 | 12,779-15,393 | 17.42% |
| 50 bps | 5 | 39,000 | 37,064-39,870 | 7.19% |
| 100 bps | 1 | 3,000 | 2-5,053 | 168.36% |
| 100 bps | 3 | 15,000 | 10,184-15,393 | 34.72% |
| 100 bps | 5 | 39,000 | 37,064-42,701 | 14.45% |

No tested bucket uniquely identified even the single 3,000-unit input. With multiple
operations, individual splits are not recoverable from the closing bucket alone.
However, larger aggregate movement becomes relatively easier to estimate. An active
attacker can also subtract its own probe trades, so a minimum operation count must not
be described as complete individual-amount protection.

## Recommendation

The in-pool lazy design is technically feasible without a keeper. It should remain a
separate privacy mode so mode 1 and its existing threat model stay unchanged.

For a production prototype:

- use immutable time and activity thresholds and expose the counter so the closing
  gas cost is predictable;
- use one-epoch-delayed publication when the additional roughly 176,000 gas over
  immediate closing is acceptable;
- publish the quantized initial launch price so a new pool is discoverable before its
  second active epoch;
- keep paid encrypted quotes authoritative for exact minimum output and settlement;
- publish no reserves, depth, amount volume or exact OHLC values;
- make any separately funded updater strictly optional;
- design and test an adaptive quantizer before production because a fixed launch-price
  quantum becomes too precise after large appreciation and too coarse after large
  depreciation;
- treat indexer candles and TWAP as approximate observations with explicit timestamps,
  activity counts and staleness.

The random epoch-closing trader still pays an additional 3.7-3.8 million gas. With no
keeper or subsidy, that cost cannot be eliminated: some state-changing transaction must
execute the MPC price calculation and public decryption. It can only be made predictable,
less frequent, or distributed differently.
