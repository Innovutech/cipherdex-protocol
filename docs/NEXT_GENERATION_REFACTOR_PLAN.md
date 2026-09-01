# CipherDEX Next-Generation Refactor Plan

## Review basis

Reviewed repository: `Innovutech/cipherdex-protocol`

Reviewed branch and SHA: upstream `main` at
`9e66e8f424d242013326a9c408a16e371ce35342`.

Source, tests and committed deployment records at that SHA are the authority for
this plan. This is Phase 1 only: no contract, SDK, deployment-code or deployment
change is included.

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

`chainId, factory, protocolVersion, privacyMode, poolKind, ordered pair, feeBps, protectedToken`

`STANDARD` uses `protectedToken = address(0)`. `PROTECTED` requires the explicit
protected token to be one member of the pair. Standard and protected keys are
independent. Decimals are validated metadata, not a second identity for the same
token pair.

There are no proxies, governance hooks, replacement authorities, mutable plugin
registries or open-ended mode registries. A future Mode 3 is a new factory-bound
bundle and manifest entry; existing bundles do not trust it automatically.

### Sealed bundle and binding rules

Each mode receives its own pool, factory, protocol-fee vault, protected initializer
and best router. Modes 1/2 also receive separate pool deployers. A factory is not
usable until one-time configuration is finalized.

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
4. Deploy one protected initializer and one best router per mode; bind each once
   after checking address, runtime codehash, interface, factory, mode and version.
5. Finalize each factory. Pool creation is disabled before finalization.
6. Deploy replaceable ordinary periphery, validate its immutable dependencies and
   record it in the manifest. Do not reverse-bind periphery that has no privileged
   core entrypoint.

Pools store their factory, mode, version, pool kind, protected token, fee vault and
LP token immutably or through a factory-only one-time initialization performed in
the creation transaction. Privileged GT, protected initialization, LP mint/burn or
transfer hooks, and fee-liability movement are accepted only from the receiving
core's bound component. No privileged function accepts caller-selected factory,
pool, payer or fee destination addresses.

The current strategy registries, launch strategies and migrators are not carried
forward. The two fixed pool kinds do not need a strategy plugin layer.

### Protected-pool issuer proof

The smallest fail-closed v1 proof is a new MIT integration interface implemented
by the explicit protected token:

`ICipherDEXLaunchTokenIssuer.cipherDEXLaunchIssuer() -> address`

The interface must be detected explicitly (ERC-165 or an equally strict reviewed
selector check). The protected initializer reads it from `protectedToken`, not from
the paired asset or token ordering. Generic `owner()`, admin roles,
`DEFAULT_ADMIN_ROLE`, `MINTER_ROLE`, balances, `tx.origin`, deployment guesses and
frontend attestations are not issuer proofs.

The current COTI `PrivateERC20` base exposes AccessControl but no universal issuer
semantic. Arbitrary public ERC-20s likewise expose no universal issuer. Therefore:

- tokens implementing the reviewed explicit issuer interface may use protected
  pools;
- a partner token-factory provenance path is unsupported until its exact source,
  immutability, token-to-issuer record and runtime codehash are reviewed and tested;
- all other tokens get standard pools only.

The issuer may initialize directly, or authorize one vault for one launch. The
vault authorization is EIP-712 data consumed in the same transaction and binds:

`chainId, protectedInitializer, factory, protocolVersion, privacyMode, poolKind,
ordered pair, feeBps, protectedToken, issuer, vault, initialization terms, nonce,
deadline`.

The caller must be the named issuer or vault. `SignatureValidation` provides EOA
and ERC-1271 verification. No authorization is installed ahead of time. Protected
pool creation, authorization consumption, asset movement and initialization occur
atomically; a revert leaves no pool, commitment, allowance, escrow or reservation.
An arbitrary caller cannot create or reserve a protected key.

### EOA IT and contract GT initialization

Modes 1/2 expose paired endpoints with identical accounting:

- `initializeStandardIT`: user IT is generated for and validated by that exact
  pool endpoint.
- `initializeStandardGT`: a calling contract supplies transaction-scoped GT; the
  pool pulls assets only from `msg.sender`.
- `initializeProtectedIT`: the bound initializer validates IT generated for that
  exact initializer endpoint, escrows from `msg.sender`, and atomically creates and
  initializes the protected pool.
- `initializeProtectedGT`: the issuer/vault calls with transaction-scoped GT; the
  initializer escrows only from `msg.sender` and forwards through its bound core
  path. There is no arbitrary `from` parameter.

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

Use Q128 cumulative growth, subject to a pre-implementation overflow proof and
explicit bounds on reserves, total shares and fee products. Settle a holder before
every mint, burn or transfer:

`claimable += floor((balance * growthDelta + holderCarry) / 2^128)`

and retain the fractional remainder as `holderCarry`. Minted shares checkpoint at
current growth and cannot capture history. Sender and receiver settle before a
transfer; accrued fees remain with the sender and future fees follow transferred
shares. Claims debit only LP-fee liability and use exact token-delta checks.

LP-token ownership alone determines entitlement; protected launch provenance adds
no special fee account. Public growth, claims and amount events may be plaintext.
Modes 1/2 keep growth, checkpoints, claimable balances and claim amounts encrypted,
offer owner-readable ciphertext results, and emit no plaintext amount event.

Global and per-holder fractional dust remains segregated as LP-fee accounting and
rolls forward; it is never added to reserves, protocol fees or a new holder's
checkpoint. No rescue or beneficiary sweep may redirect it. The arithmetic review
must prove aggregate paid claims cannot exceed aggregate LP liability and quantify
the maximum permanently sub-unit remainder.

Locks leave shares in the owner's LP balance. The pool records locked principal;
the LP token's transfer hook and pool withdrawals enforce
`requested <= balance - locked`. Locked shares therefore continue to receive and
claim fees. Timed unlock changes transferability only. Permanent locks never regain
principal transfer or withdrawal rights but retain normal fee claims.

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

Add matching MIT interfaces under `contracts/interfaces/` using `I` plus the exact
deployable name for every externally called component above. Also add the shared
MIT interfaces `ICipherDEXPoolIdentity.sol`, `ICipherDEXLaunchTokenIssuer.sol` and
`ICipherDEXLPTransferHook.sol`. Generic function/event/error names remain unchanged.

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
| Protected issuer/vault | Explicit protected token in pair/key; unsupported token rejection; direct issuer; authorized vault; EOA and ERC-1271; wrong vault/token/mode/factory/chain/version/kind/pair/tier/nonce/deadline; replay. |
| Anti-squatting/atomicity | Arbitrary protected create/reserve attempts fail; every failure leaves no pool, consumed auth, escrow, approval or commitment; standard key remains usable. |
| IT/GT parity | Identical transition outputs and reverts for IT and GT; IT endpoint/selector/caller replay; GT actual-caller funding only; no arbitrary `from`; zero residual allowances. |
| Swap accounting | Both directions and tiers; total fee split; active reserves exclude both liabilities; quote/settlement parity; minOut; tiny trades; rounding; transfer-tax/rebase rejection policy. |
| LP fee growth | No historical capture; claim once; repeated claim; mint/burn/transfer checkpoints; sender keeps accrued fees; future fees follow shares; aggregate claims never exceed liability. |
| LP locks | Timed/permanent principal restrictions; owner balance retained; locked shares earn and claim; transfer/withdraw cannot exceed unlocked amount; unlock does not duplicate shares or fees. |
| Full exit/dust/loss | Active reserves only on exit; old claims survive; new shares get no history; Q128 carry conservation; bounded dust; unsolicited surplus segregation; accounting deficit fails closed. |
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
2. **Identity and accounting core:** implement shared identities, fixed fee policy,
   LP issuers, Q128 growth/checkpoints/locks and public reference math. Complete
   arithmetic/fuzz/invariant review before adding routers.
3. **Mode 0:** implement standard/protected public pools and ordinary periphery.
4. **Modes 1/2:** implement separate sealed bundles, IT/GT parity and protected
   initializer paths. Run focused COTI MPC probes for transfer hooks, encrypted growth,
   claims and exact-delta callbacks before broad integration.
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
- **Private LP transfer hooks:** `PrivateERC20._update` is virtual, but encrypted lock
  enforcement, pool callbacks, claim checkpoints, reentrancy ordering and gas are not
  funded-COTI proven. Build a disposable token/pool probe covering transfer, mint,
  burn, lock and claim before adopting the hook.
- **Q128 arithmetic:** prove overflow bounds and aggregate liability conservation in
  public and MPC arithmetic, fuzz extreme decimals/supply/fees, and measure COTI gas.
  If Q128 cannot satisfy checked bounds, select the largest proven power-of-two scale
  before implementation; do not silently reduce precision.
- **Confidential limit orders:** feasibility and keeper liveness remain unproven until
  the funded lifecycle above passes. They are not part of the initial deployment.
- **Mainnet value:** exact private amounts are not publicly inventoryable. Treat any
  ambiguous confidential activity as value-bearing and require an explicit decision.
- **Legal parameters:** Licensor, rights, release date and license wording are unknown
  until confirmed and legally reviewed.
