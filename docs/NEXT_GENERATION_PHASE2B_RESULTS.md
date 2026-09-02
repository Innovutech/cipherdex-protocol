# CipherDEX Next-Generation Phase 2B Results

## Review basis and scope

Reviewed upstream `main` at exact SHA
`59b3de345d9c63fd6d02249bb681a9b17aefae08`. The Phase 2A sequence after
`52685e3bb5b117b1322dcd3ff2e637a67b27a9e8` is:

1. `b868e66de5b19a8ca38c0823b554512844a98565`
2. `0285edd549a8dd54cda78d9941ff90d672e801fa`
3. `59b3de345d9c63fd6d02249bb681a9b17aefae08`

Phase 2B changes only disposable models/probes/tests, the authenticated proof runner
and plan/result documentation. It does not add or rename production next-generation
contracts, change SDK or deployment manifests, apply licenses, deploy production
stacks, or alter funded secret/recovery architecture.

## Proven facts

### Transaction atomicity

The dependency-free model now snapshots all balances, allowances, checkpoints,
carries, claimable amounts, locks, global growth/remainder, liabilities, reserves,
protocol fees, custody, generation and total shares before every public mutation.
Any exception restores the complete snapshot. Focused tests prove failed direct
transfer, delegated transfer, burn, lock, unlock and claim are state-atomic.

### Authorization IDs

The candidate EIP-712 authorization uses an issuer-chosen nonzero `bytes32
authorizationId` instead of a sequential issuer nonce. The disposable probe proves:

- one issuer can sign several independent launches and execute them in any order;
- failed atomic execution does not consume the ID;
- exact replay fails;
- vault, factory, version, mode, kind, pair, fee tier, protected token, issuer,
  disposition, chain and verifying contract are bound;
- EOA and ERC-1271 signatures work;
- no preauthorization record is installed;
- transaction-scoped GT values remain unsigned and vault-funded.

This remains a candidate mechanism. The real launch-token/factory source has not
been reviewed and no production issuer ABI is selected.

### Arithmetic bounds

The actual pool formulas support token decimals `0..18`; initial shares are the
minimum normalized side, and confidential operational checks multiply reserves,
shares, decimal scales and `1e18` price scale within uint256. The selected proof
bounds are:

- `SCALE = 2^128`;
- maximum total LP shares: `2^128 - 1`;
- maximum active reserve operand: `2^128 - 1`;
- maximum per-operation LP fee: `2^128 - 1`;
- checked uint256 lifetime LP-fee accrual per token.

At these bounds, `reserve0 * reserve1` and `shares * reserve` are below `2^256`.
The worst decimal/price normalization is below `2^248`.

The selected growth representation stores whole and fractional cumulative growth.
It decomposes `lpFee` by current supply before multiplying only the fee remainder by
`SCALE`. This keeps every per-accrual product below `2^256` and avoids a single
scaled lifetime accumulator. Holder settlement uses a two-limb delta. Its
fractional product is statically below `2^256`; its whole product is bounded for
reachable states because holder balance is constant between checkpoints and never
exceeds supply during an included accrual. Fabricated unreachable products fail
closed. A checked lifetime overflow rejects new accrual without disabling existing
transfer, burn or claim operations.

### Remainder ownership

Holder carry is allocated and owner-bound across transfer, burn and zero supply.
Global remainder is unallocated. One scalar rolls across supply changes and
zero-supply generations. It remains below `SCALE`, so historical unallocated value
is strictly below one raw token. New holders cannot capture allocated or claimable
history, but may receive part of this prior sub-unit unallocated remainder.

The exact settled conservation equation is:

`(LP liability - whole claimable) * SCALE = sum(holder carry) + global remainder`.

Focused tests cover nonzero remainder across mint/burn/transfer, 100 zero-supply
generations, 257 holders with carry, reverse-order claims, maximum operands,
lifetime/wrap boundaries and 1,000 deterministic mixed operations.

## Selected decisions

- Use a factory-local key containing ordered pair, fee tier, protocol version,
  privacy mode, pool kind and explicit protected token. Chain and factory remain in
  signatures, EIP-712 domain separation and manifests, not the local mapping key.
- Use independent issuer authorization IDs consumed only by successful atomic
  execution.
- Use quotient/remainder two-limb fee growth with `SCALE = 2^128` and the explicit
  operand caps above.
- Roll one sub-unit global remainder across supply generations. Keep holder carry
  owner-bound. Do not add retired remainder arrays or token-to-pool transfer hooks.
- Prove private lock rejection with a successful outer transaction that catches the
  real reverted LP-token subcall and emits the exact error selector/hash.

## Rejected alternatives

- Generic `staticCall` rejection as proof of `LockedPrivatePrincipal`.
- Sequential issuer nonces that couple unrelated launches.
- Chain ID or factory address duplicated in one immutable factory's local pool key.
- The Phase 2A single scaled lifetime accumulator.
- Retired remainder arrays/buckets or redirecting LP fractional value to a vault.
- Informal overflow claims without concrete checked bounds.

## Test and funded status

Focused Phase 2B tests: `31 passing`.

- `npm run typecheck`: passed.
- `npm run compile`: passed.
- `npm run verify`: passed. It reported `410` Mocha tests (`409` active and
  the existing funded integration test pending), `6` passing Cotiscan tests and
  zero npm-audit vulnerabilities.
- Corrected funded COTI lifecycle: **passed** on COTI testnet chain `7082400` from
  exact clean source commit `9fc974533e0ecfa44df89c0b0fa40bcd9104f8cc`.
- Sanitized evidence record:
  `evidence/coti-testnet-phase2b-private-lp-accounting-9fc974533e0ecfa44df89c0b0fa40bcd9104f8cc.json`.
- Both transaction-backed lock diagnostics returned exact
  `LockedPrivatePrincipal()` selector `0x750c1c38`; the transfer diagnostic used
  `13,581,177` gas and the burn diagnostic used `6,788,943` gas.
- The encrypted pre/post diagnostic snapshot used `14,405,762` gas per read and
  proved balances, shares, locks, fee claims, allowance and lock metadata unchanged.
- Direct and delegated transfers used `13,859,395` and `14,425,823` gas. Full exit
  used `7,608,227` gas. The funded remainder edge created and later resolved a
  nonzero global remainder across mint and burn.
- Cleanup restored exact funded token balances and left zero probe custody, total
  shares, fee liability and residual allowances. The authenticated recovery resource
  is closed. All `49` recorded receipts have status `1`; total measured lifecycle gas
  was `265,961,110` across deployments, writes, paid encrypted reads and cleanup.

## Remaining gates

- Review the real partner launch-token/factory source and select or reject the
  candidate issuer signal. Unsupported tokens remain standard-only.
- Optimize and remeasure the eventual production encrypted storage layout; proof
  contracts intentionally prioritize auditability over gas.
- Run production security/confidentiality review only after licensed production
  contracts exist.
- Complete Mainnet inventory and explicit migration/deprecation decisions.
- Resolve Licensor, ownership/relicensing rights, release date, Additional Use Grant,
  Change Date and exact license wording before publishing replacement production core.
- Confidential limit orders remain a separate feasibility gate.
