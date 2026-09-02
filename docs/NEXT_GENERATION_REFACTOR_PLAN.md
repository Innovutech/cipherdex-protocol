# CipherDEX Next-Generation Refactor Plan

## Review basis

Reviewed repository: `Innovutech/cipherdex-protocol`

Topology source reviewed: upstream `main` at
`9e66e8f424d242013326a9c408a16e371ce35342`. Phase 2A corrections and proof
work start from its plan commit
`52685e3bb5b117b1322dcd3ff2e637a67b27a9e8`. Phase 2B proof work starts from
upstream `main` at `59b3de345d9c63fd6d02249bb681a9b17aefae08`.

Source, tests and committed deployment records at that SHA are the authority for
this plan. Phases 2A/2B change only this plan, result documents and disposable proof
artifacts; they do not change production contracts, SDK, deployment code, manifests,
licenses or deployments.

## Current topology and gaps

| Mode | Source-backed topology | Binding and product gap |
| --- | --- | --- |
| 0 | `PublicCPMM`/`PublicCPMMFactory`, public LP issuer, quoter, direct/best/liquidity/native routers, native best adapter and `PublicCPMMLimitOrderBook`; `PRIVACY_MODE=0`. | Standard pools only. The factory has no protected initializer. Public periphery validates some immutable dependencies, but the factory does not reverse-register every native adapter or the limit-order book. This is acceptable only for periphery that escrows its own assets and calls canonical user paths. |
| 1 | Separate `ConfidentialCPMM`, factory, deployer, finalized strategy registry, launch strategy/migrator, best router and the confidential side of `CipherDEXFeeVault`; `PRIVACY_MODE=1`. | Protected initialization authenticates a reviewed strategy/migrator and one creator EIP-712 authorization. It does not prove that the creator is the issuer of an explicit token in the pair. The protected key identifies the strategy, not a `poolKind` and protected token. |
| 2 | Separate `ObservableConfidential*` pool/factory/deployer/strategy/migrator/router bundle and `CipherDEXConfidentialFeeVault`; `PRIVACY_MODE=2`. It reuses `PrivateLPTokenFactory`, keeps exact execution confidential and publishes non-authoritative 50-bps price buckets. | It duplicates the Mode-1 launch topology and has the same issuer-proof gap. It is funded-testnet validated, but no `deployments/coti-mainnet-observable-confidential-*.json` active Mainnet record exists. |

Modes 1 and 2 currently use IT at exact EOA-facing endpoints and privileged,
factory-bound GT paths for best routing and migration settlement. Their factories,
deployers, routers, strategy/migrator stacks and fee-vault bindings are separate.
The shared private LP issuer is permissionless and records exact
`(pool, token, issuer)` provenance; it has no cross-mode asset authority.

Current fee tiers are 5, 30 and 100 bps. One sixth of the integer-rounded total
fee is the protocol share. The remaining LP share is credited to active reserves
and therefore auto-compounds. Public protocol liabilities are plaintext; Modes
1/2 use encrypted per-token accumulators and batched collection. Current locks do
not retain LP tokens in the holder balance: public locks escrow shares and private
locks burn/remint them.

Active base Mainnet remains the unified record
`deployments/coti-mainnet-b99c41abc031754990d4efcaaf1baa6754b3bb1e.json`.
The active optional public limit-order and native-best adapters are recorded
separately. Historical records remain evidence and do not imply that Mainnet is
empty.

## Settled target design

### Mode and pool identity

Keep three isolated bundles:

- Mode 0: `CipherDEXPublic*`.
- Mode 1: `CipherDEXConfidential*`.
- Mode 2: `CipherDEXObservableConfidential*`.

Use the same identity fields and ordering rules in every factory:

`ordered pair, feeBps, protocolVersion, privacyMode, poolKind, protectedToken`

This key is local to one immutable factory, so it does not redundantly encode chain
ID or factory address. Chain ID and factory remain mandatory in EIP-712 signatures,
domain separation and deployment manifests. Add either field to CREATE2/mapping
identity only if a concrete cross-factory collision requirement is later proven.

`STANDARD` uses `protectedToken = address(0)`. `PROTECTED` requires the explicit
protected token to be one member of the pair. Standard and protected keys are
independent. Decimals are validated metadata, not a second identity for the same
token pair.

There are no proxies, governance hooks, replacement authorities, mutable plugin
registries or open-ended mode registries. A future Mode 3 is a new factory-bound
bundle and manifest entry; existing bundles do not trust it automatically.

### Sealed bundle and binding rules

Each mode receives its own pool, factory, protocol-fee vault and protected
initializer. Modes 1/2 also receive separate pool deployers and best routers. A
factory is not usable until one-time configuration is finalized.

Mode 0 may deploy pools directly from its factory because that path introduces no
trusted intermediary; its creation/runtime hashes still belong in the manifest.
Do not add a public deployer solely for symmetry unless compiler-size evidence
requires it.

The deployment sequence is:

1. Deploy immutable fee policy dependencies, LP issuers, per-mode vaults and
   Modes 1/2 deployers.
2. Deploy each factory with exact dependency addresses, runtime codehashes,
   interface IDs, mode and protocol version.
3. Bind each deployer and fee vault back to exactly one factory.
4. Deploy each protected initializer and the Mode 1/2 best routers; bind each once
   after checking address, runtime codehash, interface, factory, mode and version.
5. Finalize each factory. Pool creation is disabled before finalization.
6. Deploy replaceable ordinary periphery, validate its immutable dependencies and
   record it in the manifest. Do not reverse-bind periphery that has no privileged
   core entrypoint.

Pools store their factory, mode, version, pool kind, protected token, fee vault and
LP token immutably or through a factory-only one-time initialization performed in
the creation transaction. Protected initialization, forwarded GT, LP mint/burn,
and fee-liability movement are accepted only from the receiving core's bound
component. No privileged function accepts caller-selected factory, pool, payer or
fee destination addresses.

Public swap, best-execution, native and liquidity routers and the public limit-order
book are ordinary periphery while they only escrow their own assets and call
canonical user paths. They authenticate immutable factory/router/WCOTI dependencies
and appear in the reviewed manifest, but the core does not reverse-bind them merely
for symmetry. A public protected initializer is privileged and core-bound. Mode 1/2
best routers remain core-bound because their pools accept forwarded GT only from
the configured router.

The current strategy registries, launch strategies and migrators are not carried
forward. The two fixed pool kinds do not need a strategy plugin layer.

### Protected-pool issuer proof

The candidate smallest fail-closed proof is an explicit issuer signal implemented
by the protected token:

`ICipherDEXLaunchTokenIssuer.cipherDEXLaunchIssuer() -> address`

`ICipherDEXLaunchTokenIssuer` remains a candidate ABI, not a production ABI, until
the actual launch-token and factory source is reviewed. If selected, the interface
must be detected explicitly (ERC-165 or an equally strict reviewed selector check).
The protected initializer reads it from `protectedToken`, not from the paired asset
or token ordering. Generic `owner()`, admin roles,
`DEFAULT_ADMIN_ROLE`, `MINTER_ROLE`, balances, `tx.origin`, deployment guesses and
frontend attestations are not issuer proofs.

The current COTI `PrivateERC20` base exposes AccessControl but no universal issuer
semantic. Arbitrary public ERC-20s likewise expose no universal issuer. Therefore:

- tokens implementing the reviewed explicit issuer interface may use protected
  pools;
- a partner token-factory provenance path is unsupported until its exact source,
  immutability, token-to-issuer record and runtime codehash are reviewed and tested;
- all other tokens get standard pools only.

The issuer may initialize directly, or authorize one vault for one launch. A prior
EOA/ERC-1271 issuer signature authorizes only that vault and the static launch terms.
It is consumed in the execution transaction and binds:

`chainId, protectedInitializer, factory, protocolVersion, privacyMode, poolKind,
ordered pair, feeBps, protectedToken, issuer, vault, LP disposition,
issuer-chosen `authorizationId`,
deadline`.

The signature does not bind future transaction-scoped GT values. At execution the
authorized vault creates, supplies and funds its own GT. CipherDEX pulls only from
that vault and enforces exact transfer deltas, pool identity, price/slippage checks
and LP disposition. There is no arbitrary `from`.

Authorization replay state is `consumedAuthorizationId[issuer][authorizationId]`.
Independent IDs may execute in any order. The exact ID is marked consumed only in
the successful atomic execution; a revert restores it to unused. Sequential issuer
nonces are rejected because one abandoned signature would otherwise block unrelated
launches. No mutable preauthorization record is installed.

The caller must be the named issuer or vault. `SignatureValidation` provides EOA
and ERC-1271 verification. No authorization is installed ahead of time. Protected
pool creation, authorization consumption, asset movement and initialization occur
atomically; a revert leaves no pool, commitment, allowance, escrow or reservation.
An arbitrary caller cannot create or reserve a protected key.

### EOA IT and contract GT initialization

Modes 1/2 expose paired endpoints with identical accounting:

- `initializeStandardIT`: user IT is generated for and validated by that exact
  pool endpoint.
- `initializeStandardGT`: any calling contract may supply transaction-scoped GT;
  the pool pulls assets only from `msg.sender`. This permissionless self-funded
  path is not a trusted-router path and requires no reverse binding.
- `initializeProtectedIT`: the bound initializer validates IT generated for that
  exact initializer endpoint, escrows from `msg.sender`, and atomically creates and
  initializes the protected pool.
- `initializeProtectedGT`: the authorized issuer/vault calls with transaction-scoped
  GT; the initializer escrows only from `msg.sender` and forwards through its bound
  core path. This forwarding authority is privileged. There is no arbitrary `from`
  parameter.

Only a forwarded GT path, or any path receiving authority over funds/state beyond
the actual caller's own funds, is privileged and core-bound.

IT and GT use one internal transition for transfer-delta checks, fee accounting,
price bounds, slippage, LP minting and initialization state. Both standard and
protected first initialization support IT and GT. Add further GT entrypoints only
for a demonstrated protocol-to-protocol flow.

Mode 0 implements the same standard/protected rules using ordinary ERC-20 calls
from EOAs or contracts. Exact before/after balance checks remain authoritative.

Mode 1 publishes no reserve-derived price. Mode 2 retains the public initial
reference, immediate 50-bps bucket-crossing observations, encrypted exact quotes
and encrypted authoritative minimum output. Buckets remain advisory and exclude
depth and price impact.

### Fungible LP shares and claimable LP fees

Keep full-range, pool-bound fungible LP tokens. Do not add LP NFTs or concentrated
liquidity.

For each input token, separate:

- active CPMM reserve;
- protocol-fee liability;
- LP-fee liability;
- cumulative LP fee growth;
- per-holder growth checkpoint, claimable amount and fractional carry.

The total swap fee and one-sixth protocol split remain unchanged. A swap credits
`netInput` to the active reserve, the protocol share to protocol liability, and
the LP share to LP liability. LP fees do not become active reserves.

The pool-bound LP token owns fee-growth and lock bookkeeping. For each token it
stores global fee growth and global remainder; for each holder it stores a growth
checkpoint, fractional carry, claimable balance and locked principal. The pool
alone may record newly accrued LP fees, mint/burn, lock/unlock principal and
atomically consume claim amounts. The pool retains the underlying reserves and fee
liabilities and pays claims. The LP token settles affected holders internally
before every mint, burn, direct transfer or delegated transfer. No LP-token to pool
callback occurs during transfer.

Use the Phase 2B quotient/remainder representation:

- `SCALE = 2^128`;
- `MAX_TOTAL_SHARES = 2^128 - 1`;
- `MAX_RESERVE_OPERAND = 2^128 - 1` per active reserve;
- `MAX_LP_FEE_OPERAND = 2^128 - 1` per accrual;
- checked `uint256` lifetime LP-fee accrual per token.

These caps align with the actual full-range share formula
`min(amount0 * scale0, amount1 * scale1)` and the existing supported decimals
`0..18`. With reserves and shares below `2^128`, reserve multiplication and
`shares * reserve` are below `2^256`. The worst normalization product is
`reserve * 10^18 * 10^18 < 2^248`, so it also fits public and COTI MPC uint256.

Store cumulative per-share growth as `(growthWhole, growthFraction)` with
`growthFraction < SCALE`. For each fee accrual:

`feeWhole = floor(lpFee / totalShares)`

`feeRemainder = lpFee % totalShares`

`fractionalNumerator = feeRemainder * SCALE + globalRemainder`

`fractionIncrement = floor(fractionalNumerator / totalShares)`

`globalRemainder = fractionalNumerator % totalShares`

Normalize `growthFraction + fractionIncrement` into the two growth limbs. This
avoids the single-accumulator design's full `lpFee * SCALE` and prevents a scaled
lifetime accumulator from overflowing after only `2^128` fee units. Its largest
product is `(totalShares - 1) * SCALE + (SCALE - 1) < 2^256`.

For settlement, subtract the holder's two-limb checkpoint with one fractional
borrow, then calculate:

`newClaim = balance * wholeDelta + floor((balance * fractionDelta + holderCarry) / SCALE)`

`holderCarry = (balance * fractionDelta + holderCarry) % SCALE`

The fractional product is below `2^256`. The whole product is also bounded for every
reachable holder: balance is constant between checkpoints, and for every included
accrual that balance is no greater than total supply, so its whole entitlement is
no greater than cumulative accrued fees. A fabricated unreachable product fails
closed. The lifetime counter and whole accumulator use checked uint256 additions;
new accrual stops before wrap, while transfer, burn and claim remain available.

Minted shares checkpoint at current growth and cannot capture history. Sender and
receiver settle before a transfer; accrued fees remain with the sender and future
fees follow transferred shares. Claims debit only LP-fee liability and use exact
token-delta checks. The sum of paid claims must never exceed total accrued LP-fee
liability.

LP-token ownership alone determines entitlement; protected launch provenance adds
no special fee account. Public growth, claims and amount events may be plaintext.
Modes 1/2 keep growth, checkpoints, claimable balances and claim amounts encrypted,
offer owner-readable ciphertext results, and emit no plaintext amount event.

Holder carry is allocated, owner-bound fractional entitlement and remains with that
owner across transfer, burn and zero supply. Global remainder is unallocated. Keep
one rolling global scalar across ordinary supply changes and zero-supply generations;
do not create retired arrays or buckets. Because `globalRemainder < totalShares <=
SCALE - 1` after every accrual, the historical unallocated amount is always strictly
less than one raw token unit. A later LP may receive part of that sub-unit remainder,
but can never capture allocated/claimable historical fees. This is the precise scope
of the no-historical-capture guarantee.

Exact conservation after settling known holders is:

`(lpFeeLiability - wholeClaimable) * SCALE = sum(holderCarry) + globalRemainder`.

Rolling the sub-unit global remainder is selected over an immutable vault/burn close:
the latter would assign LP-owned value elsewhere, requires a terminal-state trigger,
and still cannot transfer a fractional raw token. Owner carries are not swept or
retired; they may mature when that owner later holds shares. This creates no
unbounded storage and no unowned whole-token bucket. Integer-token granularity still
means one dormant owner may hold less than one raw unit until future growth.

Locks leave shares in the owner's LP balance. The pool instructs the LP token to
record locked principal; the LP token enforces
`requested <= balance - locked` during transfer and burn. Locked shares therefore
continue to receive and claim fees. Timed unlock changes transferability only.
Permanent locks never regain principal transfer or withdrawal rights but retain
normal fee claims.

A full exit distributes active reserves only. Protocol and LP-fee liabilities stay
segregated and claimable; reinitialization checkpoints new shares at current growth.
Positive unsolicited balances remain unpriced surplus. For supported assets, any
raw-balance deficit below active reserves plus liabilities fails closed with an
accounting-deficit error; the next generation does not silently haircut holder
claims. Supporting rebasing, externally burnable or otherwise lossy tokens would
require a separate loss-index design and is out of scope.

Required conservation per token:

`raw balance >= active reserve + protocol liability + LP-fee liability`

and every successful state transition must account exactly for transfers, claims
and segregated surplus.

### Router choice

Choose option A: one router per mode. Do not initially deploy a cross-mode router.

- It preserves the current factory-bound GT trust boundary.
- Mode 1 and Mode 2 have different disclosure and gas behavior.
- A flaw or bad binding in one router cannot gain GT authority in another mode.
- SDK routing can compare authenticated per-mode results and require explicit mode
  selection without adding on-chain cross-mode authority.

Option B, one confidential router bound to both factories, removes code duplication
but makes both cores trust one component, enlarges candidate/gas bounds and creates
a cross-mode failure domain. Reconsider it only if a funded COTI test proves a
material UX/gas benefit and a scoped security review proves factory/pool/mode
derivation cannot cross.

### Confidential limit-order feasibility verdict

Do not include confidential limit orders in the replacement deployment yet. A
full-fill, token-only module is technically plausible but utility and COTI cost are
unproven.

The minimum prototype stores maker escrow and minimum output as ciphertext, exposes
a permissionless trigger, onboards transaction-scoped GT, and calls a bound mode
router. Cancellation must atomically return all escrow; replay protection is keyed
by maker, order ID, revision and endpoint. No amount-bearing plaintext event is
allowed.

Mode 2 keepers may use the bucket only as an advisory trigger. Mode 1 provides no
public price, so keepers must pay for blind attempts or a paid exact quote; failed
attempt cost and absence of a bounty may make liveness unacceptable. Existing
evidence measures about 75.45M gas for nine-candidate quote-only selection and about
38.28M gas for three-candidate quote-plus-swap in the current Mode-1 router. Those
numbers do not prove an escrow-order lifecycle or the new fee-accounting path.

Prototype one separately bound module per confidential mode. A shared module would
need authority in both mode bundles and is rejected unless isolated funded proof
shows a compelling benefit. Do not add partial fills, native settlement or bounties.

Required funded proof: create, exact full fill, below-minimum failed trigger, expiry,
maker cancellation/refund, replay, wrong mode/pool/router, transfer-delta mismatch,
zero residual balances/allowances, encrypted-liability conservation, Mode-2 bucket
crossing, Mode-1 no-price liveness measurements, and worst-case candidate gas with
safe headroom under the observed COTI block limit.

## File-level implementation inventory

### Add: project-owned core/deployables (BUSL-1.1 after legal gates)

- Common: `CipherDEXSwapFeePolicy.sol`, `CipherDEXPublicLPToken.sol`,
  `CipherDEXPublicLPTokenFactory.sol`, `CipherDEXPrivateLPToken.sol`,
  `CipherDEXPrivateLPTokenFactory.sol`.
- Mode 0: `CipherDEXPublicCPMM.sol`, `CipherDEXPublicCPMMFactory.sol`,
  `CipherDEXPublicProtocolFeeVault.sol`, `CipherDEXPublicProtectedInitializer.sol`,
  `CipherDEXPublicRouter.sol`, `CipherDEXPublicBestExecutionRouter.sol`,
  `CipherDEXPublicQuoter.sol`, `CipherDEXPublicLiquidityRouter.sol`,
  `CipherDEXPublicNativeRouter.sol`, `CipherDEXPublicBestExecutionNativeRouter.sol`,
  `CipherDEXPublicLimitOrderBook.sol`.
- Mode 1: `CipherDEXConfidentialCPMM.sol`,
  `CipherDEXConfidentialCPMMFactory.sol`, `CipherDEXConfidentialCPMMDeployer.sol`,
  `CipherDEXConfidentialProtocolFeeVault.sol`,
  `CipherDEXConfidentialProtectedInitializer.sol`,
  `CipherDEXConfidentialBestExecutionRouter.sol`.
- Mode 2: `CipherDEXObservableConfidentialCPMM.sol`,
  `CipherDEXObservableConfidentialCPMMFactory.sol`,
  `CipherDEXObservableConfidentialCPMMDeployer.sol`,
  `CipherDEXObservableConfidentialProtocolFeeVault.sol`,
  `CipherDEXObservableConfidentialProtectedInitializer.sol`,
  `CipherDEXObservableConfidentialBestExecutionRouter.sol`.

After Phase 2A approval, add matching MIT interfaces under `contracts/interfaces/`
using `I` plus the exact deployable name for every externally called component
above. Also add the shared MIT interface `ICipherDEXPoolIdentity.sol`. Keep
`ICipherDEXLaunchTokenIssuer.sol` as a candidate until the real launch-token/factory
source gate is resolved. Do not add `ICipherDEXLPTransferHook.sol`; the smaller
token-internal accounting design is sufficient in the reference and public probes.
Generic function/event/error names remain unchanged.

The concrete interface set is:

- public: `ICipherDEXPublicCPMM`, `ICipherDEXPublicCPMMFactory`,
  `ICipherDEXPublicProtocolFeeVault`, `ICipherDEXPublicProtectedInitializer`,
  `ICipherDEXPublicRouter`, `ICipherDEXPublicBestExecutionRouter`,
  `ICipherDEXPublicQuoter`, `ICipherDEXPublicLiquidityRouter`,
  `ICipherDEXPublicNativeRouter`, `ICipherDEXPublicBestExecutionNativeRouter`,
  `ICipherDEXPublicLimitOrderBook`, `ICipherDEXPublicLPToken` and
  `ICipherDEXPublicLPTokenFactory`;
- Mode 1: `ICipherDEXConfidentialCPMM`, `ICipherDEXConfidentialCPMMFactory`,
  `ICipherDEXConfidentialCPMMDeployer`, `ICipherDEXConfidentialProtocolFeeVault`,
  `ICipherDEXConfidentialProtectedInitializer` and
  `ICipherDEXConfidentialBestExecutionRouter`;
- Mode 2: `ICipherDEXObservableConfidentialCPMM`,
  `ICipherDEXObservableConfidentialCPMMFactory`,
  `ICipherDEXObservableConfidentialCPMMDeployer`,
  `ICipherDEXObservableConfidentialProtocolFeeVault`,
  `ICipherDEXObservableConfidentialProtectedInitializer` and
  `ICipherDEXObservableConfidentialBestExecutionRouter`;
- shared private LP: `ICipherDEXPrivateLPToken` and
  `ICipherDEXPrivateLPTokenFactory`.

The single private LP issuer may serve Modes 1/2 only because it is permissionless,
has no asset authority and records exact pool/factory/mode/version provenance. Each
factory pins its codehash and validates the issued token. Mode authority never flows
through the shared issuer.

### Replace in SDK/ABI (MIT)

- Replace generation-specific contents of `sdk/src/index.ts`, `liquidity.ts`,
  `publicBestExecution.ts`, `publicLimitOrder.ts` and
  `observableConfidential.ts`.
- Add `sdk/src/poolIdentity.ts`, `protectedInitialization.ts`, `lpFees.ts`,
  `confidentialExecution.ts` and `deploymentManifest.ts`.
- Regenerate matching `sdk/dist/*`; do not hand-edit generated output.
- Retain `tokenApproval.ts`, `operationPlan.ts`, `walletCallBatch.ts`,
  `executionError.ts` and `nativeAsset.ts`, changing them only where a new endpoint
  or ABI requires it.

The SDK must expose explicit `privacyMode`, `poolKind`, `protectedToken`, protocol
version, IT versus GT endpoint, public versus encrypted fee state, and authoritative
manifest provenance. It must never use a Mode-2 bucket as `minOut`.

### Add/modify deployment and verification tooling

- Add `scripts/inventory-mainnet.ts` (read-only),
  `scripts/cipherdex-generation-preflight.ts`,
  `scripts/deploy-cipherdex-generation.ts`, and
  `scripts/testnet-cipherdex-generation.ts`.
- Add isolated `scripts/testnet-confidential-limit-order-feasibility.ts`; it is not
  part of deployment.
- Extend only the necessary schemas/checks in `deployment-record.ts`,
  `cotiscan-verify.mjs`, `check-security-boundary.mjs`,
  `check-privacy-boundary.mjs`, `solidity-privacy-ast.mjs` and the funded launcher
  target allowlist.
- Retain the authenticated operator launcher, private runtime, recovery journal,
  transaction provenance, secure publication and funded-evidence tooling unchanged
  unless a concrete new manifest field requires a focused extension.

Produce one versioned record:

`deployments/coti-<network>-cipherdex-generation-<protocolVersion>-<sourceCommit>.json`

It contains every deployed or explicitly reused address, constructor input,
runtime codehash, interface/mode/version check, one-time binding/finalization
transaction, fee policy, pool-kind constants and compiler provenance. Old deployment
records remain immutable deprecated evidence; do not rewrite them.

### Retain or deprecate

- Retain unchanged MIT third-party code/notices, `SignatureValidation.sol`,
  `PrivateTokenCompatibility.sol`, funded-run protections and exact compiler inputs.
- Reuse the deployed `WrappedNativeToken` only if the Mainnet inventory confirms
  runtime codehash, supply/backing and no unresolved liability. Otherwise a separately
  reviewed `CipherDEXWrappedNativeToken` replacement is required.
- Keep all current MIT contracts/interfaces and records in source history for old
  deployments. Mark their generation deprecated only after the inventory and an
  explicit migration/deprecation decision.
- The current public, Mode-1 and Mode-2 pools/factories/LP issuers/vaults/routers,
  current strategy/migrator stacks, and current public periphery are superseded by
  the new names; do not delete them during implementation.

## Existing Mainnet inventory gate

At one pinned block number/hash, the read-only inventory must verify:

- every active and historical factory, canonical pool, mode/version, initialization
  state, token pair, fee tier and codehash;
- public reserves, raw balances, LP supply, LP holders from transfer logs, locks,
  protocol fees, surplus and open LP claims;
- confidential pool/LP addresses, initialized state, public participant/lock metadata
  and encrypted liabilities without pretending to know plaintext values;
- WCOTI total supply, native backing and forced surplus;
- every public limit order by iterating `nextOrderId`, token escrow, native bounty,
  claimable bounty/proceeds and surplus;
- balances and allowances of every vault, router, migrator, adapter, order book or
  other asset-holding/authoritative address in the active records.

Exact private reserves, private LP balances and private fee amounts cannot be inferred
from current public getters. This is unproven, not zero. Any initialized confidential
pool or private transfer/LP history is conservatively treated as non-test value unless
holders produce authenticated position/exit evidence. Any non-test value requires an
explicit migration, continued-support or deprecation decision before deployment.

## Invariant and test matrix

| Surface | Required tests/invariants |
| --- | --- |
| Identity/binding | All dependency address/codehash/interface/mode/version checks; one-time finalization; wrong bundle rejection; no pools before finalization. |
| Standard initialization | Mode 0 EOA/contract and Modes 1/2 EOA-IT/vault-GT; both directions, mixed decimals, ratio bounds, exact deltas, rollback and reinitialization after full exit. |
| Protected issuer/vault | Explicit protected token in pair/key; unsupported token rejection; direct issuer; authorized vault; EOA and ERC-1271; independent authorization IDs in any order; wrong vault/token/mode/factory/chain/version/kind/pair/tier/ID/deadline; replay; failed execution does not consume. |
| Anti-squatting/atomicity | Arbitrary protected create/reserve attempts fail; every failure leaves no pool, consumed auth, escrow, approval or commitment; standard key remains usable. |
| IT/GT parity | Identical transition outputs and reverts for IT and GT; IT endpoint/selector/caller replay; GT actual-caller funding only; no arbitrary `from`; zero residual allowances. |
| Swap accounting | Both directions and tiers; total fee split; active reserves exclude both liabilities; quote/settlement parity; minOut; tiny trades; rounding; transfer-tax/rebase rejection policy. |
| LP fee growth | No historical capture; claim once; repeated claim; mint/burn/transfer checkpoints; sender keeps accrued fees; future fees follow shares; aggregate claims never exceed liability. |
| LP locks | Timed/permanent principal restrictions; owner balance retained; locked shares earn and claim; transfer/withdraw cannot exceed unlocked amount; unlock does not duplicate shares or fees. |
| Full exit/dust/loss | Active reserves only on exit; old claims survive; new shares get no allocated history; two-limb carry conservation; rolling sub-unit global remainder across supply generations; no retired arrays; unsolicited surplus segregation; accounting deficit fails closed. |
| Mode isolation | Mode/router/factory/pool cross-calls fail; Mode 1 emits no price; Mode 2 preserves initial reference, 50-bps observations and encrypted authoritative minOut; future mode is untrusted. |
| Routing | Canonical derivation only; explicit mode/kind; absent/uninitialized/invalid candidates; deterministic ties; request replay; funded candidate/gas ceilings per mode. |
| Deployment | Exact source/clean tree, compiler input, manifest digest, constructor/binding receipts, codehash readback, failed/uncertain transaction recovery and zero temporary resources. |
| Limit-order probe | Encrypted escrow/minOut, full fill, failed trigger, cancellation/refund, expiry, replay, wrong bundle, no plaintext amounts, conservation, cleanup and measured COTI gas/liveness. |

Use focused unit, fuzz and invariant suites named for the new contracts, plus
`NextGenerationTopology.spec.ts`, `ProtectedPoolAuthorization.spec.ts`,
`ConfidentialITGTParity.spec.ts`, `LPFeeAccounting.spec.ts`,
`LPFeeAccounting.invariants.spec.ts`, `LPTransferLockClaim.spec.ts`,
`ModeIsolation.invariants.spec.ts`, `NextGenerationDeploymentRecord.spec.ts` and
`ConfidentialLimitOrderFeasibility.spec.ts`. Existing suites remain regression
evidence for deprecated contracts.

## Implementation stages and gates

1. **Inventory/legal gate:** run the read-only Mainnet inventory; confirm Licensor,
   ownership/relicensing rights, release date and approved license wording; review the
   actual launch-token/factory source that will implement issuer proof.
2. **Identity and accounting core:** after Phase 2A approval, implement shared
   identities, fixed fee policy, LP issuers, proven growth/checkpoints/locks and
   public reference math. Complete scale/bounds/fuzz/invariant review before adding
   routers.
3. **Mode 0:** implement standard/protected public pools and ordinary periphery.
4. **Modes 1/2:** implement separate sealed bundles, IT/GT parity and protected
   initializer paths. Run focused COTI MPC probes for token-internal transfer
   settlement, encrypted growth, claims and exact-delta custody before broad
   integration.
5. **Routers and SDK:** add per-mode routers, explicit SDK mode/kind APIs and generated
   ABIs. Measure each populated candidate set; do not inherit current gas ceilings.
6. **Limit-order investigation:** isolated token-only full-fill prototype and funded
   feasibility report. Production inclusion requires a separate approval.
7. **Fresh COTI testnet:** deploy the complete generation from one clean commit and
   manifest; run the invariant matrix, both IT/GT sources, protected authorization,
   fee claims/transfers/locks, Mode-2 observations, cleanup and recovery. Record actual
   gas, not only limits.
8. **Security/provenance gate:** scoped diff review during development, then a complete
   value-extraction/confidentiality scan of the final contracts and deployment flow;
   exact compiler inputs, Cotiscan dry run, manifest signature and independent review.
9. **Mainnet decision:** compare inventory to the new manifest and approve explicit
   migration/deprecation actions. Deployment remains a separate authorized phase.

## Naming and license migration checklist

- Every new project-owned production deployable/file uses exact `CipherDEX` casing;
  every matching interface uses `ICipherDEX...`.
- Do not rename generic methods, events, errors, mocks or third-party interfaces only
  for branding.
- Existing MIT generation files remain MIT and keep their headers.
- New project-owned core/deployable files use unmodified BUSL-1.1 after legal approval.
- New integration interfaces, SDK/ABI and examples use MIT.
- Third-party files retain original license text and notices.
- Proposed structure: `LICENSES/BUSL-1.1.txt`, `LICENSES/MIT.txt`, and `NOTICE` mapping
  file classes, Licensor, Additional Use Grant, Change Date and Change License.
- The Change Date is one fixed calendar date exactly three years after the confirmed
  release date; the Change License is `GPL-2.0-or-later`.
- The Additional Use Grant should permit production integrations with
  Licensor-authorized CipherDEX deployments, but not a separate or derivative
  protocol-core deployment.
- Do not add license files or change SPDX headers until legal review confirms the
  Licensor, ownership/relicensing rights, release date and exact wording.

## Unresolved proof gates

- **Issuer interface:** no current universal token issuer signal exists. Review and
  test the actual partner launch-token/factory implementation before freezing
  `ICipherDEXLaunchTokenIssuer`; unsupported tokens remain standard-only.
- **Private LP production gas:** the Phase 2A funded probe passed without a callback,
  but its lock rejection used non-authoritative `eth_call`. Phase 2B requires paid
  exact-selector diagnostics plus before/after encrypted state evidence. Production
  storage must then be optimized and remeasured against the selected two-limb math.
- **Arithmetic integration:** Phase 2B selects `SCALE = 2^128`, `2^128 - 1` share,
  reserve and per-fee operands, quotient/remainder growth and a rolling sub-unit
  global remainder. The reference/public/private probes must pass full local and
  funded COTI evidence before these constants move into production code.
- **Confidential limit orders:** feasibility and keeper liveness remain unproven until
  the funded lifecycle above passes. They are not part of the initial deployment.
- **Mainnet value:** exact private amounts are not publicly inventoryable. Treat any
  ambiguous confidential activity as value-bearing and require an explicit decision.
- **Legal parameters:** Licensor, rights, release date and license wording are unknown
  until confirmed and legally reviewed.
