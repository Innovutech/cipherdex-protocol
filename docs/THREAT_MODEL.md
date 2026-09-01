# Threat Model

## Protected against in this phase

- public reserve/amount leakage from the pool implementation;
- public minimum-output leakage;
- reentrancy around token transfers;
- zero/identical token pairs and fee bounds;
- arithmetic overflow/underflow and division by zero;
- insufficient private liquidity and private share checks;
- replay of the same encrypted input digest at this pool;
- accidental donation of excess proportional liquidity;
- caller-controlled mutable fee or admin withdrawal paths.
- protocol-fee collection withdrawing LP-owned effective reserves or changing
  pool price;
- passing confidential tokens through the public fee-vault sweep ABI;
- administrator-controlled liquidity unlocks or withdrawals.
- unauthorized public LP mint/burn/escrow, forged LP-token provenance, or a
  permit replay withdrawing another holder's position;
- a wrapped-native administrator minting unbacked WCOTI or recovering backing;
- native periphery retaining token/native residue, stale allowances, or sending
  an unwrap to an attacker-selected intermediate recipient;
- native best execution trusting a frontend-selected pool, diverging from the
  allowed fee-tier policy, or leaving wrapper/router custody after settlement;
- a forced native transfer making WCOTI under-collateralized (it can only create
  excess backing because supply changes solely through deposit/withdraw);
- WCOTI becoming stranded through a direct or delegated transfer to the wrapper
  itself, or callback reentry withdrawing more native backing than was burned;
- stale signed inputs executing after their intended deadline.
- launchpad bootstrap changing an initialized pool or bypassing the factory,
  reviewed strategy and pinned-migrator boundary;
- launchpad price-bound checks bypassing the private normalized-price interval.
- launchpad bootstrap redirecting assets into an arbitrary caller-selected or
  creator-specific pool;
- launch-ID or protected-pool-slot squatting without the creator's exact signed
  migration authorization and the pinned migrator code identity;
- standard-pool initialization consuming a launch-protected initialization slot,
  or protected-pool commitment blocking the standard pool;
- failed or expired migration attempts leaving an empty reserved protected pool;
- completed launches being superseded or initialized twice;
- a completed protected pool becoming permanently unusable after every LP exits;
- a reused protected key accepting signed decimal metadata that differs from the
  already-deployed pool;
- EOA-only migration validation rejecting a creator contract whose ERC-1271
  signature the launch strategy accepted;
- proxy, metamorphic or replaced strategy/migrator code passing the recorded
  runtime-codehash/registration boundary;
- unmanaged private-token donations changing initial share or launchpad price
  state.
- pre-funding a deterministic confidential pool address blocking launchpad
  initialization; bootstrap uses transaction-scoped strategy-migrator escrow and exact
  pool balance deltas rather than requiring the raw pool balance to equal the
  accounting deposit;
- unmanaged public-token donations permanently blocking initialization;
- direct public-token transfers or positive rebases changing an initialized
  pool's price, proportional-liquidity ratio, LP shares or withdrawable reserves;
- permissionless surplus collection redirecting funds anywhere except the fixed
  protocol vault, or debiting stored LP reserves and accrued protocol fees;
- public swap/router/withdrawal minimums being satisfied by a nominal transfer
  while a taxed recipient receives less;
- caller-selected or noncanonical pools being injected into public best
  execution or escrow-order settlement;
- partial fills weakening the maker price through floor rounding, filling below
  the configured minimum size, or overpaying the native bounty;
- non-makers amending, reactivating, topping up, or cancelling public orders;
- failed routed fills consuming escrow, bounty, allowance, or terminal status;
- permissionless order-book surplus sweeps touching open token escrow, open
  bounties, deferred bounty credits, or redirecting proceeds away from the
  immutable beneficiary;
- untrusted confidential discovery metadata selecting a non-factory pool;
- stack exhaustion or getter execution while validating untrusted SDK metadata;
- the confidential core has no public spot, TWAP, reserve, TVL, or aggregate
  LP-supply publication path;
- caller-supplied pool substitution in confidential best execution; candidates
  come only from complete canonical factory keys selected through a bounded
  nine-bit approved fee/strategy-class bitmap;
- cross-selector/request ciphertext replay at the best-execution router;
- losing confidential candidate outputs being offboarded or logged;
- quote-only requests moving funds or mutating pool accounting;
- liquidity-preview requests moving funds, mutating reserve/share accounting or
  publishing the accepted amounts and expected shares in plaintext;
- position or removal-preview results being decrypted from a spoofed pool,
  caller, request, calldata, failed receipt or duplicate event;
- a non-owner reading active or locked private LP claims;
- successful atomic routing leaving input escrow or candidate allowance residue;
- selected settlement bypassing pool-owned fee, slippage, invariant, reserve,
  protocol-fee or exact-delta enforcement;
- arbitrary or lookalike LP-token helper code being accepted by the canonical
  factory, or a helper-created token being rebound to a different pool/issuer;
- a full LP exit receiving or stranding sub-threshold encrypted protocol fees;
- a noncanonical pool depositing encrypted fees into the protocol vault;
- confidential fee deposits leaving residual token allowance or bypassing exact
  encrypted vault balance-delta validation;

## Not solved by this phase

- MEV based on public participant, direction, timing or encrypted transaction
  ciphertext metadata;
- endpoint/RPC observers correlating private transactions and ciphertexts;
- defects, malicious behavior or upgrades in an external private-token
  implementation. Pool creation is permissionless for contracts that report the
  required interface and valid decimals. Canonical pools enforce exact encrypted
  balance deltas, but structural compatibility cannot prove token economics or
  honest semantics;
- compromise or misuse of COTI MPC/precompile/operator infrastructure;
- hidden recipient identity under the standard token event/interface;
- asynchronous PoD callback failures or cross-chain settlement;
- wallet/UI leakage before a transaction is encrypted;
- gasless confidential exact quoting on COTI runtimes that reject fresh MPC
  execution under `eth_call`; the paid best-quote transaction adds gas, latency
  and public caller/winning-pool/direction/timing metadata;
- best-quote or best-swap liveness when one canonical candidate itself reverts
  unexpectedly rather than returning an encrypted invalid result. Immutable
  reviewed pool/token code limits this to defects or external MPC failure; the
  router does not catch and reinterpret arbitrary failures;
- gas cost and block-limit headroom as more variants are considered. The router
  namespace is fixed to three fee tiers by three classes and accepts no
  caller-provided pool addresses. Paid quotes permit up to nine candidates, but
  only the three-candidate route has funded COTI gas evidence. Atomic execution
  remains capped at three. Integrations must measure larger deployed quote sets
  or use deterministic fresh-ciphertext quote batches;
- pool-state movement between a confidential liquidity preview and settlement.
  The preview reserves nothing; the later add must use fresh authenticated
  inputs, nonzero minimum shares, normalized price bounds and a deadline;
- public routed orders provide no MEV protection, pool-state reservation,
  off-chain signature/rebroadcast model, multi-hop routing or split execution.
  `canFillOrder` is advisory; state can move before inclusion. Editing the token
  pair, escrow amount or native settlement mode requires cancellation and a new
  order. Exact-transfer ERC-20 behavior is required for non-native escrow.
  Native COTI is wrapped only inside the order book; WCOTI is rejected from
  token-mode creation. Failed native output or cancellation delivery creates a
  beneficiary-owned proceeds liability, so availability depends on the
  beneficiary eventually claiming to a payable recipient, but fills and refunds
  cannot be redirected or swept by an outsider;
- public spot-route previews provide no pool-state reservation. The confirmed
  best-execution transaction re-evaluates every allowed canonical fee tier and
  may select a different pool than the preview. `minAmountOut` and the deadline
  remain the user's execution bounds. The native adapter adds no multi-hop or
  split routing and rejects direct pool injection;
- pool-state movement between a position/removal preview and settlement. Position
  results are informational; removal must recompute current values and enforce
  fresh encrypted minima and a deadline;
- active differencing of low-volume confidential fee batches by a beneficiary or
  adversary that already knows most constituent trades; pool count/time batching,
  fixed daily cross-pool epochs, terminal deposits and the vault sweep threshold
  reduce routine per-swap disclosure but cannot create unknown traffic;
- quote-identity key compromise, request logging or traffic analysis; the quote
  identity is non-custodial but learns its own requested outputs;
- whether a launchpad's encrypted allowances are economically scoped to its
  migration transaction; a malicious launchpad can still spend whatever allowance
  a creator explicitly grants it.
- creator-key compromise. A compromised creator can authorize and fund an atomic
  protected launch using that creator's own allowances, but cannot spend another
  account's private assets or alter the separate standard pool;
- denial of service by completing a valid funded launch for an unused protected
  key. There is no unfunded precommit state: failed, expired, or reverted
  migrations leave no pool or active launch record. Completed keys remain
  intentionally one-shot;
- rollback or replacement of the encrypted funded-run journal by a malicious
  administrator of the test host. The same host necessarily has access to the
  funded private/AES keys, so local authenticated storage cannot provide an
  independent monotonic freshness anchor. Exclusive compare-and-swap locking and
  atomic durable writes protect concurrent runners and crashes; backup restores
  require manual transaction reconciliation and prohibit automatic re-signing.
- malicious source that the operator intentionally reviews and commits. The
  funded runner can authenticate a reviewed commit and prevent post-review byte
  substitution, but code cannot establish its own trustworthiness. Source review
  and commit approval remain an operator trust boundary;
- compromise of the same OS identity that holds the funded environment. That
  identity can read the private/AES keys directly. Separate local ACLs cannot
  defend against it. The fresh authenticated private runtime, secret directory, build receipt,
  coordinator and recovery storage do reject other ordinary OS identities and
  fail closed on symlinks, hard links, changed source or changed runtime bytes;

## Independent-review scope

An external audit is not enforced by the deployment tooling. If an independent
review is commissioned, it should cover MPC input authenticity/replay semantics,
all token callbacks, gas griefing, pool initialization, LP rounding, event
linkability, precompile behavior under `eth_call`, and testnet-to-mainnet
compiler/deployment differences. No external audit is claimed.

All active deployed protocol components and the discovery schema report version
1. Development changes do not create compatibility generations. Integrations must
bind execution to the configured
factory, exact runtime codehashes, finalized strategy registry, one-time router
binding and each strategy's one-time migrator binding, fee vault, protocol
versions and complete canonical pool mapping.

## Observable confidential risks

- Consecutive buckets can reveal aggregate flow when an attacker knows or probes
  curve depth. Immediate bucket-crossing publication makes the triggering swap public
  and can narrow that swap's amount to a range; this is an explicit mode-2 tradeoff.
- An attacker can create probe swaps around bucket boundaries and combine those events
  with paid exact quotes to improve its estimate of confidential depth and flow.
- Indicative prices can be stale during inactivity or intentionally bounded during
  extreme movement. Integrations must show age and use paid encrypted quotes for
  exact execution.
- Every swap evaluates the MPC bucket and a crossing swap also pays public-decryption
  and storage gas. The crossing cannot be predicted publicly, so all mode-2 swaps must
  use the reviewed publication-capable gas envelope; out-of-gas reverts atomically.
- Boundary manipulation can affect chart buckets. The bucket must not be used as a
  collateral oracle, execution oracle or authoritative `minOut`.
- Empty pool creation cannot lock an initial reference. The reference is committed
  only by a successful first-liquidity transaction, and a malicious reference cannot
  activate a misleading pool unless the confidential actual price lies between
  one-half and twice that reference. As with other permissionless AMMs, the first
  funded initializer still controls the initial market price.
- Pool creation code is reconstructed only from immutable constructor-created stores,
  checked against its canonical hash and deployed through a factory-pinned deployer.
- A full exit can leave one-to-seven same-token protocol-fee events below the vault's
  immutable sweep threshold. Strict privacy deliberately provides no sub-threshold
  rescue, so rare-token fees may remain unavailable until later same-token activity.
  This affects protocol revenue availability, not LP reserves or user withdrawals.
