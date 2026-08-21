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
- stale signed inputs executing after their intended deadline.
- launchpad bootstrap changing an initialized pool or bypassing the factory,
  reviewed strategy and pinned-migrator boundary;
- launchpad price-bound checks bypassing the private normalized-price interval.
- launchpad bootstrap redirecting assets into an arbitrary caller-selected or
  creator-specific pool;
- launch commitment squatting without both creator and launch-authority
  authorization;
- standard-pool initialization consuming a launch-protected initialization slot,
  or protected-pool commitment blocking the standard pool;
- expired/canceled protected pools becoming permissionlessly initializable;
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
- public swap/router/withdrawal minimums being satisfied by a nominal transfer
  while a taxed recipient receives less;
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
  namespace is fixed to three fee tiers by three classes, rejects more than three
  active candidates, and accepts no caller-provided pool addresses;
- active differencing of low-volume confidential fee batches by a beneficiary or
  adversary that already knows most constituent trades; pool count/time batching,
  fixed daily cross-pool epochs, terminal deposits and the vault sweep threshold
  reduce routine per-swap disclosure but cannot create unknown traffic;
- quote-identity key compromise, request logging or traffic analysis; the quote
  identity is non-custodial but learns its own requested outputs;
- whether a launchpad's encrypted allowances are economically scoped to its
  migration transaction; a malicious launchpad can still spend whatever allowance
  a creator explicitly grants it.
- abandonment of an empty launch-protected pool. Cancellation/expiry allow a
  later fully authorized commitment to reuse that same protected complete key,
  but neither condition recovers deployment gas or converts it to a standard pool;
- creator-key compromise alone cannot commit a protected launch without the
  fixed launch authority. Launch-authority compromise remains an admission and
  liveness trust failure: the authority can create and co-sign with a second
  self-controlled creator identity, fund that launch and occupy an unused
  protected key. It still cannot spend an honest creator's assets, alter the
  separate standard pool or bypass exact migration funding and authorization;
- denial of service by a valid authorized commitment occupying one protected key
  until cancellation or expiry. The standard pool and other reviewed strategy
  identities remain unaffected.
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

## Required review before release

Independent review must cover MPC input authenticity/replay semantics, all token
callbacks, gas griefing, pool initialization, LP rounding, event linkability,
precompile behavior under `eth_call`, and testnet-to-mainnet compiler/deployment
differences. No external audit is claimed.

Public pool/factory contracts report version 2; confidential pool/factory
contracts report version 3; the best-execution router reports version 2; the
launchpad migrator reports version 4; and the strategy, registry and pool
deployer report version 1. Integrations must bind execution to the configured
factory, exact runtime codehashes, finalized strategy registry, one-time router
binding and each strategy's one-time migrator binding, fee vault, protocol
versions and complete canonical pool mapping.
