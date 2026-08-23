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

Use `PublicCPMMLiquidityRouter.createOrAddLiquidity` for one-transaction public
pool creation/seeding or a proportional add to an existing canonical pool. The
call accepts token-order-independent desired maxima, price bounds and minimum
shares. It mints shares directly to the caller and refunds unused maxima. Direct
factory and pool calls remain available for existing integrations.

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
each token with `isCompatiblePrivateToken` on that exact immutable factory. This
proves deployed interface/decimal compatibility, not approval or economic
honesty. For LP-token provenance it verifies the factory's immutable helper,
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
candidates from the factory. The candidate-aware quote variant accepts only a
nine-bit fee/strategy-class bitmap and may evaluate all nine canonical slots in
one paid request. The atomic swap variant remains limited to three active bits.
Neither accepts pool addresses. Both skip missing or uninitialized variants,
reuse the same GT input, select privately and emit only one caller-encrypted
winner. Construct the active namespace with
`buildConfidentialCandidateBitmap(1 + registeredStrategyCount)`, not an
unconditional `0x1ff`. After submission, call
`decryptConfidentialBestExecutionResult` with the expected operation, caller,
request ID, token pair, transaction hash and exact encoded transaction calldata.
Its trusted adapter must fetch the
raw transaction and receipt by that hash; application code cannot inject either
as evidence. The SDK verifies the chain, byte-for-byte calldata, exact router event,
selected tier/strategy and a fresh complete-key pool lookup before decrypting.
Paid pool-level `requestQuoteExactInput` and the canonical paid best-quote and
best-execution router both have fresh funded proof. Use the router as the
preferred bounded integration path and the pool-level method for explicit direct
pool quoting. Neither path is gasless; there is no gasless route for either one
to fall back from on the tested runtime.

Only the three-candidate route currently has funded COTI gas evidence. Before
enabling a larger bitmap, measure the exact deployed router against the live
block limit. If needed, use `partitionConfidentialQuoteCandidateBitmap` to split
the active bitmap deterministically. Each returned batch is an independent paid
quote and requires a fresh request ID and ciphertext bound to the quote selector.
Compare only authenticated, successfully decrypted batch winners.

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

## Confidential liquidity preview

For an existing initialized pool, encrypt one token-side maximum for
`requestAddLiquidityQuote` and submit the paid preview transaction with a fresh
request ID and deadline. Its result event contains the accepted specified
amount, required proportional counterpart and expected shares as ciphertexts
offboarded only to the caller. Authenticate the canonical pool, successful
receipt, exact caller, request ID and side before decrypting the event.

The preview discloses the pool ratio/depth to that active caller in the same way
as repeated exact swap quotes. It does not reserve state. Re-read balances and
allowances, apply explicit tolerance to minimum shares and normalized price
bounds, create fresh pool/function-bound encrypted inputs, then submit
`addLiquidity`. Never turn the preview into an unbounded or zero-minimum add.

## Optional wallet batching and signing UI

Use the SDK confidential-operation plan builders to present the purpose and
position of every COTI encrypted-input signature separately from transaction
confirmations. Plans cover quotes, direct or best-execution swaps, liquidity
addition/removal and LP locking. They expose sequential and batched prompt counts
without including plaintext private values.

`prepareWalletCallExecution` is optional client orchestration, not a protocol
requirement. Query live per-chain capabilities with `wallet_getCapabilities` and
pass that untrusted response to the helper. It returns a validated EIP-5792 v2
`wallet_sendCalls` request only when batching is advertised, otherwise retaining
the exact ordered calls for sequential execution. One-call operations remain
sequential. Integrators may require, prefer or decline atomic execution.

Poll the wallet-returned identifier with the request from
`buildWalletCallsStatusRequest`, then validate responses with
`normalizeWalletCallsStatus`. Never retry an uncertain batch blindly. A partial
non-atomic batch containing token approvals requires explicit allowance review
and recovery. The helper does not invoke the provider, sign inputs, persist batch
state or replace the application's existing sequential fallback.

## Launchpad bootstrap

Launchpads encrypt five private inputs for the exact migrator and selector, then
use `LAUNCHPAD_MIGRATION_EIP712_TYPES` for one creator authorization covering the
complete migration. The migrator prepares and initializes the reviewed
strategy-bound protected pool in the same transaction. This is a distinct
complete key from the standard `address(0)` pool, not a creator-scoped namespace.
Index `PoolCreated`, `LaunchPrepared`, `LaunchInitializationAuthorized`,
`LaunchpadMigration` and optional `LaunchpadLockDisposition` from that successful
atomic transaction.

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
the launch. The protected pool must match the transaction-scoped launch record
and be empty; the factory and strategy consume its one-shot creator authorization atomically with
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
