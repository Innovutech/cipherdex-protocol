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

Additional local gates:

- `npm run typecheck`: passed.
- `npm run compile`: passed.
- `npm run verify`: passed before and after the funded-read correction. The final
  run reported `402` Mocha tests (`401` active and the existing funded integration
  test pending), `6` passing Cotiscan tests and zero npm-audit vulnerabilities.

### Funded COTI result

Status: **passed** on COTI testnet chain `7082400` from exact source commit
`0285edd549a8dd54cda78d9941ff90d672e801fa`.

The authenticated run proved mint, fee accrual on both sides, direct transfer,
delegated transfer, timed lock, blocked transfer/burn simulations, fees earned while
locked, exact claim consumption, no double payment, timed unlock, full exit with
surviving claims, reinitialization checkpoint isolation, encrypted conservation and
zero final custody/liabilities/shares. Both funded wallets' private-token balances
were restored exactly and all temporary allowances were cleared.

Measured gas:

| Operation | Gas |
| --- | ---: |
| Probe / delegated-spender deployment | 4,837,441 / 216,126 |
| Underlying approvals (each) / LP delegated approval | 458,470 / 459,296 |
| Mint / reinitialize | 4,836,626 / 5,335,370 |
| First-holder fee accrual | 3,924,101 |
| Multi-holder fee accrual | 4,209,282-4,209,294 |
| Direct / delegated LP transfer | 9,471,985 / 10,277,131 |
| Lock / timed unlock | 5,002,830 / 321,876 |
| LP claim, including zero repeated claim | 5,667,954-5,667,978 |
| Conservation read with active supply | 988,620-988,633 |
| Conservation read after exit/reinitialization | 1,058,683-1,058,696 |
| Full exit / reinitialized-generation burn | 6,265,383 / 6,267,082 |
| Share consolidation | 9,899,015 |
| Funded token-balance restoration | 886,865-886,901 |

The first funded attempt at commit
`b868e66de5b19a8ca38c0823b554512844a98565` failed because its proof runner tried
to onboard encrypted state through `eth_call`. Its authenticated recovery claimed
both fee sides, consolidated and burned all shares, and restored both funded token
allocations, but the final recovery check repeated the same invalid static MPC read,
leaving stale nonterminal recovery metadata for that disposable source commit. The
corrected probe emits only owner-encrypted conservation ciphertexts from a paid
transaction; the final run passed and left no assets or allowances.

## Remaining gates

- Review the actual partner launch-token and token-factory source. Confirm an
  immutable issuer signal or a smaller fail-closed factory-provenance alternative;
  then freeze the production issuer ABI. Unsupported tokens remain standard-only.
- Select `SCALE` only after checked public and COTI MPC overflow bounds cover maximum
  shares, fee products, cumulative growth, carry and lifetime accrual.
- Optimize the private LP storage/settlement path and remeasure production code.
  The proof establishes feasibility, but direct/delegated transfers cost about
  `9.47M`/`10.28M` gas and claims cost about `5.67M` gas in the disposable design.
- Define the final deterministic treatment of retired sub-unit LP dust. It must stay
  bounded and cannot enter reserves, protocol fees or a later LP generation.
- Run production-focused reentrancy, token-delta, external-loss and confidentiality
  review only after production contracts exist.
- Complete Mainnet inventory and migration/deprecation decisions before deployment.
- Resolve Licensor, ownership/relicensing rights, release date, Additional Use Grant,
  Change Date and exact legal wording before applying licenses.
- Confidential limit orders remain a separate funded feasibility gate and are not
  part of this phase.
