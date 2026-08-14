# CipherDEX SDK Surface

The SDK surface is intentionally dependency-free. It exports stable ABI
fragments and public pool-discovery types for dashboards, launchpads and third
parties.

Private amounts, reserves, balances and LP positions are not represented in the
discovery schema. Use the official COTI SDK and the caller's AES key for
caller-specific ciphertext preparation and decryption.
