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
- execute both swap directions with a private minimum output and a short
  explicit deadline;
- exercise failed slippage and replayed encrypted-input paths;
- remove liquidity and check the full-exit path;
- record gas/latency without printing amounts, AES keys, ciphertexts or signatures.

The harness should be enabled only with explicit environment variables and should
never run from CI against a funded wallet by default.

## Full scenario runner

After the isolated quote/swap harness is reviewed, run the full scenario with:

```text
npm run testnet:scenario
```

It creates a permissionless factory and pool when `COTI_POOL` is unset, resets
and sets encrypted token approvals, adds liquidity, performs swaps in both
directions, checks caller-local balance/share changes, exercises a timed lock and
unlock, creates a permanent lock, and removes the remaining shares. It logs only
public addresses, transaction hashes, gas, and latency. It does not print any
amount, ciphertext, signature, AES key, or raw RPC error.

The scenario requires `COTI_TOKEN0`, `COTI_TOKEN1`, their exact public decimals,
`COTI_LIQUIDITY_AMOUNT0`, `COTI_LIQUIDITY_AMOUNT1`, `COTI_SWAP_AMOUNT0`,
`COTI_SWAP_AMOUNT1`, `COTI_TESTNET_PRIVATE_KEY`, and `COTI_AES_KEY`. Amount
variables are expressed in the pool's canonical `token0`/`token1` order after
address sorting. Use a disposable, funded testnet account only.
