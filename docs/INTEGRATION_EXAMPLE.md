# CipherDEX Confidential Quote Integration

This is a reference boundary for CipherTools, CipherTrade, launchpads, and third
parties. It does not add a centralized protocol dependency or a confidential
router. Discovery is public; quote outputs remain ephemeral to the requesting
identity; user execution remains direct-to-pool.

## Discover canonical candidates

Index `PoolCreated` from `ConfidentialCPMMFactory` or enumerate `allPools`. For a
requested ordered token pair, collect each supported fee tier and verify the
pool's immutable metadata:

```ts
const untrustedDiscovery = {
  disclosureSchemaVersion: DISCLOSURE_SCHEMA_VERSION,
  protocolVersion: Number(await pool.PROTOCOL_VERSION()),
  pool: poolAddress,
  token0: await pool.token0(),
  token1: await pool.token1(),
  token0Decimals: Number(await pool.token0Decimals()),
  token1Decimals: Number(await pool.token1Decimals()),
  feeBps: Number(await pool.feeBps()),
  feeVault: await pool.feeVault(),
  feePolicy: getCipherDEXV1FeePolicy(Number(await pool.feeBps())),
  privacyMode: PRIVACY_MODE.AMOUNT_CONFIDENTIAL_PRIVATE_LP,
  poolKind: "private-erc20-cpmm-v2",
  quoteTransport: CONFIDENTIAL_QUOTE_TRANSPORT.TRANSACTION_EVENT,
};

if (!isConfidentialPoolDiscovery(untrustedDiscovery)) {
  throw new Error("unsupported confidential pool");
}

const discovery = await verifyConfidentialPoolDiscovery(
  untrustedDiscovery,
  {
    expectedFactory: configuredFactory,
    expectedFeeVault: configuredFeeVault,
    expectedProtocolVersion: CIPHERDEX_PROTOCOL_VERSION,
  },
  rpcBackedVerificationAdapter,
);
```

`isConfidentialPoolDiscovery` is only a bounded JSON-shape check. It does not
prove provenance. The RPC adapter used by `verifyConfidentialPoolDiscovery`
must check deployed code, factory `isPool`, the applicable manual or
creator-scoped canonical lookup, and all immutable pool fields. Only its
process-local verified return value can be passed to quote selection.

The manual factory key includes ordered pair, fee tier, privacy mode, and
protocol version. Launchpad pools use a separate domain and include the creator.
Token decimals are validated against each token contract at pool creation but
are not a second pool-identity dimension. Never treat individual LP positions as
quote candidates.

## Service-local best-pool selection

Use a dedicated onboarded COTI quote identity and AES key, separate from user and
treasury keys. For one logical request:

1. Generate an opaque request ID in memory.
2. For every candidate, create a fresh authenticated encrypted amount bound to
   that pool and the selected quote transport's selector.
3. On COTI testnet, submit `requestQuoteExactInput` and read the caller-encrypted
   result from `ConfidentialQuoteResult`. On a future RPC that executes the same
   MPC precompiles under `eth_call`, `quoteExactInput` can avoid a transaction.
4. Decrypt the caller-specific result locally.
5. Compare only results for the same request ID, pair, and direction.

```ts
const evaluations = await Promise.all(candidates.map(async (discovery) => {
  const pool = new Contract(discovery.pool, CONFIDENTIAL_CPMM_ABI, quoteWallet);
  const selector = pool.interface.getFunction("requestQuoteExactInput")!.selector;
  const encryptedInput = await quoteWallet.encryptValue256(
    logicalAmountIn,
    discovery.pool,
    selector,
  );
  const tx = await pool.requestQuoteExactInput(
    encryptedInput,
    zeroForOne,
    requestId,
  );
  const receipt = await tx.wait();
  const encryptedOutput = readMatchingQuoteResult(receipt, discovery.pool, requestId);
  return {
    discovery,
    requestId,
    zeroForOne,
    decryptedAmountOut: await quoteWallet.decryptValue256(encryptedOutput),
  };
}));

const best = selectBestConfidentialPoolQuote(evaluations);
```

`ConfidentialQuoteEvaluation` is explicitly service-local. Do not return the
evaluation array, persist decrypted outputs, or add it to discovery/indexer
schemas. A product API may return the selected pool and a short-lived user quote
under its own reviewed privacy/retention policy.

## User execution

The service does not build a transferable ciphertext for the user. COTI inputs
are authenticated to sender, target pool, selector, and encrypted value. After
reviewing the selected pool and expected output, the user:

1. creates a fresh encrypted `amountIn` for `swapExactInput`;
2. creates a fresh encrypted `minAmountOut` from its own slippage policy;
3. grants the selected pool the exact encrypted token allowance;
4. calls `swapExactInput` directly before the chosen deadline.

A generic router is intentionally absent. Forwarding would change `msg.sender`
and invalidate or weaken the authenticated input binding unless COTI supplies a
separately reviewed delegation primitive.

## Public pools

For `public-erc20-cpmm-v2`, use `PublicCPMMQuoter` and `PublicCPMMRouter` after
verifying that the pool is registered in the expected public factory. Public and
confidential route responses must retain their explicit `privacyMode` and
`poolKind`; do not silently fall back between them.

## Launchpad metadata

Index `LaunchpadPoolCreated`, `LaunchpadMigration`, and
`LaunchpadLockDisposition` only for public creator/pool/lock identity and timing.
Use the creator from `LaunchpadPoolCreated` to verify `launchPoolKey` and
`getLaunchPool`. Liquidity amounts, price bounds, minted shares, reserves, and
TVL stay outside public discovery.

## Prohibited integration shortcuts

- no public reserve/TVL/spot/TWAP reconstruction endpoint for confidential pools;
- no plaintext quote input sent to the pool;
- no service-held user funds or service-signed user swaps;
- no reuse of quote ciphertext as a swap ciphertext;
- no logging of AES keys, plaintext inputs/outputs, ciphertexts, or signatures;
- no private multi-hop execution in v1;
- no acceptance of unsupported privacy mode `2`.
