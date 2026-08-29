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

The SDK also exports exact-by-default public and private token approval planning,
canonical confidential-operation signature/transaction steps, and optional
EIP-5792 v2 wallet-call preparation. Every sufficient existing allowance is
reused in either approval mode. When approval is required, exact/unlimited selects
the new target and an insufficient nonzero allowance produces an ordered zero
reset first. The private planner returns plaintext amounts for the application to
encrypt with the official COTI SDK; CipherDEX never handles AES keys or
ciphertexts. Capability parsing, batching and status normalization are
dependency-free and provider-agnostic: clients query their connected wallet, use
a prepared batch only when supported, and retain sequential execution as the
fallback. Partial non-atomic batches involving approvals are marked for explicit
allowance review. The SDK never signs, sends, polls or persists wallet requests.

Confidential operation transaction steps are explicitly marked and prepared
wallet calls preserve an optional `gasLimit`. When the wallet reports atomic
batching as `supported` or `ready`, the SDK retains standard EIP-5792 atomic
execution without adding per-call gas metadata; the wallet owns the combined
execution gas. For non-atomic confidential batches with explicit limits, the SDK
uses `wallet_sendCalls` only when the active chain, or global `0x0`, advertises
`org.ciphertrade.callGasLimit: { supported: true }`. Each applicable call then
carries `{ gasLimit: "0x..." }` inside that call-level capability. Otherwise the
plan remains sequential with the original bigint limits intact. Ordinary
batching without confidential gas limits is unchanged, and the SDK never emits
the nonstandard EIP-5792 `gas` field.

`classifyCipherDexExecutionError` recognizes the protocol's exact
`TransferAmountMismatch()` selector through bounded, getter-free nested error
inspection and returns a stable `token-transfer-amount-mismatch` issue with
operation context. `preflightCipherDexTransaction` wraps a provider-specific
gas estimator: known transfer-semantics failures become a structured gate,
while unrelated RPC or execution failures remain exceptions. Applications own
localized wording and token capability policy; the SDK does not hardcode token
addresses or assume a tax-token classification remains permanent.

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

For an existing public pool, use `previewPublicProportionalLiquidity` with the
current effective reserves, total LP shares, a typed `"token0" | "token1"`
specified side and its raw-unit amount. The helper mirrors the pool's
full-precision `mulDiv` behavior: shares round down and accepted token amounts
round up. The two submitted amounts are maxima, not promised deposits; the
liquidity router refunds excess. After confirmation,
`parsePublicLiquidityRoutedResult` authenticates the successful transaction,
reviewed router and provider before returning the pool, creation flag, actual
amounts, minted shares and refunds.

`isEvmNativeAssetAddress` recognizes the standard `0xEeee...` UI/RPC sentinel.
`resolvePublicPoolAsset` maps that sentinel to the reviewed WCOTI address for
pool lookup. `buildPublicSwapExecution`,
`buildPublicNativeLiquidityAddExecution`, and the removal builder select the
factory-bound native router when wrapping or unwrapping is required. The
sentinel is never a contract address, approval target, or canonical pool asset.
`parseNativeLiquidityAddedResult` authenticates both the native-router event and
its nested public-liquidity-router event before returning actual native/token
amounts, minted shares, creation state and derived refunds.

`buildConfidentialLiquidityQuoteCall` and
`buildConfidentialAddLiquidityQuoteOperationPlan` cover the paid private
liquidity preview. The preview takes one encrypted side and returns the accepted
specified amount, counterpart and expected shares encrypted for the caller; it
does not reserve state or replace the bounded `addLiquidity` settlement call.
`parseConfidentialAddLiquidityQuoteResult` authenticates the typed event boundary
and maps its specified/counterpart ciphertexts to token0/token1. Decryption stays
in the connected wallet integration; the SDK never receives an AES key.

For every existing pool, users specify one side and the application derives the
other proportionally. Editing either displayed amount invalidates a confidential
preview: generate a new request ID, new function-bound ciphertext and new paid
preview before confirmation. Only new-pool initialization treats both amounts
as the initial price ratio. In every flow, the confirmed router events are
authoritative; a local preview is presentation and slippage-planning data, not
settlement evidence.

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

Authoritative production addresses, deployment transactions, runtime codehashes,
compiler settings and exact source commit are published in the reviewed
`deployments/coti-mainnet-b99c41abc031754990d4efcaaf1baa6754b3bb1e.json`
record. Integrations must pin and validate that manifest's factories, routers,
fee vault and protocol versions rather than copying address constants into
multiple SDK modules. Historical `coti-testnet-<commit>.json` manifests remain
test evidence only and are not production registries.

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
