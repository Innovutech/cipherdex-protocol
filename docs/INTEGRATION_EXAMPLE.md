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
    expectedFactory: configuredFactory,
    expectedFeeVault: configuredFeeVault,
    expectedProtocolVersion: CIPHERDEX_PROTOCOL_VERSION,
  },
  rpcBackedVerificationAdapter,
);
```

The shape validator does not prove provenance. The RPC adapter must verify
deployed code, factory protocol version, `isPool`, the one canonical `poolKey`
mapping and all immutable pool fields. It must also compare each token's current
runtime implementation with `isApprovedPrivateToken` on that exact immutable
factory. Only verified discoveries may enter candidate selection. The SDK
verification adapter makes this check mandatory.

## Confidential quote gate

Current COTI nodes reject fresh MPC execution under `eth_call`, beginning with
raw stored-ciphertext `OnBoard`. Deployment-time encrypted constants remove
`SetPublic` but do not remove the required onboarding and therefore do not make a
complete quote callable. A dedicated quote identity therefore creates a fresh
authenticated input for each verified canonical candidate, calls
`requestQuoteExactInput`, decrypts the matching `ConfidentialQuoteResult`, and
passes process-local evaluations to `selectBestConfidentialPoolQuote`.
Each evaluation is bound to the same exact process-local `amountIn`, logical
request ID and direction; mixed-input candidates are rejected.

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
The protocol therefore has no generic confidential router. A future supported
execution flow must create fresh user-bound inputs for `swapExactInput`, include
a reviewed nonzero minimum output and call the selected pool directly. Quote
inputs cannot be reused for settlement.

## Launchpad bootstrap

Launchpads use the factory's restricted bootstrap adapter to resolve the same
canonical pool key as permissionless creation. There is no creator-scoped pool
namespace. Index `PoolCreated`, `LaunchpadMigration` and
`LaunchpadLockDisposition`; the latter two add provenance and LP-disposition
metadata without defining a second market identity.

Liquidity amounts, normalized price bounds, minted shares, reserves and TVL are
not public discovery fields. A pre-existing initialized canonical pool rejects
bootstrap before private token pulls. For an empty pool, the launchpad escrows
exact amounts, grants exact pool allowances and lets the pool validate its own
balance deltas. New pool creation, escrow, approvals and bootstrap roll back
atomically if any later check fails. Prior unmanaged balances cannot become
reserves or block this exact-delta initialization.

## Version boundary

Integrations must pin the expected factories, fee vault, protocol version,
privacy mode and pool kind. Unknown discovery schema versions and privacy mode
`2` are rejected rather than inferred.
