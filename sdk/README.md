# CipherDEX SDK Surface

The SDK surface is intentionally dependency-free. Discovery objects use the
versioned `DISCLOSURE_SCHEMA_VERSION` contract and must be rejected when the
version is unknown. It exports stable ABI
fragments and public pool-discovery types for dashboards, launchpads and third
parties. `privacyMode` is explicit: `0` is transparent public settlement and
`1` is amount-confidential settlement with private LP accounting. `2` is a
reserved, explicitly unsupported fully-confidential recipient/identity mode;
clients must reject it rather than infer support. Public pool users can also use the factory-gated quoter and
exact-input router ABI fragments. Private pool swaps and quotes remain
direct-to-pool because COTI encrypted inputs bind the caller and target
contract.

The SDK also validates privacy-minimal lock and launchpad migration records.
Those records contain only public pool/participant identity, disposition, lock
timing and lock identifiers; they do not contain private share amounts,
reserves, balances or encrypted payloads. Confidential pool discovery contains
identity and immutable configuration only.

See `docs/INTEGRATION_EXAMPLE.md` for the candidate discovery, dedicated quote
identity, direct execution and launchpad indexing boundaries.

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
any native-COTI swap fee. See `docs/FEE_ECONOMICS.md`.

`isConfidentialPoolDiscovery` validates only the untrusted JSON shape and remains
available for legacy read-only data. Before quoting or routing, callers must run
`verifyConfidentialPoolDiscovery` with the expected factory, fee vault and
protocol version plus an RPC-backed adapter. The verifier proves deployed code,
factory membership, canonical lookup and immutable pool metadata, then returns a
process-local verified value. `selectBestConfidentialPoolQuote` rejects raw or
serialized discoveries that have not passed that verification in the current
process. Patched execution uses protocol version 2 and `private-erc20-cpmm-v2`;
legacy version-1 records may be displayed but must not be silently promoted.

`selectBestConfidentialPoolQuote` compares decrypted outputs only as ephemeral
service-local values tied to one opaque request ID and direction. It is not a
public response schema and must not be used to publish exact quotes, reserves or
TVL. The user always creates fresh authenticated inputs and executes the selected
confidential pool directly.
