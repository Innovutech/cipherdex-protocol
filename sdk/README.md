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
one encrypted transaction per fee-tier candidate because fresh MPC execution is
rejected under `eth_call`.

The SDK also validates privacy-minimal lock and launchpad migration records.
Those records contain only public pool/participant identity, disposition, lock
timing and lock identifiers; they do not contain private share amounts,
reserves, balances or encrypted payloads. Confidential pool discovery contains
identity and immutable configuration only.

See `docs/INTEGRATION_EXAMPLE.md` for discovery, current routing gates, public
execution and launchpad indexing boundaries.

The current authoritative COTI testnet addresses, deployment transactions,
runtime codehashes, compiler settings and exact source commit are published once
in `deployments/coti-testnet-latest.json`. Integrations should pin and validate
that manifest's factory, fee vault and protocol version rather than copying
address constants into multiple SDK modules. The manifest is testnet-only and is
not a mainnet registry.

Private amounts, reserves, balances and LP positions are not represented in the
discovery schema. Use the official COTI SDK and the caller's AES key for
caller-specific ciphertext preparation and decryption. Factory-created
confidential pools expose a pool-bound `PrivateLPToken`; its ABI fragment is
available for encrypted LP transfers and approvals, while aggregate
`totalSupply()` must not be used as a private-supply oracle.

Discovery schema version 5 also binds every pool to the immutable CipherDEX v1
fee policy and fee vault. Integrations can present the complete total fee and
its LP/protocol split without exposing accrued confidential amounts. The SDK's
`calculateCipherDEXV1FeeBreakdown` mirrors pool integer rounding; it does not add
any native-COTI swap fee. A confidential quote/settlement must not be submitted
when its calculated `protocolFee` is zero because that pool mode rejects
zero-accrual dust swaps to protect aggregate collection batching. Public pools
do not need that privacy-specific restriction. Use
`minimumCipherDEXV1ConfidentialInput` to determine the raw-unit floor for an
approved confidential fee tier. See `docs/FEE_ECONOMICS.md`.

`isConfidentialPoolDiscovery` validates only the untrusted JSON shape. Before
trusting a discovery record, callers must run
`verifyConfidentialPoolDiscovery` with the expected factory, fee vault and
protocol version plus an RPC-backed adapter. The verifier proves deployed code,
factory membership, canonical lookup and immutable pool metadata, then returns a
process-local verified value. Protocol version 2 uses
`private-erc20-cpmm-v2`. Only verified records may enter confidential quote
selection.

The confidential factory also exposes its immutable approved private-token
runtime codehashes. Deployment and integration policy must verify both token
addresses with `isApprovedPrivateToken` on that exact factory; the confidential
discovery verifier requires this adapter check. The allowlist is an
implementation trust boundary, not token discovery metadata: do not approve mutable proxy or
metamorphic code, and deploy a reviewed new factory to support another token
implementation.

Current COTI nodes reject MPC precompile execution under `eth_call`; raw stored
ciphertext `OnBoard` is the first isolated failing primitive, and pre-stored
encrypted constants do not remove that requirement. A walletless
backend can operate a dedicated non-custodial COTI quote identity, submit a fresh
pool-bound encrypted request, decrypt only its result, and compare verified
canonical candidates with `selectBestConfidentialPoolQuote`. Every evaluation
must carry the same exact process-local `amountIn`, request ID and direction so
results for different inputs cannot be compared accidentally. That identity must
not hold user funds or sign swaps. Integrators must disclose quote latency/cost,
use fresh user-bound inputs for execution, and never substitute zero minimum
output or a public reserve approximation.
