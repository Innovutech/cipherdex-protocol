# CipherDEX Next-Generation Phase 2A Results

## Review basis and scope

Phase 2A was performed from exact commit
`52685e3bb5b117b1322dcd3ff2e637a67b27a9e8`. The source topology was reviewed at
its exact parent `9e66e8f424d242013326a9c408a16e371ce35342`.

Only disposable reference/probe artifacts, focused tests and the Phase 1 plan were
changed. No production contract or interface was added or renamed. No SDK,
deployment manifest, license, deployment, funded secret or recovery architecture
was changed.

## Proven results

### Fungible LP fee accounting and locks

The dependency-free integer reference model and disposable public probe prove the
smaller LP-token-owned design:

- global growth/remainder and per-holder checkpoints/carry/claimable amounts settle
  before mint, burn, direct transfer and delegated transfer;
- a mint or transfer cannot capture historical fees;
- accrued fees remain with the sender and only future fees follow transferred
  shares;
- repeated claim consumption cannot double-pay;
- a burn, including full exit, preserves accrued claims;
- locked and unlocked shares earn identically;
- locked principal cannot transfer or burn, and timed unlock changes only
  transferability;
- active reserves, protocol liabilities and LP-fee liabilities remain separate;
- paid plus outstanding plus explicitly bounded dust equals accrued LP fees;
- when supply reaches zero, the active global remainder is retired by generation
  and reset, so a later generation cannot inherit it.

The reference proof uses configurable integer `SCALE` and enforces
`totalShares <= SCALE`. It does not select Q128. The bounded dust rule includes
active global remainder, retired global remainder and nonzero holder carries.

The disposable public token keeps settlement and lock state internally. Only its
probe pool can accrue fees, mint/burn, lock/unlock and consume claims. Transfers do
not call back into the pool.

The disposable private token extends the pinned COTI `PrivateERC20` and compiles by
overriding its required `internal virtual _update` hook. It mirrors encrypted total
shares because the base implementation's storage is private, and keeps encrypted
growth, remainder, checkpoints, carry, claims and locked principal in the LP token.
Its external ABI contains no token-to-pool transfer callback. Local Hardhat proves
hook access, deployment size and pool-only authorization only; it is not treated as
faithful MPC lifecycle execution.

### Issuer-to-vault authorization

The disposable authorization probe proves:

- an immutable explicit issuer signal can fail closed;
- EOA and ERC-1271 issuers can authorize one vault;
- EIP-712 domain separation binds chain and verifying contract;
- static authorization binds factory, protocol version, privacy mode, protected
  pool kind, ordered pair, fee tier, explicit protected token, issuer, vault, LP
  disposition, nonce and deadline;
- wrong static fields, wrong caller, expiry and replay fail;
- a revert after nonce consumption atomically restores nonce and execution state;
- the vault's transaction-scoped execution-values tag is intentionally not signed.

This proves authorization semantics, not the final issuer ABI. The actual vault
must self-fund its future GT, and the eventual protected initializer must enforce
exact transfer deltas, pool identity, price/slippage and LP disposition.

## Rejected designs

- Reverse-binding ordinary public swap/best/native/liquidity periphery or the public
  limit-order book solely for symmetry.
- Treating permissionless, caller-funded `initializeStandardGT` as trusted routing.
- A token-to-pool callback on every LP transfer.
- An issuer signature that claims to pre-authorize unknown future GT amounts.
- Freezing `ICipherDEXLaunchTokenIssuer` before the real launch-token/factory source
  is reviewed.
- Selecting Q128 without public and MPC bounds and measured COTI gas.
- Rolling a zero-supply remainder into a later LP generation.

## Tests and status

Focused local command:

`npx hardhat test test/unit/LPFeeAccountingModel.spec.ts test/unit/PublicLPAccountingProbe.spec.ts test/unit/PrivateLPAccountingProbe.spec.ts test/unit/ProtectedVaultAuthorizationProbe.spec.ts`

Result: `23 passing`.

Additional local gates completed before the first results commit:

- `npm run typecheck`: passed.
- `npm run compile`: passed.
- `npm run verify`: passed (`402` Mocha tests reported: `401` active and the
  existing funded integration test pending; `6` Cotiscan tests passed; both npm
  audit reports contained zero vulnerabilities).

Funded COTI private probe status: **not run**. The runner requires a clean committed
source revision and the existing authenticated external funded configuration. If
that configuration is available after the first results commit, the exact status
and measured transaction gas will replace this paragraph in a follow-up results
commit. No funded success is inferred.

## Remaining gates

- Review the actual partner launch-token and token-factory source. Confirm an
  immutable issuer signal or a smaller fail-closed factory-provenance alternative;
  then freeze the production issuer ABI. Unsupported tokens remain standard-only.
- Select `SCALE` only after checked public and COTI MPC overflow bounds cover maximum
  shares, fee products, cumulative growth, carry and lifetime accrual.
- Complete the funded COTI lifecycle: mint, both fee sides, direct and delegated
  transfer, timed lock, blocked transfer/burn, claim consumption, timed unlock,
  full exit, reinitialization, exact encrypted conservation, exact funded-balance
  restoration and measured gas.
- Define the final deterministic treatment of retired sub-unit LP dust. It must stay
  bounded and cannot enter reserves, protocol fees or a later LP generation.
- Run production-focused reentrancy, token-delta, external-loss and confidentiality
  review only after production contracts exist.
- Complete Mainnet inventory and migration/deprecation decisions before deployment.
- Resolve Licensor, ownership/relicensing rights, release date, Additional Use Grant,
  Change Date and exact legal wording before applying licenses.
- Confidential limit orders remain a separate funded feasibility gate and are not
  part of this phase.
