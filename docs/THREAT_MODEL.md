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
- administrator-controlled liquidity unlocks or withdrawals.
- stale signed inputs executing after their intended deadline.
- launchpad bootstrap changing an initialized pool or bypassing the factory
  bootstrapper boundary;
- launchpad price-bound checks bypassing the private normalized-price interval.
- unmanaged private-token donations changing initial share or launchpad price
  state.

## Not solved by this phase

- MEV based on public participant, direction, timing or encrypted transaction
  ciphertext metadata;
- endpoint/RPC observers correlating private `eth_call` requests;
- malicious or non-conforming PrivateERC20 tokens;
- compromise or misuse of COTI MPC/precompile/operator infrastructure;
- hidden recipient identity under the standard token event/interface;
- asynchronous PoD callback failures or cross-chain settlement;
- wallet/UI leakage before a transaction is encrypted;
- economic review of fee tiers, share fairness, oracle/TWAP or launchpad curves.
- whether a launchpad's encrypted allowances are economically scoped to its
  migration transaction; a malicious launchpad can still spend whatever allowance
  a creator explicitly grants it.

## Required review before release

Independent review must cover MPC input authenticity/replay semantics, all token
callbacks, gas griefing, pool initialization, LP rounding, event linkability,
precompile behavior under `eth_call`, and testnet-to-mainnet compiler/deployment
differences. No external audit is claimed.
