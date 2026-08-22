# CipherDEX SDK Surface

The SDK surface is intentionally dependency-free. Discovery objects use the
versioned `DISCLOSURE_SCHEMA_VERSION` contract and must be rejected when the
version is unknown. It exports stable ABI
fragments and public pool-discovery types for dashboards, launchpads and third
parties. `privacyMode` is explicit: `0` is transparent public settlement and
`1` is amount-confidential settlement with private LP accounting. `2` is a
reserved, explicitly unsupported fully-confidential recipient/identity mode;
clients must reject it rather than infer support. Public pool users can use the
factory-gated quoter and exact-input router ABI fragments. Confidential pool
discovery reports `encrypted-transaction-event-v1`: current COTI testnet requires
paid MPC transactions because fresh MPC execution is rejected under `eth_call`.
Paid per-pool transactions are the only proven primary exact-quote transport.
The confidential router can evaluate a bounded factory-derived set in one paid
transaction, but it is not gasless and becomes a preferred integration path only
after a fresh funded deployment proves the final router. Per-pool transactions
remain direct protocol operations rather than being mislabeled as a fallback.

The SDK also exports exact-by-default token approval planning, canonical
confidential-operation signature/transaction steps, and optional EIP-5792 v2
wallet-call preparation. Capability parsing, batching and status normalization
are dependency-free and provider-agnostic: clients query their connected wallet,
use a prepared batch only when supported, and retain sequential execution as the
fallback. Partial non-atomic batches involving approvals are marked for explicit
allowance review. The SDK never signs, sends, polls or persists wallet requests.

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
discovery schema. Use the official COTI SDK and the caller's AES key for
caller-specific ciphertext preparation and decryption. Factory-created
confidential pools expose a pool-bound `PrivateLPToken`; its ABI fragment is
available for encrypted LP transfers and approvals, while aggregate
`totalSupply()` must not be used as a private-supply oracle.

Discovery schema version 6 also binds every pool to the immutable CipherDEX v1
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
returns a process-local verified value. Confidential protocol version 3 uses
`private-erc20-cpmm-v3` and includes the initialization strategy, strategy class,
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

Launch integrations should build the EIP-712 value with
`buildConfidentialLaunchCommitment`, sign `LAUNCH_COMMITMENT_EIP712_TYPES` with
both creator and launch-authority identities, then build immutable calldata with
`buildConfidentialLaunchCommitCall`. These builders canonicalize token order and
pin confidential protocol version 3 and privacy mode 1; they do not sign or hold
keys. Discovery must distinguish a standard pool (`initializationStrategy` zero,
class 0), an empty committed launch pool, and an initialized active launch pool.
