# COTI Testnet Harness Requirements

The integration test is intentionally gated until real COTI testnet inputs are
available. It must use the official COTI SDK/COTI Ethers package and an onboarded
test account; it must not replace the MPC precompile with a plaintext mock.

The harness must:

- prepare authenticated `itUint256` values with the exact pool address and function
  selector;
- approve the pool with the official private approval flow;
- add balanced liquidity and decrypt only user-specific ciphertexts locally;
- quote via the COTI RPC and record whether static simulation works;
- execute both swap directions with a private minimum output;
- exercise failed slippage and replayed encrypted-input paths;
- remove liquidity and check the full-exit path;
- record gas/latency without printing amounts, AES keys, ciphertexts or signatures.

The harness should be enabled only with explicit environment variables and should
never run from CI against a funded wallet by default.

