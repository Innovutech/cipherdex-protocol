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
- launchpad bootstrap changing an initialized pool or bypassing the factory
  bootstrapper boundary;
- launchpad price-bound checks bypassing the private normalized-price interval.
- launchpad bootstrap redirecting assets into a creator-specific parallel pool;
- unmanaged private-token donations changing initial share or launchpad price
  state.
- pre-funding a deterministic confidential pool address blocking launchpad
  initialization; bootstrap uses transaction-scoped adapter escrow and exact
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
  come only from canonical factory keys and approved v1 fee tiers;
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
- defects or compromise in a reviewed PrivateERC20 implementation admitted by
  the immutable factory codehash policy. Canonical pools reject other runtime
  codehashes, verify the private-token interface and enforce exact encrypted
  balance deltas, but those checks cannot prove the economics of an approved
  implementation. Mutable proxy and metamorphic implementations must not be
  approved;
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
- gas cost and block-limit headroom as additional fee tiers are considered. V1
  is hard-bounded to three tiers and has no caller-controlled candidate loop;
- active differencing of low-volume confidential fee batches by a beneficiary or
  adversary that already knows most constituent trades; pool count/time batching,
  fixed daily cross-pool epochs, terminal deposits and the vault sweep threshold
  reduce routine per-swap disclosure but cannot create unknown traffic;
- quote-identity key compromise, request logging or traffic analysis; the quote
  identity is non-custodial but learns its own requested outputs;
- whether a launchpad's encrypted allowances are economically scoped to its
  migration transaction; a malicious launchpad can still spend whatever allowance
  a creator explicitly grants it.
- launch availability after another participant initializes the canonical pool;
  migration fails closed before MPC work or token movement, but the permissionless
  factory does not reserve a pair for a launch creator or create an alternate pool.

## Required review before release

Independent review must cover MPC input authenticity/replay semantics, all token
callbacks, gas griefing, pool initialization, LP rounding, event linkability,
precompile behavior under `eth_call`, and testnet-to-mainnet compiler/deployment
differences. No external audit is claimed.

Pool/factory execution contracts report protocol version 2, the confidential
best-execution router reports version 1, and the launchpad migrator reports
version 3. Integrations must bind execution to the configured factory, its
one-time router, fee vault, protocol versions and canonical pool mapping.
