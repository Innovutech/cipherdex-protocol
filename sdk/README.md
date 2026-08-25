# CipherDEX SDK Surface

The SDK surface is intentionally dependency-free. Discovery objects use the
versioned `DISCLOSURE_SCHEMA_VERSION` contract and must be rejected when the
version is unknown. It exports stable ABI
fragments and public pool-discovery types for dashboards, launchpads and third
parties. `privacyMode` is explicit: `0` is transparent public settlement and
`1` is amount-confidential settlement with private LP accounting. `2` is a
reserved, explicitly unsupported fully-confidential recipient/identity mode;
clients must reject it rather than infer support. Public pool users can use the
factory-gated quoter, exact-input router and atomic create-or-add liquidity
router ABI fragments. Confidential pool
discovery reports `encrypted-transaction-event-v1`: current COTI testnet requires
paid MPC transactions because fresh MPC execution is rejected under `eth_call`.
Paid per-pool transactions are the only proven primary exact-quote transport.
The confidential router can evaluate up to the complete nine-slot canonical
fee/strategy namespace in one paid quote transaction. Atomic best execution is
limited to three candidates because only that execution bound has funded COTI
gas evidence. Larger quote sets require live-runtime measurement before release.
Per-pool transactions remain direct protocol operations rather than being
mislabeled as a fallback.

The SDK also exports exact-by-default token approval planning, canonical
confidential-operation signature/transaction steps, and optional EIP-5792 v2
wallet-call preparation. Capability parsing, batching and status normalization
are dependency-free and provider-agnostic: clients query their connected wallet,
use a prepared batch only when supported, and retain sequential execution as the
fallback. Partial non-atomic batches involving approvals are marked for explicit
allowance review. The SDK never signs, sends, polls or persists wallet requests.

`buildConfidentialCandidateBitmap` derives the active bitmap from the standard
class plus the factory's finalized registered strategy count.
`partitionConfidentialQuoteCandidateBitmap` deterministically groups that bitmap
when a live chain cannot fit one larger paid quote. Each group requires a fresh
request ID and encrypted input. `buildConfidentialQuoteOperationPlan` accepts the
resulting batch count so signing UI can present the real number of signatures and
transactions instead of hiding them.

`PUBLIC_CPMM_LIQUIDITY_ROUTER_ABI` and
`buildPublicCreateOrAddLiquidityCall` cover atomic public pool creation/seeding
and proportional joins. Public pools expose transferable permit-enabled LP
tokens. `buildPublicLpPermitTypedData` prepares the EIP-2612 signature, while
`buildPublicLiquidityRemovalExecution` selects allowance or permit removal and
native or ERC-20 output without signing or sending anything.

`isEvmNativeAssetAddress` recognizes the standard `0xEeee...` UI/RPC sentinel.
`resolvePublicPoolAsset` maps that sentinel to the reviewed WCOTI address for
pool lookup. `buildPublicSwapExecution`,
`buildPublicNativeLiquidityAddExecution`, and the removal builder select the
factory-bound native router when wrapping or unwrapping is required. The
sentinel is never a contract address, approval target, or canonical pool asset.

`buildConfidentialLiquidityQuoteCall` and
`buildConfidentialAddLiquidityQuoteOperationPlan` cover the paid private
liquidity preview. The preview takes one encrypted side and returns the accepted
specified amount, counterpart and expected shares encrypted for the caller; it
does not reserve state or replace the bounded `addLiquidity` settlement call.

The SDK exposes shape parsers and semantic guards for privacy-minimal lock and
launchpad migration records. Shape or semantic validity is not chain
authentication. Integrations must use `verifyLaunchpadMigrationMetadata` with a
reviewed deployment policy and an RPC-backed adapter before treating indexed
migration metadata as protocol evidence. The verifier authenticates the
successful transaction and exact emitter logs, configured factory/migrator
binding, canonical pool, immutable pool metadata and current public `lockInfo`.
Migrator provenance is read from the expected initialization strategy itself;
there is no factory-global launch adapter to conflate independent strategy
classes.
Those records contain only public pool/participant identity, disposition, lock
timing and lock identifiers; they do not contain private share amounts,
reserves, balances or encrypted payloads. Confidential pool discovery contains
identity and immutable configuration only.

See `docs/INTEGRATION_EXAMPLE.md` for discovery, current routing gates, public
execution and launchpad indexing boundaries.

Authoritative COTI testnet addresses, deployment transactions, runtime
codehashes, compiler settings and exact source commit are published only in a
reviewed immutable `deployments/coti-testnet-<commit>.json` record. Integrations should pin and validate
that manifest's factory, fee vault and protocol version rather than copying
address constants into multiple SDK modules. The manifest is testnet-only and is
not a mainnet registry.

Private amounts, reserves, balances and LP positions are not represented in the
discovery schema. The confidential pool instead exposes paid, owner-targeted
position results. `decryptConfidentialPositionResult` authenticates the exact
chain, verified pool, caller, calldata, request ID, successful receipt and unique
result event before decrypting active, removal-preview or locked-position values.
`readConfidentialActiveShares` adapts the existing no-MPC `myShares` ciphertext,
while `readConfidentialTokenAllowance` selects the owner ciphertext from the
official private-token allowance response. Integrations supply COTI decryption
adapters; the SDK never receives or stores an AES key. Factory-created
confidential pools expose a pool-bound `PrivateLPToken`; its ABI fragment is
available for encrypted LP transfers and approvals, while aggregate
`totalSupply()` must not be used as a private-supply oracle.

Discovery schema version 1 also binds every pool to the immutable CipherDEX v1
fee policy and fee vault. Integrations can present the complete total fee and
its LP/protocol split without exposing accrued confidential amounts. The SDK's
`calculateCipherDEXV1FeeBreakdown` mirrors pool integer rounding; it does not add
any native-COTI swap fee. A confidential quote/settlement must not be submitted
when its calculated `protocolFee` is zero because that pool mode rejects
zero-accrual dust swaps to protect aggregate collection batching. Public pools
do not need that privacy-specific restriction. Use
`minimumCipherDEXV1ConfidentialInput` to determine the raw-unit floor for an
approved confidential fee tier. See `docs/FEE_ECONOMICS.md`.

`isConfidentialLockDiscoveryShape` and
`isLaunchpadMigrationMetadataShape` only parse exact untrusted JSON shapes.
`isConfidentialLockDiscovery` and `isLaunchpadMigrationMetadata` additionally
reject impossible disposition, lock-ID and unlock-time combinations, but still
do not prove that an event happened on-chain. Only
`verifyLaunchpadMigrationMetadata` returns process-local verified migration
evidence. It authenticates the successful receipt, exact expected-migrator
events, canonical factory/pool state and current lock state. It intentionally
does not require the migration call to be the top-level transaction, so an
ERC-1271 account may execute through its wallet or entry-point contract without
being rejected as false provenance.

`isConfidentialPoolDiscovery` validates only the untrusted JSON shape. Before
trusting a discovery record, callers must run
`verifyConfidentialPoolDiscovery` with the expected factory, fee vault and
protocol version, plus the expected private LP-token factory and its reviewed
runtime codehash, through an RPC-backed adapter. The verifier proves deployed
code, factory membership, canonical lookup, immutable pool metadata, the
factory's helper address/codehash constant, helper runtime codehash, LP-token
code, and exact `(pool, token, canonicalFactory)` issuance attestation before it
returns a process-local verified value. The current protocol uses
`private-erc20-cpmm-v1` and includes the initialization strategy, strategy class,
standard/launch-protected class and initialized state. Canonical lookup is for
the complete key `(ordered pair, fee tier, privacy mode, protocol version,
initialization strategy)`. Only verified, initialized records may enter quote
selection.

The confidential factory exposes `isCompatiblePrivateToken` as a structural
check over deployed code, the official COTI `IPrivateERC20` ERC-165 identifier
and supported decimals. The discovery verifier requires the adapter's
`isFactoryPrivateTokenCompatible` check for both assets. This is not a token
approval, reputation or economic-safety signal: any compatible external token
may create a pool, while malicious or broken semantics remain an external-token
trust risk. Exact runtime-codehash verification remains required for
CipherDEX-owned helpers, factories, routers and initialization strategies.

Current COTI nodes reject MPC precompile execution under `eth_call`; raw stored
ciphertext `OnBoard` is the first isolated failing primitive, and pre-stored
encrypted constants do not remove that requirement. Verify the configured
router with `verifyConfidentialBestExecutionRouter` before using it. Then use
`getConfidentialBestExecutionEncryptionBinding` with the official COTI wallet,
followed by `buildVerifiedConfidentialBestQuoteTransaction` or
`buildVerifiedConfidentialBestSwapTransaction`. Result events must be bound to
that verified emitter, expected caller and request ID before
`decryptConfidentialBestExecutionResult` is called. Verification is chain-bound,
and decryption requires the adapter to fetch the authentic submitted transaction
and successful receipt by the expected transaction hash, then verify the exact
submitted calldata, router result log and a fresh canonical-pool lookup. Application code cannot
provide a caller-authored transaction or receipt as provenance evidence.

Addresses and runtime codehashes supplied to router verification must come from
the reviewed deployment record, not an indexer response. The RPC adapter is an
explicit trusted chain-data boundary. If one RPC is not trusted, use the wallet
provider or an independent quorum; a single adversarial RPC can fabricate a
self-consistent chain view and is outside what ordinary JSON-RPC reads can prove.

A walletless backend can operate a dedicated non-custodial COTI quote identity
and submit one fresh router-bound best-quote request. That identity must not hold
user funds or sign swaps. Paid per-pool quote transactions remain the proven
primary direct operation; the SDK does not turn caller-authored decrypted
outputs into execution-grade route evidence. Integrators must disclose quote
latency/cost, use fresh router/swap-selector-bound inputs for execution, and
never substitute zero minimum output or a public reserve approximation.

The default best quote covers the three standard fee tiers. Candidate-aware paid
quotes accept at most `MAX_CONFIDENTIAL_QUOTE_CANDIDATES` (nine), while atomic
swaps accept at most `MAX_CONFIDENTIAL_ATOMIC_SWAP_CANDIDATES` (three). Do not use
`ALL_CONFIDENTIAL_CANDIDATE_BITMAP` unless the factory actually has all three
pool classes; inactive strategy bits are invalid rather than empty candidates.

Launch integrations should encrypt all five private inputs for the exact migrator
and selector, then sign `LAUNCHPAD_MIGRATION_EIP712_TYPES` once with the creator.
That authorization binds the strategy, caller, pair/decimals, fee tier, ordered
encrypted inputs, deadline and LP disposition. The migration atomically creates
and initializes the protected pool; there is no launch-authority precommit.
Discovery must distinguish a standard pool (`initializationStrategy` zero, class
0) from an initialized protected pool and must not route uninitialized pools.
