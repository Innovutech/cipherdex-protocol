# CipherDEX Integration Boundary

This boundary applies to CipherTools, CipherTrade, launchpads and third-party
integrators. Public and confidential pools share canonical discovery and fee
policy, but they do not currently share quote availability.

## Public pools

Index `PoolCreated` from `PublicCPMMFactory` or enumerate `allPools`. Verify the
expected factory, deployed code, canonical mapping, protocol version, fee vault,
pair, decimals and fee tier before routing.

Use `PublicCPMMQuoter.quoteExactInput` for gasless exact-input quotes and
`PublicCPMMRouter.swapExactInput` for execution. Both periphery contracts reject
pools outside their immutable factory. Route responses must retain
`privacyMode: 0` and `poolKind: "public-erc20-cpmm-v2"`.

## Confidential pool discovery

Index `PoolCreated` from `ConfidentialCPMMFactory` or enumerate `allPools`. Build
a privacy-minimal discovery record:

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
  initializationStrategy: await pool.initializationStrategy(),
  strategyClass: Number(
    await factory.initializationStrategyClass(
      await pool.initializationStrategy(),
    ),
  ),
  poolClass:
    (await pool.initializationStrategy()) === ZeroAddress
      ? "standard"
      : "launch-protected",
  initialized: await pool.initialized(),
  poolKind: "private-erc20-cpmm-v3",
  quoteTransport:
    CONFIDENTIAL_QUOTE_TRANSPORT.TRANSACTION_EVENT,
};

if (!isConfidentialPoolDiscovery(untrustedDiscovery)) {
  throw new Error("unsupported confidential pool discovery");
}

const discovery = await verifyConfidentialPoolDiscovery(
  untrustedDiscovery,
  {
    expectedChainId: configuredChainId,
    expectedFactory: configuredFactory,
    expectedFeeVault: configuredFeeVault,
    expectedProtocolVersion: CIPHERDEX_PROTOCOL_VERSION,
    expectedLPTokenFactory: configuredPrivateLPTokenFactory,
    expectedLPTokenFactoryRuntimeCodehash:
      deployment.contracts.confidentialLpTokenFactory.runtimeCodehash,
  },
  rpcBackedVerificationAdapter,
);
```

The shape validator does not prove provenance. The RPC adapter must verify
deployed code, factory protocol version, `isPool`, the complete canonical
`poolKey` mapping and all immutable pool fields, including strategy class,
strategy runtime codehash and initialized state. The key is ordered pair, fee,
privacy mode, protocol version and initialization strategy. It must also compare
each token's current
runtime implementation with `isApprovedPrivateToken` on that exact immutable
factory. For LP-token provenance it verifies the factory's immutable helper,
the helper's reviewed runtime codehash and factory constant, deployed LP-token
code, and the helper's exact `(pool, lpToken, canonicalFactory)` issuance
attestation. Only verified discoveries may enter candidate selection. The SDK
verification adapter makes these checks mandatory.

## Confidential quote gate

Current COTI nodes reject fresh MPC execution under `eth_call`, beginning with
raw stored-ciphertext `OnBoard`. Deployment-time encrypted constants remove
`SetPublic` but do not remove the required onboarding and therefore do not make a
complete quote callable. Integrations must first verify the configured router
against deployed code, its protocol version, immutable `factory()` and the
factory's one-time `bestExecutionRouter()` binding:

```ts
const router = await verifyConfidentialBestExecutionRouter(
  configuredRouter,
  {
    expectedChainId: configuredChainId,
    expectedFactory: configuredFactory,
    expectedFactoryRuntimeCodehash:
      deployment.contracts.confidentialFactory.runtimeCodehash,
    expectedRouter: deployment.contracts.confidentialBestExecutionRouter.address,
    expectedRouterRuntimeCodehash:
      deployment.contracts.confidentialBestExecutionRouter.runtimeCodehash,
    expectedFactoryProtocolVersion: CIPHERDEX_PROTOCOL_VERSION,
    expectedRouterProtocolVersion: CONFIDENTIAL_BEST_EXECUTION_ROUTER_VERSION,
  },
  rpcBackedRouterVerificationAdapter,
);

const binding = getConfidentialBestExecutionEncryptionBinding(router, "quote");
const encryptedAmount = await cotiWallet.encryptValue256(
  amountIn,
  binding.contractAddress,
  binding.functionSelector,
);
const requestId = randomNonzeroBytes32();
const transaction = buildVerifiedConfidentialBestQuoteTransaction(
  router,
  tokenIn,
  tokenOut,
  encryptedAmount,
  requestId,
  deadline,
);
```

The default `requestBestQuoteExactInput` derives the three standard 5/30/100 bps
candidates from the factory. The candidate-aware variant accepts only a nine-bit
fee/strategy-class bitmap, rejects more than three active bits and never accepts
pool addresses. It skips missing or uninitialized variants, uses the same GT
input, selects privately and emits one caller-encrypted winner. After submission, call
`decryptConfidentialBestExecutionResult` with the expected operation, caller,
request ID, token pair, transaction hash and exact encoded transaction calldata.
Its trusted adapter must fetch the
raw transaction and receipt by that hash; application code cannot inject either
as evidence. The SDK verifies the chain, byte-for-byte calldata, exact router event,
selected tier/strategy and a fresh complete-key pool lookup before decrypting.
Paid pool-level `requestQuoteExactInput` is the only proven primary quote path.
The paid router may become the preferred integration transport after fresh
funded proof, but neither path is gasless and the direct path is not merely a
fallback.

The verification and decryption adapters are trusted chain-data boundaries, not
indexer callbacks. Expected addresses and runtime codehashes must come from the
reviewed deployment record over a separately authenticated channel. Use the
wallet's reviewed provider or a provider quorum for chain reads; an adversarial
single RPC can fabricate an internally consistent chain view, which ordinary
JSON-RPC reads cannot independently disprove.

The identity is non-custodial: it holds only quote gas, never receives user funds
and never signs swaps. Integrators must expose the transaction cost/latency and
must not:

- reuse an encrypted input across pools or selectors;
- use a zero minimum output;
- infer exact output from public token balances;
- publish reserves, spot price, TVL or TWAP for confidential pools;
- silently route through a public pool or another privacy mode.

## Confidential execution boundary

Authenticated COTI inputs bind sender, target contract and function selector.
For atomic best execution, independently encrypt both exact input and nonzero
minimum output for the verified router's `swapBestExactInput` selector and use
`buildVerifiedConfidentialBestSwapTransaction`. Quote ciphertext cannot be
reused because its selector binding differs.

Before submitting, grant the router exactly the encrypted input amount on the
input token. The router resolves only canonical candidates, pulls that exact
amount into temporary escrow, grants only the selected pool an exact temporary
allowance and settles directly to the caller. The pool recomputes its quote and
enforces encrypted slippage, fees, reserves, invariant and token deltas. A
successful call requires the router's starting token balance and every candidate
allowance to be restored; any failure rolls the whole transaction back.

Direct `swapExactInput` remains supported for a user that intentionally selects
one verified pool. It requires fresh pool/selector-bound ciphertexts. Promote
the router as a preferred integration path only after its exact deployed source
has passed the documented funded mixed-class proof.

## Launchpad bootstrap

Launchpads first use `buildConfidentialLaunchCommitment`, creator and
launch-authority EIP-712 signatures, and `buildConfidentialLaunchCommitCall` to
commit a reviewed strategy-bound protected pool. This is a distinct complete
key from the standard `address(0)` pool, not a creator-scoped namespace. Index
`PoolCreated`, `LaunchCommitted`, `LaunchCanceled`, `LaunchExpired`,
`LaunchInitializationAuthorized`, `LaunchpadMigration` and
`LaunchpadLockDisposition` as separate lifecycle evidence.

Indexer JSON is untrusted discovery data. Parse it with the SDK shape guards,
apply the semantic guards, and then call `verifyLaunchpadMigrationMetadata`
through an RPC-backed adapter before presenting a migration or lock as verified.
That final step binds the record to the successful transaction, configured
migrator, canonical factory pool, exact migration/lock events and current public
lock state. Receipt/event authentication rather than a top-level sender or
selector assumption preserves verification for nested ERC-1271 wallet
execution. Shape validation alone is never transaction evidence.

Liquidity amounts, normalized price bounds, minted shares, reserves and TVL are
not public discovery fields. The ordinary standard pool never blocks or receives
the launch. The protected pool must match the active commitment and be empty;
the factory and strategy consume its one-shot authorization atomically with
escrow, exact pool allowances, pool balance-delta validation and bootstrap.
Prior unmanaged balances cannot become reserves or block this exact-delta
initialization.

## Version boundary

Integrations must pin the expected factories, private LP-token factory and its
runtime codehash, pool deployer/codehash, finalized strategy registry,
strategy/migrator runtime codehashes, fee vault, protocol versions, privacy mode
and pool kind.
Unknown discovery schema versions and privacy mode `2` are rejected rather than
inferred.
