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
  poolKind: "private-erc20-cpmm-v2",
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
deployed code, factory protocol version, `isPool`, the one canonical `poolKey`
mapping and all immutable pool fields. It must also compare each token's current
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

`requestBestQuoteExactInput` derives all candidates from the canonical factory,
quotes initialized 5/30/100 bps pools with the same GT input, selects privately
and emits one caller-encrypted winner. After submission, call
`decryptConfidentialBestExecutionResult` with the expected operation, caller,
request ID, token pair, transaction hash and exact encoded transaction calldata.
Its trusted adapter must fetch the
raw transaction and receipt by that hash; application code cannot inject either
as evidence. The SDK verifies the chain, byte-for-byte calldata, exact router event,
selected tier and a fresh canonical-pool lookup before decrypting. The currently
recorded pre-router deployment uses pool-level `requestQuoteExactInput` as its
primary working quote; after this router version is finalized and freshly
deployed, that path remains supported for compatibility and diagnosis.

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
one verified pool. It requires fresh pool/selector-bound ciphertexts and is not
the preferred best-execution path.

## Launchpad bootstrap

Launchpads use the factory's restricted bootstrap adapter to resolve the same
canonical pool key as permissionless creation. There is no creator-scoped pool
namespace. Index `PoolCreated`, `LaunchpadMigration` and
`LaunchpadLockDisposition`; the latter two add provenance and LP-disposition
metadata without defining a second market identity.

Indexer JSON is untrusted discovery data. Parse it with the SDK shape guards,
apply the semantic guards, and then call `verifyLaunchpadMigrationMetadata`
through an RPC-backed adapter before presenting a migration or lock as verified.
That final step binds the record to the successful transaction, configured
migrator, canonical factory pool, exact migration/lock events and current public
lock state. Shape validation alone is never transaction evidence.

Liquidity amounts, normalized price bounds, minted shares, reserves and TVL are
not public discovery fields. A pre-existing initialized canonical pool rejects
bootstrap before private token pulls. For an empty pool, the launchpad escrows
exact amounts, grants exact pool allowances and lets the pool validate its own
balance deltas. New pool creation, escrow, approvals and bootstrap roll back
atomically if any later check fails. Prior unmanaged balances cannot become
reserves or block this exact-delta initialization.

## Version boundary

Integrations must pin the expected factories, private LP-token factory and its
runtime codehash, fee vault, protocol version, privacy mode and pool kind.
Unknown discovery schema versions and privacy mode `2` are rejected rather than
inferred.
