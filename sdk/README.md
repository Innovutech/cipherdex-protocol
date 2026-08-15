# CipherDEX SDK Surface

The SDK surface is intentionally dependency-free. It exports stable ABI
fragments and public pool-discovery types for dashboards, launchpads and third
parties. Public pool users can also use the factory-gated quoter and exact-input
router ABI fragments. Private pool swaps and quotes remain direct-to-pool
because COTI encrypted inputs bind the caller and target contract.

Private amounts, reserves, balances and LP positions are not represented in the
discovery schema. Use the official COTI SDK and the caller's AES key for
caller-specific ciphertext preparation and decryption. Factory-created
confidential pools expose a pool-bound `PrivateLPToken`; its ABI fragment is
available for encrypted LP transfers and approvals, while aggregate
`totalSupply()` must not be used as a private-supply oracle.
