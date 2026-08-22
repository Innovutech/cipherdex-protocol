# Confidential Input Batch Authorization Feasibility

## Decision

The proposed one-signature confidential input batch cannot be implemented safely
with the current COTI testnet MPC boundary.

CipherDEX production entry points remain unchanged. The diagnostic contracts and
SDK builders in source commit `ce16606989985b09a0607b8b12a4bcf14b0245ff`
prove the intended authorization semantics locally and isolate the live runtime
blocker. They are not a production protocol version or deployment.

## Intended Boundary

The tested EIP-712 authorization binds:

- COTI chain ID;
- `CipherDEX Confidential Inputs` domain version `1`;
- caller and target contract;
- exact function selector;
- protocol version;
- exact ordered slot-schema hash;
- every ordered ciphertext commitment;
- one nonzero caller nonce; and
- one deadline.

The contract rejects an invalid slot count, wrong schema or protocol version,
expired authorization, modified or reordered ciphertexts, duplicate ciphertexts,
wrong caller/chain/target/selector, and nonce reuse. EOA and ERC-1271 signature
validation use the shared `SignatureValidation` boundary.

## Local Evidence

The focused `InputBatchAuthorization.spec.ts` suite proves:

- SDK and Solidity digest equality;
- one successful EOA authorization and nonce consumption;
- mutation, reordering, missing-slot and duplicate-slot rejection;
- wrong caller, chain, target, selector, schema and protocol rejection;
- expiry and cross-function nonce-reuse rejection; and
- ERC-1271 authorization through the calling contract wallet.

The full repository verifier passed before the live probe with zero production or
operational dependency advisories, fresh Solidity/privacy/security compilation,
`224` passing tests plus one intentionally gated integration, and `225` total
Mocha results.

## Live COTI Testnet Evidence

The diagnostic source-bound stack is recorded in
`deployments/coti-testnet-ce16606989985b09a0607b8b12a4bcf14b0245ff.json`.
It exists only to authenticate the funded probe and is not an authoritative
CipherDEX integration deployment.

The asset-free batch probe and ERC-1271 wallet deployed successfully:

- `MpcBatchAuthorizationProbe` deployment:
  `0x27f32311cd4040a13a9968544dbd76d30dc0b4bd2443a5e9a7ae4346b34e9b88`.
- `MockERC1271Wallet` deployment:
  `0x4932060545e34976934b400ee2d9c985ab91459054367ab317861a0650c49476`.

The modified two-slot batch was rejected before MPC execution, as expected:

- transaction:
  `0xb79233d39e4b54ce1bbf4001cffb00aa15eb59e8e1dfefd9e2afdb2901bd201f`;
- status: reverted;
- gas used: `37971`.

The correctly authorized two-slot batch then reverted after authorization when it
attempted to onboard the first caller ciphertext:

- transaction:
  `0xdad6e6726c25e9625f5cfdc342c17c3b9f5df6f2424ec31bef35ce6c2dd826e1`;
- status: reverted;
- gas used: `143283` of a `30000000` gas limit;
- revert payload: unavailable from the COTI RPC/precompile boundary.

Independent read-only reconstruction of that exact transaction proved:

- SDK digest equals the contract digest;
- ECDSA recovery equals the transaction caller;
- schema hash equals the contract's two-slot schema;
- protocol version matches;
- deadline was live at the mined block; and
- the batch nonce rolled back to unused.

The additional gas consumed beyond the invalid-signature control, together with
the complete digest/signature checks above, isolates the failure to raw caller
ciphertext onboarding rather than EIP-712 authorization.

## MPC Boundary

The installed official COTI contracts expose only:

```text
ValidateCiphertext(metadata, ciphertext, per-ciphertext signature)
OnBoard(metadata, network ciphertext)
```

`ValidateCiphertext` authenticates each `itUint256` separately. The official
browser-wallet builder signs a payload containing the signer, contract, function
selector and that one ciphertext. There is no `ValidateCiphertextBatch` primitive
and no contract API that converts several caller ciphertexts under one external
batch signature.

`OnBoard` is valid for ciphertext produced by the MPC network and stored by a
contract, such as reserve state created through `OffBoard`. A ciphertext produced
locally with the caller AES key is not interchangeable with that network
ciphertext. The live probe demonstrates that passing such caller ciphertext
directly to `OnBoard` reverts even after a valid contract-level authorization.

## Rejected Workarounds

- Keeping each COTI `itUint256` signature and adding a batch signature does not
  reduce wallet requests and duplicates authorization.
- Passing the same batch signature to each `ValidateCiphertext` call is invalid;
  the precompile expects the official per-ciphertext signed payload.
- Packing multiple values into one encrypted uint256 loses the required full
  uint256 ranges, changes arithmetic semantics and cannot represent five slots.
- Persisting caller ciphertext and onboarding it later does not transform
  user-AES ciphertext into MPC-network ciphertext and would also break atomicity.
- A two-phase trusted relayer or custody service would weaken the caller-bound,
  permissionless security model and is outside the requested design.

## Required COTI Capability

One of the following upstream capabilities is required before this refactor can
continue:

1. A `ValidateCiphertextBatch` MPC primitive that accepts an ordered ciphertext
   array and one caller/contract/function-bound signature, returning one garbled
   value per slot atomically; or
2. An official SDK/runtime format for caller-created ciphertext that `OnBoard`
   accepts after a contract-verifiable batch authorization, with documented
   caller, chain, target, selector and replay guarantees.

Until then, removing the existing per-input `itUint256` validation would make
caller ciphertext unauthenticated or unusable. CipherDEX must retain the current
production boundary rather than weaken validation.
