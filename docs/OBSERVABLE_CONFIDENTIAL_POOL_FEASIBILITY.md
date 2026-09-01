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
